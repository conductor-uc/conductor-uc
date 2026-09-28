import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'audio_recorder.dart' show Recorder, encodeWav;

/// Records from the browser's microphone: MediaRecorder for the capture, then
/// the browser's own decoder turns what it recorded into samples, which are
/// written out as WAV (what the voicemail greeting store takes).
class AudioRecorder implements Recorder {
  static bool get supported =>
      web.window.navigator.mediaDevices.isDefinedAndNotNull;

  web.MediaStream? _stream;
  web.MediaRecorder? _recorder;
  final _chunks = <web.Blob>[];

  @override
  Future<void> start() async {
    _stream = await web.window.navigator.mediaDevices
        .getUserMedia(web.MediaStreamConstraints(audio: true.toJS))
        .toDart;
    _chunks.clear();
    final recorder = web.MediaRecorder(_stream!);
    recorder.ondataavailable = ((web.BlobEvent e) => _chunks.add(e.data)).toJS;
    recorder.start();
    _recorder = recorder;
  }

  @override
  Future<Uint8List> stop() async {
    final recorder = _recorder;
    if (recorder == null) throw StateError('Not recording.');
    final stopped = Completer<void>();
    recorder.onstop = ((web.Event _) => stopped.complete()).toJS;
    recorder.stop();
    await stopped.future;
    _release();
    final blob = web.Blob(_chunks.toJS);
    final encoded = await blob.arrayBuffer().toDart;
    final context = web.AudioContext();
    try {
      final audio = await context.decodeAudioData(encoded).toDart;
      final samples = audio.getChannelData(0).toDart;
      return encodeWav(samples, audio.sampleRate.round());
    } finally {
      await context.close().toDart;
    }
  }

  @override
  void cancel() {
    _recorder?.stop();
    _release();
  }

  void _release() {
    final tracks =
        _stream?.getTracks().toDart ?? const <web.MediaStreamTrack>[];
    for (final t in tracks) {
      t.stop();
    }
    _stream = null;
    _recorder = null;
  }
}
