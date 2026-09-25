/**
 * The uploader's client for recording-service's internal API (`/internal/v1/recordings/...`).
 * Talks HTTP only: the node holds this service's bearer token and nothing else. It has no
 * database or storage credentials, which is why the uploader can run beside FreeSWITCH.
 */

/** The recording id in the file name is not one the service knows. Retrying will not help until it does. */
export class UnknownRecordingError extends Error {
  override readonly name = 'UnknownRecordingError';
}

/** The service already holds this recording (a duplicate spool file): the local copy is redundant. */
export class AlreadyUploadedError extends Error {
  override readonly name = 'AlreadyUploadedError';
}

/** The service refused the upload as corrupt or incomplete (size, checksum, or missing object). */
export class VerificationFailedError extends Error {
  override readonly name = 'VerificationFailedError';
}

/** Anything else that is worth retrying: network trouble, a 5xx, an expired URL. */
export class TransientUploadError extends Error {
  override readonly name = 'TransientUploadError';
}

export interface UploadTarget {
  readonly uploadUrl: string;
  readonly contentType: string;
}

export interface CompleteInput {
  readonly sizeBytes: number;
  readonly md5: string;
  readonly sha256: string;
  readonly durationMs: number | null;
}

export interface RecordingApi {
  requestUploadUrl(recordingId: string): Promise<UploadTarget>;
  complete(recordingId: string, input: CompleteInput): Promise<{ sizeBytes: number | null }>;
  fail(recordingId: string, reason: string): Promise<void>;
}

export interface RecordingApiOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createRecordingApi(options: RecordingApiOptions): RecordingApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function post(path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/internal/v1/recordings/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.internalServiceToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TransientUploadError(
        `recording-service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return response;
  }

  async function code(response: Response): Promise<string | undefined> {
    try {
      return ((await response.json()) as { code?: string }).code;
    } catch {
      return undefined;
    }
  }

  return {
    async requestUploadUrl(recordingId) {
      const response = await post(`${encodeURIComponent(recordingId)}/upload-url`);
      if (response.status === 404)
        throw new UnknownRecordingError('recording-service has no such recording.');
      if (response.status === 409)
        throw new AlreadyUploadedError('recording-service already has this recording.');
      if (!response.ok) {
        throw new TransientUploadError(`upload-url answered ${String(response.status)}.`);
      }
      return (await response.json()) as UploadTarget;
    },

    async complete(recordingId, input) {
      const response = await post(`${encodeURIComponent(recordingId)}/complete`, input);
      if (response.status === 409) {
        throw new VerificationFailedError(
          `recording-service rejected the upload (${(await code(response)) ?? 'conflict'}).`,
        );
      }
      if (response.status === 404)
        throw new UnknownRecordingError('recording-service has no such recording.');
      if (!response.ok) {
        throw new TransientUploadError(`complete answered ${String(response.status)}.`);
      }
      return (await response.json()) as { sizeBytes: number | null };
    },

    async fail(recordingId, reason) {
      const response = await post(`${encodeURIComponent(recordingId)}/fail`, { reason });
      if (!response.ok && response.status !== 404) {
        throw new TransientUploadError(`fail answered ${String(response.status)}.`);
      }
    },
  };
}
