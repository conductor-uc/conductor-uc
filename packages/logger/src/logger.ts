import { pino, type DestinationStream, type Level, type Logger, type LoggerOptions } from 'pino';

import { censor, defaultRedactPaths } from './redaction.js';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Correlation fields carried on child loggers (09 §4). `@cuc/http` binds
 * `requestId` and `traceId` per request; services add the rest as they learn
 * them.
 */
export interface LogContext {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly tenantId?: string;
  readonly resellerId?: string;
  readonly actorId?: string;
  readonly callUuid?: string;
}

export interface CreateLoggerOptions {
  /** Service identity, from `SERVICE_NAME`. */
  readonly name: string;
  /** From `LOG_LEVEL`. */
  readonly level?: LogLevel;
  /** From `SERVICE_VERSION`; included on every line for release correlation. */
  readonly version?: string;
  /** Extra redact paths on top of the defaults. Defaults are never removed. */
  readonly redact?: readonly string[];
  /** Extra fields on every line. */
  readonly base?: Readonly<Record<string, unknown>>;
  /** Test seam: capture output instead of writing to stdout. */
  readonly destination?: DestinationStream;
}

/**
 * Builds the service logger: JSON on stdout, ISO timestamps, and redaction of
 * secret paths.
 *
 * Redaction is not optional and cannot be switched off — `redact` only adds to
 * the defaults. A service that needs to see a secret has a bug, not a logging
 * problem.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { name, level = 'info', version, redact = [], base, destination } = options;

  const loggerOptions: LoggerOptions = {
    name,
    level,
    // ISO over epoch millis: these lines are read by humans during incidents.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: name, ...(version === undefined ? {} : { version }), ...base },
    redact: {
      paths: [...defaultRedactPaths(), ...redact],
      censor,
    },
    formatters: {
      // `level: "info"` rather than `level: 30`, so log queries read naturally.
      level: (label: string) => ({ level: label }),
    },
  };

  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}

/** Narrows an arbitrary string to a pino level, falling back to `info`. */
export function toLogLevel(value: string | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value ?? '') ? (value as LogLevel) : 'info';
}

/** The part of a logger this helper needs: pino's `Logger` and Fastify's
 * `FastifyBaseLogger` both satisfy it, so callers keep their own type. */
export interface ChildLogger {
  child(bindings: Record<string, unknown>): this;
}

/** A child logger carrying correlation fields. */
export function withContext<T extends ChildLogger>(logger: T, context: LogContext): T {
  return logger.child(definedOnly(context));
}

function definedOnly(context: LogContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}

/** Re-exported so services do not import pino directly for a level type. */
export type PinoLevel = Level;
