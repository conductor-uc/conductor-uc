import { Env, Type } from '@cuc/config';

/**
 * The environment variables that back {@link ContextOptions}. A service opts
 * in with:
 *
 * ```ts
 * const schema = Type.Object({ ...baseEnvSchema.properties, ...httpEnvSchema.properties });
 * // ...
 * context: {
 *   trustInternalHeaders: config.TRUST_INTERNAL_HEADERS,
 *   internalHeaderSigningSecret: config.INTERNAL_HEADER_SIGNING_SECRET,
 * },
 * ```
 *
 * Kept here rather than redeclared per service so api-gateway (the one signer)
 * and every service it forwards to (the verifiers) are guaranteed to be
 * reading the same variable name for the same secret.
 */
export const httpEnvSchema = Type.Object({
  /**
   * Only trust the x-internal-* identity headers when this service is reachable
   * solely through api-gateway, which authenticates the caller and signs them.
   */
  TRUST_INTERNAL_HEADERS: Env.bool({ default: false }),
  /**
   * Verifies `x-internal-signature` (S1-08). Required whenever
   * `TRUST_INTERNAL_HEADERS` is true — `createServer` fails at startup
   * otherwise. Must be the same value api-gateway signs with.
   */
  INTERNAL_HEADER_SIGNING_SECRET: Env.optional(Env.secret()),
});
