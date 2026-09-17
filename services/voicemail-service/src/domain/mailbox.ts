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
