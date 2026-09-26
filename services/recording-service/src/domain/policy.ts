/**
 * Recording policies and how one is chosen for a call (S5-01). Pure: no DB, no HTTP.
 *
 * ## Precedence
 *
 * A policy names a scope (the tenant, one extension, one queue agent, one queue, or one DID), a
 * direction (`inbound`, `outbound`, `internal`, or `any`), and an action
 * (`record` or `no_record`), optionally with a consent announcement. Given one
 * call, the policies that *match* it are those whose scope names something on the
 * call and whose direction is `any` or the call's own. Of those, exactly one
 * group decides:
 *
 * 1. **The narrowest scope wins.** `extension` beats `agent`, which beats `queue`, which
 *    beats `did`, which beats `tenant`. A person's own setting overrides the queue they
 *    answer, which overrides the number that was dialled, which overrides the tenant default.
 *    `agent` (S5-14) is a person too, so it sits with `extension` above `queue`: "record
 *    this agent's queue calls" is about the agent, and must win over a queue that does not
 *    record. It sits below `extension` because the extension rule is the person's own rule
 *    for every call, the agent rule only their queue calls.
 * 2. **Within a scope, a policy naming the call's direction beats `any`.**
 * 3. **Whatever still ties is resolved towards privacy:** if any tied policy says
 *    `no_record`, the call is not recorded. Ties happen only when a call carries
 *    two different scopes of the same kind (two extensions on an internal call).
 *    Of tied `record` policies, the call is announced if any of them announces.
 * 4. **No matching policy means no recording**, and no announcement.
 *
 * A `no_record` policy never announces: nothing is being recorded to consent to.
 *
 * ## On demand (S5-13)
 *
 * A policy may also *allow on demand*: the people on its calls can use feature codes to start and
 * stop a recording of their own (on a call the deciding group does not record) or to pause and
 * resume one (on a call it records). Which group decides is exactly the precedence above, so the
 * narrowest rule that applies also decides whether feature codes work. Within the deciding group:
 * a refusal allows on-demand recording only if every tied policy does (starting a recording is the
 * privacy-reducing act, so a tie leans away from it), while a recording decision allows pause and
 * resume if any tied policy does (pausing only ever records less). No matching policy allows
 * nothing.
 *
 * ## Agent scope (S5-14)
 *
 * An `agent` policy names an extension acting as a queue agent (its id is the extension's id).
 * It applies only to queue calls that agent answers, and only from the moment they answer:
 * which agent will answer is not known when the call is set up, so this is decided again when
 * the agent answers (`CallContext.agentId`), and the recording is made on the agent's leg. An
 * agent's extension-scope rules do not apply to their queue calls: the agent scope exists so a
 * tenant can choose that separately. An agent policy can only record, without an announcement
 * (the caller is already connected to the queue when the agent answers, so there is nothing to
 * play it before; announce on the queue or DID rule instead) and without feature codes (those act
 * on the caller's leg). A queue call already recorded from setup is not recorded a second time.
 */

export const POLICY_SCOPE_TYPES = ['tenant', 'extension', 'agent', 'queue', 'did'] as const;
export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number];

export const POLICY_DIRECTIONS = ['any', 'inbound', 'outbound', 'internal'] as const;
export type PolicyDirection = (typeof POLICY_DIRECTIONS)[number];

export const CALL_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const POLICY_ACTIONS = ['record', 'no_record'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** Narrower scopes have a higher rank and win. */
const SCOPE_RANK: Readonly<Record<PolicyScopeType, number>> = {
  tenant: 0,
  did: 1,
  queue: 2,
  agent: 3,
  extension: 4,
};

export interface Policy {
  readonly id: string;
  readonly scopeType: PolicyScopeType;
  /** For scope `tenant`, the tenant's own id. */
  readonly scopeId: string;
  readonly direction: PolicyDirection;
  readonly action: PolicyAction;
  readonly announce: boolean;
  readonly consentAssetId: string | null;
  /** S5-13: feature codes may start/stop (no_record) or pause/resume (record) on its calls. */
  readonly allowOnDemand: boolean;
}

/** What telephony-config knows about one call at setup time. */
export interface CallContext {
  readonly direction: CallDirection;
  /** Every extension on the call (the caller and the callee of an internal call). */
  readonly extensionIds: readonly string[];
  readonly queueId?: string | null | undefined;
  readonly didId?: string | null | undefined;
  /** S5-14: the extension that answered a queue call as its agent; only known at that answer. */
  readonly agentId?: string | null | undefined;
}

export interface Decision {
  readonly record: boolean;
  readonly announce: boolean;
  /** The media asset to play as the announcement; null plays the neutral default. */
  readonly consentAssetId: string | null;
  readonly policyId: string | null;
  readonly reason: 'policy' | 'default';
  /**
   * S5-13: whether feature codes work on this call: start and stop an on-demand recording when
   * `record` is false, pause and resume when it is true.
   */
  readonly allowOnDemand: boolean;
}

export const NO_RECORDING: Decision = {
  record: false,
  announce: false,
  consentAssetId: null,
  policyId: null,
  reason: 'default',
  allowOnDemand: false,
};

export class InvalidPolicyError extends Error {
  override readonly name = 'InvalidPolicyError';
}

export function policyMatches(policy: Policy, call: CallContext): boolean {
  if (policy.direction !== 'any' && policy.direction !== call.direction) return false;
  switch (policy.scopeType) {
    case 'tenant':
      return true;
    case 'extension':
      return call.extensionIds.includes(policy.scopeId);
    case 'agent':
      return call.agentId !== undefined && call.agentId !== null && call.agentId === policy.scopeId;
    case 'queue':
      return call.queueId !== undefined && call.queueId !== null && call.queueId === policy.scopeId;
    case 'did':
      return call.didId !== undefined && call.didId !== null && call.didId === policy.scopeId;
  }
}

/** Chooses the decision for `call` among `policies` (all of one tenant). */
export function evaluatePolicies(policies: readonly Policy[], call: CallContext): Decision {
  const matching = policies.filter((policy) => policyMatches(policy, call));
  if (matching.length === 0) return NO_RECORDING;

  const specificity = (policy: Policy): number =>
    SCOPE_RANK[policy.scopeType] * 2 + (policy.direction === 'any' ? 0 : 1);
  const top = Math.max(...matching.map(specificity));
  // Sorted by id so a tie resolves the same way on every node and every call.
  const tied = matching.filter((policy) => specificity(policy) === top).sort(byId);

  const refusal = tied.find((policy) => policy.action === 'no_record');
  if (refusal !== undefined) {
    return {
      record: false,
      announce: false,
      consentAssetId: null,
      policyId: refusal.id,
      reason: 'policy',
      allowOnDemand: tied.every((policy) => policy.allowOnDemand),
    };
  }

  const announcing = tied.filter((policy) => policy.announce);
  return {
    record: true,
    announce: announcing.length > 0,
    consentAssetId:
      announcing.find((policy) => policy.consentAssetId !== null)?.consentAssetId ?? null,
    policyId: tied[0]!.id,
    reason: 'policy',
    allowOnDemand: tied.some((policy) => policy.allowOnDemand),
  };
}

function byId(a: Policy, b: Policy): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface PolicyInput {
  readonly scopeType: PolicyScopeType;
  readonly scopeId?: string | undefined;
  readonly direction: PolicyDirection;
  readonly action: PolicyAction;
  readonly announce: boolean;
  readonly consentAssetId?: string | null | undefined;
  readonly allowOnDemand?: boolean | undefined;
}

/** A policy ready to store: `scopeId` resolved and the combination checked. */
export interface ValidPolicy {
  readonly scopeType: PolicyScopeType;
  readonly scopeId: string;
  readonly direction: PolicyDirection;
  readonly action: PolicyAction;
  readonly announce: boolean;
  readonly consentAssetId: string | null;
  readonly allowOnDemand: boolean;
}

/** Checks a proposed policy. `tenantId` is the scope id of a tenant-wide one. */
export function validatePolicy(input: PolicyInput, tenantId: string): ValidPolicy {
  let scopeId: string;
  if (input.scopeType === 'tenant') {
    if (input.scopeId !== undefined && input.scopeId !== tenantId) {
      throw new InvalidPolicyError("A tenant-wide policy cannot name another tenant's scope.");
    }
    scopeId = tenantId;
  } else {
    const named = input.scopeId?.trim() ?? '';
    if (named === '' || named.length > 36) {
      throw new InvalidPolicyError(
        `A ${input.scopeType} policy needs the ${input.scopeType}'s id.`,
      );
    }
    scopeId = named;
  }

  if (input.scopeType === 'agent') {
    if (input.action !== 'record') {
      throw new InvalidPolicyError(
        'An agent rule can only record: it applies when the agent answers a queue call.',
      );
    }
    if (input.announce) {
      throw new InvalidPolicyError(
        'An agent rule cannot announce: the caller is already connected to the queue when the ' +
          'agent answers. Announce on the queue or phone number rule instead.',
      );
    }
    if (input.allowOnDemand === true) {
      throw new InvalidPolicyError(
        'An agent rule cannot allow feature codes: its recording is on the agent’s side of the call.',
      );
    }
  }
  if (input.action === 'no_record' && input.announce) {
    throw new InvalidPolicyError('A policy that does not record has nothing to announce.');
  }
  const consentAssetId = input.consentAssetId ?? null;
  if (consentAssetId !== null && !input.announce) {
    throw new InvalidPolicyError('A consent announcement asset needs announce to be on.');
  }
  if (consentAssetId !== null && (consentAssetId.trim() === '' || consentAssetId.length > 36)) {
    throw new InvalidPolicyError('The consent announcement asset id is not valid.');
  }

  return {
    scopeType: input.scopeType,
    scopeId,
    direction: input.direction,
    action: input.action,
    announce: input.announce,
    consentAssetId,
    allowOnDemand: input.allowOnDemand ?? false,
  };
}
