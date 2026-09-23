/**
 * Pure business logic for extension numbering (06: "Validates extension
 * numbering against the tenant's dial plan"). No DB here —
 * `repo/extension.repo.ts` is where this meets actual rows.
 *
 * 06 describes the full check as "no collisions with feature codes, parking
 * slots, conference numbers, or queue numbers" — this still only validates
 * the two things S1-09 actually has: the number's own shape, and collisions
 * with other extensions in the same tenant. Parking lots (S2-14) and
 * conference rooms (S2-15) now exist, but each still only checks collisions
 * against its own kind (a lot's slot range against other lots', a room's
 * number against other rooms') — this module was not extended to cross-check
 * against them, or they against it, when those tasks landed (docs/decisions.md
 * G-49: 06's full cross-resource numbering-plan check remains unimplemented).
 */

// 2-6 digits: short enough to dial comfortably, long enough for a few
// thousand extensions per tenant. No fixed plan is documented anywhere in
// the architecture, so this is a deliberately simple, generous default
// rather than a guess at one.
const NUMBER_PATTERN = /^[0-9]{2,6}$/;

export class InvalidExtensionNumberError extends Error {
  override readonly name = 'InvalidExtensionNumberError';
}

export class ExtensionNumberTakenError extends Error {
  override readonly name = 'ExtensionNumberTakenError';
}

/** Validates an extension number's shape: 2-6 digits. */
export function validateExtensionNumber(number: string): string {
  if (!NUMBER_PATTERN.test(number)) {
    throw new InvalidExtensionNumberError(
      `'${number}' is not a valid extension number: 2-6 digits.`,
    );
  }
  return number;
}

/** Checked in `repo/extension.repo.ts` against a real uniqueness query. */
export function assertNumberAvailable(number: string, taken: boolean): void {
  if (taken) {
    throw new ExtensionNumberTakenError(`Extension number '${number}' is already in use.`);
  }
}
