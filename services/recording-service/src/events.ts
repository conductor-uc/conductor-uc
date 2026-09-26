import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (S5-01, S5-04, S5-05).
 *
 * All payloads are thin: ids and a change kind, never call parties or media
 * (recordings are private-class data, 07 §3.2). A consumer re-reads what it
 * needs. `recording.policy.*` is what telephony-config's cache would subscribe
 * to (05 §5); today it relies on a short TTL instead, so a policy edit takes
 * effect within that TTL (see `telephony-config/src/recording-client.ts`).
 */
const policyData = Type.Object({ policyId: Type.String({ minLength: 1 }) });
const recordingData = Type.Object({ recordingId: Type.String({ minLength: 1 }) });

export const recordingEvents = defineEvents({
  'recording.policy.created': {
    schemaVersion: 1,
    description: 'A recording policy was created.',
    data: policyData,
  },
  'recording.policy.updated': {
    schemaVersion: 1,
    description: 'A recording policy was changed.',
    data: policyData,
  },
  'recording.policy.deleted': {
    schemaVersion: 1,
    description: 'A recording policy was deleted.',
    data: policyData,
  },
  'recording.recording.ready': {
    schemaVersion: 1,
    description: 'A recording finished uploading and can be played.',
    data: recordingData,
  },
  'recording.recording.deleted': {
    schemaVersion: 1,
    description: 'A recording was deleted by a person with permission.',
    data: recordingData,
  },
  'recording.recording.expired': {
    schemaVersion: 1,
    description: "A recording passed its tenant's retention period and its audio was deleted.",
    data: recordingData,
  },
  'recording.retention.updated': {
    schemaVersion: 1,
    description: "A tenant's recording retention period was changed.",
    data: Type.Object({ retentionDays: Type.Number({ minimum: 0 }) }),
  },
  'recording.settings.updated': {
    schemaVersion: 1,
    description:
      "A tenant's recording settings were changed. Carries the settings themselves (configuration, " +
      'not call data): telephony-config keeps its own copy of `failClosed` so a call can be refused ' +
      'while this service is unreachable (S5-12).',
    data: Type.Object({
      retentionDays: Type.Number({ minimum: 0 }),
      failClosed: Type.Boolean(),
    }),
  },
});
