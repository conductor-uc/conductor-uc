import 'realtime_socket.dart';

/// Non-web stand-in so the sources analyze and unit-test on the Dart VM. The
/// console itself only runs on the web; tests pass their own connector.
Future<RealtimeSocket> connectBrowserSocket(Uri url) =>
    Future.error(UnsupportedError('Live updates need a browser.'));
