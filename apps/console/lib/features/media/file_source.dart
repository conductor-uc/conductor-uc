import 'dart:typed_data';

export 'file_source_stub.dart'
    if (dart.library.js_interop) 'file_source_web.dart';

/// A file the user chose to upload.
class PickedFile {
  const PickedFile(this.name, this.contentType, this.bytes);

  final String name;
  final String contentType;
  final Uint8List bytes;
}

/// The audio content type for a file, from what the browser reported or, when
/// it reported none, the extension. Null when it is not audio the service
/// takes.
String? audioContentType(String name, String reported) {
  if (reported.startsWith('audio/')) return reported;
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'wav' => 'audio/wav',
    'mp3' => 'audio/mpeg',
    'ogg' => 'audio/ogg',
    'm4a' => 'audio/mp4',
    'flac' => 'audio/flac',
    _ => null,
  };
}
