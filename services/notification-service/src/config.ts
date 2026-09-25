import { Env, Type, baseEnvSchema, loadConfig } from '@cuc/config';
import { dbEnvSchema } from '@cuc/db';
import { eventsEnvSchema } from '@cuc/events';
import { httpEnvSchema } from '@cuc/http';

/**
 * Everything this service reads from the environment. Validated once at
 * startup; the process refuses to start on anything invalid (09 §1).
 */
export const configSchema = Type.Object({
  ...baseEnvSchema.properties,
  ...dbEnvSchema.properties,
  ...eventsEnvSchema.properties,
  ...httpEnvSchema.properties,

  /** org-service, which resolves the brand an org's emails carry (`org-client.ts`). */
  ORG_SERVICE_URL: Env.url(),
  INTERNAL_SERVICE_TOKEN: Env.secret(),

  /**
   * identity-service, which issues the one-time token of a reset or invitation
   * link when the email is sent (G-55, `identity-client.ts`).
   */
  IDENTITY_SERVICE_URL: Env.url(),

  /** voicemail-service: mailbox email settings, message details and audio for voicemail-to-email (S5-07). */
  VOICEMAIL_SERVICE_URL: Env.url(),
  /**
   * The largest recording attached to a voicemail email, in bytes. A longer one
   * is sent without the audio and says so. Many relays refuse a message over
   * 10 to 25 MB, and base64 adds a third.
   */
  VOICEMAIL_MAX_ATTACHMENT_BYTES: Env.int({ minimum: 1, default: 10_000_000 }),

  /** The SMTP relay every email goes out through. */
  SMTP_HOST: Env.string(),
  SMTP_PORT: Env.int({ minimum: 1, maximum: 65_535, default: 587 }),
  /** Implicit TLS (port 465). Leave off for STARTTLS or a plain local relay. */
  SMTP_SECURE: Env.bool({ default: false }),
  SMTP_USER: Env.optional(Env.string()),
  SMTP_PASSWORD: Env.optional(Env.secret()),

  /**
   * The sender address of every email (S3-03). A reseller's own address is not
   * used yet: nothing records whether its domain passes SPF and DKIM (G-57), so
   * a brand only sets the display name.
   */
  PLATFORM_NOREPLY_ADDRESS: Env.string(),

  /** Where links point when the org has no reseller console hostname: `https://console.{this}`. */
  PLATFORM_BASE_DOMAIN: Env.string(),
  /** `https` in any real deployment; `http` for a local console. */
  CONSOLE_LINK_SCHEME: Env.string({ default: 'https' }),
  /**
   * Full base URL to use for links instead of any derived one (for example a
   * local console at `http://localhost:8099`). Development only.
   */
  CONSOLE_URL_OVERRIDE: Env.optional(Env.string()),
});

export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadServiceConfig(env?: Record<string, string | undefined>) {
  return loadConfig(configSchema, env === undefined ? {} : { env });
}
