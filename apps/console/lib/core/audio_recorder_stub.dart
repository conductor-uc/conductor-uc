import 'dart:typed_data';

import 'audio_recorder.dart' show Recorder;

/// Where recording is not possible (tests, non-web builds).
class AudioRecorder implements Recorder {
  static bool get supported => false;

  @override
  Future<void> start() async => throw UnsupportedError('No microphone here.');

  @override
  Future<Uint8List> stop() async =>
      throw UnsupportedError('No microphone here.');

  @override
  void cancel() {}
}
