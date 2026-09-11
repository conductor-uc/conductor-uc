import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

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
} as const;

/** Header carrying the caller's request id, echoed back on the response. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** W3C Trace Context header. */
export const TRACEPARENT_HEADER = 'traceparent';

export interface ContextOptions {
  /**
   * Whether to believe `x-internal-*` headers.
   *
   * Defaults to **false**. These headers are only trustworthy when the service
   * is reachable solely through api-gateway, which authenticates the caller and
   * signs them. A directly reachable service that trusted them would let any
   * client name its own tenant.
   *
   * Signature verification arrives with identity-service in S1; until then this
   * is a deployment-topology promise, so it is off unless a service opts in.
   */
  readonly trustInternalHeaders?: boolean;
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

  return {
    ...base,
    ...defined({
      actorId: header(headers[INTERNAL_CONTEXT_HEADERS.actorId]),
      actorType: asActorType(header(headers[INTERNAL_CONTEXT_HEADERS.actorType])),
      orgId: header(headers[INTERNAL_CONTEXT_HEADERS.orgId]),
      orgType: asOrgType(header(headers[INTERNAL_CONTEXT_HEADERS.orgType])),
      resellerId: header(headers[INTERNAL_CONTEXT_HEADERS.resellerId]),
      tenantId: header(headers[INTERNAL_CONTEXT_HEADERS.tenantId]),
    }),
  };
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
