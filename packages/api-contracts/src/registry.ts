import { Type, type Static, type TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

import { EnvelopeSchema, type EventEnvelope } from './envelope.js';
import { parseSubject } from './subjects.js';

/** One versioned event contract. */
export interface EventContract<TSchemaType extends TSchema = TSchema> {
  /**
   * Bumped only for a breaking change to `data`, which also needs a
   * dual-publish period (05 §5).
   */
  readonly schemaVersion: number;
  readonly data: TSchemaType;
  /** What the event means, for the generated catalogue. */
  readonly description?: string;
}

/** A map of event type to contract. */
export type EventDefinitions = Readonly<Record<string, EventContract>>;

export class UnknownEventTypeError extends Error {
  override readonly name = 'UnknownEventTypeError';

  constructor(type: string, known: readonly string[]) {
    super(
      `No contract registered for event type '${type}'. ` +
        `Register it in @cuc/api-contracts. Known types: ${known.join(', ') || '(none)'}.`,
    );
  }
}

export class EventValidationError extends Error {
  override readonly name = 'EventValidationError';
  readonly issues: readonly string[];

  constructor(type: string, issues: readonly string[]) {
    super(
      `Event '${type}' does not match its contract:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.issues = issues;
  }
}

/** The payload type of a registered event. */
export type PayloadOf<TDefs extends EventDefinitions, TType extends keyof TDefs> = Static<
  TDefs[TType]['data']
>;

/**
 * The part of a registry a consumer needs.
 *
 * Narrower than `EventRegistry` on purpose: that type is generic in its
 * definitions and therefore invariant, so a consumer typed against
 * `EventRegistry<EventDefinitions>` would reject every concrete registry. This
 * interface mentions no definitions, so any registry satisfies it.
 */
export interface EnvelopeValidator {
  /**
   * A property rather than a method, so callers can pass it around and invoke it
   * without tripping `unbound-method` — an assertion signature has to be reached
   * through an explicitly typed reference anyway.
   */
  readonly assertEnvelope: (envelope: unknown) => asserts envelope is EventEnvelope;
}

export interface EventRegistry<TDefs extends EventDefinitions> extends EnvelopeValidator {
  readonly definitions: TDefs;
  readonly types: readonly (keyof TDefs & string)[];
  /** The contract for one type, or throws {@link UnknownEventTypeError}. */
  contract<TType extends keyof TDefs & string>(type: TType): TDefs[TType];
  has(type: string): boolean;
  /** Throws unless `data` matches the registered contract for `type`. */
  assertPayload(type: string, data: unknown): void;
}

/**
 * Registers event contracts.
 *
 * Every event type is validated against its subject shape at registration, so a
 * typo like `pbx.extensions.create` or a subject in an unknown domain fails at
 * module load rather than the first time something publishes it.
 *
 * @example
 * ```ts
 * export const events = defineEvents({
 *   'pbx.extension.created': {
 *     schemaVersion: 1,
 *     data: Type.Object({ extensionId: Type.String(), number: Type.String() }),
 *   },
 * });
 * ```
 */
export function defineEvents<const TDefs extends EventDefinitions>(
  definitions: TDefs,
): EventRegistry<TDefs> {
  for (const type of Object.keys(definitions)) {
    parseSubject(type);
    const contract = definitions[type];
    if (contract !== undefined && contract.schemaVersion < 1) {
      throw new Error(
        `Event '${type}' has schemaVersion ${String(contract.schemaVersion)}; versions start at 1.`,
      );
    }
  }

  const types = Object.keys(definitions) as (keyof TDefs & string)[];

  const registry: EventRegistry<TDefs> = {
    definitions,
    types,

    contract(type) {
      const contract = definitions[type];
      if (contract === undefined) throw new UnknownEventTypeError(type, types);
      return contract;
    },

    has(type) {
      return Object.hasOwn(definitions, type);
    },

    assertPayload(type, data) {
      const contract = definitions[type];
      if (contract === undefined) throw new UnknownEventTypeError(type, types);
      if (Check(contract.data, data)) return;
      throw new EventValidationError(type, describe(contract.data, data));
    },

    assertEnvelope(envelope): asserts envelope is EventEnvelope {
      if (!Check(EnvelopeSchema, envelope)) {
        throw new EventValidationError('(envelope)', describe(EnvelopeSchema, envelope));
      }
      const { type, schemaVersion, data } = envelope;
      const contract = definitions[type];
      if (contract === undefined) throw new UnknownEventTypeError(type, types);

      if (schemaVersion !== contract.schemaVersion) {
        throw new EventValidationError(type, [
          `schemaVersion ${String(schemaVersion)} was published, but the registered contract is version ${String(contract.schemaVersion)}`,
        ]);
      }
      registry.assertPayload(type, data);
    },
  };

  return registry;
}

/** Merges registries, so each domain can own its own file. */
export function mergeEvents<const TDefs extends EventDefinitions[]>(
  ...registries: { [K in keyof TDefs]: EventRegistry<TDefs[K]> }
): EventRegistry<EventDefinitions> {
  const merged: Record<string, EventContract> = {};

  for (const registry of registries) {
    for (const type of registry.types) {
      if (Object.hasOwn(merged, type)) {
        throw new Error(`Event type '${type}' is registered twice.`);
      }
      merged[type] = registry.contract(type);
    }
  }
  return defineEvents(merged);
}

/** Validator output as one readable line per problem. */
function describe(schema: TSchema, value: unknown): string[] {
  return [...Errors(schema, value)].map(
    (error) => `${error.instancePath === '' ? '(root)' : error.instancePath} ${error.message}`,
  );
}

/** Re-exported so contracts are written without a direct TypeBox dependency. */
export { Type };
export type { Static, TSchema };
