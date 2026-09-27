import type { Server } from './server-type.js';

/** Outcome of one readiness check. */
export interface ReadinessResult {
  readonly status: 'pass' | 'fail';
  /** Short, non-sensitive note, e.g. `lag 3s`. Never a connection string. */
  readonly detail?: string;
}

export type ReadinessCheck = () => ReadinessResult | Promise<ReadinessResult>;

/**
 * S4-12: one part of `GET /statusz`, such as a service's outbox backlog. Its answer is shown to
 * the master's operations console as it is, so it holds counts and ages, never a connection
 * string or anything of a tenant's.
 */
export type StatusSection = () => unknown;

export interface HealthOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

/**
 * Registers `GET /healthz` (liveness) and `GET /readyz` (dependencies), per 06.
 *
 * Liveness answers "is the process running", so it never touches a dependency:
 * a failing database must not get the container killed and restarted into the
 * same failure. Readiness runs the registered checks and answers 503 when any
 * of them fails, which takes the instance out of the load balancer instead.
 */
export function registerHealthRoutes(app: Server, options: HealthOptions): void {
  const checks = new Map<string, ReadinessCheck>();
  const sections = new Map<string, StatusSection>();
  const startedAt = Date.now();

  app.decorate('addReadinessCheck', (name: string, check: ReadinessCheck): void => {
    checks.set(name, check);
  });
  app.decorate('addStatusSection', (name: string, section: StatusSection): void => {
    sections.set(name, section);
  });

  async function runChecks(log: {
    error: (obj: object, msg: string) => void;
  }): Promise<Record<string, ReadinessResult>> {
    const results: Record<string, ReadinessResult> = {};
    for (const [name, check] of checks) {
      try {
        results[name] = await check();
      } catch (error) {
        // The thrown message may carry a DSN or credentials, so it is logged
        // and not echoed to the caller.
        log.error({ err: error, check: name }, 'readiness check threw');
        results[name] = { status: 'fail' };
      }
    }
    return results;
  }

  app.route({
    method: 'GET',
    url: '/healthz',
    config: { public: true },
    schema: {
      hide: true,
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            version: { type: 'string' },
            uptimeSeconds: { type: 'number' },
          },
        },
      },
    },
    handler: () => ({
      status: 'ok',
      service: options.serviceName,
      version: options.serviceVersion,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
  });

  app.route({
    method: 'GET',
    url: '/readyz',
    config: { public: true },
    schema: { hide: true },
    handler: async (request, reply) => {
      const results = await runChecks(request.log);
      const ready = Object.values(results).every((result) => result.status === 'pass');
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ok' : 'unavailable',
        service: options.serviceName,
        version: options.serviceVersion,
        checks: results,
      });
    },
  });

  /**
   * S4-12: everything the master's operations console shows about this process: `/readyz`'s
   * checks, plus uptime, memory and each section a service added (`addStatusSection`). Like
   * `/readyz` it is on the internal network only and names no secret: the gateway asks it for
   * `GET /v1/platform/overview`. Kept apart from `/readyz` so a load balancer's frequent probes
   * never run a section's queries. A section that throws is `null`, with the error logged.
   */
  app.route({
    method: 'GET',
    url: '/statusz',
    config: { public: true },
    schema: { hide: true },
    handler: async (request) => {
      const results = await runChecks(request.log);
      const extra: Record<string, unknown> = {};
      for (const [name, section] of sections) {
        try {
          extra[name] = await section();
        } catch (error) {
          request.log.error({ err: error, section: name }, 'status section threw');
          extra[name] = null;
        }
      }
      const memory = process.memoryUsage();
      return {
        service: options.serviceName,
        version: options.serviceVersion,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        ready: Object.values(results).every((result) => result.status === 'pass'),
        checks: Object.entries(results).map(([name, result]) => ({ name, status: result.status })),
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
        sections: extra,
      };
    },
  });
}
