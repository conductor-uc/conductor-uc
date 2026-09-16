import { NODE_TYPES } from '@cuc/callflow-ir';
import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import { InvalidFlowNameError, normalizeFlowName } from '../domain/flow.js';
import {
  FlowNotFoundError,
  FlowVersionNotFoundError,
  InvalidDraftGraphError,
  type Flow,
  type FlowRepo,
  type FlowVersionSummary,
} from '../repo/flow.repo.js';

const TenantParamsSchema = Type.Object({ tenantId: Type.String({ minLength: 1 }) });
const FlowParamsSchema = Type.Object({
  tenantId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
});

const FlowSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  currentPublishedVersionId: Type.Union([Type.String(), Type.Null()]),
});

const NodeInputSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  config: Type.Unknown(),
});
const EdgeInputSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  port: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
});
const FlowGraphSchema = Type.Object({
  entryPoints: Type.Record(Type.String(), Type.String()),
  nodes: Type.Array(NodeInputSchema),
  edges: Type.Array(EdgeInputSchema),
});

const FlowSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  currentPublishedVersionId: Type.Union([Type.String(), Type.Null()]),
  draftGraph: FlowGraphSchema,
  draftUpdatedAt: Type.String(),
});

const ValidationIssueSchema = Type.Object({
  kind: Type.String(),
  message: Type.String(),
  nodeId: Type.Optional(Type.String()),
});

const VersionSummarySchema = Type.Object({
  id: Type.String(),
  versionNumber: Type.Number(),
  publishedAt: Type.String(),
});

const CreateBodySchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }) });
const RollbackBodySchema = Type.Object({ versionNumber: Type.Number({ minimum: 1 }) });

function ctxFor(request: {
  readonly context: DbContext;
  readonly params: { readonly tenantId: string };
}): DbContext {
  return { ...request.context, tenantId: request.params.tenantId };
}

function toFlowResponse(flow: Flow) {
  return {
    id: flow.id,
    name: flow.name,
    currentPublishedVersionId: flow.currentPublishedVersionId,
    // Fastify's JSON-Schema response typing wants mutable arrays; the IR
    // package deliberately types the authored graph as readonly (05 §1.1's
    // "domain code should be pure") so this is a shallow copy at the
    // response boundary, not a sign the readonly-ness upstream was wrong.
    draftGraph: {
      entryPoints: { ...flow.draftGraph.entryPoints },
      nodes: flow.draftGraph.nodes.map((node) => ({ ...node })),
      edges: flow.draftGraph.edges.map((edge) => ({ ...edge })),
    },
    draftUpdatedAt: flow.draftUpdatedAt.toISOString(),
  };
}

function toVersionResponse(version: FlowVersionSummary) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    publishedAt: version.publishedAt.toISOString(),
  };
}

function toProblem(error: unknown): ProblemError {
  if (error instanceof InvalidFlowNameError) return ProblemError.badRequest(error.message);
  if (error instanceof FlowNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof FlowVersionNotFoundError) return ProblemError.notFound(error.message);
  if (error instanceof InvalidDraftGraphError) {
    // 422, not 400: the request body itself was well-formed JSON matching the
    // graph shape — what's invalid is the *graph*, the same distinction
    // RFC 9457 draws between a malformed request and a semantically invalid one.
    return new ProblemError(
      422,
      '/problems/invalid-draft-graph',
      'Invalid draft graph',
      'invalid_draft_graph',
      {
        detail: error.message,
        errors: error.issues.map((issue) => ({
          field: issue.nodeId ?? '',
          message: issue.message,
        })),
      },
    );
  }
  throw error;
}

/**
 * Registers `/v1/tenants/{tenantId}/flows` (S2-09; 05 §3.3).
 *
 * A flow always has exactly one mutable draft and zero or more immutable
 * published versions. `:validate` and `:publish` both run the draft through
 * `@cuc/callflow-ir`'s validator/compiler; `:publish` additionally persists
 * the result as a new version and only ever *adds* a row — no route in this
 * file ever updates or deletes a `flow_versions` row, which is what makes
 * "a published version cannot be modified" true by construction rather than
 * by convention.
 */
export function registerFlowRoutes(app: Server, flows: FlowRepo): void {
  app.get(
    '/v1/tenants/:tenantId/flows',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: {
        params: TenantParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(FlowSummarySchema) }) },
      },
    },
    async (request) => ({ rows: await flows.list(ctxFor(request)) }),
  );

  app.get(
    '/v1/tenants/:tenantId/flows/:id',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: { params: FlowParamsSchema, response: { 200: FlowSchema } },
    },
    async (request) => {
      const found = await flows.findById(ctxFor(request), request.params.id);
      if (found === undefined) throw ProblemError.notFound('No flow with that id.');
      return toFlowResponse(found);
    },
  );

  app.get(
    '/v1/tenants/:tenantId/flows/:id/versions',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: {
        params: FlowParamsSchema,
        response: { 200: Type.Object({ rows: Type.Array(VersionSummarySchema) }) },
      },
    },
    async (request) => {
      const versions = await flows.listVersions(ctxFor(request), request.params.id);
      return { rows: versions.map(toVersionResponse) };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/flows',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: { params: TenantParamsSchema, body: CreateBodySchema, response: { 201: FlowSchema } },
    },
    async (request, reply) => {
      let name: string;
      try {
        name = normalizeFlowName(request.body.name);
      } catch (error) {
        throw toProblem(error);
      }
      const created = await flows.create(ctxFor(request), name);
      return reply.status(201).send(toFlowResponse(created));
    },
  );

  app.put(
    '/v1/tenants/:tenantId/flows/:id/draft',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: { params: FlowParamsSchema, body: FlowGraphSchema, response: { 200: FlowSchema } },
    },
    async (request) => {
      try {
        const updated = await flows.updateDraft(ctxFor(request), request.params.id, request.body);
        return toFlowResponse(updated);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/flows/:id/validate',
    {
      config: { permission: 'callflow.edit', dataClass: 'config' },
      schema: {
        params: FlowParamsSchema,
        response: {
          200: Type.Object({ valid: Type.Boolean(), issues: Type.Array(ValidationIssueSchema) }),
        },
      },
    },
    async (request) => {
      try {
        const issues = await flows.validateDraft(ctxFor(request), request.params.id);
        return { valid: issues.length === 0, issues };
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/flows/:id/publish',
    {
      config: { permission: 'callflow.publish', dataClass: 'config' },
      schema: { params: FlowParamsSchema, response: { 201: VersionSummarySchema } },
    },
    async (request, reply) => {
      try {
        const version = await flows.publish(ctxFor(request), request.params.id);
        return reply.status(201).send(toVersionResponse(version));
      } catch (error) {
        throw toProblem(error);
      }
    },
  );

  app.post(
    '/v1/tenants/:tenantId/flows/:id/rollback',
    {
      config: { permission: 'callflow.publish', dataClass: 'config' },
      schema: {
        params: FlowParamsSchema,
        body: RollbackBodySchema,
        response: { 200: VersionSummarySchema },
      },
    },
    async (request) => {
      try {
        const version = await flows.rollback(
          ctxFor(request),
          request.params.id,
          request.body.versionNumber,
        );
        return toVersionResponse(version);
      } catch (error) {
        throw toProblem(error);
      }
    },
  );
}

/** Re-exported so callers building a graph by hand (tests) get the node-type list from one place. */
export { NODE_TYPES };
