/// Saves bytes the console made itself (S1-16: the settings export) as a file
/// the browser downloads.
library;

export 'save_file_stub.dart' if (dart.library.js_interop) 'save_file_web.dart';
