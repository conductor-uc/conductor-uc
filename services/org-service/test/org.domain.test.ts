import { describe, expect, it } from 'vitest';

import {
  InvalidOrgHierarchyError,
  InvalidOrgStatusTransitionError,
  InvalidSlugError,
  assertCanResume,
  assertCanSuspend,
  assertValidParentType,
  resellerIdFor,
  validateSlug,
} from '../src/domain/org.js';

describe('validateSlug', () => {
  it('accepts a lowercase DNS label', () => {
    expect(validateSlug('acme')).toBe('acme');
    expect(validateSlug('acme-corp')).toBe('acme-corp');
    expect(validateSlug('ab')).toBe('ab');
  });

  it('accepts the maximum length of 63', () => {
    expect(validateSlug('a'.repeat(63))).toHaveLength(63);
  });

  it('rejects a single character', () => {
    expect(() => validateSlug('a')).toThrow(InvalidSlugError);
  });

  it('rejects over 63 characters', () => {
    expect(() => validateSlug('a'.repeat(64))).toThrow(InvalidSlugError);
  });

  it('rejects uppercase', () => {
    expect(() => validateSlug('Acme')).toThrow(InvalidSlugError);
  });

  it('rejects a leading or trailing hyphen', () => {
    expect(() => validateSlug('-acme')).toThrow(InvalidSlugError);
    expect(() => validateSlug('acme-')).toThrow(InvalidSlugError);
  });

  it('rejects characters outside a DNS label', () => {
    expect(() => validateSlug('acme_corp')).toThrow(InvalidSlugError);
    expect(() => validateSlug('acme.corp')).toThrow(InvalidSlugError);
    expect(() => validateSlug('acme corp')).toThrow(InvalidSlugError);
  });
});

describe('assertValidParentType', () => {
  it('accepts a reseller under the master', () => {
    expect(() => assertValidParentType('reseller', 'master')).not.toThrow();
  });

  it('accepts a tenant under a reseller', () => {
    expect(() => assertValidParentType('tenant', 'reseller')).not.toThrow();
  });

  it('rejects a reseller under a reseller', () => {
    expect(() => assertValidParentType('reseller', 'reseller')).toThrow(InvalidOrgHierarchyError);
    expect(() => assertValidParentType('reseller', 'reseller')).toThrow(/must be 'master'/);
  });

  it('rejects a reseller under a tenant', () => {
    expect(() => assertValidParentType('reseller', 'tenant')).toThrow(InvalidOrgHierarchyError);
  });

  it('rejects a tenant under the master directly — no tenant hangs under master (02 §1)', () => {
    expect(() => assertValidParentType('tenant', 'master')).toThrow(InvalidOrgHierarchyError);
    expect(() => assertValidParentType('tenant', 'master')).toThrow(/must be 'reseller'/);
  });

  it('rejects a tenant under a tenant', () => {
    expect(() => assertValidParentType('tenant', 'tenant')).toThrow(InvalidOrgHierarchyError);
  });

  it('rejects creating a second master via this path', () => {
    expect(() => assertValidParentType('master', 'master')).toThrow(InvalidOrgHierarchyError);
    expect(() => assertValidParentType('master', 'master')).toThrow(/no parent/);
  });
});

describe('resellerIdFor', () => {
  it('denormalizes the parent reseller onto a tenant', () => {
    expect(resellerIdFor('tenant', { id: 'r1', type: 'reseller' })).toBe('r1');
  });

  it('is null for a reseller, which has no owning reseller', () => {
    expect(resellerIdFor('reseller', { id: 'm1', type: 'master' })).toBeNull();
  });

  it('is null for the master', () => {
    expect(resellerIdFor('master', { id: 'x', type: 'master' })).toBeNull();
  });
});

describe('assertCanSuspend', () => {
  it('accepts an active org', () => {
    expect(() => assertCanSuspend('active')).not.toThrow();
  });

  it('rejects anything else', () => {
    for (const status of ['suspended', 'pending_deletion', 'deleted'] as const) {
      expect(() => assertCanSuspend(status)).toThrow(InvalidOrgStatusTransitionError);
    }
  });
});

describe('assertCanResume', () => {
  it('accepts a suspended org', () => {
    expect(() => assertCanResume('suspended')).not.toThrow();
  });

  it('rejects anything else', () => {
    for (const status of ['active', 'pending_deletion', 'deleted'] as const) {
      expect(() => assertCanResume(status)).toThrow(InvalidOrgStatusTransitionError);
    }
  });
});
