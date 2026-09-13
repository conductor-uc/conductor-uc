import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';

import {
  defineEvents,
  EventValidationError,
  mergeEvents,
  UnknownEventTypeError,
} from '../src/registry.js';

const events = defineEvents({
  'pbx.extension.created': {
    schemaVersion: 1,
    data: Type.Object({ extensionId: Type.String({ minLength: 1 }), number: Type.String() }),
  },
  'org.tenant.suspended': {
    schemaVersion: 2,
    data: Type.Object({ tenantId: Type.String(), reason: Type.Optional(Type.String()) }),
  },
});

const validEnvelope = {
  id: 'evt-1',
  type: 'pbx.extension.created',
  schemaVersion: 1,
  occurredAt: '2026-09-12T01:02:03.456Z',
  orgContext: { tenantId: 'ten-1' },
  data: { extensionId: 'e1', number: '1001' },
};

describe('defineEvents', () => {
  it('registers contracts and lists their types', () => {
    expect(events.types).toEqual(['pbx.extension.created', 'org.tenant.suspended']);
    expect(events.has('pbx.extension.created')).toBe(true);
    expect(events.has('pbx.extension.exploded')).toBe(false);
  });

  it('validates subjects at registration, not first publish', () => {
    expect(() =>
      defineEvents({ 'billing.invoice.created': { schemaVersion: 1, data: Type.Object({}) } }),
    ).toThrow(/unknown domain 'billing'/);

    expect(() =>
      defineEvents({ 'pbx.Extension.created': { schemaVersion: 1, data: Type.Object({}) } }),
    ).toThrow(/lowercase snake_case/);
  });

  it('rejects a schema version below 1', () => {
    expect(() =>
      defineEvents({ 'pbx.extension.created': { schemaVersion: 0, data: Type.Object({}) } }),
    ).toThrow(/versions start at 1/);
  });

  it('exposes the contract for a type', () => {
    expect(events.contract('org.tenant.suspended').schemaVersion).toBe(2);
  });

  it('names the known types when asked for one that is not registered', () => {
    expect(() => events.contract('pbx.extension.exploded' as never)).toThrow(UnknownEventTypeError);
    expect(() => events.contract('pbx.extension.exploded' as never)).toThrow(
      /Known types: pbx.extension.created, org.tenant.suspended/,
    );
  });
});

describe('assertPayload', () => {
  it('accepts a payload that matches', () => {
    expect(() =>
      events.assertPayload('pbx.extension.created', { extensionId: 'e1', number: '1001' }),
    ).not.toThrow();
  });

  it('rejects a missing field and says which', () => {
    expect(() => events.assertPayload('pbx.extension.created', { number: '1001' })).toThrow(
      EventValidationError,
    );
    expect(() => events.assertPayload('pbx.extension.created', { number: '1001' })).toThrow(
      /extensionId/,
    );
  });

  it('rejects a field of the wrong type', () => {
    expect(() =>
      events.assertPayload('pbx.extension.created', { extensionId: 'e1', number: 1001 }),
    ).toThrow(/\/number/);
  });
});

describe('assertEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(() => events.assertEnvelope(validEnvelope)).not.toThrow();
  });

  it('accepts an envelope with no tenant, for a master-level event', () => {
    expect(() =>
      events.assertEnvelope({
        ...validEnvelope,
        type: 'org.tenant.suspended',
        schemaVersion: 2,
        orgContext: {},
        data: { tenantId: 'ten-1' },
      }),
    ).not.toThrow();
  });

  it('rejects an envelope missing a required field', () => {
    const { occurredAt: _omitted, ...withoutOccurredAt } = validEnvelope;

    expect(() => events.assertEnvelope(withoutOccurredAt)).toThrow(EventValidationError);
  });

  it('rejects an unknown property, so a typo is not silently carried', () => {
    expect(() => events.assertEnvelope({ ...validEnvelope, tenantId: 'ten-1' })).toThrow(
      EventValidationError,
    );
  });

  it('rejects a schemaVersion that disagrees with the contract', () => {
    expect(() => events.assertEnvelope({ ...validEnvelope, schemaVersion: 2 })).toThrow(
      /schemaVersion 2 was published, but the registered contract is version 1/,
    );
  });

  it('rejects an unregistered type', () => {
    expect(() => events.assertEnvelope({ ...validEnvelope, type: 'call.lost' })).toThrow(
      UnknownEventTypeError,
    );
  });

  it('validates the payload as well as the envelope', () => {
    expect(() => events.assertEnvelope({ ...validEnvelope, data: { number: '1001' } })).toThrow(
      /extensionId/,
    );
  });
});

describe('mergeEvents', () => {
  it('combines registries so each domain owns its own file', () => {
    const pbx = defineEvents({
      'pbx.extension.created': { schemaVersion: 1, data: Type.Object({}) },
    });
    const org = defineEvents({
      'org.tenant.suspended': { schemaVersion: 1, data: Type.Object({}) },
    });

    expect([...mergeEvents(pbx, org).types].sort()).toEqual([
      'org.tenant.suspended',
      'pbx.extension.created',
    ]);
  });

  it('refuses to register the same type twice', () => {
    const first = defineEvents({
      'pbx.extension.created': { schemaVersion: 1, data: Type.Object({}) },
    });
    const second = defineEvents({
      'pbx.extension.created': { schemaVersion: 2, data: Type.Object({}) },
    });

    expect(() => mergeEvents(first, second)).toThrow(/registered twice/);
  });
});
