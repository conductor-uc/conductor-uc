import { createHmac, randomUUID } from 'node:crypto';
import { secretEquals } from '@cuc/crypto';
import type { FastifyRequest } from 'fastify';

import { ProblemError } from './problem.js';

/** Who is making the request, as resolved by api-gateway. */
export type ActorType = 'user' | 'apikey' | 'service' | 'node';

/** Which tier the actor's org sits in (02 §1). */
export type OrgType = 'master' | 'reseller' | 'tenant';

/**
 * Per-request identity and correlation.
 *
 * `requestId` and `traceId` are always present. Everything else is populated
 * only for authenticated requests, and only when the service trusts its
 * internal headers — see {@link ContextOptions.trustInternalHeaders}.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly spanId?: string;
  readonly actorId?: string;
  readonly actorType?: ActorType;
  readonly orgId?: string;
  readonly orgType?: OrgType;
  readonly resellerId?: string;
  readonly tenantId?: string;
  /**
   * The address of the client that reached api-gateway (G-113), as the gateway
   * saw it. A service's own `request.ip` is the gateway's address, so audit
   * events and sessions take the client's from here — see `clientIpOf`.
   */
  readonly clientIp?: string;
}

/**
 * Headers api-gateway sets when it forwards a request (06, api-gateway).
 *
 * The prefix is deliberately neutral: header names are network-visible, and no
 * product or codebase name may appear on them (02 §5.5).
 */
export const INTERNAL_CONTEXT_HEADERS = {
  actorId: 'x-internal-actor-id',
  actorType: 'x-internal-actor-type',
  orgId: 'x-internal-org-id',
  orgType: 'x-internal-org-type',
  resellerId: 'x-internal-reseller-id',
  tenantId: 'x-internal-tenant-id',
  clientIp: 'x-internal-client-ip',
} as const;

/** Header carrying the caller's request id, echoed back on the response. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** W3C Trace Context header. */
export const TRACEPARENT_HEADER = 'traceparent';

/**
 * Carries `{timestamp}.{hex-hmac-sha256}` over the context headers (S1-08) —
 * proof that api-gateway, not a client reaching a service directly, produced
 * them. Neutral name, same rule as the context headers themselves (02 §5.5).
 */
export const INTERNAL_SIGNATURE_HEADER = 'x-internal-signature';

/**
 * How far a signature's timestamp may drift from now before it's rejected.
 * Generous enough for real clock skew and proxy latency, tight enough to
 * bound how long a captured signature is worth anything.
 */
export const INTERNAL_SIGNATURE_MAX_AGE_MS = 60_000;

export interface ContextOptions {
  /**
   * Whether to believe `x-internal-*` headers.
   *
   * Defaults to **false**. These headers are only trustworthy when the service
   * is reachable solely through api-gateway, which authenticates the caller and
   * signs them with `internalHeaderSigningSecret` below (S1-08). A directly
   * reachable service that trusted them unconditionally would let any client
   * name its own tenant.
   *
   * When true, a request that carries any `x-internal-*` header must also carry
   * a valid `x-internal-signature`, or {@link buildRequestContext} throws
   * {@link ProblemError.unauthorized} — a forged or unsigned context header is
   * rejected, not silently stripped. A request with **no** internal headers at
   * all gets an anonymous context (or a `service` one, see
   * {@link ContextOptions.internalServiceToken}): that's an ordinary
   * unauthenticated request, not a forgery attempt, and `createServer` refuses
   * it on every route that declares a permission (G-112).
   */
  readonly trustInternalHeaders?: boolean;
  /** Required whenever `trustInternalHeaders` is true — see {@link ContextOptions.trustInternalHeaders}. */
  readonly internalHeaderSigningSecret?: string;
  /**
   * The shared `INTERNAL_SERVICE_TOKEN` (G-112). Only read when
   * `trustInternalHeaders` is true: a request with no `x-internal-*` headers
   * that presents `Authorization: Bearer <token>` gets a context with
   * `actorType: 'service'` and no org, marking it as a trusted machine caller
   * rather than an anonymous one. A wrong or absent token is not an error
   * here — the request stays anonymous, and a route that declares a permission
   * then refuses it (`registerAuthenticationRequirement`).
   */
  readonly internalServiceToken?: string;
}

interface RawInternalFields {
  readonly actorId?: string | undefined;
  readonly actorType?: string | undefined;
  readonly orgId?: string | undefined;
  readonly orgType?: string | undefined;
  readonly resellerId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly clientIp?: string | undefined;
}

/**
 * Fixed field order, so the signer and the verifier build byte-identical
 * strings. Adding a field changes the payload for every request, so the
 * gateway and the services must be upgraded together (G-113).
 */
function canonicalPayload(timestamp: string, fields: RawInternalFields): string {
  return [
    timestamp,
    fields.actorId ?? '',
    fields.actorType ?? '',
    fields.orgId ?? '',
    fields.orgType ?? '',
    fields.resellerId ?? '',
    fields.tenantId ?? '',
    fields.clientIp ?? '',
  ].join('\n');
}

function sign(secret: string, timestamp: string, fields: RawInternalFields): string {
  return createHmac('sha256', secret).update(canonicalPayload(timestamp, fields)).digest('hex');
}

/**
 * Builds the `x-internal-*` context headers plus a valid
 * {@link INTERNAL_SIGNATURE_HEADER} — what api-gateway calls once per
 * forwarded request, and what a test calls to exercise a service's
 * `trustInternalHeaders` path honestly instead of skipping verification.
 */
export function signInternalHeaders(
  secret: string,
  fields: {
    readonly actorId?: string;
    readonly actorType?: ActorType;
    readonly orgId?: string;
    readonly orgType?: OrgType;
    readonly resellerId?: string;
    readonly tenantId?: string;
    readonly clientIp?: string;
  },
): Record<string, string> {
  const timestamp = String(Date.now());
  const headers: Record<string, string> = {
    [INTERNAL_SIGNATURE_HEADER]: `${timestamp}.${sign(secret, timestamp, fields)}`,
  };
  if (fields.actorId !== undefined) headers[INTERNAL_CONTEXT_HEADERS.actorId] = fields.actorId;
  if (fields.actorType !== undefined)
    headers[INTERNAL_CONTEXT_HEADERS.actorType] = fields.actorType;
  if (fields.orgId !== undefined) headers[INTERNAL_CONTEXT_HEADERS.orgId] = fields.orgId;
  if (fields.orgType !== undefined) headers[INTERNAL_CONTEXT_HEADERS.orgType] = fields.orgType;
  if (fields.resellerId !== undefined)
    headers[INTERNAL_CONTEXT_HEADERS.resellerId] = fields.resellerId;
  if (fields.tenantId !== undefined) headers[INTERNAL_CONTEXT_HEADERS.tenantId] = fields.tenantId;
  if (fields.clientIp !== undefined) headers[INTERNAL_CONTEXT_HEADERS.clientIp] = fields.clientIp;
  return headers;
}

/** `undefined` on anything malformed — the caller only needs "valid or not." */
function verifySignature(
  secret: string,
  signatureHeader: string | undefined,
  fields: RawInternalFields,
): boolean {
  if (signatureHeader === undefined) return false;
  const separator = signatureHeader.indexOf('.');
  if (separator === -1) return false;

  const timestamp = signatureHeader.slice(0, separator);
  const signature = signatureHeader.slice(separator + 1);
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > INTERNAL_SIGNATURE_MAX_AGE_MS) return false;

  return secretEquals(signature, sign(secret, timestamp, fields));
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** 16 random bytes as lowercase hex, the W3C trace-id shape. */
function newTraceId(): string {
  return randomUUID().replaceAll('-', '');
}

/**
 * Pulls the trace id and span id out of a `traceparent` header.
 *
 * A malformed or absent header yields a fresh trace id rather than an error:
 * losing a correlation id must never fail a request.
 */
export function parseTraceparent(value: string | undefined): {
  traceId: string;
  spanId?: string;
} {
  const match = value === undefined ? null : TRACEPARENT_PATTERN.exec(value);
  if (match === null) return { traceId: newTraceId() };

  const [, traceId, spanId] = match;
  return { traceId: traceId!, spanId: spanId! };
}

/** Builds the context for one request. */
export function buildRequestContext(
  request: FastifyRequest,
  options: ContextOptions = {},
): RequestContext {
  const headers = request.headers;
  const { traceId, spanId } = parseTraceparent(header(headers[TRACEPARENT_HEADER]));

  const base: RequestContext = {
    requestId: request.id,
    traceId,
    ...(spanId === undefined ? {} : { spanId }),
  };

  if (options.trustInternalHeaders !== true) return base;

  const raw: RawInternalFields = {
    actorId: header(headers[INTERNAL_CONTEXT_HEADERS.actorId]),
    actorType: header(headers[INTERNAL_CONTEXT_HEADERS.actorType]),
    orgId: header(headers[INTERNAL_CONTEXT_HEADERS.orgId]),
    orgType: header(headers[INTERNAL_CONTEXT_HEADERS.orgType]),
    resellerId: header(headers[INTERNAL_CONTEXT_HEADERS.resellerId]),
    tenantId: header(headers[INTERNAL_CONTEXT_HEADERS.tenantId]),
    clientIp: header(headers[INTERNAL_CONTEXT_HEADERS.clientIp]),
  };

  // No internal header at all is not a forgery attempt — nothing to verify,
  // nothing to reject. It is either another service presenting the shared
  // token, or an unauthenticated request (which only a public route serves).
  if (Object.values(raw).every((value) => value === undefined)) {
    return presentsServiceToken(request, options.internalServiceToken)
      ? { ...base, actorType: 'service' }
      : base;
  }

  // A missing secret here is a deployment misconfiguration, not a per-request
  // concern — `createServer` validates it eagerly at startup, so reaching
  // this point with `trustInternalHeaders: true` means the secret exists.
  const secret = options.internalHeaderSigningSecret;
  if (
    secret === undefined ||
    !verifySignature(secret, header(headers[INTERNAL_SIGNATURE_HEADER]), raw)
  ) {
    throw ProblemError.unauthorized(
      'Internal request-context headers are missing a valid signature.',
      { code: 'internal_headers_forged' },
    );
  }

  return {
    ...base,
    ...defined({
      actorId: raw.actorId,
      actorType: asActorType(raw.actorType),
      orgId: raw.orgId,
      orgType: asOrgType(raw.orgType),
      resellerId: raw.resellerId,
      tenantId: raw.tenantId,
      clientIp: raw.clientIp,
    }),
  };
}

/**
 * The address to record for the caller of this request: an audit event's or a
 * session's `ip` (G-113). Behind api-gateway that is the client address the
 * gateway signed into the context; the service's own `request.ip` would be the
 * gateway's. Without one (a direct call from another service, or a service
 * that does not trust internal headers) it is the connection's own address.
 */
export function clientIpOf(request: {
  readonly context: RequestContext;
  readonly ip: string;
}): string {
  return request.context.clientIp ?? request.ip;
}

/** `Authorization: Bearer <token>` matching the configured internal service token. */
function presentsServiceToken(request: FastifyRequest, token: string | undefined): boolean {
  if (token === undefined || token === '') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header(request.headers.authorization) ?? '');
  return match !== null && secretEquals(token, match[1]!);
}

function header(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === '' ? undefined : value;
}

function asActorType(value: string | undefined): ActorType | undefined {
  const allowed: readonly string[] = ['user', 'apikey', 'service', 'node'];
  return value !== undefined && allowed.includes(value) ? (value as ActorType) : undefined;
}

function asOrgType(value: string | undefined): OrgType | undefined {
  const allowed: readonly string[] = ['master', 'reseller', 'tenant'];
  return value !== undefined && allowed.includes(value) ? (value as OrgType) : undefined;
}

function defined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
