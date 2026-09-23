import { DESTINATION_TYPES, type DestinationType } from './dids.js';

/**
 * Pure business logic for parking lots (S2-14; 05 §3.3; `mod_valet_parking`).
 * No DB here — `repo/parking-lot.repo.ts` is where this meets actual rows.
 */

const MAX_LABEL_LENGTH = 255;
const MIN_SLOT = 0;
const MAX_SLOT = 999_999;
const MAX_LOT_SIZE = 1000;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 3600;

export class InvalidParkingLotError extends Error {
  override readonly name = 'InvalidParkingLotError';
}

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidParkingLotError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

/** Both bounds inclusive, `slotStart <= slotEnd` — the dialable slot range this lot claims. */
export function validateSlotRange(
  slotStart: number,
  slotEnd: number,
): { start: number; end: number } {
  if (!Number.isInteger(slotStart) || slotStart < MIN_SLOT || slotStart > MAX_SLOT) {
    throw new InvalidParkingLotError(
      `slot_start must be an integer between ${String(MIN_SLOT)} and ${String(MAX_SLOT)}.`,
    );
  }
  if (!Number.isInteger(slotEnd) || slotEnd < MIN_SLOT || slotEnd > MAX_SLOT) {
    throw new InvalidParkingLotError(
      `slot_end must be an integer between ${String(MIN_SLOT)} and ${String(MAX_SLOT)}.`,
    );
  }
  if (slotEnd < slotStart) {
    throw new InvalidParkingLotError('slot_end must be greater than or equal to slot_start.');
  }
  if (slotEnd - slotStart + 1 > MAX_LOT_SIZE) {
    throw new InvalidParkingLotError(`A lot cannot span more than ${String(MAX_LOT_SIZE)} slots.`);
  }
  return { start: slotStart, end: slotEnd };
}

export function validateTimeoutSeconds(seconds: number): number {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_TIMEOUT_SECONDS ||
    seconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new InvalidParkingLotError(
      `timeout_seconds must be an integer between ${String(MIN_TIMEOUT_SECONDS)} and ${String(MAX_TIMEOUT_SECONDS)}.`,
    );
  }
  return seconds;
}

/**
 * Same shape as `domain/queue.ts`'s `validateNoAgentDestination` — an
 * optional DID-shaped fallback destination. Unlike a ring group's no-answer
 * destination or a queue's no-agent overflow, leaving this unset is not "no
 * fallback, just stop" — `mod_valet_parking`'s own documented default rings
 * the slot back to whoever parked the call, which this deliberately does not
 * reimplement (it is FS's own behavior, not a decision this service makes).
 */
export function validateReturnDestination(
  type: string | null | undefined,
  id: string | null | undefined,
): { type: DestinationType; id: string } | null {
  if (type === null || type === undefined) {
    if (id !== null && id !== undefined) {
      throw new InvalidParkingLotError(
        'return_destination_id was given without return_destination_type.',
      );
    }
    return null;
  }
  if (id === null || id === undefined || id.trim().length === 0) {
    throw new InvalidParkingLotError(
      'return_destination_type was given without return_destination_id.',
    );
  }
  if (!(DESTINATION_TYPES as readonly string[]).includes(type)) {
    throw new InvalidParkingLotError(
      `return_destination_type must be one of: ${DESTINATION_TYPES.join(', ')} (got '${type}').`,
    );
  }
  return { type: type as DestinationType, id };
}

/** Two lots in the same tenant must not share a slot number — otherwise dialing a slot would be ambiguous. */
export function slotRangesOverlap(
  a: { readonly start: number; readonly end: number },
  b: { readonly start: number; readonly end: number },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}
