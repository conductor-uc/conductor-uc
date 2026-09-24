import { describe, expect, it } from 'vitest';

import { createTermsLookup } from '../src/acme-terms.js';
import { FALLBACK_TERMS_URL } from '../src/domain/acme.js';

const directory = (terms: unknown) =>
  new Response(JSON.stringify({ meta: { termsOfService: terms } }), { status: 200 });

describe('terms lookup', () => {
  it('returns the address the directory publishes, and remembers it for an hour', async () => {
    let calls = 0;
    let clock = 0;
    const lookup = createTermsLookup({
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(directory('https://letsencrypt.org/documents/LE-SA-v9.9.pdf'));
      },
      now: () => clock,
    });
    expect(await lookup.termsUrl('production')).toBe(
      'https://letsencrypt.org/documents/LE-SA-v9.9.pdf',
    );
    clock += 30 * 60_000;
    await lookup.termsUrl('production');
    expect(calls).toBe(1);
    clock += 31 * 60_000;
    await lookup.termsUrl('production');
    expect(calls).toBe(2);
  });

  it('asks the directory for the one chosen', async () => {
    const asked: string[] = [];
    const lookup = createTermsLookup({
      fetchImpl: (input) => {
        asked.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(directory('https://example.test/tos.pdf'));
      },
    });
    await lookup.termsUrl('staging');
    expect(asked).toEqual(['https://acme-staging-v02.api.letsencrypt.org/directory']);
  });

  it('falls back to the page where the agreement is published, rather than failing', async () => {
    for (const fetchImpl of [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve(new Response('nope', { status: 503 })),
      () => Promise.resolve(directory(undefined)),
      () => Promise.resolve(directory('http://not-https.test/tos')),
      () => Promise.resolve(directory('javascript:alert(1)')),
    ]) {
      expect(await createTermsLookup({ fetchImpl }).termsUrl('production')).toBe(
        FALLBACK_TERMS_URL,
      );
    }
  });
});
