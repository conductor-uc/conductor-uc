/**
 * S2-04's own line: "Caller ID comes from the extension, DID, or trunk
 * policy." Three tiers, checked in that order — the first one with
 * anything set wins:
 *
 * 1. The calling extension's own `caller_id_name`/`caller_id_number`
 *    override (pbx-config-service's own `extensions` columns, S1-09 —
 *    unused until now, G-22's own text names this task as the one that
 *    defines the precedence).
 * 2. A DID the tenant has bound to that same extension as its destination
 *    (`readModel.findDidByDestination`) — "the DID" 05 §3.4's own wording
 *    names as a caller-ID source only makes sense this way: a DID is an
 *    inbound number, so the only way it can *supply* an outbound caller ID
 *    is by being the number this extension is reachable at.
 * 3. The trunk's own `caller_id_policy` (G-22's `{name, number}` shape,
 *    S2-01) — the outbound route's first/primary trunk's policy, since a
 *    route can list more than one and the policy is not itself ordered.
 *
 * No DB here — `routes/fs.routes.ts` is where this meets the actual
 * extension/DID/trunk lookups.
 */

export interface CallerId {
  readonly name: string | null;
  readonly number: string | null;
}

function isSet(callerId: CallerId | null | undefined): callerId is CallerId {
  return (
    callerId !== null &&
    callerId !== undefined &&
    (callerId.name !== null || callerId.number !== null)
  );
}

export function resolveOutboundCallerId(
  extensionCallerId: CallerId | null,
  didCallerId: CallerId | null,
  trunkCallerId: CallerId | null,
): CallerId | null {
  if (isSet(extensionCallerId)) return extensionCallerId;
  if (isSet(didCallerId)) return didCallerId;
  if (isSet(trunkCallerId)) return trunkCallerId;
  return null;
}
