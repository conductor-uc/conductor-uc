import { ORG_DELETED_EVENTS } from '@cuc/events';
import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (S2-18; 06's cdr-service section:
 * "`cdr.record.created`"). Thin, like every other event in this codebase
 * (06: "events stay thin") — a consumer that needs the full record calls
 * `GET /v1/tenants/:t/cdrs/:id` rather than trusting a payload.
 */
export const cdrEvents = defineEvents({
  /**
   * Mirrors call-control's contract (S4-04): a leg lost with its media node,
   * which becomes a `node_failure` call record here.
   */
  'call.lost': {
    schemaVersion: 1,
    description: 'A call leg was lost with the media node that carried it.',
    data: Type.Object({
      callUuid: Type.String({ minLength: 1 }),
      nodeId: Type.String({ minLength: 1 }),
      direction: Type.Union([Type.Literal('inbound'), Type.Literal('outbound')]),
      startedAt: Type.Integer({ minimum: 0 }),
      answeredAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      detectedAt: Type.Integer({ minimum: 0 }),
      from: Type.String(),
      to: Type.String(),
      extension: Type.Union([Type.String(), Type.Null()]),
      sipCallId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
  },
  // S1-16 (G-11): org-service's deletions, which this service acts on.
  ...ORG_DELETED_EVENTS,
  'cdr.record.created': {
    schemaVersion: 1,
    description: 'A CDR was ingested and normalized to CDR v1.',
    data: Type.Object({
      cdrId: Type.String({ minLength: 1 }),
      tenantId: Type.String({ minLength: 1 }),
    }),
  },
  /**
   * `POST /v1/tenants/:t/cdr-exports`'s own async trigger — this service
   * both publishes and consumes this event (`consumers/export.consumer.ts`),
   * the same "outbox decouples the HTTP response from the actual work"
   * story every other async job in this codebase follows
   * (`pbx.media_asset.finalize_requested` is the nearest precedent, though
   * that one crosses a service boundary and this one does not).
   */
  'cdr.export_requested': {
    schemaVersion: 1,
    description: 'A tenant requested an async CSV export of their CDRs.',
    data: Type.Object({
      exportId: Type.String({ minLength: 1 }),
      tenantId: Type.String({ minLength: 1 }),
    }),
  },
});
