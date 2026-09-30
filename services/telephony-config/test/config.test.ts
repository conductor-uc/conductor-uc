import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from '../src/config.js';

/** Every setting telephony-config requires, with plausible values. */
const REQUIRED: Record<string, string> = {
  SERVICE_NAME: 'telephony-config',
  DB_USER: 'telephony_config',
  DB_PASSWORD: 'x',
  DB_NAME: 'telephony_config',
  OPENSIPS_DB_USER: 'opensips',
  OPENSIPS_DB_PASSWORD: 'x',
  OPENSIPS_MI_URL: 'http://127.0.0.1:8888/mi',
  OPENSIPS_SIP_URI: '203.0.113.10:5060',
  SELF_URL: 'http://127.0.0.1:18080',
  FS_XML_CURL_TOKEN: 'x',
  INTERNAL_SERVICE_TOKEN: 'x',
  REDIS_URL: 'redis://127.0.0.1:6379',
  STORAGE_ACCESS_KEY_ID: 'x',
  STORAGE_SECRET_ACCESS_KEY: 'x',
  STORAGE_BUCKET_PREFIX: 'v1',
  CALL_CONTROL_URL: 'http://call-control:8080',
  CALLFLOW_SERVICE_URL: 'http://callflow-service:8080',
  ORG_SERVICE_URL: 'http://org-service:8080',
  PBX_CONFIG_SERVICE_URL: 'http://pbx-config-service:8080',
  RECORDING_SERVICE_URL: 'http://recording-service:8080',
  TRUNK_SERVICE_URL: 'http://trunk-service:8080',
  VOICEMAIL_SERVICE_URL: 'http://voicemail-service:8080',
};

describe('telephony-config settings', () => {
  it('starts on a single edge, with no cluster sharing tag set', () => {
    expect(loadServiceConfig(REQUIRED).OPENSIPS_CLUSTER_SHTAG).toBe('');
  });

  it('keeps the edge pair sharing tag when one is set (S4-06)', () => {
    expect(
      loadServiceConfig({ ...REQUIRED, OPENSIPS_CLUSTER_SHTAG: 'vip/1' }).OPENSIPS_CLUSTER_SHTAG,
    ).toBe('vip/1');
  });
});
