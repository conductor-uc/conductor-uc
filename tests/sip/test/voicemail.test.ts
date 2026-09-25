import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  tenantAdminCurlJson,
  runForeground,
  seedFixtures,
  sipInfraOrSkipReason,
  startDelayedCaller,
  stopContainer,
  withSingleFsNode,
  type SeedResult,
} from '../src/run-scenario.js';

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
}

/**
 * S2-20 (G-41, docs/decisions.md): `voicemail.lua`'s own two entry
 * points get their first live proof here. `withSingleFsNode` for the same
 * reason parking/conference/queue already use it: a mailbox has no
 * affinity lease of its own (S2-16 never gave it one, unlike
 * queue/parking/conference), but pinning to one node keeps every call in
 * this file on the same node as everything else this test creates,
 * avoiding an unrelated round-robin surprise.
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

  it('a DID bound directly to a mailbox records a message', async () => {
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
        // record, upload, mark complete) hangs up on its own once it
        // finishes, reliably faster than any fixed hold a scenario could
        // script (SIPp sends no real RTP audio, so FS's own silence-based
        // auto-stop ends the recording almost immediately) — the caller's
        // own 200 OK only arrives once `voicemail.lua` actually answers,
        // proof the DID genuinely routed to the Lua app and not just a
        // dialplan miss.
        const result = await caller.result();
        expect(result.successfulCalls, result.stdout).toBe(1);

        // Real time for `voicemail.lua`'s own post-hangup steps (the PUT
        // upload to the presigned URL, then the `/complete` call) to land
        // — none of that is guaranteed to have finished by the moment the
        // channel itself tears down.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const messages = await listMessages(tenantId, mailbox.id);
        expect(messages.length).toBeGreaterThanOrEqual(1);
      } finally {
        if (didId !== undefined) await deleteDid(tenantId, didId);
        if (trunk !== undefined) await deleteTrunk(tenantId, trunk.id);
        await deleteMailbox(tenantId, mailbox.id);
      }
    });
  }, 45_000);

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
