import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { cryptoEnvSchema } from '@cuc/crypto';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';

/**
 * Everything this service reads from the environment.
 *
 * Validated once at startup; the process refuses to start on anything invalid
 * (09 §1). Add service-specific variables here rather than reading process.env
 * anywhere else.
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...cryptoEnvSchema.properties,
  ...httpEnvSchema.properties,

  /**
   * Shared secret for the internal, service-to-service admin-creation endpoint.
   *
   * Interim, matching the precedent in 07 §1 for FS nodes and OpenSIPs (a shared
   * per-environment token) — real service-to-service auth (mTLS or a service
   * JWT) is not built yet. Whatever calls /internal/v1 must present this as a
   * bearer token.
   */
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /** org-service, asked which org a console hostname belongs to (G-56). */
  ORG_SERVICE_URL: Env.url(),

  /** 07 §2: the access token lives 10 minutes. */
  ACCESS_TOKEN_TTL_SECONDS: Env.int({ minimum: 30, default: 600 }),
  /** 07 §2: the refresh token lives 30 days, sliding. */
  REFRESH_TOKEN_TTL_DAYS: Env.int({ minimum: 1, default: 30 }),
  /**
   * How long an MFA enrollment or verification ticket is usable. Short on
   * purpose: the ticket alone grants no access — it only lets the holder
   * attempt a second factor — but a short window still limits how long a
   * leaked ticket is worth anything.
   */
  MFA_TICKET_TTL_SECONDS: Env.int({ minimum: 30, default: 300 }),
  /**
   * How long a retired signing key is still published in the JWKS document
   * after a new one becomes current, so tokens signed just before rotation
   * keep verifying. 07 §2 says keys rotate every 90 days "with overlap" but
   * does not give a number; seven days is a reasonable default for a token
   * that itself lives only 10 minutes.
   */
  SIGNING_KEY_OVERLAP_DAYS: Env.int({ minimum: 0, default: 7 }),

  /** How long an emailed password-reset link works. */
  PASSWORD_RESET_TTL_MINUTES: Env.int({ minimum: 5, default: 60 }),
  /** How long an emailed invitation link works. */
  INVITATION_TTL_DAYS: Env.int({ minimum: 1, default: 7 }),
  /**
   * Adds `Secure` to the refresh cookie (07 §2). Turn off only for a local
   * plain-HTTP dev setup, where a browser would otherwise refuse to store it.
   */
  COOKIE_SECURE: Env.bool({ default: true }),
  /**
   * Development only: log reset and invitation tokens when no mailer is
   * running. They are credentials; leave this off everywhere real.
   */
  DEV_EXPOSE_TOKENS: Env.bool({ default: false }),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
