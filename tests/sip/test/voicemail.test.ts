import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  dockerCurlText,
  tenantAdminCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  startDelayedCaller,
  stopContainer,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const VOICEMAIL_SERVICE_URL = 'http://voicemail-service:8080';
const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const TRUNK_SERVICE_URL = 'http://trunk-service:8080';
/** Same reasoning `trunk_did_routing.test.ts`/`queue.test.ts` already give:
 * a carrier addresses OpenSIPs' own trunk termination point, never a
 * tenant domain. */
const CARRIER_TARGET_DOMAIN = 'opensips';
const CALLER_CONTAINER = 'sip-test-vm-caller';
const MAILBOX_PIN = '5678';
const SPOOL_DIR = '/var/spool/cuc/rec';

interface ExtensionRow {
  readonly id: string;
  readonly number: string;
}

interface CreatedMailbox {
  readonly id: string;
  readonly extensionId: string;
}

interface MessageRow {
  readonly id: string;
  readonly status: string;
  readonly durationMs: number | null;
}

/**
 * S2-20 (G-41, docs/decisions.md): `voicemail.lua`'s own two entry
 * points get their first live proof here. `withSingleFsNode` for the same
 * reason parking/conference/queue already use it: a mailbox has no
 * affinity lease of its own (S2-16 never gave it one, unlike
 * queue/parking/conference), but pinning to one node keeps every call in
 * this file on the same node as everything else this test creates,
 * avoiding an unrelated round-robin surprise. It is also what makes
 * `sipTestEnv().freeswitchContainer` the node whose spool the leave-message
 * case inspects.
 *
 * S5-16: leaving a message is proved end to end, not just a message row:
 * the recording is delivered by the node uploader, verified in storage,
 * playable through its play URL, and gone from the node's spool.
 *
 * The "leave a message" case dials a DID bound directly to the mailbox
 * (`destinationType: 'voicemail'`) rather than exercising
 * `buildDialplanDocument`'s own bridge-then-fallback shape
 * (`continue_on_fail` on a bridged extension) — deliberately: that path
 * was tried first, with a real registered UAS scripted to reject with 486
 * Busy Here (a real, deterministic hangup cause, not a guess), and found
 * live, with a full packet trace, to be broken — FreeSWITCH relays the
 * B-leg's 486 straight back to the caller instead of continuing to
 * `voicemail.lua`, with neither the documented cause-list form
 * (`continue_on_fail=NORMAL_CLEARING,USER_BUSY,...`) nor the catch-all
 * form (`continue_on_fail=true`, combined with `hangup_after_bridge=false`
 * per FreeSWITCH's own docs) making any difference — identical relayed
 * response both times. This matches a known, unresolved upstream
 * FreeSWITCH issue (signalwire/freeswitch#2591, "continue_on_fail setting
 * does not take effect", filed 2024) closely enough that this task treats
 * it as that, not a config mistake — see `docs/decisions.md` G-41 for the
 * full detail and the `xml.ts` change kept anyway (the docs-recommended
 * form, even though unconfirmed to work here). The DID-to-mailbox path
 * tested here has no such dependency: `handleDidDial` returns
 * `voicemail.lua leave` directly, no bridge involved at all.
 */
describe.skipIf(skipReason !== undefined)('S2-16 voicemail (live SIPp, G-41)', () => {
  let seed: SeedResult;

  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  afterEach(async () => {
    await stopContainer(CALLER_CONTAINER);
  });

  async function findExtension(tenantId: string, number: string): Promise<ExtensionRow> {
    const response = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const { rows } = response.json as { rows: ExtensionRow[] };
    const extension = rows.find((row) => row.number === number);
    if (extension === undefined) throw new Error(`no seeded extension '${number}' for ${tenantId}`);
    return extension;
  }

  async function createMailbox(tenantId: string, extensionId: string): Promise<CreatedMailbox> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes`,
      { extensionId, pin: MAILBOX_PIN },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return created.json as CreatedMailbox;
  }

  async function deleteMailbox(tenantId: string, id: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${id}`,
    );
  }

  async function listMessages(tenantId: string, mailboxId: string): Promise<MessageRow[]> {
    const response = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailboxId}/messages`,
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return (response.json as { rows: MessageRow[] }).rows;
  }

  /**
   * S5-16: a message is listed only once the node uploader has delivered its
   * audio and voicemail-service has verified it in storage. The uploader waits
   * for the file to settle (30 s in compose) first, so this polls.
   */
  async function waitForReadyMessage(tenantId: string, mailboxId: string): Promise<MessageRow> {
    const deadline = Date.now() + 90_000;
    let last: MessageRow[] = [];
    while (Date.now() < deadline) {
      last = await listMessages(tenantId, mailboxId);
      const ready = last.find((message) => message.status === 'ready');
      if (ready !== undefined) return ready;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(
      `no ready message after 90 s; listed: ${JSON.stringify(last)}; spool: ${JSON.stringify(await spoolListing())}`,
    );
  }

  async function spoolListing(): Promise<string[]> {
    const { stdout } = await execFileAsync('docker', [
      'exec',
      sipTestEnv().freeswitchContainer,
      'ls',
      '-A',
      SPOOL_DIR,
    ]);
    return stdout.split('\n').filter((name) => name !== '');
  }

  async function createIpTrunk(tenantId: string, ip: string): Promise<{ id: string }> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks`,
      {
        name: 'S2-20 voicemail trunk',
        authMode: 'ip',
        host: ip,
        port: 5060,
        transport: 'udp',
        codecs: ['PCMU'],
      },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const trunk = created.json as { id: string };
    const ipAdded = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunk.id}/ips`,
      { cidr: `${ip}/32` },
    );
    expect(ipAdded.status, JSON.stringify(ipAdded.json)).toBe(201);
    return trunk;
  }

  async function deleteTrunk(tenantId: string, trunkId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${TRUNK_SERVICE_URL}/v1/tenants/${tenantId}/trunks/${trunkId}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  async function createVoicemailDid(
    tenantId: string,
    e164: string,
    trunkId: string,
    mailboxId: string,
  ): Promise<string> {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids`,
      { e164, trunkId, destinationType: 'voicemail', destinationId: mailboxId },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    return (created.json as { id: string }).id;
  }

  async function deleteDid(tenantId: string, didId: string): Promise<void> {
    await tenantAdminCurlJson(
      seed.resellerId,
      'DELETE',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/dids/${didId}`,
    );
  }

  it('a DID bound directly to a mailbox records a message, and its audio reaches storage', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;

      const extension401 = await findExtension(tenantId, '401');
      const mailbox = await createMailbox(tenantId, extension401.id);
      let trunk: { id: string } | undefined;
      let didId: string | undefined;
      try {
        // Real-time settling window for pbx.voicemail_mailbox.created's own
        // event-driven projection into telephony-config's local mirror —
        // same reasoning every other resource-creating test here uses.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const e164 = `+1555999${String(Math.floor(1000 + Math.random() * 9000))}`;
        const caller = await startDelayedCaller({
          scenario: 'trunk_invite_wait_for_bye.xml',
          csvLine: `carrier;${CARRIER_TARGET_DOMAIN};${e164}`,
          containerName: CALLER_CONTAINER,
        });
        trunk = await createIpTrunk(tenantId, caller.ip);
        didId = await createVoicemailDid(tenantId, e164, trunk.id, mailbox.id);

        // `trunk_invite_wait_for_bye.xml`'s own doc comment has the full
        // detail on why this scenario waits for FS's own BYE rather than
        // scripting a fixed hold: `voicemail.lua`'s own leave-message flow
        // (create the message row, answer, "play" the silent intro,
        // record into the spool) hangs up on its own once it
        // finishes, reliably faster than any fixed hold a scenario could
        // script (SIPp sends no real RTP audio, so FS's own silence-based
        // auto-stop ends the recording almost immediately) — the caller's
        // own 200 OK only arrives once `voicemail.lua` actually answers,
        // proof the DID genuinely routed to the Lua app and not just a
        // dialplan miss.
        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);

        // S5-16: the recording stays in the node spool as `vm-<id>.wav`
        // until the uploader sidecar delivers it; only then, with its size
        // and MD5 checked against storage, is the message listed.
        const message = await waitForReadyMessage(tenantId, mailbox.id);

        // The audio is really in storage: its play URL serves a WAV.
        const playUrl = await tenantAdminCurlJson(
          seed.resellerId,
          'GET',
          `${VOICEMAIL_SERVICE_URL}/v1/tenants/${tenantId}/voicemail/mailboxes/${mailbox.id}/messages/${message.id}/play-url`,
        );
        expect(playUrl.status, JSON.stringify(playUrl.json)).toBe(200);
        const audio = await dockerCurlText((playUrl.json as { url: string }).url);
        expect(audio.status).toBe(200);
        expect(audio.text.startsWith('RIFF')).toBe(true);

        // Nothing durable on the node (CLAUDE.md rule 5): the uploader deleted its copy.
        expect(await spoolListing()).not.toContain(`vm-${message.id}.wav`);
      } finally {
        if (didId !== undefined) await deleteDid(tenantId, didId);
        if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
        await deleteMailbox(tenantId, mailbox.id);
      }
    });
  }, 180_000);

  it('the mailbox owner retrieves messages via *97 with the correct PIN', async () => {
    await withSingleFsNode(async () => {
      const tenantId = seed.tenantVoicemail.id;
      const tenantFqdn = seed.tenantVoicemail.fqdn;
      const ext401 = seed.extensions[`${tenantFqdn}/401`];
      if (ext401 === undefined) throw new Error('tenantVoicemail/401 was not seeded');
      await clearRegistration(`401@${tenantFqdn}`);

      const extension401 = await findExtension(tenantId, '401');
      const mailbox = await createMailbox(tenantId, extension401.id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await runForeground({
          scenario: 'uac_call_voicemail_retrieve.xml',
          csvLine: `401;${tenantFqdn}`,
          au: '401',
          ap: ext401.password,
          authUri: tenantFqdn,
          containerName: CALLER_CONTAINER,
        });
        // Success here means the whole `retrieveMessages` flow ran to
        // completion without SIPp aborting — PIN accepted (otherwise FS
        // hangs up after 3 wrong attempts, well before this scenario's
        // own `<recv request="BYE">` step, the same "unexpected BYE"
        // abort `uac_call_wrong_pin.xml`'s own doc comment already
        // explains), an empty mailbox's own message loop skipped
        // cleanly, and FS hung up on its own as scripted.
        expect(result.successfulCalls, result.stdout).toBe(1);
      } finally {
        await deleteMailbox(tenantId, mailbox.id);
      }
    });
  }, 30_000);
});
