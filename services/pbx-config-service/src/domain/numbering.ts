/**
 * Pure business logic for extension numbering (06: "Validates extension
 * numbering against the tenant's dial plan"). No DB here —
 * `repo/extension.repo.ts` is where this meets actual rows.
 *
 * 06 describes the full check as "no collisions with feature codes, parking
 * slots, conference numbers, or queue numbers" — but parking lots, conference
 * rooms, and queues have no owning task yet (they arrive in S2-13/14/15), so
 * there is nothing for those checks to run against today. This validates the
 * two things S1-09 actually has: the number's own shape, and collisions with
 * other extensions in the same tenant. Extending `NumberCollisionChecker`'s
 * caller with more sources is how a later stage adds its own check without
 * this module changing.
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
