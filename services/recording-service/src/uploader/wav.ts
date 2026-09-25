/**
 * Just enough of a RIFF/WAVE header to tell whether FreeSWITCH has closed the file and how long
 * the audio is. libsndfile (behind `record_session`) writes placeholder sizes while a file is
 * open and the real ones when it closes, so a header whose sizes match the file's actual length
 * is a strong signal the recording is finished.
 */
export interface WavInfo {
  /** The header's sizes agree with the file's length: the writer closed it. */
  readonly complete: boolean;
  /** Null when the header has no usable format chunk. */
  readonly durationMs: number | null;
}

const NOT_WAV: WavInfo = { complete: false, durationMs: null };

/** `header` is the file's first bytes (a few hundred are plenty); `fileSize` is its full length. */
export function inspectWav(header: Buffer, fileSize: number): WavInfo {
  if (header.length < 12) return NOT_WAV;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    return NOT_WAV;
  }
  const riffSize = header.readUInt32LE(4);

  let byteRate: number | null = null;
  let dataOffset: number | null = null;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= header.length) {
    const id = header.toString('ascii', offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= header.length) {
      byteRate = header.readUInt32LE(offset + 8 + 8);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset === null) return NOT_WAV;

  // While the file is open the sizes are a placeholder (0 or 0xFFFFFFFF), never the real length.
  const complete = riffSize + 8 === fileSize && dataOffset + dataSize === fileSize;
  const audioBytes = complete ? dataSize : Math.max(fileSize - dataOffset, 0);
  const durationMs =
    byteRate === null || byteRate === 0 ? null : Math.round((audioBytes / byteRate) * 1000);
  return { complete, durationMs };
}

/** Builds a PCM WAV file's bytes: for tests and for callers that need a valid sample. */
export function buildWav(options: {
  readonly sampleRate: number;
  readonly channels: number;
  readonly seconds: number;
  /** Write header sizes as libsndfile does before it closes a file. */
  readonly open?: boolean;
}): Buffer {
  const bytesPerSample = 2;
  const byteRate = options.sampleRate * options.channels * bytesPerSample;
  const dataSize = Math.round(byteRate * options.seconds);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(options.open === true ? 0 : 36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(options.channels, 22);
  buffer.writeUInt32LE(options.sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(options.channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(options.open === true ? 0 : dataSize, 40);
  return buffer;
}
