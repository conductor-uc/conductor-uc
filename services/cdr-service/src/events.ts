import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (S2-18; 06's cdr-service section:
 * "`cdr.record.created`"). Thin, like every other event in this codebase
 * (06: "events stay thin") — a consumer that needs the full record calls
 * `GET /v1/tenants/:t/cdrs/:id` rather than trusting a payload.
 */
export const cdrEvents = defineEvents({
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
