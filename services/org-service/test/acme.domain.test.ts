import { describe, expect, it } from 'vitest';

import {
  ACME_DIRECTORY_URLS,
  InvalidContactEmailError,
  acmeReady,
  validateContactEmail,
} from '../src/domain/acme.js';

describe('validateContactEmail', () => {
  it('trims and lower-cases one address, and treats nothing as no address', () => {
    expect(validateContactEmail('  Certs@Example.COM ')).toBe('certs@example.com');
    expect(validateContactEmail(null)).toBeNull();
    expect(validateContactEmail(undefined)).toBeNull();
    expect(validateContactEmail('   ')).toBeNull();
  });

  it.each([
    'nope',
    'a@b',
    'a b@example.com',
    'a@example.com, b@example.com',
    '<a@example.com>',
    '@example.com',
  ])('refuses %j', (value) => {
    expect(() => validateContactEmail(value)).toThrow(InvalidContactEmailError);
  });
});

describe('acmeReady', () => {
  it('needs an address and the terms agreed for the directory chosen now', () => {
    expect(
      acmeReady({
        contactEmail: 'a@example.com',
        directory: 'production',
        termsAgreedDirectory: 'production',
      }),
    ).toBe(true);
    expect(
      acmeReady({
        contactEmail: null,
        directory: 'production',
        termsAgreedDirectory: 'production',
      }),
    ).toBe(false);
    expect(
      acmeReady({
        contactEmail: 'a@example.com',
        directory: 'production',
        termsAgreedDirectory: null,
      }),
    ).toBe(false);
    expect(
      acmeReady({
        contactEmail: 'a@example.com',
        directory: 'production',
        termsAgreedDirectory: 'staging',
      }),
    ).toBe(false);
  });
});

describe('directories', () => {
  it("are Let's Encrypt's own, over HTTPS", () => {
    expect(ACME_DIRECTORY_URLS.production).toBe('https://acme-v02.api.letsencrypt.org/directory');
    expect(ACME_DIRECTORY_URLS.staging).toBe(
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  });
});
