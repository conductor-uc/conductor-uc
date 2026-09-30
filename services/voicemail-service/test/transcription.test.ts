import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { engineFor, TENANT_DEFAULT } from '../src/domain/transcription.js';
import { registerMailboxRoutes } from '../src/routes/mailbox.routes.js';
import { createTranscriber } from '../src/transcriber.js';
import {
  createOpenAiCompatibleProvider,
  TranscriptionError,
  type TranscriptionProvider,
} from '../src/transcription/provider.js';
import { resetSchema, startHarness, storeAudio, TEST_ENGINES, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';

describe('engineFor (S5-06)', () => {
  const on = { enabled: true, engine: 'self_hosted' as const };
  it('is off by default, and follows the tenant unless the mailbox says otherwise', () => {
    expect(engineFor(TENANT_DEFAULT, 'inherit', ['default', 'self_hosted'])).toBeNull();
    expect(engineFor(on, 'inherit', ['self_hosted'])).toBe('self_hosted');
    expect(engineFor(on, 'off', ['self_hosted'])).toBeNull();
    // A mailbox turned on uses the tenant's engine even while the tenant is off.
    expect(engineFor({ ...on, enabled: false }, 'on', ['self_hosted'])).toBe('self_hosted');
  });

  it('never picks an engine the operator did not configure', () => {
    expect(engineFor({ enabled: true, engine: 'default' }, 'inherit', ['self_hosted'])).toBeNull();
    expect(engineFor(TENANT_DEFAULT, 'on', [])).toBeNull();
  });
});

describe('the OpenAI-compatible adapter (S5-06)', () => {
  it('posts the recording and model as multipart, with the key, and returns the text', async () => {
    let seen: {
      url?: string | undefined;
      auth?: string | undefined;
      type?: string | undefined;
      body?: string;
    } = {};
    const server = createHttpServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen = {
          url: request.url,
          auth: request.headers.authorization,
          type: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('latin1'),
        };
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ text: '  Hi, call me back.  ' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: base,
        apiKey: 'k-123',
        model: 'whisper-small',
        language: 'en',
      });
      expect(await provider.transcribe(Buffer.from('RIFF-wav'))).toBe('Hi, call me back.');
      expect(seen.url).toBe('/v1/audio/transcriptions');
      expect(seen.auth).toBe('Bearer k-123');
      expect(seen.type).toContain('multipart/form-data');
      for (const part of [
        'name="model"',
        'whisper-small',
        'name="file"',
        'RIFF-wav',
        'json',
        'en',
      ]) {
        expect(seen.body).toContain(part);
      }
    } finally {
      server.close();
    }
  });

  it('fails plainly when the engine refuses or is unreachable', async () => {
    const refusing = createOpenAiCompatibleProvider({
      baseUrl: 'http://127.0.0.1:1',
      model: 'm',
      timeoutMs: 2_000,
    });
    await expect(refusing.transcribe(Buffer.from('x'))).rejects.toThrow(TranscriptionError);
  });
});

/**
 * S5-06 (O-3), against a real database and MinIO: a message is marked for transcription when it
 * becomes ready and its tenant or mailbox asked, the transcriber sends the stored audio to the
 * engine and keeps the text, and the API shows it. The engine is faked.
 */
describe.skipIf(skipReason !== undefined)('voicemail transcription (S5-06)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'voicemail-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerMailboxRoutes(app, h.mailboxes, h.messages, h.storage, {
      transcriptionSettings: h.transcriptionSettings,
      availableEngines: TEST_ENGINES,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function headers(tenantId: string) {
    return signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  /** A mailbox with one message whose audio is in storage, completed now. */
  async function leaveMessage(tenantId: string, mailboxId?: string) {
    const box =
      mailboxId ??
      (await h.mailboxes.create({ tenantId }, { extensionId: crypto.randomUUID(), pin: '1234' }))
        .id;
    const { message } = await h.messages.create({ tenantId }, box, {});
    await storeAudio(h, tenantId, message.objectKey, 'RIFF-audio-bytes');
    const ready = await h.messages.complete({ tenantId }, message.id, {
      durationMs: 4_000,
      sizeBytes: 16,
    });
    return { mailboxId: box, message: ready };
  }

  function transcriber(provider: TranscriptionProvider, now = () => new Date()) {
    return createTranscriber({
      messages: h.messages,
      storage: h.storage,
      engines: new Map([['self_hosted', provider]]),
      logger: h.logger,
      now,
      maxAttempts: 2,
    });
  }

  it('transcribes nothing by default', async () => {
    const tenantId = crypto.randomUUID();
    const { message } = await leaveMessage(tenantId);
    expect(message.transcriptStatus).toBe('none');
    const calls: Buffer[] = [];
    expect(
      await transcriber({
        transcribe: (audio) => (calls.push(audio), Promise.resolve('x')),
      }).drain(),
    ).toBe(0);
    expect(calls).toEqual([]);
  });

  it('transcribes a tenant that opted in, keeps the text, and shows it', async () => {
    const tenantId = crypto.randomUUID();
    await h.transcriptionSettings.put({ tenantId }, { enabled: true, engine: 'self_hosted' });
    const { mailboxId, message } = await leaveMessage(tenantId);
    expect(message.transcriptStatus).toBe('pending');

    const heard: string[] = [];
    const done = await transcriber({
      transcribe: (audio) => {
        heard.push(audio.toString());
        return Promise.resolve('Hi, it is Pat. Call me back on 555 0100.');
      },
    }).drain();
    expect(done).toBe(1);
    expect(heard).toEqual(['RIFF-audio-bytes']);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${mailboxId}/messages`,
      headers: headers(tenantId),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ rows: unknown[] }>().rows).toEqual([
      expect.objectContaining({
        id: message.id,
        transcript: 'Hi, it is Pat. Call me back on 555 0100.',
        transcriptStatus: 'done',
      }),
    ]);
  });

  it('follows a mailbox turned on or off by itself', async () => {
    const tenantId = crypto.randomUUID();
    await h.transcriptionSettings.put({ tenantId }, { enabled: false, engine: 'self_hosted' });
    const box = await h.mailboxes.create(
      { tenantId },
      { extensionId: crypto.randomUUID(), pin: '1234' },
    );
    const on = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/voicemail/mailboxes/${box.id}/transcription`,
      headers: headers(tenantId),
      payload: { transcribe: 'on' },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ id: box.id, transcribe: 'on' });
    expect((await leaveMessage(tenantId, box.id)).message.transcriptStatus).toBe('pending');

    await h.transcriptionSettings.put({ tenantId }, { enabled: true, engine: 'self_hosted' });
    await h.mailboxes.setTranscription({ tenantId }, box.id, 'off');
    expect((await leaveMessage(tenantId, box.id)).message.transcriptStatus).toBe('none');
  });

  it('tries a failed transcription again, then marks it failed; the message stays', async () => {
    const tenantId = crypto.randomUUID();
    await h.transcriptionSettings.put({ tenantId }, { enabled: true, engine: 'self_hosted' });
    const { mailboxId, message } = await leaveMessage(tenantId);
    let tries = 0;
    const failing = transcriber({
      transcribe: () => {
        tries += 1;
        return Promise.reject(new TranscriptionError('engine down'));
      },
    });
    await failing.drain();
    expect(tries).toBe(2);
    const [row] = await h.messages.listReady({ tenantId }, mailboxId);
    expect(row).toMatchObject({ id: message.id, transcriptStatus: 'failed', transcript: null });
  });

  it('takes again a message whose transcriber died, and never gives one message to two', async () => {
    const tenantId = crypto.randomUUID();
    await h.transcriptionSettings.put({ tenantId }, { enabled: true, engine: 'self_hosted' });
    const { message } = await leaveMessage(tenantId);
    const now = new Date();
    const first = await h.messages.claimTranscription({}, now, new Date(now.getTime() - 60_000));
    expect(first?.id).toBe(message.id);
    // Taken and not stale: nobody else gets it.
    expect(
      await h.messages.claimTranscription({}, now, new Date(now.getTime() - 60_000)),
    ).toBeUndefined();
    // Ten minutes later it counts as abandoned.
    const later = new Date(now.getTime() + 11 * 60_000);
    const again = await h.messages.claimTranscription(
      {},
      later,
      new Date(later.getTime() - 600_000),
    );
    expect(again).toMatchObject({ id: message.id, attempts: 2 });
  });

  it('keeps the tenant opt-in, and refuses an engine the operator did not configure', async () => {
    const tenantId = crypto.randomUUID();
    const get = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/voicemail/transcription`,
      headers: headers(tenantId),
    });
    expect(get.json()).toEqual({
      enabled: false,
      engine: 'default',
      availableEngines: ['self_hosted'],
    });

    const refused = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/voicemail/transcription`,
      headers: headers(tenantId),
      payload: { enabled: true, engine: 'default' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'transcription_engine_unavailable' });

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/voicemail/transcription`,
      headers: headers(tenantId),
      payload: { enabled: true, engine: 'self_hosted' },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({
      enabled: true,
      engine: 'self_hosted',
      availableEngines: ['self_hosted'],
    });
    expect(await h.transcriptionSettings.get({ tenantId })).toEqual({
      enabled: true,
      engine: 'self_hosted',
    });
    // Another tenant is untouched.
    expect(await h.transcriptionSettings.get({ tenantId: crypto.randomUUID() })).toEqual(
      TENANT_DEFAULT,
    );
  });
});
