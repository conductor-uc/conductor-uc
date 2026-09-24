import { ProblemError, Type } from '@cuc/http';
import type { Server, Static } from '@cuc/http';

export interface HealthTarget {
  readonly name: string;
  readonly url: string;
}

export interface PlatformHealthOptions {
  readonly targets: readonly HealthTarget[];
  /** How long one service has to answer its `/readyz` before it counts as down. */
  readonly timeoutMs: number;
}

const ServiceHealthSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('up'), Type.Literal('degraded'), Type.Literal('down')]),
  latencyMs: Type.Number(),
  version: Type.Union([Type.String(), Type.Null()]),
  /** Names of the readiness checks that failed, if any. Never their details. */
  failing: Type.Array(Type.String()),
});

interface ReadyBody {
  readonly version?: unknown;
  readonly checks?: unknown;
}

async function probe(
  target: HealthTarget,
  timeoutMs: number,
): Promise<Static<typeof ServiceHealthSchema>> {
  const started = Date.now();
  try {
    const response = await fetch(new URL('/readyz', target.url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const body = (await response.json().catch(() => ({}))) as ReadyBody;
    const checks =
      typeof body.checks === 'object' && body.checks !== null
        ? (body.checks as Record<string, { status?: unknown }>)
        : {};
    const failing = Object.entries(checks)
      .filter(([, result]) => result.status !== 'pass')
      .map(([name]) => name);
    return {
      name: target.name,
      status: response.ok ? 'up' : 'degraded',
      latencyMs,
      version: typeof body.version === 'string' ? body.version : null,
      failing,
    };
  } catch {
    // Unreachable, timed out, or not HTTP at all: all the same to an operator.
    return {
      name: target.name,
      status: 'down',
      latencyMs: Date.now() - started,
      version: null,
      failing: [],
    };
  }
}

/**
 * `GET /v1/platform/health` (S3-05): each service's own `/readyz`, asked in
 * parallel, for the master's Platform health screen.
 *
 * The gateway has the actor's org type but not their roles, so it enforces
 * "master only" itself and leaves finer permissions to the console (G-90). The
 * answer names services and which of their checks fail, and carries nothing a
 * check reports beyond its name (readiness details can hold connection
 * strings; `@cuc/http` already keeps them out of `/readyz`).
 */
export function registerPlatformHealth(app: Server, options: PlatformHealthOptions): void {
  app.get(
    '/v1/platform/health',
    {
      config: { permission: 'analytics.view', dataClass: 'config' },
      schema: {
        response: {
          200: Type.Object({
            checkedAt: Type.String(),
            services: Type.Array(ServiceHealthSchema),
          }),
        },
      },
    },
    async (request) => {
      if (request.context.orgType !== 'master') {
        throw ProblemError.forbidden('Only the master can see platform health.');
      }
      const services = await Promise.all(
        options.targets.map((target) => probe(target, options.timeoutMs)),
      );
      return { checkedAt: new Date().toISOString(), services };
    },
  );
}
