import { Type, type Static } from 'typebox';

/** Who caused the event. Absent for events a system process originated. */
export const ActorSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('user'),
      Type.Literal('apikey'),
      Type.Literal('service'),
      Type.Literal('node'),
    ]),
    id: Type.String({ minLength: 1 }),
    orgId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * Which tenant and reseller the event concerns.
 *
 * Both are optional: a master-level event such as `org.reseller.created` has
 * neither, and a reseller-level one has no tenant.
 */
export const OrgContextSchema = Type.Object(
  {
    tenantId: Type.Optional(Type.String({ minLength: 1 })),
    resellerId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/**
 * The event envelope from 05 §5.
 *
 * `data` is left open here; the registry in `./registry.ts` carries the schema
 * per event type, so the envelope is validated once and the payload against its
 * own contract.
 */
export const EnvelopeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 3 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    occurredAt: Type.String({ format: 'date-time' }),
    orgContext: OrgContextSchema,
    actor: Type.Optional(ActorSchema),
    correlationId: Type.Optional(Type.String({ minLength: 1 })),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type Actor = Static<typeof ActorSchema>;
export type OrgContext = Static<typeof OrgContextSchema>;

/** An event envelope with a typed payload. */
export interface EventEnvelope<TData = unknown> {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly orgContext: OrgContext;
  readonly actor?: Actor;
  readonly correlationId?: string;
  readonly data: TData;
}
