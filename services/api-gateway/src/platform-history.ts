import { ProblemError, Type, type PermissionResolver, type Server } from '@cuc/http';

import { requireObserver } from './platform-overview.js';

type Unit = 'count' | 'percent' | 'perSecond' | 'seconds' | 'bytes';

interface Chart {
  readonly unit: Unit;
  /** PromQL. Fixed here: nothing from the request ever becomes part of a query. */
  readonly query: string;
  /** The label that names each line; none for a single line. */
  readonly seriesLabel?: string;
}

/**
 * S4-13 (G-124): the charts the operations console can draw over time, each a fixed PromQL query
 * over the metrics every service exports (`@cuc/http` `/metrics`). A browser picks one by name and
 * a range; it never sends a query.
 */
export const CHARTS: Readonly<Record<string, Chart>> = {
  'calls-by-node': { unit: 'count', query: 'sum by (node) (fs_node_calls)', seriesLabel: 'node' },
  'sessions-by-node': {
    unit: 'count',
    query: 'sum by (node) (fs_node_sessions)',
    seriesLabel: 'node',
  },
  'node-cpu': {
    unit: 'percent',
    query: '100 - avg by (node) (fs_node_cpu_idle_percent)',
    seriesLabel: 'node',
  },
  registrations: { unit: 'count', query: 'sum(opensips_registrations)' },
  dialogs: { unit: 'count', query: 'sum(opensips_active_dialogs)' },
  'request-rate': {
    unit: 'perSecond',
    query: 'sum by (service) (rate(http_server_request_duration_seconds_count[5m]))',
    seriesLabel: 'service',
  },
  'error-rate': {
    unit: 'perSecond',
    query:
      'sum by (service) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))',
    seriesLabel: 'service',
  },
  'latency-p95': {
    unit: 'seconds',
    query:
      'histogram_quantile(0.95, sum by (le, service) (rate(http_server_request_duration_seconds_bucket[5m])))',
    seriesLabel: 'service',
  },
  'outbox-pending': {
    unit: 'count',
    query: 'sum by (service) (outbox_pending)',
    seriesLabel: 'service',
  },
  'consumer-backlog': {
    unit: 'count',
    query: 'sum by (consumer) (nats_consumer_pending + nats_consumer_ack_pending)',
    seriesLabel: 'consumer',
  },
};

/** Each range, and the step that gives it about 120 points. */
export const RANGES = {
  '1h': { seconds: 3_600, step: 30 },
  '6h': { seconds: 21_600, step: 180 },
  '24h': { seconds: 86_400, step: 720 },
  '7d': { seconds: 604_800, step: 5_040 },
} as const;

interface PrometheusMatrix {
  readonly status: string;
  readonly data?: {
    readonly resultType: string;
    readonly result: readonly {
      readonly metric: Readonly<Record<string, string>>;
      readonly values: readonly [number, string][];
    }[];
  };
}

/**
 * `GET /v1/platform/metrics/{chart}?range=1h|6h|24h|7d` (S4-13, `platform.observe`, master only):
 * one chart of the operations console's history, from Prometheus (`PROMETHEUS_URL`), as
 * `{chart, unit, range, stepSeconds, series: [{label, points: [[unixSeconds, value], ...]}]}`.
 * 404 `unknown_chart`; 503 `history_unavailable` when no Prometheus is configured or it does not
 * answer, and the console then draws only what it has seen since it opened.
 */
export function registerPlatformHistory(
  app: Server,
  options: {
    readonly prometheusUrl?: string;
    readonly permissions: PermissionResolver;
    readonly timeoutMs: number;
  },
): void {
  const unavailable = (detail: string): ProblemError =>
    ProblemError.unavailable(detail, { code: 'history_unavailable' });

  app.get(
    '/v1/platform/metrics/:chart',
    {
      config: { permission: 'platform.observe', dataClass: 'config' },
      schema: {
        params: Type.Object({ chart: Type.String({ minLength: 1, maxLength: 64 }) }),
        querystring: Type.Object({
          range: Type.Optional(
            Type.Union([
              Type.Literal('1h'),
              Type.Literal('6h'),
              Type.Literal('24h'),
              Type.Literal('7d'),
            ]),
          ),
        }),
      },
    },
    async (request) => {
      await requireObserver(request.context, options.permissions);
      const chart = Object.hasOwn(CHARTS, request.params.chart)
        ? CHARTS[request.params.chart]
        : undefined;
      if (chart === undefined) {
        throw ProblemError.notFound('There is no such chart.', { code: 'unknown_chart' });
      }
      if (options.prometheusUrl === undefined) {
        throw unavailable('History is not set up: the gateway has no PROMETHEUS_URL.');
      }
      const rangeName = request.query.range ?? '1h';
      const range = RANGES[rangeName];
      const end = Math.floor(Date.now() / 1000);
      const url = new URL('/api/v1/query_range', options.prometheusUrl);
      url.searchParams.set('query', chart.query);
      url.searchParams.set('start', String(end - range.seconds));
      url.searchParams.set('end', String(end));
      url.searchParams.set('step', String(range.step));

      let body: PrometheusMatrix;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
        if (!response.ok) throw new Error(`Prometheus answered ${String(response.status)}`);
        body = (await response.json()) as PrometheusMatrix;
      } catch (error) {
        request.log.warn({ err: error, chart: request.params.chart }, 'history: Prometheus failed');
        throw unavailable('History is not available right now.');
      }

      const series = (body.data?.result ?? []).map((result) => ({
        label:
          chart.seriesLabel === undefined
            ? request.params.chart
            : (result.metric[chart.seriesLabel] ?? 'unknown'),
        points: result.values.flatMap(([at, value]) => {
          const number = Number(value);
          return Number.isFinite(number) ? [[at, number] as const] : [];
        }),
      }));
      series.sort((a, b) => a.label.localeCompare(b.label));
      return {
        chart: request.params.chart,
        unit: chart.unit,
        range: rangeName,
        stepSeconds: range.step,
        series,
      };
    },
  );
}
