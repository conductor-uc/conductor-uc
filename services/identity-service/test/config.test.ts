import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from '../src/config.js';

/** The smallest environment a deployment must provide. */
const REQUIRED = {
  SERVICE_NAME: 'identity-service',
  DB_HOST: 'db',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'identity_service',
  NATS_SERVERS: 'nats://nats:4222',
  CRYPTO_KEKS: `1:${randomBytes(32).toString('base64')}`,
  CRYPTO_KEK_CURRENT: '1',
  INTERNAL_SERVICE_TOKEN: 'token',
  ORG_SERVICE_URL: 'http://org-service:8080',
};

describe('loadServiceConfig', () => {
  it('invitations last 72 hours by default (G-55)', () => {
    expect(loadServiceConfig(REQUIRED).INVITATION_TTL_HOURS).toBe(72);
  });

  it('takes a different lifetime in hours, and no longer reads the old days setting', () => {
    expect(
      loadServiceConfig({ ...REQUIRED, INVITATION_TTL_HOURS: '24' }).INVITATION_TTL_HOURS,
    ).toBe(24);
    const config = loadServiceConfig({ ...REQUIRED, INVITATION_TTL_DAYS: '7' });
    expect(config.INVITATION_TTL_HOURS).toBe(72);
    expect('INVITATION_TTL_DAYS' in config).toBe(false);
  });

  it('keeps outbox rows and stream messages for 7 days by default (G-55)', () => {
    const config = loadServiceConfig(REQUIRED);
    expect(config.OUTBOX_RETENTION_DAYS).toBe(7);
    expect(config.NATS_STREAM_MAX_AGE_DAYS).toBe(7);
  });
});
