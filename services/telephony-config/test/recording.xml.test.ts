import { describe, expect, it } from 'vitest';

import {
  CONSENT_TONE,
  RECORDING_UNAVAILABLE_ACTION,
  buildDialplanDocument,
  buildOutboundDialplanDocument,
  buildQueueDialplanDocument,
  buildRingGroupDialplanDocument,
  injectDialplanActions,
  recordingActions,
  recordingSpoolPath,
} from '../src/xml.js';

const ID = '5f1c2b7e-0a3d-4c1e-9d2a-7b8e4f6a1c3d';
const SPOOL = '/var/spool/cuc/rec';
const TENANT = '0e7a9d2c-1111-4222-8333-444455556666';

const base = { recordingId: ID, spoolDir: SPOOL, announce: false, consentUrl: null };

describe('recording actions (S5-02)', () => {
  it('records to the spool in stereo from answer, with the opaque id as the whole file name', () => {
    expect(recordingActions(base)).toEqual([
      `<action application="set" data="cuc_recording_id=${ID}"/>`,
      '<action application="set" data="RECORD_STEREO=true"/>',
      '<action application="set" data="recording_follow_transfer=true"/>',
      `<action application="set" data="execute_on_answer=record_session ${SPOOL}/${ID}.wav"/>`,
    ]);
  });

  it('never runs record_session before answer, which would pre-answer the call and kill ringback', () => {
    for (const announce of [false, true]) {
      const actions = recordingActions({ ...base, announce });
      expect(actions.some((a) => a.includes('application="record_session"'))).toBe(false);
    }
  });

  it('plays the announcement before recording starts, without answering the call', () => {
    const actions = recordingActions({ ...base, announce: true });
    const names = actions.map((a) => /application="([^"]+)"/.exec(a)?.[1]);
    expect(names).toEqual(['set', 'pre_answer', 'playback', 'set', 'set', 'set']);
    const armed = actions.findIndex((a) => a.includes('execute_on_answer=record_session'));
    expect(names.indexOf('playback')).toBeLessThan(armed);
    expect(names).not.toContain('answer');
  });

  it('with no announcement asset, plays a neutral tone: no words, no names', () => {
    const [, , playback] = recordingActions({ ...base, announce: true });
    expect(playback).toBe(`<action application="playback" data="${CONSENT_TONE}"/>`);
    expect(CONSENT_TONE).toMatch(/^tone_stream:\/\/%\([0-9,]+\);loops=\d+$/);
  });

  it("plays the tenant's own announcement asset when the policy names one", () => {
    const url = 'http_cache://http://fs-node:tok@telephony-config:8080/fs/media/t/a/8k.wav';
    const [, , playback] = recordingActions({ ...base, announce: true, consentUrl: url });
    expect(playback).toBe(`<action application="playback" data="${url}"/>`);
  });

  it('does not play or answer anything when no announcement is asked for, even if a URL is given', () => {
    const actions = recordingActions({ ...base, consentUrl: 'http_cache://x' }).join('\n');
    expect(actions).not.toContain('playback');
    expect(actions).not.toContain('pre_answer');
  });

  it('names the file by the recording id only, so nothing about the tenant or call leaks into the path', () => {
    const joined = recordingActions({ ...base, announce: true }).join('\n');
    expect(joined).not.toContain(TENANT);
    expect(recordingSpoolPath(`${SPOOL}/`, ID)).toBe(`${SPOOL}/${ID}.wav`);
  });

  it('escapes what it embeds', () => {
    const [set] = recordingActions({ ...base, recordingId: 'a"b' });
    expect(set).toBe('<action application="set" data="cuc_recording_id=a&quot;b"/>');
  });

  it('carries no product, company or operator name anywhere (CLAUDE.md rule 1)', () => {
    const text = [
      ...recordingActions({ ...base, announce: true }),
      RECORDING_UNAVAILABLE_ACTION,
      CONSENT_TONE,
    ].join('\n');
    expect(text.toLowerCase()).not.toMatch(/conductor|cuc-brand|acme/);
  });
});

describe('injecting into a dialplan document', () => {
  const actions = recordingActions({ ...base, announce: true });

  const documents: Record<string, string> = {
    'ext to ext': buildDialplanDocument('public', '101', 'acme.test', 'opensips:5060', TENANT),
    'ext to ext with voicemail': buildDialplanDocument(
      'public',
      '101',
      'acme.test',
      'opensips:5060',
      TENANT,
      '101',
      { tenantId: TENANT, mailboxId: 'm1' },
    ),
    outbound: buildOutboundDialplanDocument(
      'public',
      '+15551234567',
      '+15551234567',
      'acme.test',
      'opensips:5060',
      1,
      null,
      TENANT,
      0,
    ),
    'ring group': buildRingGroupDialplanDocument(
      'public',
      '+15551234567',
      'acme.test',
      'opensips:5060',
      TENANT,
      ['101', '102'],
      'simultaneous',
      20,
      null,
    ),
    queue: buildQueueDialplanDocument('public', '+15551234567', 'q@acme.test', TENANT),
  };

  for (const [name, document] of Object.entries(documents)) {
    it(`puts the actions first inside the condition of a ${name} call, before it bridges`, () => {
      const result = injectDialplanActions(document, actions);
      const inner = /<condition [^>]*>\n([\s\S]*?)<\/condition>/.exec(result)?.[1] ?? '';
      const applications = [...inner.matchAll(/application="([^"]+)"/g)].map((m) => m[1]);
      expect(applications.slice(0, actions.length)).toEqual(
        actions.map((a) => /application="([^"]+)"/.exec(a)?.[1]),
      );
      const record = [...inner.matchAll(/<action [^>]*>/g)].findIndex((m) =>
        m[0].includes('execute_on_answer=record_session'),
      );
      const dial = applications.findIndex((a) => a === 'bridge' || a === 'callcenter');
      expect(record).toBeGreaterThanOrEqual(0);
      expect(dial).toBeGreaterThan(record);
      // Everything the builder already had is still there, in order.
      expect(result.replace(actions.map((a) => `          ${a}\n`).join(''), '')).toBe(document);
      // Still one well-formed document.
      expect(result.match(/<condition /g)).toHaveLength(1);
      expect(result.match(/<\/condition>/g)).toHaveLength(1);
    });
  }

  it('flags an unrecorded call with a channel variable, changing nothing else', () => {
    const document = documents['ext to ext']!;
    const flagged = injectDialplanActions(document, [RECORDING_UNAVAILABLE_ACTION]);
    expect(flagged).toContain(
      '<action application="set" data="cuc_recording_status=unavailable"/>',
    );
    expect(flagged).not.toContain('record_session');
    expect(flagged.replace(`          ${RECORDING_UNAVAILABLE_ACTION}\n`, '')).toBe(document);
  });

  it('leaves a document with no condition alone', () => {
    expect(injectDialplanActions('<document/>', actions)).toBe('<document/>');
  });
});
