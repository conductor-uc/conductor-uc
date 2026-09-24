import 'dart:typed_data';

/// A file the user chose.
class PickedFile {
  const PickedFile(this.name, this.contentType, this.bytes);

  final String name;
  final String contentType;
  final Uint8List bytes;
}

/// Non-web stand-in so the sources analyze and unit-test on the Dart VM. Tests
/// pass their own picker; the console itself only runs on the web.
Future<PickedFile?> pickImageFile() async => null;
