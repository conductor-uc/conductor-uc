import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A service's Fastify instance: TypeBox schemas drive both validation and
 * handler types, so one schema produces the runtime check, the TypeScript type,
 * and the OpenAPI fragment.
 *
 * The logger is Fastify's own `FastifyBaseLogger` rather than pino's `Logger`.
 * The concrete instance is a pino logger, but typing it as pino here would make
 * this instance incompatible with every plugin that takes a plain
 * `FastifyInstance`.
 */
export type Server = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;
