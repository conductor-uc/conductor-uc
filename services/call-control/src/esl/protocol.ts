/**
 * A minimal parser for FreeSWITCH's Event Socket Library wire protocol.
 *
 * No third-party ESL client library is used here — the protocol is a small,
 * well-documented, plain-text framing (mime-header-style blocks, optionally
 * followed by a `Content-Length`-delimited body), and writing it directly
 * keeps the one thing this service depends on for correctness testable
 * against a fake in-process TCP server (`test/esl-client.test.ts`) rather
 * than trusting an unfamiliar dependency's own protocol handling — the same
 * "verify against real behavior rather than an unverified assumption" bar
 * the rest of this codebase holds FreeSWITCH module config to (G-19 and
 * friends in docs/decisions.md).
 *
 * A frame is a block of `Key: value` header lines terminated by a blank
 * line. If the headers include `Content-Length`, that many bytes
 * immediately follow as the frame's body (used for `text/event-json` and
 * `api/response`) — everything else has no body.
 */

export interface EslFrame {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string | undefined;
}

const HEADER_BLOCK_SEPARATOR = /\r\n\r\n|\n\n/;

/**
 * Accumulates raw socket bytes and yields complete frames as they become
 * available. Stateful and single-use per connection — construct a new one
 * per `net.Socket`.
 */
export class EslFrameParser {
  private buffer = '';

  /** Feeds newly received bytes in and returns every frame that is now complete. */
  push(chunk: Buffer | string): EslFrame[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    const frames: EslFrame[] = [];
    for (;;) {
      const frame = this.tryExtractOne();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  private tryExtractOne(): EslFrame | undefined {
    const match = HEADER_BLOCK_SEPARATOR.exec(this.buffer);
    if (match === null) return undefined;

    const headerBlock = this.buffer.slice(0, match.index);
    const afterHeaders = this.buffer.slice(match.index + match[0].length);

    const headers = parseHeaders(headerBlock);
    const lengthHeader = headers.get('Content-Length');
    const contentLength = lengthHeader === undefined ? 0 : Number(lengthHeader);

    if (contentLength > 0) {
      if (afterHeaders.length < contentLength) return undefined; // body not fully arrived yet
      const body = afterHeaders.slice(0, contentLength);
      this.buffer = afterHeaders.slice(contentLength);
      return { headers, body };
    }

    this.buffer = afterHeaders;
    return { headers, body: undefined };
  }
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.split(/\r\n|\n/)) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers.set(key, value);
  }
  return headers;
}

/** Builds one outbound command, terminated the way the protocol expects. */
export function eslCommand(command: string): string {
  return `${command}\n\n`;
}

/** True when a `command/reply` frame's `Reply-Text` indicates success. */
export function isOkReply(frame: EslFrame): boolean {
  const replyText = frame.headers.get('Reply-Text') ?? '';
  return replyText.startsWith('+OK');
}
