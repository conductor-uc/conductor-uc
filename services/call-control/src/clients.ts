import type { RecordingCallDirection } from '@cuc/api-contracts';

/**
 * The two services call-control asks when someone presses a recording button on a live call
 * (S5-15): recording-service, which decides and audits, and pbx-config-service, which says which
 * extension is a person's own. Same shared bearer token as every internal call (07 §1).
 */

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
}

interface ClientOptions {
  /** e.g. `http://recording-service:8080`. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

async function call(
  options: ClientOptions,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${options.internalServiceToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new UpstreamError(error instanceof Error ? error.message : String(error));
  }
}

/** The explicit recording actions (recording-service's `action`). */
export type RecordingAction = 'start' | 'stop' | 'pause' | 'resume';

export interface RecordingControlRequest {
  readonly tenantId: string;
  readonly action: RecordingAction;
  /** The channel that owns the call's recording (`cuc_rec_owner`). */
  readonly callUuid: string;
  readonly recordingId?: string;
  readonly nodeId: string;
  readonly context: {
    readonly direction: RecordingCallDirection;
    readonly extensionIds: readonly string[];
    readonly queueId?: string | undefined;
    readonly didId?: string | undefined;
  };
  /** The person who pressed the button; audited as them. */
  readonly actor: { readonly id: string; readonly orgId: string };
  readonly ip?: string;
  readonly requestId?: string;
}

export interface RecordingControlAnswer {
  readonly result: 'started' | 'stopped' | 'paused' | 'resumed' | 'refused';
  readonly recordingId: string | null;
  readonly reason: string | null;
}

/** Asks recording-service (`POST /internal/v1/recordings/control`). Throws {@link UpstreamError} when it cannot answer. */
export type RecordingControlClient = (
  request: RecordingControlRequest,
) => Promise<RecordingControlAnswer>;

export function createRecordingControlClient(options: ClientOptions): RecordingControlClient {
  return async (request) => {
    const { context, ...rest } = request;
    const response = await call(options, '/internal/v1/recordings/control', {
      method: 'POST',
      body: {
        ...rest,
        context: {
          direction: context.direction,
          extensionIds: [...context.extensionIds],
          ...(context.queueId === undefined ? {} : { queueId: context.queueId }),
          ...(context.didId === undefined ? {} : { didId: context.didId }),
        },
      },
    });
    if (!response.ok) {
      throw new UpstreamError(`recording-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<RecordingControlAnswer>;
    const results = ['started', 'stopped', 'paused', 'resumed', 'refused'];
    if (typeof body.result !== 'string' || !results.includes(body.result)) {
      throw new UpstreamError('recording-service gave an answer this service cannot read');
    }
    return {
      result: body.result,
      recordingId: typeof body.recordingId === 'string' ? body.recordingId : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  };
}

export interface UserExtension {
  readonly extensionId: string;
  readonly number: string;
}

/**
 * Which extension belongs to a person (pbx-config-service's
 * `GET /internal/v1/tenants/:tenantId/users/:userId/extension`, parity 1e), the same lookup the
 * other self-service routes use. `undefined` when none is linked; throws {@link UpstreamError}
 * when it cannot be asked.
 */
export type UserExtensionLookup = (
  tenantId: string,
  userId: string,
) => Promise<UserExtension | undefined>;

export function createUserExtensionLookup(options: ClientOptions): UserExtensionLookup {
  return async (tenantId, userId) => {
    const response = await call(
      options,
      `/internal/v1/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/extension`,
      { method: 'GET' },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new UpstreamError(`pbx-config-service answered ${String(response.status)}`);
    }
    const body = (await response.json()) as Partial<UserExtension>;
    if (typeof body.extensionId !== 'string' || typeof body.number !== 'string') {
      throw new UpstreamError('pbx-config-service gave an answer this service cannot read');
    }
    return { extensionId: body.extensionId, number: body.number };
  };
}
