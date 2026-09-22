import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  dockerCurlJson,
  dockerCurlUpload,
  fsCli,
  sipInfraOrSkipReason,
  startBackgroundUas,
  stopContainer,
  uasReceivedCall,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TELEPHONY_CONFIG_TARGET = 'telephony-config:8080';
const UAS_CONTAINER = 'sip-test-media-uas';
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/tone.mp3', import.meta.url));

interface CreatedMediaAsset {
  readonly asset: { readonly id: string; readonly status: string };
  readonly uploadUrl: string;
}
interface MediaAssetStatus {
  readonly status: string;
}

/**
 * S2-07's own acceptance test — the same "run the literal thing the plan's
 * own 'Done when' describes" discipline every S2 telephony task has
 * established, adapted the same way G-19 (docs/decisions.md) was: no
 * callflow/IVR feature exists yet to trigger playback through a real call
 * flow (S2-10's own future job, per the plan's dependency graph — S2-07
 * depends only on S0-10/S1-09), so this exercises FreeSWITCH's own
 * `http_cache://` resolution directly via `fs_cli originate`, the same
 * "verify the raw capability, not through routing that does not exist yet"
 * shape G-19 used for outbound-call capability before any dialplan wiring
 * existed for it either.
 *
 * Two things this test cannot independently confirm, both flagged in
 * docs/decisions.md (G-35, G-36) rather than assumed silently: whether
 * `mod_http_cache`'s own default cache location/size settings (no
 * `http_cache.conf.xml` exists — this task deliberately did not add one
 * with guessed parameter names) are adequate, and the exact `fs_cli
 * originate` dial-string syntax below, neither of which this task's own
 * environment could verify against a real FreeSWITCH process. This suite
 * is exactly the live check for both — a real failure here is the expected,
 * useful outcome if either assumption is wrong, not a surprise.
 */
describe.skipIf(skipReason !== undefined)('S2-07 media asset playback', () => {
  beforeAll(async () => {
    // Fails loudly and immediately if the fixture is ever missing, rather
    // than surfacing as a confusing upload failure deep in the test body.
    await access(FIXTURE_PATH);
  });

  afterEach(async () => {
    await stopContainer(UAS_CONTAINER);
  });

  async function waitForReady(
    tenantId: string,
    assetId: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await dockerCurlJson(
        'GET',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets/${assetId}`,
      );
      const status = (response.json as MediaAssetStatus | undefined)?.status;
      if (status === 'ready') return;
      if (status === 'failed') {
        throw new Error(
          `media asset ${assetId} failed to transcode: ${JSON.stringify(response.json)}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `media asset ${assetId} did not reach 'ready' within ${String(timeoutMs)}ms (last status: ${String(status)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  it('an uploaded MP3 is transcoded end to end, and FreeSWITCH plays it back via http_cache', async () => {
    const tenantId = crypto.randomUUID();

    const created = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets`,
      { kind: 'prompt', label: 'SIP test prompt', contentType: 'audio/mpeg' },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const { asset, uploadUrl } = created.json as CreatedMediaAsset;

    const uploaded = await dockerCurlUpload(uploadUrl, FIXTURE_PATH, 'audio/mpeg');
    expect(uploaded.status).toBe(200);

    const finalized = await dockerCurlJson(
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/media-assets/${asset.id}/finalize`,
    );
    expect(finalized.status, JSON.stringify(finalized.json)).toBe(200);

    // Real work: the transcode worker consumes the event, fetches the raw
    // upload, runs ffmpeg, and reports back — not instantaneous.
    await waitForReady(tenantId, asset.id);

    const uas = startBackgroundUas('carrier_answer.xml', UAS_CONTAINER, 5095);
    await uas.ready();

    const mediaUrl = `http_cache://${TELEPHONY_CONFIG_TARGET}/fs/media/${tenantId}/${asset.id}/8k`;
    // Confirmed live (G-36): this node has only an `internal` Sofia
    // profile (`fs_cli sofia status`) — 03 §1's "FS accepts calls only
    // from OpenSIPs, over one internal-facing profile" — there is no
    // `external` profile to originate through.
    await fsCli(
      `originate {ignore_early_media=true}sofia/internal/900@${UAS_CONTAINER}:5095 &playback(${mediaUrl})`,
    );

    // `carrier_answer.xml` answers, then waits for the BYE `playback`'s own
    // completion triggers (FS hangs up once the last app in an origination
    // finishes) — a real answered-and-held call is only possible if FS
    // actually resolved and played real audio, not an instant failure.
    //
    // Unlike `outbound_failover.test.ts`'s own use of this same check
    // (which waits on `runForeground`, itself blocking until the call
    // fully ends), `fsCli`'s `originate` only blocks until the call leg is
    // *created* (`+OK <uuid>`), not until the call/playback/BYE actually
    // finish. Confirmed live: checking immediately raced the real call
    // every time. A generous wait past the fixture's own ~2s duration,
    // same idiom as outbound_failover.test.ts's own comment on log-flush
    // lag, covers both that and the actual call taking real time.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const receivedCall = await uasReceivedCall(UAS_CONTAINER);
    expect(receivedCall).toBe(true);
  }, 60_000);
});
