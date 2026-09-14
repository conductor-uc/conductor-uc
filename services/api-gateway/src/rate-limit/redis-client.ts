import { Redis } from 'ioredis';

/** One connection, shared by the IP and actor limiters. */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    // Fails fast at startup (readiness check) rather than retrying forever
    // silently; request-time retry is handled by ioredis's own reconnect.
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });
}
