import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger, toLogLevel, withContext } from '../src/logger.js';

/** Collects the JSON lines a logger writes. */
function capture(): { lines: Record<string, unknown>[]; stream: Writable } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, stream };
}

function logOnce(payload: Record<string, unknown>): Record<string, unknown> {
  const { lines, stream } = capture();
  const logger = createLogger({ name: 'org-service', level: 'trace', destination: stream });
  logger.info(payload, 'message');
  return lines[0]!;
}

describe('createLogger', () => {
  it('emits JSON with the service identity and an ISO timestamp', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'org-service', version: '1.2.3', destination: stream });

    logger.info('started');

    expect(lines[0]).toMatchObject({
      service: 'org-service',
      version: '1.2.3',
      level: 'info',
      msg: 'started',
    });
    expect(String(lines[0]!['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes the level as a label rather than a number', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'x', level: 'warn', destination: stream });

    logger.warn('careful');

    expect(lines[0]!['level']).toBe('warn');
  });

  it('honours the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'x', level: 'warn', destination: stream });

    logger.info('dropped');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]!['msg']).toBe('kept');
  });
});

describe('redaction', () => {
  it('masks secrets at the top level', () => {
    const line = logOnce({ password: 'hunter2', token: 'abc' });

    expect(line['password']).toBe('[redacted]');
    expect(line['token']).toBe('[redacted]');
  });

  it('masks secrets nested inside an object', () => {
    const line = logOnce({ user: { id: 'u1', password: 'hunter2' } });

    expect(line['user']).toEqual({ id: 'u1', password: '[redacted]' });
  });

  it('masks SIP credentials in both spellings', () => {
    const line = logOnce({ endpoint: { sipPassword: 'a', sip_password: 'b', ha1: 'c' } });

    expect(line['endpoint']).toEqual({
      sipPassword: '[redacted]',
      sip_password: '[redacted]',
      ha1: '[redacted]',
    });
  });

  it('masks authorization and cookie request headers', () => {
    const line = logOnce({
      req: {
        method: 'GET',
        headers: { authorization: 'Bearer x', cookie: 'sid=1', accept: '*/*' },
      },
    });

    expect(line['req']).toEqual({
      method: 'GET',
      headers: { authorization: '[redacted]', cookie: '[redacted]', accept: '*/*' },
    });
  });

  it('keeps a media URL identifiable but strips its signature', () => {
    const line = logOnce({
      recordingUrl:
        'https://s3.example/bucket/rec-1.wav?X-Amz-Signature=deadbeef&X-Amz-Expires=900',
    });

    expect(line['recordingUrl']).toBe('https://s3.example/bucket/rec-1.wav?[redacted]');
  });

  it('leaves an unsigned media URL fully readable', () => {
    const line = logOnce({ mediaUrl: 'https://s3.example/bucket/rec-1.wav' });

    expect(line['mediaUrl']).toBe('https://s3.example/bucket/rec-1.wav');
  });

  it('masks a *Url value that is not a URL rather than passing it through', () => {
    const line = logOnce({ downloadUrl: 'not-a-url-but-maybe-a-token' });

    expect(line['downloadUrl']).toBe('[redacted]');
  });

  it('never leaks a secret anywhere in the serialized line', () => {
    const line = logOnce({ db: { credentials: { password: 'hunter2' } }, apiKey: 'cuc_live_x' });

    expect(JSON.stringify(line)).not.toContain('hunter2');
    expect(JSON.stringify(line)).not.toContain('cuc_live_x');
  });

  it('adds caller-supplied paths without dropping the defaults', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'x', redact: ['custom'], destination: stream });

    logger.info({ custom: 'x', password: 'hunter2' }, 'm');

    expect(lines[0]!['custom']).toBe('[redacted]');
    expect(lines[0]!['password']).toBe('[redacted]');
  });
});

describe('withContext', () => {
  it('binds correlation fields onto every line', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'x', destination: stream });

    withContext(logger, { requestId: 'r1', traceId: 't1', tenantId: 'ten1' }).info('handled');

    expect(lines[0]).toMatchObject({ requestId: 'r1', traceId: 't1', tenantId: 'ten1' });
  });

  it('omits fields that are not known yet', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'x', destination: stream });

    withContext(logger, { requestId: 'r1' }).info('handled');

    expect(lines[0]).not.toHaveProperty('tenantId');
  });
});

describe('toLogLevel', () => {
  it('accepts a valid level and falls back to info otherwise', () => {
    expect(toLogLevel('debug')).toBe('debug');
    expect(toLogLevel('shout')).toBe('info');
    expect(toLogLevel(undefined)).toBe('info');
  });
});
