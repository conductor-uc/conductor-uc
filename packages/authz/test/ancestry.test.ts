import { describe, expect, it } from 'vitest';

import { orgAncestry } from '../src/ancestry.js';
import type { OrgRef } from '../src/types.js';

const master: OrgRef = { id: 'm1', type: 'master', resellerId: null };
const resellerA: OrgRef = { id: 'r1', type: 'reseller', resellerId: null };
const resellerB: OrgRef = { id: 'r2', type: 'reseller', resellerId: null };
const tenantUnderA: OrgRef = { id: 't1', type: 'tenant', resellerId: 'r1' };
const tenantUnderB: OrgRef = { id: 't2', type: 'tenant', resellerId: 'r2' };

describe('orgAncestry', () => {
  it('master is an ancestor of everything', () => {
    expect(orgAncestry(master, master)).toBe(true);
    expect(orgAncestry(master, resellerA)).toBe(true);
    expect(orgAncestry(master, tenantUnderA)).toBe(true);
    expect(orgAncestry(master, tenantUnderB)).toBe(true);
  });

  it('every org is an ancestor of itself', () => {
    expect(orgAncestry(resellerA, resellerA)).toBe(true);
    expect(orgAncestry(tenantUnderA, tenantUnderA)).toBe(true);
  });

  it('a reseller is an ancestor of its own tenants', () => {
    expect(orgAncestry(resellerA, tenantUnderA)).toBe(true);
  });

  it('a reseller is not an ancestor of another reseller’s tenants', () => {
    expect(orgAncestry(resellerA, tenantUnderB)).toBe(false);
  });

  it('a reseller is not an ancestor of another reseller', () => {
    expect(orgAncestry(resellerA, resellerB)).toBe(false);
  });

  it('a reseller is not an ancestor of the master', () => {
    expect(orgAncestry(resellerA, master)).toBe(false);
  });

  it('a tenant is an ancestor of nothing but itself', () => {
    expect(orgAncestry(tenantUnderA, tenantUnderB)).toBe(false);
    expect(orgAncestry(tenantUnderA, resellerA)).toBe(false);
    expect(orgAncestry(tenantUnderA, master)).toBe(false);
  });
});
