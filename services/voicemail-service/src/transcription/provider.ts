/**
 * S5-06 (O-3): a speech-to-text engine. One adapter per kind of API; an operator configures
 * which engines exist (`config.ts`). The audio and the text are private-class data: an adapter
 * never logs either.
 */
export interface TranscriptionProvider {
  /** The text of a recording (WAV). Throws when the engine could not be reached or refused it. */
  transcribe(audio: Buffer): Promise<string>;
}

export class TranscriptionError extends Error {
  override readonly name = 'TranscriptionError';
}

export interface OpenAiCompatibleOptions {
  /** The engine's base URL, e.g. `http://whisper:8000` or a vendor's `https://api.example.com`. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  /** Asked of the engine as a hint; omitted when not set. */
  readonly language?: string;
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The widely implemented `POST /v1/audio/transcriptions` API (multipart: `file`, `model`,
 * `response_format=json`, answering `{text}`). Self-hosted Whisper servers (faster-whisper,
 * speaches) speak it, and so do several hosted engines, so the one adapter serves both the
 * operator's in-house engine and a hosted one; a vendor with its own API gets its own adapter.
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): TranscriptionProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  return {
    async transcribe(audio) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voicemail.wav');
      form.append('model', options.model);
      form.append('response_format', 'json');
      if (options.language !== undefined) form.append('language', options.language);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          body: form,
          headers:
            options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        });
      } catch (error) {
        throw new TranscriptionError(
          `Could not reach the transcription engine (${error instanceof Error ? error.name : 'error'}).`,
        );
      }
      if (!response.ok) {
        throw new TranscriptionError(
          `The transcription engine refused the recording (${String(response.status)}).`,
        );
      }
      const body = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
      if (typeof body?.text !== 'string') {
        throw new TranscriptionError('The transcription engine answered without a transcript.');
      }
      return body.text.trim();
    },
  };
}
