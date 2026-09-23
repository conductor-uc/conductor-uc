/**
 * Pure business logic for conference rooms (S2-15; 05 §3.3; `mod_conference`).
 * No DB here — `repo/conference-room.repo.ts` is where this meets actual
 * rows.
 */

const MAX_LABEL_LENGTH = 255;
// Same shape as `domain/numbering.ts`'s `NUMBER_PATTERN` (2-6 digits) — not
// imported from there since that module's exports are extension-specific
// (its own error classes, `assertNumberAvailable`); duplicated the same way
// `domain/parking-lot.ts`'s slot-range validation stands on its own instead
// of reaching into `numbering.ts`.
const NUMBER_PATTERN = /^[0-9]{2,6}$/;
// 4-8 digits, the same bound `voicemail-service`'s `domain/mailbox.ts`
// `PIN_PATTERN` uses for a mailbox PIN — no documented convention exists for
// a conference PIN specifically, so this mirrors the nearest precedent.
const PIN_PATTERN = /^[0-9]{4,8}$/;
const MIN_MAX_MEMBERS = 2;
const MAX_MAX_MEMBERS = 250;
const MAX_LAYOUT_LENGTH = 32;

export class InvalidConferenceRoomError extends Error {
  override readonly name = 'InvalidConferenceRoomError';
}

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidConferenceRoomError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

export function validateNumber(number: string): string {
  if (!NUMBER_PATTERN.test(number)) {
    throw new InvalidConferenceRoomError(`'${number}' is not a valid room number: 2-6 digits.`);
  }
  return number;
}

/** Null means no PIN is required to join — `undefined` on input is treated the same as `null`. */
export function validatePin(pin: string | null | undefined): string | null {
  if (pin === null || pin === undefined) return null;
  if (!PIN_PATTERN.test(pin)) {
    throw new InvalidConferenceRoomError('pin must be 4 to 8 digits.');
  }
  return pin;
}

/** A caller-supplied max member count, one node's worth of memory (04 §3.3's `kind: 'conf'`) — not FS-enforced elsewhere, so validated here. */
export function validateMaxMembers(maxMembers: number): number {
  if (
    !Number.isInteger(maxMembers) ||
    maxMembers < MIN_MAX_MEMBERS ||
    maxMembers > MAX_MAX_MEMBERS
  ) {
    throw new InvalidConferenceRoomError(
      `max_members must be an integer between ${String(MIN_MAX_MEMBERS)} and ${String(MAX_MAX_MEMBERS)}.`,
    );
  }
  return maxMembers;
}

/**
 * Free-form, not a fixed enum: `mod_conference`'s own video-layout names
 * (`docs/decisions.md` G-50) were not confident enough to hard-code, and
 * `video` (below) has no live effect yet anyway (this image is audio-only
 * — `008_add_conference_rooms.ts`'s own comment). Only length-bounded.
 */
export function validateLayout(layout: string | null | undefined): string | null {
  if (layout === null || layout === undefined) return null;
  const trimmed = layout.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LAYOUT_LENGTH) {
    throw new InvalidConferenceRoomError(
      `layout must be 1-${String(MAX_LAYOUT_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}
