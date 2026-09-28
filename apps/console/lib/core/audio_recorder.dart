/// Records a short piece of audio from the microphone and hands it back as a
/// WAV file (S9-11: a person recording their own voicemail greeting).
library;

import 'dart:typed_data';

export 'audio_recorder_stub.dart'
    if (dart.library.js_interop) 'audio_recorder_web.dart';

/// What records a greeting: [AudioRecorder] in a browser, a fake in tests.
abstract interface class Recorder {
  /// Asks for the microphone and starts; throws when it is refused.
  Future<void> start();

  /// Stops, and gives back what was said as a WAV file.
  Future<Uint8List> stop();

  /// Stops without keeping anything.
  void cancel();
}

/// Mono 16-bit PCM samples (-1.0 to 1.0) at [sampleRate], as a WAV file.
Uint8List encodeWav(List<double> samples, int sampleRate) {
  final data = ByteData(44 + samples.length * 2);
  void ascii(int offset, String text) {
    for (var i = 0; i < text.length; i++) {
      data.setUint8(offset + i, text.codeUnitAt(i));
    }
  }

  ascii(0, 'RIFF');
  data.setUint32(4, 36 + samples.length * 2, Endian.little);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little); // PCM
  data.setUint16(22, 1, Endian.little); // mono
  data.setUint32(24, sampleRate, Endian.little);
  data.setUint32(28, sampleRate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  ascii(36, 'data');
  data.setUint32(40, samples.length * 2, Endian.little);
  for (var i = 0; i < samples.length; i++) {
    final s = samples[i].clamp(-1.0, 1.0);
    data.setInt16(44 + i * 2, (s * 32767).round(), Endian.little);
  }
  return data.buffer.asUint8List();
}
