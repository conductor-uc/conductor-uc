/**
 * Pure rules for pickup groups (S9-18, G-125): who may pick up whose ringing
 * calls. No DB here; `repo/pickup-group.repo.ts` is where this meets rows.
 */

const MAX_LABEL_LENGTH = 255;
/** A group of one picks up nobody's calls. */
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 200;

export class InvalidPickupGroupError extends Error {
  override readonly name = 'InvalidPickupGroupError';
}

export function validatePickupLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidPickupGroupError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

export function validatePickupMembers(ids: readonly string[]): string[] {
  if (ids.length < MIN_MEMBERS || ids.length > MAX_MEMBERS) {
    throw new InvalidPickupGroupError(
      `A pickup group needs ${String(MIN_MEMBERS)}-${String(MAX_MEMBERS)} members (got ${String(ids.length)}).`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new InvalidPickupGroupError('memberExtensionIds must not contain duplicates.');
  }
  return [...ids];
}

/**
 * The extensions whose calls [extensionId] may pick up: every other member of
 * every group it is in.
 */
export function pickupPeers(
  extensionId: string,
  groups: readonly { readonly memberExtensionIds: readonly string[] }[],
): string[] {
  const peers = new Set<string>();
  for (const group of groups) {
    if (!group.memberExtensionIds.includes(extensionId)) continue;
    for (const id of group.memberExtensionIds) if (id !== extensionId) peers.add(id);
  }
  return [...peers];
}
