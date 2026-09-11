import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import type { Server } from './server-type.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** One field-level validation failure. */
export interface ProblemFieldError {
  /** JSON Pointer-ish path to the offending field, e.g. `/name`. */
  readonly field: string;
  readonly message: string;
}

/**
 * An RFC 9457 problem document (09 §2).
 *
 * `type` is a path, never an absolute URL: a product domain on an error body
 * would be a brand leak (02 §5.5), and the path is stable across deployments.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly requestId?: string;
}

/** The problem types this package emits. */
export const PROBLEM_TYPES = {
  validation: '/problems/validation',
  unauthorized: '/problems/unauthorized',
  forbidden: '/problems/forbidden',
  notFound: '/problems/not-found',
  conflict: '/problems/conflict',
  preconditionFailed: '/problems/precondition-failed',
  preconditionRequired: '/problems/precondition-required',
  unsupportedMediaType: '/problems/unsupported-media-type',
  payloadTooLarge: '/problems/payload-too-large',
  rateLimited: '/problems/rate-limited',
  unavailable: '/problems/unavailable',
  internal: '/problems/internal',
} as const;

export interface ProblemOptions {
  readonly detail?: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly code?: string;
}

/**
 * Throw this from a handler to produce a problem+json response.
 *
 * @example
 * ```ts
 * throw ProblemError.notFound('No extension with that id', { code: 'extension_not_found' });
 * ```
 */
export class ProblemError extends Error {
  override readonly name = 'ProblemError';
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly errors?: readonly ProblemFieldError[];

  constructor(
    status: number,
    type: string,
    title: string,
    code: string,
    options: ProblemOptions = {},
  ) {
    super(options.detail ?? title);
    this.status = status;
    this.type = type;
    this.title = title;
    this.code = options.code ?? code;
    if (options.errors !== undefined) this.errors = options.errors;
  }

  toProblem(instance?: string, requestId?: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.message === this.title ? {} : { detail: this.message }),
      ...(instance === undefined ? {} : { instance }),
      ...(this.errors === undefined ? {} : { errors: this.errors }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  static badRequest(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(400, PROBLEM_TYPES.validation, 'Invalid request', 'bad_request', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static validation(errors: readonly ProblemFieldError[], detail?: string): ProblemError {
    return new ProblemError(
      400,
      PROBLEM_TYPES.validation,
      'Request validation failed',
      'validation_failed',
      { errors, ...(detail === undefined ? {} : { detail }) },
    );
  }

  static unauthorized(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(
      401,
      PROBLEM_TYPES.unauthorized,
      'Authentication required',
      'unauthorized',
      { ...options, ...(detail === undefined ? {} : { detail }) },
    );
  }

  static forbidden(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(403, PROBLEM_TYPES.forbidden, 'Not permitted', 'forbidden', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static notFound(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(404, PROBLEM_TYPES.notFound, 'Not found', 'not_found', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static conflict(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(409, PROBLEM_TYPES.conflict, 'Conflict', 'conflict', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static preconditionFailed(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(
      412,
      PROBLEM_TYPES.preconditionFailed,
      'Precondition failed',
      'precondition_failed',
      { ...options, ...(detail === undefined ? {} : { detail }) },
    );
  }

  /** `If-Match` is required on PATCH/PUT (09 §2). */
  static preconditionRequired(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(
      428,
      PROBLEM_TYPES.preconditionRequired,
      'Precondition required',
      'precondition_required',
      { ...options, ...(detail === undefined ? {} : { detail }) },
    );
  }

  static rateLimited(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(429, PROBLEM_TYPES.rateLimited, 'Too many requests', 'rate_limited', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static unavailable(detail?: string, options: ProblemOptions = {}): ProblemError {
    return new ProblemError(503, PROBLEM_TYPES.unavailable, 'Service unavailable', 'unavailable', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

/**
 * Maps Fastify's validation errors onto problem field errors.
 *
 * Ajv reports `instancePath` (`/name`) plus a message; the offending value is
 * deliberately not copied across, since request bodies carry credentials.
 */
function fieldErrors(error: FastifyError): ProblemFieldError[] {
  const validation = error.validation ?? [];
  return validation.map((entry) => {
    const path = typeof entry.instancePath === 'string' ? entry.instancePath : '';
    const missing = (entry.params as { missingProperty?: string } | undefined)?.missingProperty;
    return {
      field: path === '' && missing !== undefined ? `/${missing}` : path === '' ? '/' : path,
      message: entry.message ?? 'is invalid',
    };
  });
}

/** Where the failure happened: `body`, `querystring`, `params`, or `headers`. */
function validationDetail(error: FastifyError): string {
  const context = error.validationContext;
  return context === undefined
    ? 'The request failed validation.'
    : `The ${context} failed validation.`;
}

/**
 * Turns any thrown value into a problem document.
 *
 * A 5xx never carries the underlying message: it is logged at `error` with the
 * request id, and the client gets a generic detail so internals and connection
 * strings stay out of API responses.
 */
export function toProblem(error: FastifyError, request: FastifyRequest): Problem {
  const requestId = request.id;
  const instance = request.url;

  if (error instanceof ProblemError) return error.toProblem(instance, requestId);

  if (error.validation !== undefined) {
    return ProblemError.validation(fieldErrors(error), validationDetail(error)).toProblem(
      instance,
      requestId,
    );
  }

  const status = error.statusCode ?? 500;

  if (status >= 500) {
    return {
      type: PROBLEM_TYPES.internal,
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
      detail: 'The request could not be completed.',
      instance,
      requestId,
    };
  }

  return {
    type: statusType(status),
    title: statusTitle(status),
    status,
    code: error.code ?? statusCode(status),
    ...(error.message === '' ? {} : { detail: error.message }),
    instance,
    requestId,
  };
}

function statusType(status: number): string {
  switch (status) {
    case 401:
      return PROBLEM_TYPES.unauthorized;
    case 403:
      return PROBLEM_TYPES.forbidden;
    case 404:
      return PROBLEM_TYPES.notFound;
    case 409:
      return PROBLEM_TYPES.conflict;
    case 412:
      return PROBLEM_TYPES.preconditionFailed;
    case 413:
      return PROBLEM_TYPES.payloadTooLarge;
    case 415:
      return PROBLEM_TYPES.unsupportedMediaType;
    case 429:
      return PROBLEM_TYPES.rateLimited;
    default:
      return PROBLEM_TYPES.validation;
  }
}

function statusTitle(status: number): string {
  switch (status) {
    case 401:
      return 'Authentication required';
    case 403:
      return 'Not permitted';
    case 404:
      return 'Not found';
    case 405:
      return 'Method not allowed';
    case 409:
      return 'Conflict';
    case 412:
      return 'Precondition failed';
    case 413:
      return 'Payload too large';
    case 415:
      return 'Unsupported media type';
    case 429:
      return 'Too many requests';
    default:
      return 'Invalid request';
  }
}

function statusCode(status: number): string {
  return statusTitle(status).toLowerCase().replaceAll(' ', '_');
}

/** Installs the problem+json error and 404 handlers. */
export function registerProblemHandlers(app: Server): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const problem = toProblem(error, request);

    if (problem.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ err: error, status: problem.status }, 'request rejected');
    }

    void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const problem = ProblemError.notFound('No route matches this path.').toProblem(
      request.url,
      request.id,
    );
    void reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });
}
