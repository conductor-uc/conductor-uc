import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@cuc/logger';

import { createServer, type CreateServerOptions } from '../src/server.js';
import type { Server } from '../src/server-type.js';

/** Captures log output so tests can assert on it and stdout stays clean. */
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
  return {
    lines,
    logger: createLogger({ name: 'test-service', level: 'trace', destination: stream }),
  };
}

/** A server wired like a real service, but logging into memory. */
export function testServer(options: Partial<CreateServerOptions> = {}): Promise<Server> {
  return createServer({
    serviceName: 'test-service',
    serviceVersion: '1.2.3',
    logger: captureLogger().logger,
    ...options,
  });
}
