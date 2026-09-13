import { describe, expect, it } from 'vitest';

import {
  allStreams,
  EVENT_DOMAINS,
  InvalidSubjectError,
  isEventSubject,
  parseSubject,
  streamFor,
  streamSubjects,
} from '../src/subjects.js';

describe('parseSubject', () => {
  it('splits domain, entity, and verb', () => {
    expect(parseSubject('pbx.extension.created')).toEqual({
      domain: 'pbx',
      stream: 'PBX',
      rest: ['extension', 'created'],
    });
  });

  it('accepts the two-segment forms the SAD documents', () => {
    // 05 §5 lists `call.lost` alongside three-segment subjects, so both shapes
    // are valid rather than pretending the convention is uniform.
    expect(parseSubject('call.lost')).toMatchObject({ domain: 'call', rest: ['lost'] });
  });

  it('rejects an unknown domain', () => {
    expect(() => parseSubject('billing.invoice.created')).toThrow(InvalidSubjectError);
    expect(() => parseSubject('billing.invoice.created')).toThrow(/unknown domain 'billing'/);
  });

  it('rejects a subject with only one segment', () => {
    expect(() => parseSubject('pbx')).toThrow(/at least domain.verb/);
  });

  it('rejects a subject deeper than three segments', () => {
    // A deeper subject is nearly always a filter pattern that leaked into an
    // event type.
    expect(() => parseSubject('pbx.extension.created.v2')).toThrow(/at most three segments/);
  });

  it('rejects segments that are not lowercase snake_case', () => {
    for (const subject of ['pbx.Extension.created', 'pbx.extension.Created', 'pbx.extension.*']) {
      expect(() => parseSubject(subject)).toThrow(/lowercase snake_case/);
    }
  });

  it('allows snake_case, which real event names need', () => {
    expect(() => parseSubject('identity.user.password_reset_requested')).not.toThrow();
  });
});

describe('isEventSubject', () => {
  it('answers without throwing', () => {
    expect(isEventSubject('org.tenant.suspended')).toBe(true);
    expect(isEventSubject('nope.nope.nope')).toBe(false);
  });
});

describe('streams', () => {
  it('names a stream after its domain, uppercased', () => {
    expect(streamFor('callflow')).toBe('CALLFLOW');
    expect(streamSubjects('callflow')).toBe('callflow.>');
  });

  it('covers every domain the SAD lists', () => {
    expect(EVENT_DOMAINS).toEqual([
      'org',
      'identity',
      'pbx',
      'trunk',
      'callflow',
      'call',
      'cdr',
      'recording',
      'voicemail',
      'sms',
      'fax',
      'audit',
    ]);
  });

  it('describes one stream per domain, each capturing its own subtree', () => {
    const streams = allStreams();

    expect(streams).toHaveLength(EVENT_DOMAINS.length);
    expect(streams[0]).toEqual({ name: 'ORG', subjects: ['org.>'] });
    expect(new Set(streams.map((stream) => stream.name)).size).toBe(EVENT_DOMAINS.length);
  });

  it('gives every documented example subject a stream', () => {
    for (const subject of [
      'org.tenant.suspended',
      'trunk.trunk.updated',
      'call.channel.answered',
      'call.lost',
      'cdr.record.created',
    ]) {
      expect(parseSubject(subject).stream).toBeTruthy();
    }
  });
});
