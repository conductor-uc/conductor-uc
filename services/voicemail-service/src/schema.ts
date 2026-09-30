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
    /** S5-06: `inherit` (the tenant's setting), `on` or `off`. */
    transcribe: string;
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
    /** Hex SHA-256 of the uploaded WAV, as the node uploader read it (S5-16, 05 §4). */
    sha256: string | null;
    /** Why the message never became ready: `empty_file` (uploader), `never_uploaded` (sweep). */
    failure_reason: string | null;
    is_read: boolean;
    /** S5-06: the text of the message, once transcribed. Private-class data: never logged. */
    transcript: string | null;
    /** `none` (not asked for), `pending`, `working`, `done` or `failed`. */
    transcript_status: string;
    /** The engine asked (`default` or `self_hosted`), from the settings when the message became ready. */
    transcript_engine: string | null;
    transcript_attempts: number;
    /** When a transcriber took the message; one taken long ago is taken again. */
    transcript_claimed_at: Date | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /** S5-06 (O-3): each tenant's opt-in; no row means off. */
  transcription_settings: {
    tenant_id: string;
    enabled: boolean;
    engine: string;
    updated_at: Date;
    version: number;
  };
}
