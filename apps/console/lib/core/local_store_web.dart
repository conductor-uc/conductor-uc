import 'package:web/web.dart' as web;

/// The saved value for [key], or null, including when the browser refuses
/// storage (a private window, a blocked site).
String? readLocal(String key) {
  try {
    return web.window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

/// Saves [value] under [key]; null forgets it.
void writeLocal(String key, String? value) {
  try {
    value == null
        ? web.window.localStorage.removeItem(key)
        : web.window.localStorage.setItem(key, value);
  } catch (_) {
    // Storage refused: the choice lasts until the page is reloaded.
  }
}
