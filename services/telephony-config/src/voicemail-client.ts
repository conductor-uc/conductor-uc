/**
 * Calls voicemail-service's own internal routes (S2-16;
 * `voicemail-service/src/routes/internal.routes.ts`'s own doc comments on
 * each). This service never reads voicemail-service's database directly —
 * same "each service owns its own schema" story every other internal
 * client in this codebase follows (`pbx-config-client.ts`).
 *
 * Every `/fs/voicemail/...` route (`routes/fs.routes.ts`) is a thin proxy
 * over this client: FreeSWITCH's Lua voicemail app never calls
 * voicemail-service directly (CLAUDE.md rule 4 — only telephony-config
 * talks to FS nodes, and symmetrically, this service is the only thing FS
 * itself is configured to call).
 */

export interface VoicemailMailbox {
  readonly id: string;
  readonly extensionId: string;
  readonly greetingStatus: string;
  readonly greetingObjectKey: string | null;
}

export interface VoicemailMessage {
  readonly id: string;
  readonly status: string;
  readonly objectKey: string;
  readonly isRead: boolean;
  readonly createdAt: string;
}

export interface CreateVoicemailMessageInput {
  readonly callerIdName?: string | null;
  readonly callerIdNumber?: string | null;
}

export interface CompleteVoicemailMessageInput {
  readonly durationMs: number;
  readonly sizeBytes: number;
}

export class VoicemailClientError extends Error {
  override readonly name = 'VoicemailClientError';
}

export interface VoicemailClientOptions {
  /** e.g. http://voicemail-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface VoicemailClient {
  findMailboxByExtension(
    tenantId: string,
    extensionId: string,
  ): Promise<VoicemailMailbox | undefined>;
  findMailbox(tenantId: string, mailboxId: string): Promise<VoicemailMailbox | undefined>;
  findMessage(
    tenantId: string,
    mailboxId: string,
    messageId: string,
  ): Promise<VoicemailMessage | undefined>;
  verifyPin(tenantId: string, mailboxId: string, pin: string): Promise<boolean>;
  createMessage(
    tenantId: string,
    mailboxId: string,
    input: CreateVoicemailMessageInput,
  ): Promise<{ messageId: string; uploadUrl: string; objectKey: string }>;
  completeMessage(
    tenantId: string,
    mailboxId: string,
    messageId: string,
    input: CompleteVoicemailMessageInput,
  ): Promise<VoicemailMessage>;
  failMessage(tenantId: string, mailboxId: string, messageId: string): Promise<void>;
  listMessages(tenantId: string, mailboxId: string): Promise<VoicemailMessage[]>;
  markMessageRead(
    tenantId: string,
    mailboxId: string,
    messageId: string,
  ): Promise<VoicemailMessage>;
  deleteMessage(tenantId: string, mailboxId: string, messageId: string): Promise<void>;
  presignGreeting(
    tenantId: string,
    mailboxId: string,
  ): Promise<{ uploadUrl: string; objectKey: string }>;
  completeGreeting(tenantId: string, mailboxId: string): Promise<VoicemailMailbox>;
}

export function createVoicemailClient(options: VoicemailClientOptions): VoicemailClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.internalServiceToken}` };

  function mailboxUrl(tenantId: string, mailboxId: string): string {
    return `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/voicemail/mailboxes/${encodeURIComponent(mailboxId)}`;
  }

  async function call(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<Response | undefined> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new VoicemailClientError(
        `Could not reach voicemail-service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new VoicemailClientError(
        `voicemail-service rejected the request (${String(response.status)}): ` +
          (await responseDetail(response)),
      );
    }
    return response;
  }

  return {
    async findMailboxByExtension(tenantId, extensionId) {
      const response = await call(
        'GET',
        `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/voicemail/mailboxes/by-extension/${encodeURIComponent(extensionId)}`,
      );
      if (response === undefined) return undefined;
      return (await response.json()) as VoicemailMailbox;
    },
    async findMailbox(tenantId, mailboxId) {
      const response = await call('GET', mailboxUrl(tenantId, mailboxId));
      if (response === undefined) return undefined;
      return (await response.json()) as VoicemailMailbox;
    },
    async findMessage(tenantId, mailboxId, messageId) {
      const response = await call(
        'GET',
        `${mailboxUrl(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}`,
      );
      if (response === undefined) return undefined;
      return (await response.json()) as VoicemailMessage;
    },
    async verifyPin(tenantId, mailboxId, pin) {
      const response = await call('POST', `${mailboxUrl(tenantId, mailboxId)}/verify-pin`, { pin });
      const { valid } = (await response!.json()) as { valid: boolean };
      return valid;
    },
    async createMessage(tenantId, mailboxId, input) {
      const response = await call('POST', `${mailboxUrl(tenantId, mailboxId)}/messages`, input);
      return (await response!.json()) as {
        messageId: string;
        uploadUrl: string;
        objectKey: string;
      };
    },
    async completeMessage(tenantId, mailboxId, messageId, input) {
      const response = await call(
        'POST',
        `${mailboxUrl(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}/complete`,
        input,
      );
      return (await response!.json()) as VoicemailMessage;
    },
    async failMessage(tenantId, mailboxId, messageId) {
      await call(
        'POST',
        `${mailboxUrl(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}/fail`,
      );
    },
    async listMessages(tenantId, mailboxId) {
      const response = await call('GET', `${mailboxUrl(tenantId, mailboxId)}/messages`);
      if (response === undefined) return [];
      const { rows } = (await response.json()) as { rows: VoicemailMessage[] };
      return rows;
    },
    async markMessageRead(tenantId, mailboxId, messageId) {
      const response = await call(
        'POST',
        `${mailboxUrl(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}/mark-read`,
      );
      return (await response!.json()) as VoicemailMessage;
    },
    async deleteMessage(tenantId, mailboxId, messageId) {
      await call(
        'POST',
        `${mailboxUrl(tenantId, mailboxId)}/messages/${encodeURIComponent(messageId)}/delete`,
      );
    },
    async presignGreeting(tenantId, mailboxId) {
      const response = await call('POST', `${mailboxUrl(tenantId, mailboxId)}/greeting/presign`);
      return (await response!.json()) as { uploadUrl: string; objectKey: string };
    },
    async completeGreeting(tenantId, mailboxId) {
      const response = await call('POST', `${mailboxUrl(tenantId, mailboxId)}/greeting/complete`);
      return (await response!.json()) as VoicemailMailbox;
    },
  };
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { title?: string; detail?: string };
    return body.detail ?? body.title ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
