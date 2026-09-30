/**
 * S5-06 (O-3): who is transcribed, and by which engine. Transcription is off by default: a
 * tenant opts in and picks the engine, and a mailbox either follows the tenant (`inherit`) or
 * is turned on or off by itself. No DB here.
 */

/** The engines an operator can configure: the platform's hosted default, or one run in-house. */
export const ENGINES = ['default', 'self_hosted'] as const;
export type Engine = (typeof ENGINES)[number];

export const MAILBOX_MODES = ['inherit', 'on', 'off'] as const;
export type MailboxTranscription = (typeof MAILBOX_MODES)[number];

export interface TenantTranscription {
  readonly enabled: boolean;
  readonly engine: Engine;
}

/** Off, on the default engine: what a tenant that never chose has. */
export const TENANT_DEFAULT: TenantTranscription = { enabled: false, engine: 'default' };

export class InvalidTranscriptionSettingsError extends Error {
  override readonly name = 'InvalidTranscriptionSettingsError';
}

export function isEngine(value: unknown): value is Engine {
  return (ENGINES as readonly unknown[]).includes(value);
}

export function isMailboxTranscription(value: unknown): value is MailboxTranscription {
  return (MAILBOX_MODES as readonly unknown[]).includes(value);
}

/**
 * The engine a new message of this mailbox is sent to, or null when it is not transcribed. A
 * mailbox turned on uses the tenant's engine even when the tenant as a whole is off. An engine
 * the operator has not configured transcribes nothing.
 */
export function engineFor(
  tenant: TenantTranscription,
  mailbox: MailboxTranscription,
  available: readonly Engine[],
): Engine | null {
  const on = mailbox === 'on' || (mailbox === 'inherit' && tenant.enabled);
  if (!on || !available.includes(tenant.engine)) return null;
  return tenant.engine;
}
