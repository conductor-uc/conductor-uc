import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import type { Server } from './server-type.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** A value a message is built from: never a credential or a request body. */
export type ProblemParam = string | number | boolean | readonly (string | number | boolean)[];

/**
 * One field-level validation failure.
 *
 * A client shows it under the field it names, in its own language: schema
 * failures carry the JSON Schema `keyword` (`required`, `minLength`,
 * `maximum`, ...) with its `params` (`{ limit: 12 }`), and a service's own
 * checks carry a `code` (`extension_number_taken`). `message` is English, for
 * clients that translate neither (S9-02, D-018).
 */
export interface ProblemFieldError {
  /** JSON Pointer-ish path to the offending field, e.g. `/name`. */
  readonly field: string;
  readonly message: string;
  readonly keyword?: string;
  readonly code?: string;
  readonly params?: Readonly<Record<string, ProblemParam>>;
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
  /**
   * Stable and machine-readable (`extension_number_taken`): what a client
   * translates and branches on. `detail` is English, for the log and for
   * clients that do not know the code (S9-02, D-018).
   */
  readonly code: string;
  readonly detail?: string;
  /** The values `detail` names, so a client can say the same in its language. */
  readonly params?: Readonly<Record<string, ProblemParam>>;
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
  /**
   * Required (S9-02): every problem a service raises names what went wrong
   * in a way a client can translate, `snake_case`, specific to the case
   * (`extension_not_found`, not `not_found`).
   */
  readonly code: string;
  readonly params?: Readonly<Record<string, ProblemParam>>;
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
  readonly params?: Readonly<Record<string, ProblemParam>>;

  constructor(status: number, type: string, title: string, options: ProblemOptions) {
    super(options.detail ?? title);
    this.status = status;
    this.type = type;
    this.title = title;
    this.code = options.code;
    if (options.errors !== undefined) this.errors = options.errors;
    if (options.params !== undefined) this.params = options.params;
  }

  toProblem(instance?: string, requestId?: string): Problem {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.message === this.title ? {} : { detail: this.message }),
      ...(this.params === undefined ? {} : { params: this.params }),
      ...(instance === undefined ? {} : { instance }),
      ...(this.errors === undefined ? {} : { errors: this.errors }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  static validation(
    errors: readonly ProblemFieldError[],
    detail?: string,
    code = 'validation_failed',
  ): ProblemError {
    return new ProblemError(400, PROBLEM_TYPES.validation, 'Request validation failed', {
      code,
      errors,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static badRequest(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(400, PROBLEM_TYPES.validation, 'Invalid request', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static unauthorized(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(401, PROBLEM_TYPES.unauthorized, 'Authentication required', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static forbidden(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(403, PROBLEM_TYPES.forbidden, 'Not permitted', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static notFound(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(404, PROBLEM_TYPES.notFound, 'Not found', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static conflict(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(409, PROBLEM_TYPES.conflict, 'Conflict', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static preconditionFailed(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(412, PROBLEM_TYPES.preconditionFailed, 'Precondition failed', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** `If-Match` is required on PATCH/PUT (09 §2). */
  static preconditionRequired(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(428, PROBLEM_TYPES.preconditionRequired, 'Precondition required', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static rateLimited(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(429, PROBLEM_TYPES.rateLimited, 'Too many requests', {
      ...options,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static unavailable(detail: string | undefined, options: ProblemOptions): ProblemError {
    return new ProblemError(503, PROBLEM_TYPES.unavailable, 'Service unavailable', {
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
    const params = schemaParams(entry.params);
    return {
      field: path === '' && missing !== undefined ? `/${missing}` : path === '' ? '/' : path,
      message: entry.message ?? 'is invalid',
      ...(typeof entry.keyword === 'string' ? { keyword: entry.keyword } : {}),
      ...(params === undefined ? {} : { params }),
    };
  });
}

/**
 * Ajv's `params` for a keyword (`{ limit: 12 }`, `{ allowedValues: [...] }`),
 * keeping only plain values. They describe the schema, never the request, so
 * nothing the caller sent is echoed back.
 */
function schemaParams(params: unknown): Record<string, ProblemParam> | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const out: Record<string, ProblemParam> = {};
  for (const [key, value] of Object.entries(params)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as string | number | boolean;
    } else if (
      Array.isArray(value) &&
      value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
    ) {
      out[key] = value as (string | number | boolean)[];
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
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
    const problem = ProblemError.notFound('No route matches this path.', {
      code: 'route_not_found',
    }).toProblem(request.url, request.id);
    void reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });
}
