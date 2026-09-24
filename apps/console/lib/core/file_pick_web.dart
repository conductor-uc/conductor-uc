import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

/// A file the user chose.
class PickedFile {
  const PickedFile(this.name, this.contentType, this.bytes);

  final String name;
  final String contentType;
  final Uint8List bytes;
}

/// Opens the browser's file chooser for an image and reads what is chosen, or
/// returns null when the chooser is dismissed.
Future<PickedFile?> pickImageFile() {
  final done = Completer<PickedFile?>();
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = 'image/png,image/jpeg,image/svg+xml,image/x-icon,image/webp';
  input.onChange.first.then((_) async {
    final file = input.files?.item(0);
    if (file == null) {
      done.complete(null);
      return;
    }
    final buffer = await file.arrayBuffer().toDart;
    done.complete(
      PickedFile(file.name, file.type, buffer.toDart.asUint8List()),
    );
  });
  input.addEventListener(
    'cancel',
    ((web.Event _) {
      if (!done.isCompleted) done.complete(null);
    }).toJS,
  );
  input.click();
  return done.future;
}
