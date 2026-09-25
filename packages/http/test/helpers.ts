import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@cuc/logger';

import { signInternalHeaders, type ActorType, type OrgType } from '../src/context.js';
import { createServer, type CreateServerOptions } from '../src/server.js';
import type { Server } from '../src/server-type.js';

/** Every test that trusts internal headers signs them with this secret. */
export const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

/** Signs a set of internal context headers with {@link TEST_INTERNAL_SECRET}, for `app.inject`. */
export function signedHeaders(fields: {
  readonly actorId?: string;
  readonly actorType?: ActorType;
  readonly orgId?: string;
  readonly orgType?: OrgType;
  readonly resellerId?: string;
  readonly tenantId?: string;
  readonly clientIp?: string;
}): Record<string, string> {
  return signInternalHeaders(TEST_INTERNAL_SECRET, fields);
}

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

/**
 * A server wired like a real service, but logging into memory.
 *
 * Defaults `context.internalHeaderSigningSecret` to {@link TEST_INTERNAL_SECRET}
 * whenever the caller opts into `trustInternalHeaders`, so a test only has to
 * say *that* it trusts internal headers, not repeat which secret verifies
 * them — use {@link signedHeaders} to actually set them on a request.
 */
export function testServer(options: Partial<CreateServerOptions> = {}): Promise<Server> {
  const { context, ...rest } = options;
  return createServer({
    serviceName: 'test-service',
    serviceVersion: '1.2.3',
    logger: captureLogger().logger,
    ...rest,
    ...(context === undefined
      ? {}
      : {
          context: {
            ...context,
            ...(context.trustInternalHeaders === true
              ? {
                  internalHeaderSigningSecret:
                    context.internalHeaderSigningSecret ?? TEST_INTERNAL_SECRET,
                }
              : {}),
          },
        }),
  });
}
