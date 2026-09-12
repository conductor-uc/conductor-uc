import { randomUUID } from 'node:crypto';

import fastifySwagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger, withContext, type Logger } from '@cuc/logger';
import Fastify, { LogController, type FastifyServerOptions } from 'fastify';

import { registerHardRules } from './authz.js';
import {
  buildRequestContext,
  REQUEST_ID_HEADER,
  type ContextOptions,
  type RequestContext,
} from './context.js';
import { registerHealthRoutes } from './health.js';
import { registerProblemHandlers } from './problem.js';
import { registerRouteContractGuard } from './route-guard.js';
import type { Server } from './server-type.js';

export interface OpenApiOptions {
  /**
   * Document title. Defaults to the service name.
   *
   * This is a brand-leak surface (02 §5.5): it must stay a functional name, so
   * no product, operator, or codebase name belongs here.
   */
  readonly title?: string;
  readonly description?: string;
  readonly servers?: readonly { url: string; description?: string }[];
}

export interface CreateServerOptions {
  /** From `SERVICE_NAME`. Names the service in logs, traces, and OpenAPI. */
  readonly serviceName: string;
  /** From `SERVICE_VERSION`. */
  readonly serviceVersion?: string;
  /** From `LOG_LEVEL`. Ignored when `logger` is supplied. */
  readonly logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Supply a logger to share one instance across HTTP, DB, and the bus. */
  readonly logger?: Logger;
  readonly openapi?: OpenApiOptions;
  readonly context?: ContextOptions;
  /** Behind api-gateway this should be true so client IPs are correct. */
  readonly trustProxy?: boolean;
  /** Escape hatch for Fastify options this factory does not cover. */
  readonly fastify?: Partial<FastifyServerOptions>;
}

/**
 * Headers that identify the server software (02 §5.5). Fastify sends none of
 * them, and neither does anything this factory registers.
 *
 * The `onSend` strip below is a backstop for the plugins registered *inside*
 * this factory: Fastify runs `onSend` hooks in registration order, so a hook a
 * service adds later still runs after it. Keeping these headers off the wire is
 * therefore a rule that code review and the S0-07 brand-leak scan enforce, not
 * something this factory can guarantee on its own.
 */
const IDENTIFYING_HEADERS = ['server', 'x-powered-by'] as const;

/**
 * Builds a service HTTP server with the platform defaults wired in:
 * request id and trace propagation, a request context, problem+json errors,
 * health and readiness routes, OpenAPI generation, hard rule H1, and the route
 * contract guard.
 *
 * Routes still have to declare `permission` and `dataClass`; registering one
 * that does not throws at the registration call, or rejects `app.ready()` when
 * the route sits inside a plugin.
 */
export async function createServer(options: CreateServerOptions): Promise<Server> {
  const {
    serviceName,
    serviceVersion = '0.0.0',
    logLevel = 'info',
    openapi = {},
    context = {},
    trustProxy = false,
  } = options;

  const logger =
    options.logger ?? createLogger({ name: serviceName, level: logLevel, version: serviceVersion });

  const app = Fastify({
    loggerInstance: logger,
    // An inbound id is reused so one request keeps one id across services;
    // otherwise each hop would invent its own.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => randomUUID(),
    logController: new LogController({
      // Matches the field name `@cuc/logger` binds, so request logs and
      // application logs correlate on one key (09 §4).
      requestIdLogLabel: 'requestId',
      disableRequestLogging: false,
    }),
    trustProxy,
    ajv: { customOptions: { allErrors: true, removeAdditional: false, coerceTypes: false } },
    ...options.fastify,
  }).withTypeProvider<TypeBoxTypeProvider>() as Server;

  registerRouteContractGuard(app);
  registerProblemHandlers(app);

  // Declared here so the property exists on the request prototype; the real
  // value is assigned per request in the onRequest hook below. Fastify 5
  // forbids a reference-type default, so the placeholder is null.
  app.decorateRequest('context', null as unknown as RequestContext);

  app.addHook('onRequest', (request, reply, done) => {
    const requestContext = buildRequestContext(request, context);
    request.context = requestContext;

    // Correlation fields land on every line this request produces (09 §4).
    request.log = withContext(request.log, {
      requestId: requestContext.requestId,
      traceId: requestContext.traceId,
      ...(requestContext.tenantId === undefined ? {} : { tenantId: requestContext.tenantId }),
      ...(requestContext.resellerId === undefined ? {} : { resellerId: requestContext.resellerId }),
      ...(requestContext.actorId === undefined ? {} : { actorId: requestContext.actorId }),
    });

    void reply.header(REQUEST_ID_HEADER, requestContext.requestId);
    done();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const header of IDENTIFYING_HEADERS) reply.removeHeader(header);
    done(null, payload);
  });

  registerHardRules(app);

  // Awaited, not fire-and-forget: @fastify/swagger collects routes through an
  // `onRoute` hook, so it has to be loaded before any route is registered or
  // the document comes out empty.
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: openapi.title ?? serviceName,
        version: serviceVersion,
        ...(openapi.description === undefined ? {} : { description: openapi.description }),
      },
      ...(openapi.servers === undefined ? {} : { servers: [...openapi.servers] }),
    },
  });

  registerHealthRoutes(app, { serviceName, serviceVersion });

  app.route({
    method: 'GET',
    url: '/openapi.json',
    config: { public: true },
    schema: { hide: true },
    handler: () => app.swagger(),
  });

  return app;
}
