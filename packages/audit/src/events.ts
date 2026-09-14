import { Type, defineEvents } from '@cuc/api-contracts';

/** Written out rather than derived from `DATA_CLASSES.map(...)` — TypeBox can't infer a literal union through `.map`. */
const DataClassSchema = Type.Union([
  Type.Literal('config'),
  Type.Literal('private'),
  Type.Literal('usage'),
  Type.Literal('secret'),
]);

/**
 * The one AUDIT-stream event type. Unlike a domain stream (`org.tenant.created`,
 * `org.tenant.updated`, …), audit rows are structurally identical regardless of
 * what caused them — the `action` field inside `data` is what distinguishes
 * them, not the event type — so there is exactly one type here rather than one
 * per action.
 */
export const auditEvents = defineEvents({
  'audit.event.recorded': {
    schemaVersion: 1,
    description:
      'A write, a private/secret read, an authentication event, or a monitoring action (07 §4).',
    data: Type.Object({
      actorType: Type.Union([
        Type.Literal('user'),
        Type.Literal('apikey'),
        Type.Literal('service'),
        Type.Literal('node'),
      ]),
      actorId: Type.String({ minLength: 1 }),
      actorOrgId: Type.String({ minLength: 1 }),
      targetOrgId: Type.Optional(Type.String({ minLength: 1 })),
      action: Type.String({ minLength: 1 }),
      resource: Type.String({ minLength: 1 }),
      dataClass: DataClassSchema,
      reason: Type.Optional(Type.String()),
      ip: Type.Optional(Type.String()),
      requestId: Type.Optional(Type.String()),
    }),
  },
});
