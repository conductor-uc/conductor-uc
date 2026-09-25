import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigError } from '../src/errors.js';
import { Env } from '../src/env.js';
import { loadConfig } from '../src/load.js';
import { redactConfig } from '../src/redact.js';
import { Type } from 'typebox';

const schema = Type.Object({
  SERVICE_NAME: Env.string(),
  HTTP_PORT: Env.port({ default: 8080 }),
  DEBUG: Env.bool({ default: false }),
  MODE: Env.enum(['a', 'b'], { default: 'a' }),
  HOSTS: Env.list({ default: [] }),
  OPTIONAL_URL: Env.optional(Env.url()),
});

describe('loadConfig', () => {
  it('coerces strings into the declared types', () => {
    const config = loadConfig(schema, {
      env: { SERVICE_NAME: 'org-service', HTTP_PORT: '9000', DEBUG: 'true', MODE: 'b' },
    });

    expect(config).toMatchObject({
      SERVICE_NAME: 'org-service',
      HTTP_PORT: 9000,
      DEBUG: true,
      MODE: 'b',
    });
  });

  it('applies defaults for variables that are not set', () => {
    const config = loadConfig(schema, { env: { SERVICE_NAME: 'org-service' } });

    expect(config.HTTP_PORT).toBe(8080);
    expect(config.DEBUG).toBe(false);
    expect(config.MODE).toBe('a');
    expect(config.OPTIONAL_URL).toBeUndefined();
  });

  it('treats an empty string as unset so a blank variable falls back to its default', () => {
    const config = loadConfig(schema, { env: { SERVICE_NAME: 'org-service', HTTP_PORT: '' } });

    expect(config.HTTP_PORT).toBe(8080);
  });

  it('splits comma-separated lists and trims the entries', () => {
    const config = loadConfig(schema, {
      env: { SERVICE_NAME: 'org-service', HOSTS: 'a.example, b.example ,' },
    });

    expect(config.HOSTS).toEqual(['a.example', 'b.example']);
  });

  it('ignores environment variables the schema does not declare', () => {
    const config = loadConfig(schema, {
      env: { SERVICE_NAME: 'org-service', UNRELATED: 'x' },
    });

    expect(config).not.toHaveProperty('UNRELATED');
  });

  it('freezes the result', () => {
    const config = loadConfig(schema, { env: { SERVICE_NAME: 'org-service' } });

    expect(Object.isFrozen(config)).toBe(true);
  });

  it('fails fast when a required variable is missing', () => {
    expect(() => loadConfig(schema, { env: {} })).toThrow(ConfigError);
    expect(() => loadConfig(schema, { env: {} })).toThrow(/SERVICE_NAME: is required but not set/);
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      loadConfig(schema, { env: { HTTP_PORT: 'not-a-port', MODE: 'z' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.variable)).toEqual(['HTTP_PORT', 'MODE', 'SERVICE_NAME']);
    }
  });

  it('collapses a failing union into one line naming the accepted values', () => {
    try {
      loadConfig(schema, { env: { SERVICE_NAME: 'org-service', MODE: 'z' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toEqual([{ variable: 'MODE', message: 'must be one of: a, b' }]);
    }
  });

  it('rejects a port outside the valid range', () => {
    expect(() => loadConfig(schema, { env: { SERVICE_NAME: 'x', HTTP_PORT: '70000' } })).toThrow(
      /HTTP_PORT/,
    );
  });

  it('never puts the rejected value in the error, because env holds secrets', () => {
    const secretSchema = Type.Object({ TOKEN: Env.secret({ minLength: 32 }) });

    try {
      loadConfig(secretSchema, { env: { TOKEN: 'hunter2' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).not.toContain('hunter2');
      expect((error as ConfigError).message).toContain('TOKEN');
    }
  });
});

describe('loadConfig: values read from files (NAME_FILE)', () => {
  const secretSchema = Type.Object({
    SERVICE_NAME: Env.string(),
    TOKEN: Env.secret(),
    HOSTS: Env.list({ default: [] }),
    PORT: Env.port({ default: 8080 }),
    // A schema variable that itself ends in _FILE keeps its own meaning.
    CERT_FILE: Env.optional(Env.string()),
    CERT: Env.optional(Env.string()),
  });

  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cuc-config-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function secretFile(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents, { mode: 0o600 });
    return path;
  }

  it('reads the value from the file NAME_FILE names, trimming the trailing newline', () => {
    const path = secretFile('token', 'from-a-file-0123456789\n');

    const config = loadConfig(secretSchema, { env: { SERVICE_NAME: 's', TOKEN_FILE: path } });

    expect(config.TOKEN).toBe('from-a-file-0123456789');
  });

  it('coerces a file value like an environment value', () => {
    const port = secretFile('port', '9090\r\n');
    const hosts = secretFile('hosts', 'a.example, b.example\n\n');

    const config = loadConfig(secretSchema, {
      env: { SERVICE_NAME: 's', TOKEN: 't', PORT_FILE: port, HOSTS_FILE: hosts },
    });

    expect(config.PORT).toBe(9090);
    expect(config.HOSTS).toEqual(['a.example', 'b.example']);
  });

  it('keeps a value read from a file redacted when the variable is secret', () => {
    const path = secretFile('token-redact', 'hunter2-from-file\n');

    const config = loadConfig(secretSchema, { env: { SERVICE_NAME: 's', TOKEN_FILE: path } });

    expect(redactConfig(secretSchema, config)).toMatchObject({
      SERVICE_NAME: 's',
      TOKEN: '[redacted]',
    });
  });

  it('refuses to start when both NAME and NAME_FILE are set, naming both', () => {
    const path = secretFile('token-both', 'x\n');

    expect(() =>
      loadConfig(secretSchema, { env: { SERVICE_NAME: 's', TOKEN: 'y', TOKEN_FILE: path } }),
    ).toThrow(/TOKEN: is set both directly and through TOKEN_FILE/);
  });

  it('refuses to start when the file cannot be read, without a second "not set" line', () => {
    try {
      loadConfig(secretSchema, {
        env: { SERVICE_NAME: 's', TOKEN_FILE: join(dir, 'does-not-exist') },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]!.variable).toBe('TOKEN_FILE');
      expect(issues[0]!.message).toMatch(/cannot read the file .*does-not-exist.* \(ENOENT\)/);
    }
  });

  it('refuses an empty file rather than treating the secret as unset', () => {
    const path = secretFile('empty', '\n');

    expect(() =>
      loadConfig(secretSchema, { env: { SERVICE_NAME: 's', TOKEN_FILE: path } }),
    ).toThrow(/TOKEN_FILE: the file .* is empty/);
  });

  it('never puts the file contents in an error', () => {
    const path = secretFile('short', 'hunter2\n');
    const strict = Type.Object({ TOKEN: Env.secret({ minLength: 32 }) });

    try {
      loadConfig(strict, { env: { TOKEN_FILE: path } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).toContain('TOKEN');
      expect((error as ConfigError).message).not.toContain('hunter2');
    }
  });

  it('lists file problems together with every other problem', () => {
    try {
      loadConfig(secretSchema, { env: { TOKEN_FILE: join(dir, 'missing'), PORT: 'x' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).issues.map((issue) => issue.variable)).toEqual([
        'PORT',
        'SERVICE_NAME',
        'TOKEN_FILE',
      ]);
    }
  });

  it('leaves a variable the schema itself names NAME_FILE alone', () => {
    const config = loadConfig(secretSchema, {
      env: { SERVICE_NAME: 's', TOKEN: 't', CERT_FILE: '/etc/ssl/cert.pem' },
    });

    expect(config.CERT_FILE).toBe('/etc/ssl/cert.pem');
    expect(config.CERT).toBeUndefined();
  });
});
