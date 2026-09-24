import { describe, expect, it } from 'vitest';

import {
  InvalidMacError,
  generateProvisioningToken,
  globalCredentialMatches,
  globalProvisioningCredential,
  hashProvisioningToken,
  normalizeMac,
  parseBasicAuth,
  parseYealinkFile,
  renderYealinkCommonConfig,
  renderYealinkConfig,
  tokenMatches,
} from '../src/domain/provisioning.js';

describe('normalizeMac', () => {
  it.each(['00:15:65:AA:BB:CC', '00-15-65-aa-bb-cc', '0015.65aa.bbcc', ' 001565AABBCC '])(
    'reads %s',
    (input) => {
      expect(normalizeMac(input)).toBe('001565aabbcc');
    },
  );

  it.each(['', '00:15:65:aa:bb', '00:15:65:aa:bb:cc:dd', '00:15:65:aa:bb:zz'])(
    'refuses %j',
    (input) => {
      expect(() => normalizeMac(input)).toThrow(InvalidMacError);
    },
  );
});

describe('provisioning tokens', () => {
  it('are long, distinct, and header safe', () => {
    const a = generateProvisioningToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateProvisioningToken()).not.toBe(a);
  });

  it('match only their own hash, and never when none is stored', () => {
    const token = generateProvisioningToken();
    const hash = hashProvisioningToken(token);
    expect(tokenMatches(hash, token)).toBe(true);
    expect(tokenMatches(hash, `${token}x`)).toBe(false);
    expect(tokenMatches(hash, '')).toBe(false);
    expect(tokenMatches(null, token)).toBe(false);
  });
});

describe('parseBasicAuth', () => {
  const header = (text: string) => `Basic ${Buffer.from(text).toString('base64')}`;

  it('reads a user and a password that may contain a colon', () => {
    expect(parseBasicAuth(header('dev-1:pa:ss'))).toEqual({ username: 'dev-1', password: 'pa:ss' });
  });

  it('refuses anything else', () => {
    expect(parseBasicAuth(undefined)).toBeUndefined();
    expect(parseBasicAuth('Bearer abc')).toBeUndefined();
    expect(parseBasicAuth(header('nocolon'))).toBeUndefined();
    expect(parseBasicAuth(header(':nouser'))).toBeUndefined();
  });
});

describe('parseYealinkFile', () => {
  it("reads a phone's own file and the model-wide one, in any case", () => {
    expect(parseYealinkFile('001565aabbcc.cfg')).toEqual({ kind: 'mac', mac: '001565aabbcc' });
    expect(parseYealinkFile('001565AABBCC.CFG')).toEqual({ kind: 'mac', mac: '001565aabbcc' });
    expect(parseYealinkFile('y000000000028.cfg')).toEqual({ kind: 'common' });
  });

  it('ignores everything else', () => {
    for (const file of ['', 'x.cfg', '001565aabbcc', '001565aabbcc.boot', '../001565aabbcc.cfg']) {
      expect(parseYealinkFile(file)).toBeUndefined();
    }
  });
});

describe('renderYealinkConfig', () => {
  const account = {
    number: '101',
    displayName: 'Front Desk',
    username: '101',
    password: 's3cret',
    server: 'acme.voice.example.test',
    port: 5060,
    transport: 'udp' as const,
  };

  it('starts with the version line and sets the first account', () => {
    const text = renderYealinkConfig(account);
    expect(text.split('\n')[0]).toBe('#!version:1.0.0.1');
    expect(text).toContain('account.1.enable = 1\n');
    expect(text).toContain('account.1.user_name = 101\n');
    expect(text).toContain('account.1.auth_name = 101\n');
    expect(text).toContain('account.1.password = s3cret\n');
    expect(text).toContain('account.1.sip_server.1.address = acme.voice.example.test\n');
    expect(text).toContain('account.1.sip_server.1.port = 5060\n');
    expect(text).toContain('account.1.sip_server.1.transport_type = 0\n');
    expect(text).toContain('static.auto_provision.repeat.enable = 1\n');
    expect(text).toContain('static.auto_provision.repeat.minutes = 1440\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('sends nothing through a proxy unless it is given one', () => {
    expect(renderYealinkConfig(account)).toContain('account.1.outbound_proxy_enable = 0\n');
    expect(renderYealinkConfig(account)).not.toContain('outbound_host');
  });

  it('registers to the domain but connects to the outbound proxy, on the same port', () => {
    const text = renderYealinkConfig({
      ...account,
      transport: 'tls',
      port: 5061,
      outboundProxy: 'sip.voice.reseller.test',
    });
    expect(text).toContain('account.1.sip_server.1.address = acme.voice.example.test\n');
    expect(text).toContain('account.1.outbound_proxy_enable = 1\n');
    expect(text).toContain('account.1.outbound_host = sip.voice.reseller.test\n');
    expect(text).toContain('account.1.outbound_port = 5061\n');
  });

  it.each([
    ['udp', 0],
    ['tcp', 1],
    ['tls', 2],
  ] as const)('maps %s to transport_type %i', (transport, value) => {
    expect(renderYealinkConfig({ ...account, transport })).toContain(
      `transport_type = ${String(value)}\n`,
    );
  });

  it('cannot be made to add a setting through a name', () => {
    const text = renderYealinkConfig({
      ...account,
      displayName: 'Eve\naccount.1.sip_server.1.address = evil.example\r\n',
    });
    const lines = text.trim().split('\n');
    expect(lines.filter((l) => l.startsWith('account.1.sip_server.1.address'))).toEqual([
      'account.1.sip_server.1.address = acme.voice.example.test',
    ]);
  });
});

describe('renderYealinkCommonConfig', () => {
  it('is only the version line', () => {
    expect(renderYealinkCommonConfig()).toBe('#!version:1.0.0.1\n');
  });
});

describe('the global provisioning credential', () => {
  it('is absent when neither part is configured, and present when both are', () => {
    expect(globalProvisioningCredential(undefined, undefined)).toBeUndefined();
    expect(globalProvisioningCredential('phones', 'pw')).toEqual({
      username: 'phones',
      password: 'pw',
    });
  });

  it('refuses half a credential, so a typo cannot silently drop it', () => {
    expect(() => globalProvisioningCredential('phones', undefined)).toThrow(/together/);
    expect(() => globalProvisioningCredential(undefined, 'pw')).toThrow(/together/);
  });

  it('matches only the exact user name and password', () => {
    const expected = { username: 'phones', password: 'shared-secret' };
    expect(
      globalCredentialMatches(expected, { username: 'phones', password: 'shared-secret' }),
    ).toBe(true);
    expect(
      globalCredentialMatches(expected, { username: 'phones', password: 'shared-secreT' }),
    ).toBe(false);
    expect(
      globalCredentialMatches(expected, { username: 'Phones', password: 'shared-secret' }),
    ).toBe(false);
    expect(globalCredentialMatches(expected, { username: '', password: '' })).toBe(false);
  });
});
