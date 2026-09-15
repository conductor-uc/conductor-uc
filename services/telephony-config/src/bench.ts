/**
 * S1-13's literal "Done when": p99 below 20ms for `/fs/directory` and
 * `/fs/dialplan` at 200 requests/s per FS node (03 §3.1). A manual tool, not
 * a CI-gated test — like the rest of this session's real-infra verification,
 * it is run once against a real running instance and the result recorded in
 * the PR description, not asserted on every push (latency numbers on a
 * shared CI runner are not a meaningful pass/fail signal).
 *
 * Usage: point it at a running telephony-config with at least one seeded
 * tenant/domain/extension (see this PR's description for the exact seed
 * used), then:
 *
 *   BENCH_URL=http://127.0.0.1:8080 FS_XML_CURL_TOKEN=... \
 *   BENCH_TENANT_ID=... BENCH_DOMAIN=acme.platform.test BENCH_NUMBER=102 \
 *   node dist/src/bench.js
 */

interface Sample {
  readonly ms: number;
  readonly ok: boolean;
}

async function timedRequest(
  url: string,
  token: string,
  body: Record<string, string>,
): Promise<Sample> {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`fs-node:${token}`).toString('base64')}`,
      },
      body: new URLSearchParams(body).toString(),
    });
    await response.text();
    return { ms: performance.now() - start, ok: response.status === 200 };
  } catch {
    return { ms: performance.now() - start, ok: false };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

async function runFor(
  label: string,
  durationMs: number,
  ratePerSec: number,
  makeBody: () => Record<string, string>,
  baseUrl: string,
  path: string,
  token: string,
): Promise<void> {
  const intervalMs = 1000 / ratePerSec;
  const samples: Sample[] = [];
  const inFlight: Promise<void>[] = [];
  const deadline = performance.now() + durationMs;

  while (performance.now() < deadline) {
    const p = timedRequest(`${baseUrl}${path}`, token, makeBody()).then((sample) => {
      samples.push(sample);
    });
    inFlight.push(p);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await Promise.all(inFlight);

  const ok = samples.filter((s) => s.ok);
  const failed = samples.length - ok.length;
  const sorted = ok.map((s) => s.ms).sort((a, b) => a - b);

  process.stdout.write(
    `\n${label}: ${String(samples.length)} requests, ${String(failed)} failed\n` +
      `  p50: ${percentile(sorted, 50).toFixed(2)}ms\n` +
      `  p95: ${percentile(sorted, 95).toFixed(2)}ms\n` +
      `  p99: ${percentile(sorted, 99).toFixed(2)}ms\n` +
      `  max: ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}ms\n`,
  );
}

async function main(): Promise<void> {
  const baseUrl = process.env.BENCH_URL ?? 'http://127.0.0.1:8080';
  const token = process.env.FS_XML_CURL_TOKEN;
  const tenantId = process.env.BENCH_TENANT_ID;
  const domain = process.env.BENCH_DOMAIN;
  const number = process.env.BENCH_NUMBER;
  if (
    token === undefined ||
    tenantId === undefined ||
    domain === undefined ||
    number === undefined
  ) {
    process.stderr.write(
      'Set FS_XML_CURL_TOKEN, BENCH_TENANT_ID, BENCH_DOMAIN, BENCH_NUMBER (see src/bench.ts header).\n',
    );
    process.exit(1);
  }

  const durationMs = Number(process.env.BENCH_DURATION_MS ?? '5000');
  const ratePerSec = Number(process.env.BENCH_RATE ?? '200');

  await runFor(
    '/fs/directory',
    durationMs,
    ratePerSec,
    () => ({ section: 'directory', tag_name: 'domain', key_name: 'name', key_value: domain }),
    baseUrl,
    '/fs/directory',
    token,
  );

  await runFor(
    '/fs/dialplan',
    durationMs,
    ratePerSec,
    () => ({
      section: 'dialplan',
      'Caller-Context': 'public',
      'Caller-Destination-Number': number,
      'variable_sip_h_X-Tenant-Id': tenantId,
      'variable_sip_h_X-Call-Direction': 'internal',
    }),
    baseUrl,
    '/fs/dialplan',
    token,
  );
}

await main();
