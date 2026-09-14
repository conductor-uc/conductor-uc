import { describe, expect, it } from 'vitest';

import {
  locatePlatformObject,
  locateTenantObject,
  platformBucketName,
  sharedBucketName,
  tenantBucketName,
  tenantShortId,
} from '../src/bucket-naming.js';

const TENANT_ID = '018f5a2e-7b1c-7c3a-9d4e-1234567890ab';

describe('tenantShortId', () => {
  it('strips hyphens and lowercases', () => {
    expect(tenantShortId(TENANT_ID)).toBe('018f5a2e7b1c7c3a9d4e1234567890ab');
  });

  it('is deterministic', () => {
    expect(tenantShortId(TENANT_ID)).toBe(tenantShortId(TENANT_ID));
  });

  it('is bucket-name-safe: lowercase hex only', () => {
    expect(tenantShortId(TENANT_ID)).toMatch(/^[0-9a-f]+$/);
  });
});

describe('tenantBucketName', () => {
  it('is {prefix}-t-{shortId}', () => {
    expect(tenantBucketName('cuc-dev', TENANT_ID)).toBe(
      'cuc-dev-t-018f5a2e7b1c7c3a9d4e1234567890ab',
    );
  });

  it('stays within the 63-character S3 bucket-name limit for the documented max prefix (28 chars)', () => {
    const maxPrefix = 'a'.repeat(28);
    expect(tenantBucketName(maxPrefix, TENANT_ID).length).toBeLessThanOrEqual(63);
  });
});

describe('sharedBucketName / platformBucketName', () => {
  it('are fixed, tenant-independent names', () => {
    expect(sharedBucketName('cuc-dev')).toBe('cuc-dev-shared');
    expect(platformBucketName('cuc-dev')).toBe('cuc-dev-platform');
  });
});

describe('locateTenantObject', () => {
  it("bucket-per-tenant: resolves to the tenant's own bucket, key unchanged", () => {
    expect(
      locateTenantObject('bucket-per-tenant', 'cuc-dev', TENANT_ID, 'recordings/a.wav'),
    ).toEqual({
      bucket: 'cuc-dev-t-018f5a2e7b1c7c3a9d4e1234567890ab',
      key: 'recordings/a.wav',
    });
  });

  it('prefix-per-tenant: resolves to the shared bucket, key prefixed with the tenant', () => {
    expect(
      locateTenantObject('prefix-per-tenant', 'cuc-dev', TENANT_ID, 'recordings/a.wav'),
    ).toEqual({
      bucket: 'cuc-dev-shared',
      key: 't-018f5a2e7b1c7c3a9d4e1234567890ab/recordings/a.wav',
    });
  });

  it('two tenants never collide in prefix-per-tenant mode', () => {
    const otherTenant = '00000000-0000-7000-8000-000000000001';
    const a = locateTenantObject('prefix-per-tenant', 'cuc-dev', TENANT_ID, 'x.txt');
    const b = locateTenantObject('prefix-per-tenant', 'cuc-dev', otherTenant, 'x.txt');
    expect(a.bucket).toBe(b.bucket);
    expect(a.key).not.toBe(b.key);
  });
});

describe('locatePlatformObject', () => {
  it('always resolves to the platform bucket, regardless of mode', () => {
    expect(locatePlatformObject('cuc-dev', 'brand/r1/logo.svg')).toEqual({
      bucket: 'cuc-dev-platform',
      key: 'brand/r1/logo.svg',
    });
  });
});
