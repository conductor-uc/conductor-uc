import { describe, expect, it } from 'vitest';

import {
  InvalidCertificateError,
  RENEW_BEFORE_MS,
  inspectCertificate,
  renewalDue,
  retryDelayMs,
  sipProxyHostname,
} from '../src/domain/certificates.js';
import { makeCertificate } from './certs.js';

describe('sipProxyHostname', () => {
  it('is sip. in front of the base domain, lower-cased', () => {
    expect(sipProxyHostname('voice.Reseller-Brand.com')).toBe('sip.voice.reseller-brand.com');
    expect(sipProxyHostname(' platform.test ')).toBe('sip.platform.test');
  });
});

describe('renewalDue', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('is due when nothing is held, inside the window, or past expiry', () => {
    expect(renewalDue(null, now)).toBe(true);
    expect(renewalDue(new Date(now.getTime() + RENEW_BEFORE_MS - 1000), now)).toBe(true);
    expect(renewalDue(new Date(now.getTime() - 1000), now)).toBe(true);
  });
  it('is not due with time to spare', () => {
    expect(renewalDue(new Date(now.getTime() + RENEW_BEFORE_MS + 60_000), now)).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off from a minute to a day and stays there', () => {
    const minute = 60_000;
    expect(retryDelayMs(1)).toBe(minute);
    expect(retryDelayMs(2)).toBe(5 * minute);
    expect(retryDelayMs(3)).toBe(30 * minute);
    expect(retryDelayMs(6)).toBe(24 * 60 * minute);
    expect(retryDelayMs(50)).toBe(24 * 60 * minute);
    expect(retryDelayMs(0)).toBe(minute);
  });
});

describe('inspectCertificate', () => {
  const good = makeCertificate(['sip.reseller.test', '*.wild.test'], 60);

  it('accepts a certificate for the name that goes with its key, and reports its validity', () => {
    const facts = inspectCertificate(good.certificate, good.key, 'sip.reseller.test');
    expect(facts.notAfter.getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 60 * 60 * 1000);
    expect(facts.notBefore.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('accepts a wildcard name it covers', () => {
    expect(() => inspectCertificate(good.certificate, good.key, 'a.wild.test')).not.toThrow();
  });

  it('refuses a name the certificate does not cover', () => {
    expect(() => inspectCertificate(good.certificate, good.key, 'sip.other.test')).toThrow(
      InvalidCertificateError,
    );
  });

  it('refuses a key that belongs to another certificate', () => {
    const other = makeCertificate(['sip.reseller.test']);
    expect(() => inspectCertificate(good.certificate, other.key, 'sip.reseller.test')).toThrow(
      /does not belong/,
    );
  });

  it('refuses text that is not PEM, and an expired certificate', () => {
    expect(() => inspectCertificate('nope', good.key, 'sip.reseller.test')).toThrow(
      /not valid PEM/,
    );
    expect(() => inspectCertificate(good.certificate, 'nope', 'sip.reseller.test')).toThrow(
      /not valid PEM/,
    );
    const later = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    expect(() =>
      inspectCertificate(good.certificate, good.key, 'sip.reseller.test', later),
    ).toThrow(/expired/);
  });
});
