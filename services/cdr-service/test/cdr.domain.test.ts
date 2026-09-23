import { describe, expect, it } from 'vitest';

import { InvalidCdrPayloadError, normalizeCdr } from '../src/domain/cdr.js';

function samplePayload(overrides: Record<string, string> = {}): unknown {
  return {
    variables: {
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cuc_node_id: 'fs-1',
      cuc_tenant_id: 'tenant-123',
      'sip_h_X-Call-Direction': 'internal',
      start_epoch: '1700000000',
      answer_epoch: '1700000005',
      end_epoch: '1700000030',
      duration: '30',
      billsec: '25',
      sip_from_user: '101',
      sip_to_user: '102',
      destination_number: '102',
      hangup_cause: 'NORMAL_CLEARING',
      sip_hangup_disposition: 'send_bye',
      ...overrides,
    },
  };
}

describe('normalizeCdr', () => {
  it('normalizes a well-formed internal-call payload', () => {
    const cdr = normalizeCdr(samplePayload());

    expect(cdr).toMatchObject({
      tenantId: 'tenant-123',
      callUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nodeId: 'fs-1',
      direction: 'internal',
      durationSec: 30,
      billableSec: 25,
      fromNumber: '101',
      toNumber: '102',
      dialedNumber: '102',
      disposition: 'answered',
      hangupCause: 'NORMAL_CLEARING',
      hangupBy: 'caller',
      did: null,
    });
    expect(cdr.startAt.getTime()).toBe(1700000000 * 1000);
    expect(cdr.answerAt?.getTime()).toBe(1700000005 * 1000);
    expect(cdr.endAt.getTime()).toBe(1700000030 * 1000);
  });

  it('reads the cuc_call_direction override for an outbound call', () => {
    const cdr = normalizeCdr(
      samplePayload({ cuc_call_direction: 'outbound', 'sip_h_X-Call-Direction': 'internal' }),
    );
    expect(cdr.direction).toBe('outbound');
  });

  it('resolves inbound direction and sets did from the destination number', () => {
    const cdr = normalizeCdr(
      samplePayload({ 'sip_h_X-Call-Direction': 'inbound', destination_number: '+15551234567' }),
    );
    expect(cdr.direction).toBe('inbound');
    expect(cdr.did).toBe('+15551234567');
  });

  it('decodes a hyphen-stripped X-Trunk-Id back into a UUID', () => {
    const cdr = normalizeCdr(
      samplePayload({ 'sip_h_X-Trunk-Id': 'f47ac10b58cc4372a5670e02b2c3d479' }),
    );
    expect(cdr.trunkId).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });

  it('disposition is answered whenever billsec > 0, regardless of hangup cause', () => {
    const cdr = normalizeCdr(samplePayload({ billsec: '5', hangup_cause: 'USER_BUSY' }));
    expect(cdr.disposition).toBe('answered');
  });

  it('maps a zero-billsec USER_BUSY hangup to disposition busy', () => {
    const cdr = normalizeCdr(samplePayload({ billsec: '0', hangup_cause: 'USER_BUSY' }));
    expect(cdr.disposition).toBe('busy');
  });

  it('maps a zero-billsec NO_ANSWER hangup to disposition no_answer', () => {
    const cdr = normalizeCdr(samplePayload({ billsec: '0', hangup_cause: 'NO_ANSWER' }));
    expect(cdr.disposition).toBe('no_answer');
  });

  it('maps a zero-billsec ORIGINATOR_CANCEL hangup to disposition cancelled', () => {
    const cdr = normalizeCdr(samplePayload({ billsec: '0', hangup_cause: 'ORIGINATOR_CANCEL' }));
    expect(cdr.disposition).toBe('cancelled');
  });

  it('falls back to disposition failed for an unrecognized zero-billsec hangup cause', () => {
    const cdr = normalizeCdr(samplePayload({ billsec: '0', hangup_cause: 'CALL_REJECTED' }));
    expect(cdr.disposition).toBe('failed');
  });

  it('maps sip_hangup_disposition recv_bye to hangupBy callee', () => {
    const cdr = normalizeCdr(samplePayload({ sip_hangup_disposition: 'recv_bye' }));
    expect(cdr.hangupBy).toBe('callee');
  });

  it('maps an unrecognized sip_hangup_disposition to hangupBy system', () => {
    const cdr = normalizeCdr(samplePayload({ sip_hangup_disposition: 'redirected' }));
    expect(cdr.hangupBy).toBe('system');
  });

  it('leaves answerAt null when answer_epoch is 0 (never answered)', () => {
    const cdr = normalizeCdr(samplePayload({ answer_epoch: '0', billsec: '0' }));
    expect(cdr.answerAt).toBeNull();
  });

  it('rejects a payload with no variables object', () => {
    expect(() => normalizeCdr({})).toThrow(InvalidCdrPayloadError);
    expect(() => normalizeCdr(null)).toThrow(InvalidCdrPayloadError);
    expect(() => normalizeCdr('not json')).toThrow(InvalidCdrPayloadError);
  });

  it('rejects a payload missing uuid', () => {
    const payload = samplePayload();
    delete (payload as { variables: Record<string, string> }).variables.uuid;
    expect(() => normalizeCdr(payload)).toThrow(InvalidCdrPayloadError);
  });

  it('rejects a payload missing cuc_tenant_id', () => {
    const payload = samplePayload();
    delete (payload as { variables: Record<string, string> }).variables.cuc_tenant_id;
    expect(() => normalizeCdr(payload)).toThrow(InvalidCdrPayloadError);
  });

  it('rejects a payload missing cuc_node_id', () => {
    const payload = samplePayload();
    delete (payload as { variables: Record<string, string> }).variables.cuc_node_id;
    expect(() => normalizeCdr(payload)).toThrow(InvalidCdrPayloadError);
  });

  it('rejects a payload with neither cuc_call_direction nor X-Call-Direction', () => {
    const payload = samplePayload();
    delete (payload as { variables: Record<string, string> }).variables['sip_h_X-Call-Direction'];
    expect(() => normalizeCdr(payload)).toThrow(InvalidCdrPayloadError);
  });

  it('rejects a payload missing start_epoch', () => {
    const payload = samplePayload();
    delete (payload as { variables: Record<string, string> }).variables.start_epoch;
    expect(() => normalizeCdr(payload)).toThrow(InvalidCdrPayloadError);
  });
});
