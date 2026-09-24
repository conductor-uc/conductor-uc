import { describe, expect, it } from 'vitest';

import { NEUTRAL_BRAND, type MailBrand } from '../src/domain/brand.js';
import { renderEmail, validFor } from '../src/render.js';

const ACME: MailBrand = {
  displayName: 'Acme Voice',
  primaryColor: '#4a148c',
  accentColor: '#ffe082',
  supportEmail: 'help@acme.example',
  supportUrl: null,
  supportPhone: '+1 555 0100',
  emailFromName: 'Acme Voice',
  legalFooter: 'Acme Voice Ltd., 1 Main Street',
};

const LINK = 'https://portal.acme.example/reset/confirm?token=abc123';
const base = {
  email: 'sam@example.test',
  name: 'Sam',
  link: LINK,
  validFor: '1 hour',
} as const;

describe('renderEmail', () => {
  describe('password reset', () => {
    it('carries the reseller brand: name, color, support, and footer', async () => {
      const mail = await renderEmail({ template: 'password-reset', brand: ACME, ...base });

      expect(mail.html).toContain('Acme Voice');
      expect(mail.html).toContain('#4a148c');
      expect(mail.html).toContain('help@acme.example');
      expect(mail.html).toContain('Acme Voice Ltd., 1 Main Street');
      expect(mail.text).toContain('Acme Voice');
      expect(mail.text).toContain('Acme Voice Ltd.');
    });

    it('is neutral without a brand: no name, no logo, no product label', async () => {
      const mail = await renderEmail({
        template: 'password-reset',
        brand: NEUTRAL_BRAND,
        ...base,
      });

      expect(mail.html).not.toContain('Acme');
      expect(mail.html).not.toMatch(/<img/i);
      // Functional wording only.
      expect(mail.html).toContain('Reset your password');
      expect(mail.text.trimStart().startsWith('Reset your password')).toBe(true);
      // The grayscale primary, not any brand color.
      expect(mail.html).toContain('#455a64');
    });

    it('contains the link, the recipient, and how long it lasts', async () => {
      const mail = await renderEmail({ template: 'password-reset', brand: ACME, ...base });
      expect(mail.html).toContain(LINK);
      expect(mail.text).toContain(LINK);
      expect(mail.html).toContain('sam@example.test');
      expect(mail.html).toContain('1 hour');
    });

    it('has a plain functional subject', async () => {
      const mail = await renderEmail({ template: 'password-reset', brand: ACME, ...base });
      expect(mail.subject).toBe('Reset your password');
    });

    it('never lets a brand or user name inject markup', async () => {
      const mail = await renderEmail({
        template: 'password-reset',
        brand: { ...ACME, displayName: '<script>alert(1)</script>', legalFooter: '<b>x</b>' },
        ...base,
        email: '"><img src=x onerror=1>@example.test',
      });
      expect(mail.html).not.toContain('<script>alert(1)</script>');
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).not.toContain('<b>x</b>');
      expect(mail.html).toContain('&lt;script&gt;');
    });

    it('ignores a brand color that is not a hex value', async () => {
      const mail = await renderEmail({
        template: 'password-reset',
        brand: { ...ACME, primaryColor: 'red; background:url(http://evil)' },
        ...base,
      });
      expect(mail.html).not.toContain('evil');
      expect(mail.html).toContain('#455a64');
    });

    it('picks readable button text for a light brand color', async () => {
      const mail = await renderEmail({
        template: 'password-reset',
        brand: { ...ACME, primaryColor: '#ffe082' },
        ...base,
      });
      expect(mail.html).toMatch(/color:\s*#000000/);
    });
  });

  describe('invitation', () => {
    it('greets by name and names the account', async () => {
      const mail = await renderEmail({ template: 'invitation', brand: ACME, ...base });
      expect(mail.html).toContain('Hello Sam');
      expect(mail.html).toContain('sam@example.test');
      expect(mail.html).toContain(LINK);
      expect(mail.subject).toBe('You have been invited');
    });

    it('is neutral without a brand', async () => {
      const mail = await renderEmail({ template: 'invitation', brand: NEUTRAL_BRAND, ...base });
      expect(mail.html).not.toContain('Acme');
      expect(mail.html).not.toMatch(/<img/i);
    });
  });

  describe('two-step verification reset', () => {
    const signIn = 'https://portal.acme.example/login';
    const input = { email: 'sam@example.test', name: 'Sam', link: signIn } as const;

    it('says what happened and links to sign-in, with no expiry line', async () => {
      const mail = await renderEmail({ template: 'mfa-reset', brand: ACME, ...input });
      expect(mail.subject).toBe('Your two-step verification was reset');
      expect(mail.html).toContain('Hello Sam');
      expect(mail.html).toContain('sam@example.test');
      expect(mail.html).toContain(signIn);
      expect(mail.html).not.toContain('works for');
      expect(mail.text).toContain(signIn);
      expect(mail.text).toContain('has not changed');
    });

    it('is neutral without a brand', async () => {
      const mail = await renderEmail({
        template: 'mfa-reset',
        brand: NEUTRAL_BRAND,
        ...input,
        link: 'https://console.platform.test/login',
      });
      expect(mail.html).not.toContain('Acme');
      expect(mail.html).not.toMatch(/<img/i);
      expect(mail.html.toLowerCase()).not.toContain('conductor');
    });
  });
});

describe('validFor', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const after = (ms: number) => new Date(now.getTime() + ms);

  it('says minutes, hours, and days', () => {
    expect(validFor(after(45 * 60_000), now)).toBe('45 minutes');
    expect(validFor(after(60 * 60_000), now)).toBe('1 hour');
    expect(validFor(after(3 * 60 * 60_000), now)).toBe('3 hours');
    expect(validFor(after(7 * 24 * 60 * 60_000), now)).toBe('7 days');
  });

  it('never says zero', () => {
    expect(validFor(after(1000), now)).toBe('1 minute');
    expect(validFor(after(-5000), now)).toBe('1 minute');
  });
});

describe('the link', () => {
  it('is printed exactly, in both parts', async () => {
    const mail = await renderEmail({
      template: 'password-reset',
      brand: NEUTRAL_BRAND,
      ...base,
    });
    expect(mail.text).toContain(LINK);
    expect(mail.text).not.toContain('&#x3D;');
    expect(mail.html).toContain(`href="${LINK}"`);
  });

  it('refuses anything that is not a plain URL', async () => {
    for (const bad of [
      'javascript:alert(1)',
      'https://evil.example/"><script>',
      'https://evil.example/a b',
      '//evil.example/x',
    ]) {
      await expect(
        renderEmail({ template: 'password-reset', brand: NEUTRAL_BRAND, ...base, link: bad }),
      ).rejects.toThrow('unexpected link');
    }
  });
});

describe('renderEmail: voicemail (S5-07)', () => {
  const summary = {
    callerName: 'Pat Caller',
    callerNumber: '+15005550123',
    receivedAt: new Date('2026-09-24T19:20:30.000Z'),
    durationMs: 65_000,
    audio: 'attached',
  } as const;
  const input = {
    template: 'voicemail',
    email: 'owner@example.test',
    link: 'https://portal.acme.example/voicemail',
    voicemail: summary,
  } as const;

  it('carries the reseller brand plus caller, time, length and the attachment note', async () => {
    const mail = await renderEmail({ ...input, brand: ACME });
    expect(mail.subject).toBe('New voicemail from Pat Caller');
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain('Acme Voice');
      expect(part).toContain('Pat Caller');
      expect(part).toContain('+15005550123');
      expect(part).toContain('Thu, 24 Sep 2026 19:20 UTC');
      expect(part).toContain('1:05');
      expect(part).toContain('https://portal.acme.example/voicemail');
    }
    expect(mail.html).toContain('#4a148c');
    expect(mail.text).toContain('The recording is attached');
  });

  it('is neutral without a brand, and never names the platform', async () => {
    const mail = await renderEmail({ ...input, brand: NEUTRAL_BRAND });
    expect(mail.html).not.toContain('Acme');
    expect(mail.html).not.toMatch(/<img/i);
    expect(mail.html).toContain('#455a64');
    expect(mail.text.trimStart().startsWith('New voicemail')).toBe(true);
    for (const part of [mail.subject, mail.html, mail.text]) {
      expect(part.toLowerCase()).not.toContain('conductor');
    }
  });

  it('says so when the recording was too large to attach, and not when it was simply not asked for', async () => {
    const tooLarge = await renderEmail({
      ...input,
      brand: ACME,
      voicemail: { ...summary, audio: 'too_large' },
    });
    expect(tooLarge.html).toContain('too large to attach');
    expect(tooLarge.text).toContain('too large to attach');
    expect(tooLarge.text).not.toContain('is attached');

    const none = await renderEmail({
      ...input,
      brand: ACME,
      voicemail: { ...summary, audio: 'not_requested' },
    });
    expect(none.html).not.toContain('too large');
    expect(none.html).not.toContain('attached');
  });

  it('handles an unknown caller and a missing length', async () => {
    const mail = await renderEmail({
      ...input,
      brand: NEUTRAL_BRAND,
      voicemail: { ...summary, callerName: null, callerNumber: null, durationMs: null },
    });
    expect(mail.subject).toBe('New voicemail from an unknown caller');
    expect(mail.html).not.toContain('Length:');
  });

  it('cannot be tricked by a hostile caller name: markup is escaped, control characters and header breaks removed', async () => {
    const mail = await renderEmail({
      ...input,
      brand: ACME,
      voicemail: {
        ...summary,
        callerName: '<script>alert(1)</script>\r\nBcc: victim@example.test',
      },
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).not.toContain('<');
  });

  it('refuses to render without a summary', async () => {
    const { voicemail: _omitted, ...withoutSummary } = input;
    await expect(renderEmail({ ...withoutSummary, brand: ACME })).rejects.toThrow(/summary/);
  });
});
