/**
 * Calls voicemail-service's internal routes (S5-07): a mailbox's email
 * settings, a message's details, its audio bytes, and the read/delete actions.
 * Notification-service never reads voicemail-service's database or bucket
 * (05 §1.1); this is the only path to any of it.
 *
 * Everything returned here is private-class data (07 §3.3): caller ID, times,
 * audio, and the recipient's address. Nothing in this file logs any of it, and
 * error messages carry status codes only.
 */
export class VoicemailClientError extends Error {
  override readonly name = 'VoicemailClientError';
}

export interface VoicemailMailboxSettings {
  readonly id: string;
  /** Null means the mailbox does not email. */
  readonly notifyEmail: string | null;
  readonly emailAttachAudio: boolean;
  readonly emailAfter: 'keep' | 'mark_read' | 'delete';
}

export interface VoicemailMessageDetails {
  readonly id: string;
  readonly status: string;
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  readonly createdAt: string;
}

export interface VoicemailClientOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface VoicemailClient {
  /** Undefined when the mailbox no longer exists. */
  mailbox(tenantId: string, mailboxId: string): Promise<VoicemailMailboxSettings | undefined>;
  /** Undefined when the message no longer exists. */
  message(
    tenantId: string,
    mailboxId: string,
    messageId: string,
  ): Promise<VoicemailMessageDetails | undefined>;
  /** The recording's bytes; undefined when it is gone or not ready. */
  audio(tenantId: string, mailboxId: string, messageId: string): Promise<Buffer | undefined>;
  markRead(tenantId: string, mailboxId: string, messageId: string): Promise<void>;
  remove(tenantId: string, mailboxId: string, messageId: string): Promise<void>;
}

export function createVoicemailClient(options: VoicemailClientOptions): VoicemailClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function call(method: 'GET' | 'POST', path: string, timeoutMs = 10_000): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${options.internalServiceToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The message of a fetch failure can include the URL, which names ids only, but keep it generic anyway.
      throw new VoicemailClientError(
        `Could not reach voicemail-service (${error instanceof Error ? error.name : 'error'}).`,
      );
    }
  }

  function boxPath(tenantId: string, mailboxId: string): string {
    return `/internal/v1/tenants/${encodeURIComponent(tenantId)}/voicemail/mailboxes/${encodeURIComponent(mailboxId)}`;
  }
  function messagePath(tenantId: string, mailboxId: string, messageId: string): string {
    return `${boxPath(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}`;
  }
  function reject(what: string, response: Response): VoicemailClientError {
    return new VoicemailClientError(
      `voicemail-service rejected ${what} (${String(response.status)}).`,
    );
  }

  return {
    async mailbox(tenantId, mailboxId) {
      const response = await call('GET', boxPath(tenantId, mailboxId));
      if (response.status === 404) return undefined;
      if (!response.ok) throw reject('the mailbox lookup', response);
      return (await response.json()) as VoicemailMailboxSettings;
    },
    async message(tenantId, mailboxId, messageId) {
      const response = await call('GET', messagePath(tenantId, mailboxId, messageId));
      if (response.status === 404) return undefined;
      if (!response.ok) throw reject('the message lookup', response);
      return (await response.json()) as VoicemailMessageDetails;
    },
    async audio(tenantId, mailboxId, messageId) {
      const response = await call(
        'GET',
        `${messagePath(tenantId, mailboxId, messageId)}/audio`,
        30_000,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw reject('the audio fetch', response);
      return Buffer.from(await response.arrayBuffer());
    },
    async markRead(tenantId, mailboxId, messageId) {
      const response = await call(
        'POST',
        `${messagePath(tenantId, mailboxId, messageId)}/mark-read`,
      );
      if (!response.ok && response.status !== 404) throw reject('mark-read', response);
    },
    async remove(tenantId, mailboxId, messageId) {
      const response = await call('POST', `${messagePath(tenantId, mailboxId, messageId)}/delete`);
      if (!response.ok && response.status !== 404) throw reject('the delete', response);
    },
  };
}
