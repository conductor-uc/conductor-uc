import { describe, expect, it } from 'vitest';

import { buildWav, inspectWav } from '../src/uploader/wav.js';

describe('inspectWav', () => {
  it('reads the duration of a closed stereo file and calls it complete', () => {
    const file = buildWav({ sampleRate: 8000, channels: 2, seconds: 3 });
    expect(inspectWav(file.subarray(0, 512), file.length)).toEqual({
      complete: true,
      durationMs: 3000,
    });
  });

  it('calls a file whose header still has placeholder sizes incomplete, and estimates its length', () => {
    const file = buildWav({ sampleRate: 8000, channels: 1, seconds: 2, open: true });
    expect(inspectWav(file.subarray(0, 512), file.length)).toEqual({
      complete: false,
      durationMs: 2000,
    });
  });

  it('calls a file cut short incomplete', () => {
    const file = buildWav({ sampleRate: 8000, channels: 1, seconds: 2 });
    const cut = file.subarray(0, file.length - 100);
    expect(inspectWav(cut.subarray(0, 512), cut.length).complete).toBe(false);
  });

  it('is not fooled by something that is not a WAV', () => {
    expect(inspectWav(Buffer.from('hello world, definitely not audio'), 33)).toEqual({
      complete: false,
      durationMs: null,
    });
    expect(inspectWav(Buffer.alloc(0), 0).complete).toBe(false);
  });
});
