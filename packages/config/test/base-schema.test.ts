import { describe, expect, it } from 'vitest';

import { baseEnvSchema } from '../src/base-schema.js';
import { ConfigError } from '../src/errors.js';
import { loadConfig } from '../src/load.js';

describe('baseEnvSchema', () => {
  it('starts a service from SERVICE_NAME alone', () => {
    const config = loadConfig(baseEnvSchema, { env: { SERVICE_NAME: 'org-service' } });

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      SERVICE_NAME: 'org-service',
      SERVICE_VERSION: '0.0.0',
      LOG_LEVEL: 'info',
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: 8080,
      SHUTDOWN_GRACE_MS: 10_000,
    });
  });

  it('refuses to start without SERVICE_NAME', () => {
    expect(() => loadConfig(baseEnvSchema, { env: {} })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      loadConfig(baseEnvSchema, { env: { SERVICE_NAME: 'x', NODE_ENV: 'staging' } }),
    ).toThrow(/NODE_ENV: must be one of: development, test, production/);
  });

  it('leaves tracing off when no OTLP endpoint is configured', () => {
    const config = loadConfig(baseEnvSchema, { env: { SERVICE_NAME: 'x' } });

    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
});
