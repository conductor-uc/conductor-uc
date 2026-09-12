import type { Server } from './server-type.js';

/** Outcome of one readiness check. */
export interface ReadinessResult {
  readonly status: 'pass' | 'fail';
  /** Short, non-sensitive note, e.g. `lag 3s`. Never a connection string. */
  readonly detail?: string;
}

export type ReadinessCheck = () => ReadinessResult | Promise<ReadinessResult>;

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
  const startedAt = Date.now();

  app.decorate('addReadinessCheck', (name: string, check: ReadinessCheck): void => {
    checks.set(name, check);
  });

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
      const results: Record<string, ReadinessResult> = {};

      for (const [name, check] of checks) {
        try {
          results[name] = await check();
        } catch (error) {
          // The thrown message may carry a DSN or credentials, so it is logged
          // and not echoed to the caller.
          request.log.error({ err: error, check: name }, 'readiness check threw');
          results[name] = { status: 'fail' };
        }
      }

      const ready = Object.values(results).every((result) => result.status === 'pass');
      return reply.status(ready ? 200 : 503).send({
        status: ready ? 'ok' : 'unavailable',
        service: options.serviceName,
        version: options.serviceVersion,
        checks: results,
      });
    },
  });
}
