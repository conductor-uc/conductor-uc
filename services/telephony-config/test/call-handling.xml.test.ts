import { describe, expect, it } from 'vitest';

import { drTag } from '../src/repo/opensips-projection.repo.js';
import {
  buildCallHandlingDialplanDocument,
  type CallHandlingPlan,
  type PlanLeg,
} from '../src/xml.js';

/** Pure string tests of the dialplan XML for parity 1a — no database, no FreeSWITCH. */

const TENANT = 'tenant-1';
const DOMAIN = 'acme.platform.test';
const SIP = 'opensips:5060';
const own: PlanLeg = { kind: 'internal', number: '101', forwarded: false };
const ext102: PlanLeg = { kind: 'internal', number: '102', forwarded: true };
const external = (
  normalizedNumber = '+14155552671',
  callerId: { name: string | null; number: string | null } | null = {
    name: 'Front Desk',
    number: '+15559990000',
  },
): PlanLeg => ({ kind: 'external', normalizedNumber, drGroupId: 7, callerId });

const base: CallHandlingPlan = {
  hops: 0,
  dnd: null,
  forwardAlways: null,
  ringLegs: [own],
  ringSeconds: 20,
  onBusy: null,
  onNoAnswer: null,
  onUnreachable: null,
  maxConcurrentChannels: null,
};

function build(plan: Partial<CallHandlingPlan>): string {
  return buildCallHandlingDialplanDocument('public', '101', DOMAIN, SIP, TENANT, {
    ...base,
    ...plan,
  });
}

/** Every `<action application="x" data="y"/>` in order, data still XML-escaped. */
function actions(xml: string): { app: string; data: string }[] {
  return [...xml.matchAll(/<action application="([^"]+)" data="([^"]*)"\/>/g)].map((m) => ({
    app: m[1] ?? '',
    data: m[2] ?? '',
  }));
}
const apps = (xml: string) => actions(xml).map((a) => a.app);
const bridges = (xml: string) => actions(xml).filter((a) => a.app === 'bridge');
const setData = (xml: string, name: string) =>
  actions(xml).find((a) => a.app === 'set' && a.data.startsWith(`${name}=`))?.data;

describe('buildCallHandlingDialplanDocument', () => {
  it('rings just the extension when nothing is configured: one bridge, no fallbacks, attributed to the tenant', () => {
    const xml = build({});
    expect(xml).toContain('<condition field="destination_number" expression="^101$">');
    expect(actions(xml)[0]?.data).toBe('cuc_tenant_id=tenant-1');
    expect(bridges(xml)).toEqual([
      {
        app: 'bridge',
        data: '[sip_route_uri=sip:opensips:5060]sofia/internal/101@acme.platform.test',
      },
    ]);
    expect(setData(xml, 'continue_on_fail')).toBeUndefined();
    expect(apps(xml)).not.toContain('lua');
  });

  describe('do not disturb', () => {
    it('to voicemail: the call goes to the mailbox and nothing rings', () => {
      const xml = build({ dnd: { kind: 'voicemail', mailboxId: 'mb-1' } });
      expect(apps(xml)).not.toContain('bridge');
      expect(actions(xml).at(-1)).toEqual({
        app: 'lua',
        data: 'voicemail.lua leave tenant-1 mb-1',
      });
    });

    it('to busy: hangs up USER_BUSY without ringing', () => {
      const xml = build({ dnd: { kind: 'busy' } });
      expect(apps(xml)).not.toContain('bridge');
      expect(actions(xml).at(-1)).toEqual({ app: 'hangup', data: 'USER_BUSY' });
    });

    it('wins over forward always', () => {
      const xml = build({
        dnd: { kind: 'busy' },
        forwardAlways: { kind: 'bridge', legs: [ext102] },
      });
      expect(apps(xml)).not.toContain('bridge');
    });
  });

  describe('forward always', () => {
    it('to an extension: bridges only to it, straight through OpenSIPs, counting the hop', () => {
      const xml = build({ forwardAlways: { kind: 'bridge', legs: [ext102] } });
      expect(bridges(xml)).toEqual([
        {
          app: 'bridge',
          data: '[sip_route_uri=sip:opensips:5060,sip_h_X-Forward-Hops=1]sofia/internal/102@acme.platform.test',
        },
      ]);
      expect(setData(xml, 'continue_on_fail')).toBeUndefined();
    });

    it('to voicemail: runs the voicemail app, never rings the extension', () => {
      const xml = build({ forwardAlways: { kind: 'voicemail', mailboxId: 'mb-9' } });
      expect(apps(xml)).not.toContain('bridge');
      expect(actions(xml).at(-1)?.data).toBe('voicemail.lua leave tenant-1 mb-9');
    });

    it('to an external number: dialled as an outbound call, in this order: channel limit, then a tagged bridge', () => {
      const xml = build({
        forwardAlways: { kind: 'bridge', legs: [external()] },
        maxConcurrentChannels: 4,
      });
      const list = actions(xml);
      const limitAt = list.findIndex((a) => a.app === 'limit');
      const bridgeAt = list.findIndex((a) => a.app === 'bridge');
      expect(list[limitAt]?.data).toBe('redis tenant-1 outbound-channels 4');
      expect(limitAt).toBeGreaterThan(-1);
      expect(limitAt).toBeLessThan(bridgeAt);
      // The dialled user part carries the tenant's routing tag and no `+`, exactly as buildOutboundDialplanDocument does.
      expect(list[bridgeAt]?.data).toBe(
        `[sip_route_uri=sip:opensips:5060,origination_caller_id_number=+15559990000,origination_caller_id_name=&apos;Front Desk&apos;,sip_h_X-Forward-Hops=1]sofia/internal/${drTag(7)}14155552671@${DOMAIN}`,
      );
    });

    it('with no channel limit configured, emits no limit action', () => {
      const xml = build({
        forwardAlways: { kind: 'bridge', legs: [external()] },
        maxConcurrentChannels: null,
      });
      expect(apps(xml)).not.toContain('limit');
    });

    it('carries the incoming hop count forward, plus one', () => {
      const xml = build({ hops: 2, forwardAlways: { kind: 'bridge', legs: [external()] } });
      expect(setData(xml, 'cuc_forward_hops')).toBe('cuc_forward_hops=2');
      expect(bridges(xml)[0]?.data).toContain('sip_h_X-Forward-Hops=3');
    });
  });

  describe('busy, no answer and unreachable', () => {
    it('forward on busy: continues only on USER_BUSY and picks the fallback by the failed cause', () => {
      const xml = build({ onBusy: { kind: 'bridge', legs: [ext102] } });
      expect(setData(xml, 'continue_on_fail')).toBe('continue_on_fail=USER_BUSY');
      expect(setData(xml, 'cuc_cf_USER_BUSY')).toBe(
        'cuc_cf_USER_BUSY=[sip_route_uri=sip:opensips:5060,sip_h_X-Forward-Hops=1]sofia/internal/102@acme.platform.test',
      );
      // Primary first, then the cause-keyed fallback, in that order, no voicemail action.
      const list = actions(xml);
      const primary = list.findIndex((a) => a.app === 'bridge');
      expect(list[primary]?.data).toBe(
        '[sip_route_uri=sip:opensips:5060]sofia/internal/101@acme.platform.test',
      );
      expect(list[primary + 1]).toEqual({
        app: 'bridge',
        data: '${cuc_cf_${originate_disposition}}',
      });
      expect(apps(xml)).not.toContain('lua');
    });

    it('forward on no answer: rings for the configured seconds first, and covers every no-answer cause', () => {
      const xml = build({
        ringSeconds: 35,
        onNoAnswer: { kind: 'bridge', legs: [external()] },
        maxConcurrentChannels: 2,
      });
      expect(bridges(xml)[0]?.data).toBe(
        '{call_timeout=35}[sip_route_uri=sip:opensips:5060]sofia/internal/101@acme.platform.test',
      );
      for (const cause of ['NO_ANSWER', 'NO_USER_RESPONSE', 'RECOVERY_ON_TIMER_EXPIRE']) {
        expect(setData(xml, `cuc_cf_${cause}`)).toContain(`sofia/internal/${drTag(7)}14155552671@`);
      }
      expect(setData(xml, 'continue_on_fail')).toBe(
        'continue_on_fail=NO_ANSWER,NO_USER_RESPONSE,RECOVERY_ON_TIMER_EXPIRE',
      );
      // An external fallback still passes the concurrent-channel limit, before any bridge.
      const list = actions(xml);
      expect(list.findIndex((a) => a.app === 'limit')).toBeLessThan(
        list.findIndex((a) => a.app === 'bridge'),
      );
    });

    it('forward when unreachable: keyed on USER_NOT_REGISTERED and the codes an unregistered phone really produces behind OpenSIPs', () => {
      const xml = build({ onUnreachable: { kind: 'bridge', legs: [ext102] } });
      expect(setData(xml, 'continue_on_fail')).toContain('USER_NOT_REGISTERED');
      for (const cause of ['USER_NOT_REGISTERED', 'UNALLOCATED_NUMBER', 'NO_ROUTE_DESTINATION']) {
        expect(setData(xml, `cuc_cf_${cause}`)).toBeDefined();
      }
    });

    it('never continues on ORIGINATOR_CANCEL: a caller who hangs up is not forwarded', () => {
      const xml = build({
        onBusy: { kind: 'bridge', legs: [ext102] },
        onNoAnswer: { kind: 'bridge', legs: [ext102] },
        onUnreachable: { kind: 'bridge', legs: [ext102] },
      });
      expect(xml).not.toContain('ORIGINATOR_CANCEL');
      expect(xml).not.toContain('NORMAL_CLEARING');
    });

    it('voicemail fallbacks are per cause, run through the voicemail app, and need no second bridge', () => {
      const xml = build({ onNoAnswer: { kind: 'voicemail', mailboxId: 'mb-1' } });
      expect(setData(xml, 'cuc_cf_vm_NO_ANSWER')).toBe('cuc_cf_vm_NO_ANSWER=leave tenant-1 mb-1');
      expect(actions(xml).at(-1)).toEqual({
        app: 'lua',
        data: 'voicemail.lua ${cuc_cf_vm_${originate_disposition}}',
      });
      expect(bridges(xml)).toHaveLength(1);
    });

    it('mixes a bridge and a voicemail fallback across classes', () => {
      const xml = build({
        onBusy: { kind: 'bridge', legs: [ext102] },
        onNoAnswer: { kind: 'voicemail', mailboxId: 'mb-1' },
      });
      expect(setData(xml, 'continue_on_fail')).toBe(
        'continue_on_fail=USER_BUSY,NO_ANSWER,NO_USER_RESPONSE,RECOVERY_ON_TIMER_EXPIRE',
      );
      expect(bridges(xml)).toHaveLength(2);
      expect(apps(xml).at(-1)).toBe('lua');
    });

    it('does not time the ring when there is no no-answer fallback', () => {
      const xml = build({ ringSeconds: 30, onBusy: { kind: 'bridge', legs: [ext102] } });
      expect(bridges(xml)[0]?.data).not.toContain('call_timeout');
    });
  });

  describe('simultaneous ring', () => {
    it('rings the extension and every listed destination at once, comma separated, each with its own variables', () => {
      const xml = build({
        ringLegs: [own, ext102, external('+14155552672', null)],
        onNoAnswer: null,
      });
      const legs = bridges(xml)[0]?.data.split(',[') ?? [];
      // Splitting on ',[' only splits between legs: variables inside a leg use ',' without a bracket.
      expect(legs).toHaveLength(3);
      expect(legs[0]).toContain('sofia/internal/101@');
      expect(legs[1]).toContain('sofia/internal/102@');
      expect(legs[2]).toContain(`sofia/internal/${drTag(7)}14155552672@`);
      // Only the leg that leaves the platform (and the forwarded one) counts the hop.
      expect(legs[0]).not.toContain('X-Forward-Hops');
      expect(legs[2]).toContain('sip_h_X-Forward-Hops=1');
    });

    it('an external ring leg passes the channel limit before the bridge', () => {
      const xml = build({ ringLegs: [own, external()], maxConcurrentChannels: 3 });
      const list = actions(xml);
      expect(list.findIndex((a) => a.app === 'limit')).toBeLessThan(
        list.findIndex((a) => a.app === 'bridge'),
      );
    });

    it('applies the no-answer timeout to the whole group', () => {
      const xml = build({
        ringLegs: [own, ext102],
        ringSeconds: 25,
        onNoAnswer: { kind: 'voicemail', mailboxId: 'mb-1' },
      });
      expect(bridges(xml)[0]?.data.startsWith('{call_timeout=25}[')).toBe(true);
    });
  });

  describe('safety of what goes into a dial string', () => {
    it('strips characters from a caller ID name that could end the value or start a new variable', () => {
      const xml = build({
        forwardAlways: {
          kind: 'bridge',
          legs: [external('+14155552671', { name: "Eve',sip_h_X-A=1}{[", number: '+15559990000' })],
        },
      });
      const data = bridges(xml)[0]?.data ?? '';
      expect(data).toContain('origination_caller_id_name=&apos;Evesip_h_X-A=1&apos;');
      const quoted = /origination_caller_id_name=&apos;(.*?)&apos;/.exec(data)?.[1] ?? '';
      expect(quoted).not.toMatch(/[,{}[\]|']/);
    });

    it('drops a caller ID number that is not plain digits', () => {
      const xml = build({
        forwardAlways: {
          kind: 'bridge',
          legs: [external('+14155552671', { name: null, number: '1,sip_h_X-A=1' })],
        },
      });
      expect(bridges(xml)[0]?.data).not.toContain('origination_caller_id_number');
      expect(bridges(xml)[0]?.data).not.toContain('X-A');
    });

    it('carries no operator or product name anywhere in the document', () => {
      const xml = build({
        dnd: null,
        forwardAlways: null,
        ringLegs: [own, ext102, external()],
        onBusy: { kind: 'bridge', legs: [external()] },
        onNoAnswer: { kind: 'voicemail', mailboxId: 'mb' },
        onUnreachable: { kind: 'bridge', legs: [ext102] },
        maxConcurrentChannels: 5,
      });
      expect(xml.toLowerCase()).not.toMatch(/conductor|cuc-brand/);
      // The only channel/header names this feature adds, both neutral.
      expect(xml).toContain('sip_h_X-Forward-Hops');
    });
  });
});
