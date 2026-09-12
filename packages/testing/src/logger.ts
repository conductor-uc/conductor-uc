import { Writable } from 'node:stream';

import { createLogger, type Logger } from '@cuc/logger';

/** A logger that discards output, so a passing suite prints nothing. */
export function silentLogger(): Logger {
  return createLogger({
    name: 'test',
    level: 'fatal',
    destination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}
