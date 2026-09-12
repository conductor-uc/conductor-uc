import { Writable } from 'node:stream';

import { createLogger, type Logger } from '@cuc/logger';

/** Captures log lines so tests can assert on them and stdout stays clean. */
export function captureLogger(): { lines: Record<string, unknown>[]; logger: Logger } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, logger: createLogger({ name: 'db-test', level: 'trace', destination: stream }) };
}
