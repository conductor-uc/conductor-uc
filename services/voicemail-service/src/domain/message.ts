/** Voicemail message rules (S2-16, S5-16). Pure. */

export const MESSAGE_CONTENT_TYPE = 'audio/wav';

/** Message ids are `randomUUID()`s: lowercase and hyphenated. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isMessageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** 05 §4-style object layout: one WAV per message, under its own mailbox's prefix. */
export function messageObjectKey(mailboxId: string, messageId: string): string {
  return `voicemail/${mailboxId}/${messageId}.wav`;
}

/**
 * The file name `voicemail.lua` records to in the node's spool directory (S5-16). The `vm-`
 * prefix is how the node uploader tells a voicemail message from a call recording
 * (`<recording id>.wav`) in the one spool both share.
 */
export function spoolFileName(messageId: string): string {
  return `vm-${messageId}.wav`;
}
