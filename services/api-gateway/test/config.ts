import { loadServiceConfig, type ServiceConfig } from '../src/config.js';

/** A full, valid config for tests, with `overrides` layered on top. */
export function testConfig(overrides: Record<string, string> = {}): ServiceConfig {
  return loadServiceConfig({
    SERVICE_NAME: 'test-api-gateway',
    IDENTITY_SERVICE_URL: 'http://127.0.0.1:1',
    ORG_SERVICE_URL: 'http://127.0.0.1:1',
    PBX_CONFIG_SERVICE_URL: 'http://127.0.0.1:1',
    CALLFLOW_SERVICE_URL: 'http://127.0.0.1:1',
    VOICEMAIL_SERVICE_URL: 'http://127.0.0.1:1',
    CDR_SERVICE_URL: 'http://127.0.0.1:1',
    TRUNK_SERVICE_URL: 'http://127.0.0.1:1',
    RECORDING_SERVICE_URL: 'http://127.0.0.1:1',
    CALL_CONTROL_URL: 'http://127.0.0.1:1',
    INTERNAL_HEADER_SIGNING_SECRET: 'test-internal-header-secret',
    REDIS_URL: 'redis://127.0.0.1:1',
    // The realtime hub needs NATS, call-control and a service token; the suites
    // that test it turn it on with those (realtime.test.ts).
    REALTIME_ENABLED: 'false',
    ...overrides,
  });
}
