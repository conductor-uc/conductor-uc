import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Storage } from '@cuc/storage';

/**
 * A stand-in for voicemail-service's node-uploader routes (S5-16), for the uploader's tests:
 * recording-service cannot start the real voicemail-service. It keeps the real contract, over
 * real HTTP, against the same real MinIO: `POST /internal/v1/voicemail/messages/:id/upload-url`
 * presigns a PUT for the message's key (409 `already_uploaded` once ready), `.../complete`
 * checks the stored object's size and MD5 ETag before marking it ready (409 `object_missing` /
 * `size_mismatch` / `checksum_mismatch`, and 409 `already_uploaded` when already ready), and
 * `.../fail` records the reason. voicemail-service's own `test/upload.routes.test.ts` pins the
 * real routes to this same contract.
 */
export interface FakeMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly objectKey: string;
  status: 'pending' | 'ready' | 'failed';
  sizeBytes: number | null;
  durationMs: number | null;
  sha256: string | null;
  failureReason: string | null;
}

export interface FakeVoicemailService {
  readonly url: string;
  readonly messages: Map<string, FakeMessage>;
  /** Every call the uploader made, as `<action> <id>`. */
  readonly calls: string[];
  /** Answer every request with this status instead (an outage), or null for normal service. */
  down: number | null;
  /** Creates a pending message, as `voicemail.lua`'s create call does before recording. */
  create(tenantId: string): FakeMessage;
  close(): Promise<void>;
}

const TOKEN_HEADER = /^Bearer (.+)$/;
const ROUTE = /^\/internal\/v1\/voicemail\/messages\/([^/]+)\/(upload-url|complete|fail)$/;

export async function startFakeVoicemailService(
  storage: Storage,
  internalServiceToken: string,
): Promise<FakeVoicemailService> {
  const messages = new Map<string, FakeMessage>();
  const calls: string[] = [];

  async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  }

  function send(response: ServerResponse, status: number, body?: unknown): void {
    response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (fake.down !== null) return send(response, fake.down, {});
    const token = TOKEN_HEADER.exec(request.headers.authorization ?? '')?.[1];
    if (token !== internalServiceToken) return send(response, 401, {});
    const match = ROUTE.exec(request.url ?? '');
    if (request.method !== 'POST' || match === null) return send(response, 404, {});
    const [, id, action] = match as unknown as [string, string, string];
    calls.push(`${action} ${id}`);
    const message = messages.get(id);
    if (message === undefined) return send(response, 404, { code: 'not_found' });
    const scoped = storage.forTenant(message.tenantId);

    if (action === 'upload-url') {
      if (message.status === 'ready') return send(response, 409, { code: 'already_uploaded' });
      await scoped.provisionBucket();
      const uploadUrl = await scoped.presignPut(message.objectKey, { contentType: 'audio/wav' });
      return send(response, 200, {
        uploadUrl,
        objectKey: message.objectKey,
        contentType: 'audio/wav',
      });
    }

    const body = await readJson(request);
    if (action === 'fail') {
      if (message.status !== 'ready') {
        message.status = 'failed';
        message.failureReason = String(body['reason']);
      }
      return send(response, 204);
    }

    // complete
    if (message.status === 'ready') return send(response, 409, { code: 'already_uploaded' });
    const head = await scoped.headObject(message.objectKey);
    if (head === undefined) return send(response, 409, { code: 'object_missing' });
    if (head.sizeBytes !== body['sizeBytes']) return send(response, 409, { code: 'size_mismatch' });
    if (head.etag !== null && /^[0-9a-f]{32}$/.test(head.etag) && head.etag !== body['md5']) {
      return send(response, 409, { code: 'checksum_mismatch' });
    }
    message.status = 'ready';
    message.sizeBytes = head.sizeBytes;
    message.durationMs = (body['durationMs'] as number | null | undefined) ?? null;
    message.sha256 = (body['sha256'] as string | undefined) ?? null;
    message.failureReason = null;
    return send(response, 200, {
      id: message.id,
      status: message.status,
      sizeBytes: message.sizeBytes,
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      send(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeVoicemailService = {
    url: `http://127.0.0.1:${String(port)}`,
    messages,
    calls,
    down: null,
    create(tenantId) {
      const id = crypto.randomUUID();
      const mailboxId = crypto.randomUUID();
      const message: FakeMessage = {
        id,
        tenantId,
        objectKey: `voicemail/${mailboxId}/${id}.wav`,
        status: 'pending',
        sizeBytes: null,
        durationMs: null,
        sha256: null,
        failureReason: null,
      };
      messages.set(id, message);
      return message;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
  return fake;
}
