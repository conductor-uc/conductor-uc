import { describe, expect, it } from 'vitest';

import {
  InvalidPolicyError,
  NO_RECORDING,
  evaluatePolicies,
  policyMatches,
  validatePolicy,
  type CallContext,
  type Policy,
} from '../src/domain/policy.js';

let counter = 0;
function policy(overrides: Partial<Policy> = {}): Policy {
  counter += 1;
  return {
    id: `p-${String(counter).padStart(3, '0')}`,
    scopeType: 'tenant',
    scopeId: 'T1',
    direction: 'any',
    action: 'record',
    announce: false,
    consentAssetId: null,
    allowOnDemand: false,
    ...overrides,
  };
}

const call = (overrides: Partial<CallContext> = {}): CallContext => ({
  direction: 'inbound',
  extensionIds: ['E1'],
  queueId: null,
  didId: null,
  ...overrides,
});

describe('policyMatches', () => {
  it('matches a tenant policy for every call, and any direction', () => {
    expect(policyMatches(policy(), call())).toBe(true);
    expect(policyMatches(policy(), call({ direction: 'internal' }))).toBe(true);
  });

  it('matches a direction-specific policy only for that direction', () => {
    const outboundOnly = policy({ direction: 'outbound' });
    expect(policyMatches(outboundOnly, call({ direction: 'outbound' }))).toBe(true);
    expect(policyMatches(outboundOnly, call({ direction: 'inbound' }))).toBe(false);
  });

  it('matches an extension policy against any extension on the call', () => {
    const forE2 = policy({ scopeType: 'extension', scopeId: 'E2' });
    expect(policyMatches(forE2, call({ extensionIds: ['E1', 'E2'] }))).toBe(true);
    expect(policyMatches(forE2, call({ extensionIds: ['E1'] }))).toBe(false);
  });

  it('matches queue and DID policies only when the call carries that queue or DID', () => {
    const queue = policy({ scopeType: 'queue', scopeId: 'Q1' });
    const did = policy({ scopeType: 'did', scopeId: 'D1' });
    expect(policyMatches(queue, call({ queueId: 'Q1' }))).toBe(true);
    expect(policyMatches(queue, call({ queueId: 'Q2' }))).toBe(false);
    expect(policyMatches(queue, call())).toBe(false);
    expect(policyMatches(did, call({ didId: 'D1' }))).toBe(true);
    expect(policyMatches(did, call({ didId: null }))).toBe(false);
  });
});

describe('evaluatePolicies precedence', () => {
  it('records nothing and announces nothing when no policy matches', () => {
    expect(evaluatePolicies([], call())).toEqual(NO_RECORDING);
    expect(
      evaluatePolicies([policy({ scopeType: 'queue', scopeId: 'Q9' })], call({ queueId: 'Q1' })),
    ).toEqual(NO_RECORDING);
  });

  it('applies the tenant default when nothing narrower matches', () => {
    const tenant = policy({ announce: true, consentAssetId: 'A1' });
    expect(evaluatePolicies([tenant], call())).toEqual({
      record: true,
      announce: true,
      consentAssetId: 'A1',
      policyId: tenant.id,
      reason: 'policy',
      allowOnDemand: false,
    });
  });

  describe('agent scope (S5-14)', () => {
    const agent = (overrides: Partial<Policy> = {}) =>
      policy({ scopeType: 'agent', scopeId: 'A1', action: 'record', ...overrides });

    it('matches only a call that agent answered', () => {
      expect(policyMatches(agent(), call({ queueId: 'Q1' }))).toBe(false);
      expect(policyMatches(agent(), call({ queueId: 'Q1', agentId: 'A2' }))).toBe(false);
      expect(policyMatches(agent(), call({ queueId: 'Q1', agentId: 'A1' }))).toBe(true);
      // The agent's own extension id among the call's extensions is not the agent scope.
      expect(policyMatches(agent(), call({ extensionIds: ['A1'] }))).toBe(false);
    });

    it('beats the queue, the DID and the tenant, and loses to an extension rule', () => {
      const queue = policy({ scopeType: 'queue', scopeId: 'Q1', action: 'no_record' });
      const did = policy({ scopeType: 'did', scopeId: 'D1', action: 'no_record' });
      const tenant = policy({ action: 'no_record' });
      const agentRule = agent();
      const answered = call({ queueId: 'Q1', didId: 'D1', agentId: 'A1', extensionIds: [] });

      const decided = evaluatePolicies([tenant, did, queue, agentRule], answered);
      expect(decided).toMatchObject({ record: true, policyId: agentRule.id });

      const extension = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
      expect(
        evaluatePolicies([queue, agentRule, extension], { ...answered, extensionIds: ['E1'] })
          .record,
      ).toBe(false);
    });

    it('at call setup (no agent yet) the queue rule decides', () => {
      const queue = policy({ scopeType: 'queue', scopeId: 'Q1', action: 'no_record' });
      expect(evaluatePolicies([queue, agent()], call({ queueId: 'Q1' })).record).toBe(false);
    });

    it('can only record, without an announcement or feature codes', () => {
      const base = {
        scopeType: 'agent' as const,
        scopeId: 'A1',
        direction: 'any' as const,
        announce: false,
      };
      expect(validatePolicy({ ...base, action: 'record' }, 'T1')).toMatchObject({
        scopeType: 'agent',
        scopeId: 'A1',
        action: 'record',
      });
      expect(() => validatePolicy({ ...base, action: 'no_record' }, 'T1')).toThrow(
        InvalidPolicyError,
      );
      expect(() => validatePolicy({ ...base, action: 'record', announce: true }, 'T1')).toThrow(
        /cannot announce/,
      );
      expect(() =>
        validatePolicy({ ...base, action: 'record', allowOnDemand: true }, 'T1'),
      ).toThrow(/feature codes/);
      expect(() => validatePolicy({ ...base, scopeId: '', action: 'record' }, 'T1')).toThrow(
        InvalidPolicyError,
      );
    });
  });

  describe('allow on demand (S5-13)', () => {
    it('comes from the deciding rule, so the narrowest rule also decides feature codes', () => {
      const tenant = policy({ action: 'no_record', allowOnDemand: true });
      const extension = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
      expect(evaluatePolicies([tenant], call()).allowOnDemand).toBe(true);
      // The extension's own rule decides now, and it does not allow on demand.
      expect(evaluatePolicies([tenant, extension], call()).allowOnDemand).toBe(false);
    });

    it('a recording rule that allows it allows pause and resume', () => {
      const tenant = policy({ action: 'record', allowOnDemand: true });
      expect(evaluatePolicies([tenant], call())).toMatchObject({
        record: true,
        allowOnDemand: true,
      });
    });

    it('a tie that refuses allows on-demand recording only if every tied rule does', () => {
      const e1 = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
      const e2 = policy({
        scopeType: 'extension',
        scopeId: 'E2',
        action: 'no_record',
        allowOnDemand: true,
      });
      const internal = call({ direction: 'internal', extensionIds: ['E1', 'E2'] });
      expect(evaluatePolicies([e1, e2], internal).allowOnDemand).toBe(false);
      expect(evaluatePolicies([{ ...e1, allowOnDemand: true }, e2], internal).allowOnDemand).toBe(
        true,
      );
    });

    it('a tie that records allows pause if any tied rule does', () => {
      const e1 = policy({ scopeType: 'extension', scopeId: 'E1', action: 'record' });
      const e2 = policy({
        scopeType: 'extension',
        scopeId: 'E2',
        action: 'record',
        allowOnDemand: true,
      });
      const internal = call({ direction: 'internal', extensionIds: ['E1', 'E2'] });
      expect(evaluatePolicies([e1, e2], internal)).toMatchObject({
        record: true,
        allowOnDemand: true,
      });
    });

    it('no matching rule allows nothing', () => {
      expect(evaluatePolicies([], call()).allowOnDemand).toBe(false);
    });

    it('validation keeps the flag, and defaults it off', () => {
      expect(
        validatePolicy(
          { scopeType: 'tenant', direction: 'any', action: 'no_record', announce: false },
          'T1',
        ).allowOnDemand,
      ).toBe(false);
      expect(
        validatePolicy(
          {
            scopeType: 'tenant',
            direction: 'any',
            action: 'no_record',
            announce: false,
            allowOnDemand: true,
          },
          'T1',
        ).allowOnDemand,
      ).toBe(true);
    });
  });

  it('ranks extension over queue over DID over tenant', () => {
    const tenant = policy({ action: 'record' });
    const did = policy({ scopeType: 'did', scopeId: 'D1', action: 'no_record' });
    const queue = policy({ scopeType: 'queue', scopeId: 'Q1', action: 'record' });
    const extension = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
    const context = call({ queueId: 'Q1', didId: 'D1' });

    expect(evaluatePolicies([tenant], context).record).toBe(true);
    expect(evaluatePolicies([tenant, did], context).record).toBe(false); // DID beats tenant
    expect(evaluatePolicies([tenant, did, queue], context).record).toBe(true); // queue beats DID
    const decided = evaluatePolicies([tenant, did, queue, extension], context);
    expect(decided.record).toBe(false); // extension beats queue
    expect(decided.policyId).toBe(extension.id);
  });

  it('lets a direction-specific policy beat "any" within the same scope', () => {
    const anyDirection = policy({ scopeType: 'queue', scopeId: 'Q1', action: 'record' });
    const inboundOnly = policy({
      scopeType: 'queue',
      scopeId: 'Q1',
      direction: 'inbound',
      action: 'no_record',
    });
    expect(evaluatePolicies([anyDirection, inboundOnly], call({ queueId: 'Q1' })).record).toBe(
      false,
    );
    expect(
      evaluatePolicies([anyDirection, inboundOnly], call({ queueId: 'Q1', direction: 'outbound' }))
        .record,
    ).toBe(true);
  });

  it('ranks scope above direction: a wider scope naming the direction does not beat a narrower "any"', () => {
    const tenantInbound = policy({ direction: 'inbound', action: 'record' });
    const extensionAny = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
    expect(evaluatePolicies([tenantInbound, extensionAny], call()).record).toBe(false);
  });

  it('resolves a tie between two extensions on the call towards not recording', () => {
    const records = policy({ scopeType: 'extension', scopeId: 'E1', action: 'record' });
    const refuses = policy({ scopeType: 'extension', scopeId: 'E2', action: 'no_record' });
    const decided = evaluatePolicies([records, refuses], call({ extensionIds: ['E1', 'E2'] }));
    expect(decided).toMatchObject({ record: false, announce: false, policyId: refuses.id });
  });

  it('announces when any tied record policy announces, using the first asset by id', () => {
    const quiet = policy({ scopeType: 'extension', scopeId: 'E1' });
    const loud = policy({
      scopeType: 'extension',
      scopeId: 'E2',
      announce: true,
      consentAssetId: 'A2',
    });
    expect(evaluatePolicies([quiet, loud], call({ extensionIds: ['E1', 'E2'] }))).toMatchObject({
      record: true,
      announce: true,
      consentAssetId: 'A2',
    });
  });

  it('gives the same answer whatever order the policies are listed in', () => {
    const a = policy({
      scopeType: 'extension',
      scopeId: 'E1',
      announce: true,
      consentAssetId: 'A1',
    });
    const b = policy({
      scopeType: 'extension',
      scopeId: 'E2',
      announce: true,
      consentAssetId: 'A2',
    });
    const context = call({ extensionIds: ['E1', 'E2'] });
    expect(evaluatePolicies([a, b], context)).toEqual(evaluatePolicies([b, a], context));
  });

  it('a narrower no_record overrides a wider announcing record', () => {
    const tenant = policy({ announce: true, consentAssetId: 'A1' });
    const extension = policy({ scopeType: 'extension', scopeId: 'E1', action: 'no_record' });
    expect(evaluatePolicies([tenant, extension], call())).toMatchObject({
      record: false,
      announce: false,
      consentAssetId: null,
    });
  });
});

describe('validatePolicy', () => {
  const base = { direction: 'any', action: 'record', announce: false } as const;

  it('fills a tenant-wide policy with the tenant id as its scope', () => {
    expect(validatePolicy({ ...base, scopeType: 'tenant' }, 'T1')).toMatchObject({
      scopeType: 'tenant',
      scopeId: 'T1',
    });
  });

  it("rejects a tenant policy that names another tenant's scope", () => {
    expect(() => validatePolicy({ ...base, scopeType: 'tenant', scopeId: 'T2' }, 'T1')).toThrow(
      InvalidPolicyError,
    );
  });

  it('requires an id for extension, queue and DID scopes', () => {
    for (const scopeType of ['extension', 'queue', 'did'] as const) {
      expect(() => validatePolicy({ ...base, scopeType }, 'T1')).toThrow(InvalidPolicyError);
      expect(() => validatePolicy({ ...base, scopeType, scopeId: '  ' }, 'T1')).toThrow(
        InvalidPolicyError,
      );
    }
  });

  it('rejects announcing on a policy that does not record, and an asset without announce', () => {
    expect(() =>
      validatePolicy({ ...base, scopeType: 'tenant', action: 'no_record', announce: true }, 'T1'),
    ).toThrow(/nothing to announce/);
    expect(() =>
      validatePolicy({ ...base, scopeType: 'tenant', consentAssetId: 'A1' }, 'T1'),
    ).toThrow(/needs announce/);
  });

  it('accepts an announcing policy with an asset', () => {
    expect(
      validatePolicy(
        { ...base, scopeType: 'queue', scopeId: 'Q1', announce: true, consentAssetId: 'A1' },
        'T1',
      ),
    ).toMatchObject({ announce: true, consentAssetId: 'A1' });
  });
});
