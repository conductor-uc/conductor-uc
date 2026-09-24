import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (S2-16; 06 "voicemail-service: mailboxes,
 * greetings, messages, transcription jobs"). `extension_id` names a
 * pbx-config-service `extensions` row by id only — no cross-schema joins
 * (05 §1.1), the same convention every other cross-service reference in
 * this codebase follows.
 *
 * No `unread_count` column: it is always a `COUNT` over `messages` where
 * `is_read = false` for the mailbox, computed at read time. Denormalizing
 * it would mean keeping a counter in step with every message insert/
 * delete/mark-read across two tables — real complexity for a number this
 * cheap to compute on the fly at this data volume.
 */
export interface VoicemailServiceDb extends EventTables {
  mailboxes: {
    id: string;
    tenant_id: string;
    extension_id: string;
    /** Envelope-encrypted at rest (07 §5), same as SIP credentials (`extension.repo.ts`). */
    pin_enc: string;
    greeting_status: string;
    greeting_object_key: string | null;
    /** Voicemail-to-email (S5-07). Personal data: never logged. Null means no email. */
    notify_email: string | null;
    email_attach_audio: boolean;
    email_after: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  messages: {
    id: string;
    tenant_id: string;
    mailbox_id: string;
    status: string;
    object_key: string;
    caller_id_name: string | null;
    caller_id_number: string | null;
    duration_ms: number | null;
    size_bytes: number | null;
    is_read: boolean;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}
