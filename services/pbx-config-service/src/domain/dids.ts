/**
 * Pure business logic for DIDs (05 §3.3; S2-03's own line: "DID CRUD (E.164,
 * globally unique, bound to a trunk)"). No DB here — `repo/did.repo.ts` is
 * where this meets actual rows.
 */

// E.164: a leading '+', then 1-15 digits, the first of which is never 0
// (ITU-T E.164 §6.2.1's own grammar) — the same shape a real carrier's
// R-URI/From would present a DID in.
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * 03 §3.2's own dialplan node-type list (MVP): everything a DID can point
 * at. As of S2-08, `extension` and `ring_group` both have an owning
 * subsystem (pbx-config-service's own `extensions`/`ring_groups` tables) —
 * `queue` (S2-13), `conference_room` (S2-15), `flow` (S2-09/10), and
 * `voicemail` (S2-16) still do not exist. A DID can still be *created*
 * against any of these (the data model in 05 §3.3 names all of them), but
 * only `extension`/`ring_group` resolve to a real call today — everything
 * else is an honest miss at dial time, not a rejected write (docs/decisions.md G-25).
 */
export const DESTINATION_TYPES = [
  'extension',
  'ring_group',
  'flow',
  'queue',
  'conference',
  'voicemail',
] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export class InvalidE164Error extends Error {
  override readonly name = 'InvalidE164Error';
}

export class DidNumberTakenError extends Error {
  override readonly name = 'DidNumberTakenError';
}

export class TrunkNotFoundError extends Error {
  override readonly name = 'TrunkNotFoundError';
}

export class ExtensionDestinationNotFoundError extends Error {
  override readonly name = 'ExtensionDestinationNotFoundError';
}

/** S2-08: a DID's `ring_group` destination that does not name a real `ring_groups` row in this tenant. */
export class RingGroupDestinationNotFoundError extends Error {
  override readonly name = 'RingGroupDestinationNotFoundError';
}

/** Validates a DID's shape: E.164, e.g. `+15551234567`. */
export function validateE164(e164: string): string {
  if (!E164_PATTERN.test(e164)) {
    throw new InvalidE164Error(`'${e164}' is not a valid E.164 number, e.g. '+15551234567'.`);
  }
  return e164;
}
