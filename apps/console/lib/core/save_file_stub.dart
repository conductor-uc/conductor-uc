import 'dart:typed_data';

/// Off the web there is no browser to hand the file to; tests replace this
/// through `fileSaverProvider`.
void saveFile(String name, String mimeType, Uint8List bytes) {}
