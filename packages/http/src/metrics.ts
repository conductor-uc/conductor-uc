import type { Attributes, Meter } from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

import type { Server } from './server-type.js';

/** One reading of a gauge: a value, and the labels that tell it apart from the others. */
export interface GaugeReading {
  readonly value: number;
  readonly attributes?: Attributes;
}

/** How a gauge is read at each scrape: one number, or one per label set. */
export type GaugeRead = () =>
  number | readonly GaugeReading[] | Promise<number | readonly GaugeReading[]>;

export interface GaugeOptions {
  readonly description: string;
  /** UCUM, as OpenTelemetry has it: `s`, `By`, `%`, `1` (a count; the default). */
  readonly unit?: string;
}

/** Routes the request metrics leave out: the probes and this endpoint itself. */
const UNMEASURED = new Set(['/healthz', '/readyz', '/statusz', '/metrics']);

/**
 * S4-13 (G-124; 09 §4: "Prometheus via OTel"): `GET /metrics` on every service, in Prometheus'
 * text format from an OpenTelemetry meter.
 *
 * - **HTTP RED:** `http_server_request_duration_seconds`, a histogram labelled by method, route
 *   pattern (never the concrete path, which would name tenants and calls) and status code.
 * - Names are given as Prometheus shows them (unit suffix included): the exporter does not add
 *   one, so `name` passed to `addGauge` is the final metric name.
 * - **What a service adds:** `app.addGauge(name, options, read)`, read at each scrape (an outbox's
 *   backlog, a media node's calls).
 *
 * On the internal network only, like `/readyz`; Prometheus scrapes it. It holds counts and
 * timings, never a tenant's data: a label is a route pattern, a node id or a stream name.
 */
export function registerMetrics(app: Server): void {
  const exporter = new PrometheusExporter({
    preventServerStart: true,
    // The scrape job says which service this is; OpenTelemetry's own labels would only add noise.
    withoutScopeInfo: true,
    withoutTargetInfo: true,
  });
  const provider = new MeterProvider({ readers: [exporter] });
  const meter: Meter = provider.getMeter('cuc');

  const duration = meter.createHistogram('http_server_request_duration_seconds', {
    description: 'How long the service took to answer an HTTP request.',
    unit: 's',
    advice: {
      explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    },
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route === undefined || !UNMEASURED.has(route)) {
      duration.record(reply.elapsedTime / 1000, {
        'http.request.method': request.method,
        'http.route': route ?? 'unmatched',
        'http.response.status_code': reply.statusCode,
      });
    }
    done();
  });

  app.decorate('addGauge', (name: string, options: GaugeOptions, read: GaugeRead): void => {
    meter
      .createObservableGauge(name, { description: options.description, unit: options.unit ?? '1' })
      .addCallback(async (result) => {
        try {
          const reading = await read();
          if (typeof reading === 'number') {
            result.observe(reading);
            return;
          }
          for (const { value, attributes } of reading) result.observe(value, attributes);
        } catch (error) {
          // A gauge that cannot be read is left out of this scrape, not a failed scrape.
          app.log.warn({ err: error, gauge: name }, 'metrics: a gauge could not be read');
        }
      });
  });

  app.route({
    method: 'GET',
    url: '/metrics',
    config: { public: true },
    schema: { hide: true },
    handler: (request, reply) => {
      reply.hijack();
      exporter.getMetricsRequestHandler(request.raw, reply.raw);
    },
  });

  app.addHook('onClose', async () => {
    await provider.shutdown();
  });
}

/** What `@cuc/events`' relay reports about the outbox (`Relay.status()`). */
export interface OutboxStatusSource {
  status(): Promise<{
    readonly pending: number;
    readonly oldestPendingSeconds: number | null;
    readonly failed: number;
  }>;
}

/**
 * S4-12/S4-13: a service's outbox, for the operations console: its `/statusz` section and three
 * gauges (`outbox_pending`, `outbox_oldest_pending_seconds`, `outbox_failed`; 09 §4's "outbox
 * lag"). A scrape and a status read each ask the database once.
 */
export function observeOutbox(app: Server, relay: OutboxStatusSource): void {
  app.addStatusSection('outbox', () => relay.status());
  app.addGauge('outbox_pending', { description: 'Outbox rows waiting to be published.' }, () =>
    relay.status().then((status) => status.pending),
  );
  app.addGauge(
    'outbox_oldest_pending_seconds',
    { description: 'Age of the oldest outbox row waiting to be published.', unit: 's' },
    () => relay.status().then((status) => status.oldestPendingSeconds ?? 0),
  );
  app.addGauge(
    'outbox_failed',
    { description: 'Outbox rows parked after too many failed publishes.' },
    () => relay.status().then((status) => status.failed),
  );
}

/**
 * One reading shared by several gauges in the same scrape: the source is asked at most once per
 * `ttlMs` (a scrape reads every gauge within milliseconds), and a failed read is not kept.
 */
export function sharedReading<T>(read: () => Promise<T>, ttlMs = 1_000): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | undefined;
  return () => {
    const now = Date.now();
    if (cached === undefined || now - cached.at > ttlMs) {
      const value = read();
      cached = { at: now, value };
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    return cached.value;
  };
}
