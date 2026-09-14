import type { Redis } from 'ioredis';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Milliseconds until the window resets. */
  readonly resetMs: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

/**
 * Fixed-window counter in Redis (05 §1). `INCR` + `PEXPIRE` set-once-on-first-hit
 * is a single round trip via `EVAL`, so two requests racing on the same key
 * cannot both see themselves as "first" and leave the key without a TTL.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export interface CreateRateLimiterOptions {
  readonly redis: Redis;
  readonly keyPrefix: string;
  readonly max: number;
  readonly windowMs: number;
}

export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  const { redis, keyPrefix, max, windowMs } = options;
  return {
    async consume(key: string): Promise<RateLimitResult> {
      const [current, ttl] = (await redis.eval(
        CONSUME_SCRIPT,
        1,
        `${keyPrefix}${key}`,
        windowMs,
      )) as [number, number];

      return {
        allowed: current <= max,
        limit: max,
        remaining: Math.max(0, max - current),
        resetMs: ttl < 0 ? windowMs : ttl,
      };
    },
  };
}
