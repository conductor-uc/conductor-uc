import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/errors.js';
import { Env } from '../src/env.js';
import { loadConfig } from '../src/load.js';
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
