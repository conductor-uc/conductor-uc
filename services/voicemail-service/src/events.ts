import { ORG_DELETED_EVENTS } from '@cuc/events';
import { Type, defineEvents } from '@cuc/api-contracts';

/**
 * This service's event contracts (S2-16; 06's voicemail-service section:
 * "On `:complete`, emits `voicemail.message.created`. ... MWI is sent
 * through the OpenSIPs presence `message-summary` PUBLISH.").
 *
 * `voicemail.mailbox.mwi_changed` is this task's own addition, not named in
 * 06 verbatim: MWI-over-presence needs *something* to publish from — no
 * presence-publishing consumer exists yet (S2-17, a sibling in-flight task,
 * builds OpenSIPs presence/BLF, not MWI specifically), so this event is a
 * deliberately thin trigger (06: consumer re-fetches current state, here via
 * `GET /internal/v1/tenants/:tenantId/voicemail/mailboxes/:id`) for whichever
 * later task wires MWI-over-presence to actually consume. See
 * docs/decisions.md for the open item this leaves.
 */
export const voicemailEvents = defineEvents({
  // S1-16 (G-11): org-service's deletions, which this service acts on.
  ...ORG_DELETED_EVENTS,
  'voicemail.message.created': {
    schemaVersion: 1,
    description: 'A voicemail message finished uploading and is ready to retrieve.',
    data: Type.Object({
      messageId: Type.String({ minLength: 1 }),
      mailboxId: Type.String({ minLength: 1 }),
    }),
  },
  'voicemail.mailbox.mwi_changed': {
    schemaVersion: 1,
    description:
      "A mailbox's unread-message state changed (a message arrived, was read, or was deleted, or the mailbox was created or deleted) — the trigger for an MWI NOTIFY.",
    data: Type.Object({
      mailboxId: Type.String({ minLength: 1 }),
      /**
       * The mailbox's extension, on a mailbox created or deleted (S2-16, G-42): once a mailbox is
       * gone there is nothing left to read it from, and its extension's lamp must still go out.
       */
      extensionId: Type.Optional(Type.String({ minLength: 1 })),
    }),
  },
});
