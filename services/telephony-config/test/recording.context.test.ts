import { describe, expect, it } from 'vitest';

import { decodeRecordingContext, encodeRecordingContext } from '../src/recording-context.js';
import {
  agentAnswerRecordingActions,
  agentContact,
  featureCodeListenLegs,
  recordingFeatureCodeActions,
} from '../src/xml.js';

/** S5-13: the call context a feature code carries back, and the actions that arm the codes. */
describe('recording call context (S5-13)', () => {
  it('round-trips, and survives FreeSWITCH variables and mod_curl (no spaces, commas or quotes)', () => {
    const context = {
      tenantId: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
      direction: 'inbound' as const,
      extensionIds: ['e1', 'e2'],
      queueId: 'q1',
      didId: 'd1',
    };
    const token = encodeRecordingContext(context);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRecordingContext(token)).toEqual(context);
    expect(
      decodeRecordingContext(
        encodeRecordingContext({ tenantId: 't', direction: 'internal', extensionIds: [] }),
      ),
    ).toEqual({ tenantId: 't', direction: 'internal', extensionIds: [] });
  });

  it('rejects anything this service did not make', () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const bad of [
      'not base64 json',
      encode(null),
      encode({ d: 'inbound', e: [] }),
      encode({ t: 't', d: 'sideways', e: [] }),
      encode({ t: 't', d: 'inbound', e: 'e1' }),
      encode({ t: 't', d: 'inbound', e: [1] }),
      encode({ t: 't', d: 'inbound', e: [], q: 5 }),
      encode({ t: 'x'.repeat(40), d: 'inbound', e: [] }),
    ]) {
      expect(decodeRecordingContext(bad), bad).toBeUndefined();
    }
  });

  it('listens on the internal party only', () => {
    expect(featureCodeListenLegs('inbound')).toBe('b');
    expect(featureCodeListenLegs('outbound')).toBe('a');
    expect(featureCodeListenLegs('internal')).toBe('ab');
  });

  it('S5-14: an agent is dialed through OpenSIPs, and a queue call arms the agent answer', () => {
    expect(agentContact('301@t.example', 'opensips:5060')).toBe(
      '{sip_route_uri=sip:opensips:5060}sofia/internal/301@t.example',
    );
    expect(agentAnswerRecordingActions('Q1', undefined)).toEqual([
      '<action application="set" data="cuc_queue_id=Q1"/>',
      '<action application="set" data="cuc_queue_member_uuid=${uuid}"/>',
      '<action application="set" data="execute_on_answer_cuc_agent=lua agent_recording.lua"/>',
      '<action application="set" data="cc_export_vars=cuc_tenant_id,cuc_queue_id,cuc_did_id,cuc_queue_member_uuid,execute_on_answer_cuc_agent"/>',
    ]);
    expect(agentAnswerRecordingActions('Q1', 'D1')[1]).toBe(
      '<action application="set" data="cuc_did_id=D1"/>',
    );
  });

  it('arms *1 and *2 with the context, the owner and stereo', () => {
    const actions = recordingFeatureCodeActions({ direction: 'inbound', contextToken: 'abc' });
    expect(actions).toEqual([
      '<action application="set" data="cuc_rec_ctx=abc"/>',
      '<action application="export" data="cuc_rec_owner=${uuid}"/>',
      '<action application="set" data="RECORD_STEREO=true"/>',
      '<action application="bind_meta_app" data="1 b s lua::recording_control.lua record"/>',
      '<action application="bind_meta_app" data="2 b s lua::recording_control.lua pause"/>',
    ]);
  });
});
