import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'file_source.dart';

/// Opens the browser's file chooser for an audio file. Null when the person
/// cancels.
Future<PickedFile?> pickAudioFile() {
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = 'audio/*,.wav,.mp3,.ogg,.m4a,.flac';
  final done = Completer<PickedFile?>();
  input.addEventListener(
    'change',
    // `toJS` takes no async function, so the reading runs from a plain one.
    ((web.Event _) {
      final file = input.files?.item(0);
      if (file == null) {
        done.complete(null);
        return;
      }
      unawaited(() async {
        final buffer = await file.arrayBuffer().toDart;
        done.complete(
          PickedFile(file.name, file.type, buffer.toDart.asUint8List()),
        );
      }());
    }).toJS,
  );
  input.addEventListener(
    'cancel',
    ((web.Event _) {
      if (!done.isCompleted) done.complete(null);
    }).toJS,
  );
  input.click();
  return done.future;
}
