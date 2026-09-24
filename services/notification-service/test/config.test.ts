import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from '../src/config.js';

/** The smallest environment a deployment must provide. */
const REQUIRED = {
  SERVICE_NAME: 'notification-service',
  DB_HOST: 'db',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'notification_service',
  NATS_SERVERS: 'nats://nats:4222',
  ORG_SERVICE_URL: 'http://org-service:8080',
  INTERNAL_SERVICE_TOKEN: 'token',
  SMTP_HOST: 'mail',
  PLATFORM_NOREPLY_ADDRESS: 'noreply@platform.test',
  PLATFORM_BASE_DOMAIN: 'platform.test',
};

describe('loadServiceConfig', () => {
  it('starts with only the required settings: no SMTP login, no console override', () => {
    const config = loadServiceConfig(REQUIRED);

    expect(config.SMTP_PORT).toBe(587);
    expect(config.SMTP_SECURE).toBe(false);
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.SMTP_PASSWORD).toBeUndefined();
    expect(config.CONSOLE_URL_OVERRIDE).toBeUndefined();
    expect(config.CONSOLE_LINK_SCHEME).toBe('https');
  });

  it('takes SMTP credentials and a console override when given', () => {
    const config = loadServiceConfig({
      ...REQUIRED,
      SMTP_USER: 'apikey',
      SMTP_PASSWORD: 'secret',
      SMTP_SECURE: 'true',
      CONSOLE_URL_OVERRIDE: 'http://localhost:8099',
    });

    expect(config.SMTP_USER).toBe('apikey');
    expect(config.SMTP_PASSWORD).toBe('secret');
    expect(config.SMTP_SECURE).toBe(true);
    expect(config.CONSOLE_URL_OVERRIDE).toBe('http://localhost:8099');
  });

  it('refuses to start without a sender address', () => {
    const { PLATFORM_NOREPLY_ADDRESS: _omitted, ...rest } = REQUIRED;
    expect(() => loadServiceConfig(rest)).toThrow(/PLATFORM_NOREPLY_ADDRESS/);
  });
});
