import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts.
 *
 * Subjects are validated at registration, so a typo fails at startup rather
 * than at first publish. A breaking change to `data` needs a new
 * `schemaVersion` and a dual-publish period (05 §5).
 */
export const widgetEvents = defineEvents({
  'pbx.widget.created': {
    schemaVersion: 1,
    description: 'A widget was created.',
    data: Type.Object({
      widgetId: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
    }),
  },
});
