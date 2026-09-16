/**
 * A v4 UUID's hyphens stripped/reassembled — `permissions.address.context_info`
 * is `CHAR(32)` in OpenSIPs' vendored schema (S2-02), too short for a
 * hyphenated UUID (36 chars), so a trunk's id is stored this way rather than
 * truncated (collision risk). `/fs/dialplan`'s from-trunk lookup (S2-03) is
 * the other side of this same round trip: OpenSIPs' `route{}` reads
 * `context_info` back out via `check_source_address`'s AVP output and sets it
 * verbatim on `X-Trunk-Id` — this module is what turns it back into the
 * canonical trunk id `read-model.repo.ts`'s `findTrunkById` looks up by.
 */

/** `f47ac10b-58cc-4372-a567-0e02b2c3d479` -> `f47ac10b58cc4372a5670e02b2c3d479`. */
export function toContextId(trunkId: string): string {
  return trunkId.replace(/-/g, '');
}

/** The inverse of {@link toContextId} — reassembles a standard 8-4-4-4-12 UUID. */
export function fromContextId(contextId: string): string {
  return [
    contextId.slice(0, 8),
    contextId.slice(8, 12),
    contextId.slice(12, 16),
    contextId.slice(16, 20),
    contextId.slice(20),
  ].join('-');
}
