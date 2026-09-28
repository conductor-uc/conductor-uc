/** Pure business logic for mailboxes/PINs. No DB, no encryption here — `repo/mailbox.repo.ts` is where this meets rows and `@cuc/crypto`. */

const PIN_PATTERN = /^\d{4,8}$/;

export class InvalidPinError extends Error {
  override readonly name = 'InvalidPinError';
}

export class InvalidExtensionIdError extends Error {
  override readonly name = 'InvalidExtensionIdError';
}

/** 4-8 digits — the same range every DTMF-entered PIN in common voicemail systems uses; long enough to matter, short enough to key in on a phone. */
export function validatePin(pin: string): string {
  if (!PIN_PATTERN.test(pin)) {
    throw new InvalidPinError('PIN must be 4 to 8 digits.');
  }
  return pin;
}

export function validateExtensionId(extensionId: string): string {
  if (extensionId.trim() === '') {
    throw new InvalidExtensionIdError('extensionId is required.');
  }
  return extensionId;
}

type EmailSettingsRule =
  'notify_email_invalid' | 'email_after_invalid' | 'email_delete_requires_attachment';

export class InvalidEmailSettingsError extends Error {
  override readonly name = 'InvalidEmailSettingsError';

  /** Which rule failed: the stable problem code the route answers with (S9-02). */
  readonly code: EmailSettingsRule;

  constructor(message: string, options: { readonly code: EmailSettingsRule }) {
    super(message);
    this.code = options.code;
  }
}

export const EMAIL_AFTER_VALUES = ['keep', 'mark_read', 'delete'] as const;
export type EmailAfter = (typeof EMAIL_AFTER_VALUES)[number];

/** One plain address: no spaces, commas, angle brackets or control characters, so it cannot smuggle in a second recipient or a header. */
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export interface EmailSettings {
  readonly notifyEmail: string | null;
  readonly attachAudio: boolean;
  readonly afterEmail: EmailAfter;
}

/** Trims and checks the settings. An empty address means "no email". Deleting needs an attachment, or the audio would be gone with no copy anywhere. */
export function validateEmailSettings(input: {
  readonly notifyEmail: string | null;
  readonly attachAudio: boolean;
  readonly afterEmail: string;
}): EmailSettings {
  const trimmed = input.notifyEmail === null ? '' : input.notifyEmail.trim();
  if (trimmed.length > 254 || (trimmed !== '' && !EMAIL_PATTERN.test(trimmed))) {
    throw new InvalidEmailSettingsError('notifyEmail must be a single valid email address.', {
      code: 'notify_email_invalid',
    });
  }
  if (!(EMAIL_AFTER_VALUES as readonly string[]).includes(input.afterEmail)) {
    throw new InvalidEmailSettingsError("afterEmail must be 'keep', 'mark_read' or 'delete'.", {
      code: 'email_after_invalid',
    });
  }
  const afterEmail = input.afterEmail as EmailAfter;
  if (afterEmail === 'delete' && !input.attachAudio) {
    throw new InvalidEmailSettingsError(
      "afterEmail 'delete' requires attachAudio: the email is then the only copy.",
      {
        code: 'email_delete_requires_attachment',
      },
    );
  }
  return {
    notifyEmail: trimmed === '' ? null : trimmed,
    attachAudio: input.attachAudio,
    afterEmail,
  };
}
