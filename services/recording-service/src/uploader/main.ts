import { createServer as createHttpServer } from 'node:http';

import { redactConfig } from '@cuc/config';
import { createLogger } from '@cuc/logger';

import { createRecordingApi, createVoicemailApi } from './client.js';
import { loadUploaderConfig, uploaderConfigSchema } from './config.js';
import { createUploader, renderMetrics } from './uploader.js';

const config = loadUploaderConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(uploaderConfigSchema, config), 'starting');

const uploader = createUploader({
  spoolDir: config.SPOOL_DIR,
  apis: {
    recording: createRecordingApi({
      baseUrl: config.RECORDING_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
    voicemail: createVoicemailApi({
      baseUrl: config.VOICEMAIL_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
  },
  logger,
  settleMs: config.SETTLE_SECONDS * 1000,
  abandonedMs: config.ABANDONED_AFTER_SECONDS * 1000,
  stuckMs: config.STUCK_AFTER_SECONDS * 1000,
  backoffBaseMs: config.BACKOFF_BASE_MS,
  backoffMaxMs: config.BACKOFF_MAX_MS,
  concurrency: config.CONCURRENCY,
});

const metricsServer = createHttpServer((request, response) => {
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(renderMetrics(uploader.metrics()));
    return;
  }
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === '/statusz') {
    // S4-12: the operations console's view of this node's spool (api-gateway asks it, when listed
    // in its PLATFORM_STATUS_TARGETS), the same shape `@cuc/http` gives every service.
    const metrics = uploader.metrics();
    const memory = process.memoryUsage();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        service: config.SERVICE_NAME,
        version: config.SERVICE_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        ready: true,
        checks: [],
        memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
        sections: {
          facts: [
            { label: 'Spool files', value: metrics.spoolFiles, unit: 'count' },
            { label: 'Spool size', value: metrics.spoolBytes, unit: 'bytes' },
            { label: 'Stuck files', value: metrics.stuckFiles, unit: 'count' },
            { label: 'Oldest file', value: metrics.oldestFileAgeSeconds, unit: 'seconds' },
            { label: 'Uploaded', value: metrics.uploadedTotal, unit: 'count' },
          ],
        },
      }),
    );
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((resolve) => {
  metricsServer.listen(config.METRICS_PORT, config.METRICS_HOST, resolve);
});

uploader.start(config.SCAN_INTERVAL_MS);
logger.info({ spoolDir: config.SPOOL_DIR, metricsPort: config.METRICS_PORT }, 'watching the spool');

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  uploader.stop();
  metricsServer.close();
  // Files still in the spool stay there: the next start finishes them.
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
