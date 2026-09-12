import { Type } from 'typebox';
import type { TSchema } from 'typebox';

/**
 * Marks a property as holding a secret. `redactConfig` masks these, and
 * `@cuc/logger` never receives the raw value.
 */
export const SECRET_KEYWORD = 'x-config-secret';

/**
 * Option types are taken from TypeBox itself rather than restated, so every
 * JSON Schema keyword stays available and the two never drift apart.
 */
type StringOptions = NonNullable<Parameters<typeof Type.String>[0]>;
type NumberOptions = NonNullable<Parameters<typeof Type.Integer>[0]>;
type BooleanOptions = NonNullable<Parameters<typeof Type.Boolean>[0]>;
type ArrayOptions = NonNullable<Parameters<typeof Type.Array>[1]>;
type UnionOptions = NonNullable<Parameters<typeof Type.Union>[1]>;

/**
 * Schema builders for environment variables.
 *
 * Values arrive as strings and are coerced before validation, so `Env.int()`
 * accepts `"8080"` and `Env.bool()` accepts `"true"`, `"false"`, `"1"`, and
 * `"0"` (case-insensitive). Anything else is a startup failure rather than a
 * silently falsy value.
 */
export const Env = {
  /** Non-empty by default: an empty string is treated as unset by `loadConfig`. */
  string(options: StringOptions = {}) {
    return Type.String({ minLength: 1, ...options });
  },

  /** A string whose value is a secret: masked by `redactConfig`. */
  secret(options: StringOptions = {}) {
    return Type.String({ minLength: 1, ...options, [SECRET_KEYWORD]: true });
  },

  int(options: NumberOptions = {}) {
    return Type.Integer(options);
  },

  number(options: NumberOptions = {}) {
    return Type.Number(options);
  },

  port(options: NumberOptions = {}) {
    return Type.Integer({ minimum: 1, maximum: 65535, ...options });
  },

  bool(options: BooleanOptions = {}) {
    return Type.Boolean(options);
  },

  url(options: StringOptions = {}) {
    return Type.String({ minLength: 1, format: 'uri', ...options });
  },

  /** One of a fixed set of strings. */
  enum<const T extends readonly [string, ...string[]]>(values: T, options: UnionOptions = {}) {
    return Type.Union(
      values.map((value) => Type.Literal(value)),
      options,
    );
  },

  /** A comma-separated list, e.g. `CONSOLE_HOSTNAMES=a.example,b.example`. */
  list(options: ArrayOptions = {}) {
    return Type.Array(Type.String({ minLength: 1 }), options);
  },

  optional<T extends TSchema>(schema: T) {
    return Type.Optional(schema);
  },
} as const;
