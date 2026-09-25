/**
 * The uploader's clients for the services that own what lands in the node spool: call
 * recordings (recording-service, `/internal/v1/recordings/...`) and voicemail messages
 * (voicemail-service, `/internal/v1/voicemail/messages/...`, S5-16). Both speak the same
 * contract: `upload-url`, `complete`, `fail`, addressed by the opaque id in the file name.
 *
 * Talks HTTP only: the node holds these services' bearer token and nothing else. It has no
 * database or storage credentials, which is why the uploader can run beside FreeSWITCH.
 */

/** The id in the file name is not one the service knows. Retrying will not help until it does. */
export class UnknownSpoolFileError extends Error {
  override readonly name = 'UnknownSpoolFileError';
}

/** The service already holds this file's audio (a duplicate spool file): the local copy is redundant. */
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

/** One service's side of the upload contract. */
export interface UploadApi {
  requestUploadUrl(id: string): Promise<UploadTarget>;
  complete(id: string, input: CompleteInput): Promise<{ sizeBytes: number | null }>;
  fail(id: string, reason: string): Promise<void>;
}

export interface UploadApiOptions {
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Where a kind of spool file is delivered, and what to call it in errors. */
interface UploadEndpoint {
  readonly service: string;
  /** e.g. `/internal/v1/recordings`; the id and action follow. */
  readonly path: string;
  readonly noun: string;
}

function createUploadApi(endpoint: UploadEndpoint, options: UploadApiOptions): UploadApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const { service, noun } = endpoint;

  async function post(id: string, action: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${endpoint.path}/${encodeURIComponent(id)}/${action}`, {
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
        `${service} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
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
    async requestUploadUrl(id) {
      const response = await post(id, 'upload-url');
      if (response.status === 404)
        throw new UnknownSpoolFileError(`${service} has no such ${noun}.`);
      if (response.status === 409)
        throw new AlreadyUploadedError(`${service} already has this ${noun}.`);
      if (!response.ok) {
        throw new TransientUploadError(`upload-url answered ${String(response.status)}.`);
      }
      return (await response.json()) as UploadTarget;
    },

    async complete(id, input) {
      const response = await post(id, 'complete', input);
      if (response.status === 409) {
        const reason = await code(response);
        // voicemail-service answers a retried complete this way; recording-service's is a 200.
        if (reason === 'already_uploaded') {
          throw new AlreadyUploadedError(`${service} already has this ${noun}.`);
        }
        throw new VerificationFailedError(
          `${service} rejected the upload (${reason ?? 'conflict'}).`,
        );
      }
      if (response.status === 404)
        throw new UnknownSpoolFileError(`${service} has no such ${noun}.`);
      if (!response.ok) {
        throw new TransientUploadError(`complete answered ${String(response.status)}.`);
      }
      return (await response.json()) as { sizeBytes: number | null };
    },

    async fail(id, reason) {
      const response = await post(id, 'fail', { reason });
      if (!response.ok && response.status !== 404) {
        throw new TransientUploadError(`fail answered ${String(response.status)}.`);
      }
    },
  };
}

/** recording-service: `<recording id>.wav` files. */
export function createRecordingApi(options: UploadApiOptions): UploadApi {
  return createUploadApi(
    { service: 'recording-service', path: '/internal/v1/recordings', noun: 'recording' },
    options,
  );
}

/** voicemail-service: `vm-<message id>.wav` files (S5-16). */
export function createVoicemailApi(options: UploadApiOptions): UploadApi {
  return createUploadApi(
    {
      service: 'voicemail-service',
      path: '/internal/v1/voicemail/messages',
      noun: 'voicemail message',
    },
    options,
  );
}
