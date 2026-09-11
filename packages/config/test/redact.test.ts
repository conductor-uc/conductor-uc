import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';

import { Env } from '../src/env.js';
import { loadConfig } from '../src/load.js';
import { isSecret, redactConfig, secretVariables } from '../src/redact.js';

const schema = Type.Object({
  SERVICE_NAME: Env.string(),
  DB_PASSWORD: Env.secret(),
  TRUNK_SECRET: Env.secret(),
});

describe('redactConfig', () => {
  it('masks secrets and leaves everything else intact', () => {
    const config = loadConfig(schema, {
      env: { SERVICE_NAME: 'org-service', DB_PASSWORD: 'p4ssw0rd', TRUNK_SECRET: 's3cret' },
    });

    const redacted = redactConfig(schema, config);

    expect(redacted).toEqual({
      SERVICE_NAME: 'org-service',
      DB_PASSWORD: '[redacted]',
      TRUNK_SECRET: '[redacted]',
    });
    expect(JSON.stringify(redacted)).not.toContain('p4ssw0rd');
  });

  it('does not mutate the config it was given', () => {
    const config = loadConfig(schema, {
      env: { SERVICE_NAME: 'org-service', DB_PASSWORD: 'p4ssw0rd', TRUNK_SECRET: 's3cret' },
    });

    redactConfig(schema, config);

    expect(config.DB_PASSWORD).toBe('p4ssw0rd');
  });

  it('masks a secret regardless of its length', () => {
    const redacted = redactConfig(schema, { DB_PASSWORD: 'a' });

    expect(redacted['DB_PASSWORD']).toBe('[redacted]');
  });

  it('identifies which variables hold secrets', () => {
    expect(secretVariables(schema)).toEqual(['DB_PASSWORD', 'TRUNK_SECRET']);
    expect(isSecret(schema.properties.DB_PASSWORD)).toBe(true);
    expect(isSecret(schema.properties.SERVICE_NAME)).toBe(false);
  });
});
