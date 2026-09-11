import type { TObject } from 'typebox';

import { SECRET_KEYWORD } from './env.js';

/** Replaces every secret value, whatever its length. */
const MASK = '[redacted]';

/**
 * Returns a copy of `config` with every property the schema marks as a secret
 * replaced by `[redacted]`.
 *
 * Use this, never the raw config object, when logging effective configuration
 * at startup (09 §4: never log secrets).
 */
export function redactConfig<T extends TObject>(
  schema: T,
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = isSecret(schema.properties[key]) ? MASK : value;
  }
  return out;
}

/** True when the schema property was built with `Env.secret()`. */
export function isSecret(property: unknown): boolean {
  return (
    typeof property === 'object' &&
    property !== null &&
    (property as Record<string, unknown>)[SECRET_KEYWORD] === true
  );
}

/** Every environment variable in `schema` that holds a secret. */
export function secretVariables<T extends TObject>(schema: T): string[] {
  return Object.entries(schema.properties)
    .filter(([, property]) => isSecret(property))
    .map(([key]) => key);
}
