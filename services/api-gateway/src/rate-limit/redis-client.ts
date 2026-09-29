import { Redis } from 'ioredis';

/** One connection, shared by the IP and actor limiters. */
export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    // Fails fast at startup (readiness check) rather than retrying forever
    // silently; request-time retry is handled by ioredis's own reconnect.
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    // S4-11: a connection whose far end vanished without a reset (a load
    // balancer or Redis server killed, its floating address moved) never
    // answers; without this the client waits on it forever. With it, a
    // command left unanswered for 3 s drops the socket and reconnects.
    socketTimeout: 3_000,
    keepAlive: 10_000,
  });
}
