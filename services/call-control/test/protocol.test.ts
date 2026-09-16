import { describe, expect, it } from 'vitest';

import { EslFrameParser, eslCommand, isOkReply } from '../src/esl/protocol.js';

describe('EslFrameParser', () => {
  it('parses a header-only frame', () => {
    const parser = new EslFrameParser();
    const [frame] = parser.push('Content-Type: command/reply\nReply-Text: +OK accepted\n\n');
    expect(frame?.headers.get('Content-Type')).toBe('command/reply');
    expect(frame?.headers.get('Reply-Text')).toBe('+OK accepted');
    expect(frame?.body).toBeUndefined();
  });

  it('parses a frame with a Content-Length body', () => {
    const parser = new EslFrameParser();
    const body = JSON.stringify({ 'Event-Name': 'HEARTBEAT' });
    const [frame] = parser.push(
      `Content-Type: text/event-json\nContent-Length: ${String(Buffer.byteLength(body))}\n\n${body}`,
    );
    expect(frame?.body).toBe(body);
  });

  it('waits for the rest of a body split across chunks', () => {
    const parser = new EslFrameParser();
    const body = JSON.stringify({ 'Event-Name': 'HEARTBEAT' });
    const header = `Content-Type: text/event-json\nContent-Length: ${String(Buffer.byteLength(body))}\n\n`;

    expect(parser.push(header + body.slice(0, 5))).toHaveLength(0);
    const frames = parser.push(body.slice(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body).toBe(body);
  });

  it('parses several frames delivered in one chunk', () => {
    const parser = new EslFrameParser();
    const frames = parser.push(
      'Content-Type: command/reply\nReply-Text: +OK\n\nContent-Type: command/reply\nReply-Text: +OK\n\n',
    );
    expect(frames).toHaveLength(2);
  });
});

describe('isOkReply', () => {
  it('is true for a +OK reply and false otherwise', () => {
    const parser = new EslFrameParser();
    const [ok] = parser.push('Reply-Text: +OK\n\n');
    const [err] = parser.push('Reply-Text: -ERR invalid\n\n');
    expect(ok && isOkReply(ok)).toBe(true);
    expect(err && isOkReply(err)).toBe(false);
  });
});

describe('eslCommand', () => {
  it('terminates the command with a blank line', () => {
    expect(eslCommand('auth secret')).toBe('auth secret\n\n');
  });
});
