import 'file_source.dart';

/// Non-web stand-in: the console only runs on the web, and tests supply their
/// own picker.
Future<PickedFile?> pickAudioFile() async => null;
