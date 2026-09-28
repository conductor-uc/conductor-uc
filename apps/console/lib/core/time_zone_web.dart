import 'dart:js_interop';

@JS('Intl.DateTimeFormat')
extension type _DateTimeFormat._(JSObject _) implements JSObject {
  external factory _DateTimeFormat();
  external _ResolvedOptions resolvedOptions();
}

extension type _ResolvedOptions._(JSObject _) implements JSObject {
  external String? get timeZone;
}

/// The browser's time zone, or null if it won't say.
String? browserTimeZone() {
  try {
    return _DateTimeFormat().resolvedOptions().timeZone;
  } catch (_) {
    return null;
  }
}
