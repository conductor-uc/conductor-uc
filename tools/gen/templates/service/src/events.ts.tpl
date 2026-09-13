import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts.
 *
 * Subjects are validated at registration, so a typo fails at startup rather
 * than at first publish. A breaking change to `data` needs a new
 * `schemaVersion` and a dual-publish period (05 §5).
 */
export const {{entity}}Events = defineEvents({
  '{{domain}}.{{entity}}.created': {
    schemaVersion: 1,
    description: 'A {{entity}} was created.',
    data: Type.Object({
      {{entity}}Id: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
    }),
  },
});
