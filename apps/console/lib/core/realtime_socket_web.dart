import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'realtime_socket.dart';

/// Opens the browser's own WebSocket. The access token is never put in the
/// URL; the realtime client sends it as the first message.
Future<RealtimeSocket> connectBrowserSocket(Uri url) {
  final socket = web.WebSocket(url.toString());
  final opened = Completer<RealtimeSocket>();
  final messages = StreamController<String>();
  final done = Completer<int>();

  socket.onopen = ((web.Event _) {
    if (!opened.isCompleted) {
      opened.complete(_BrowserSocket(socket, messages, done));
    }
  }).toJS;
  socket.onmessage = ((web.MessageEvent event) {
    final data = event.data;
    if (data.isA<JSString>()) messages.add((data as JSString).toDart);
  }).toJS;
  socket.onclose = ((web.CloseEvent event) {
    if (!opened.isCompleted) {
      opened.completeError(StateError('Could not open the live connection.'));
    }
    if (!done.isCompleted) done.complete(event.code);
    unawaited(messages.close());
  }).toJS;
  // An error is always followed by a close event, which does the work.
  socket.onerror = ((web.Event _) {}).toJS;
  return opened.future;
}

class _BrowserSocket implements RealtimeSocket {
  _BrowserSocket(this._socket, this._messages, this._done);

  final web.WebSocket _socket;
  final StreamController<String> _messages;
  final Completer<int> _done;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<int> get done => _done.future;

  @override
  void send(String data) {
    if (_socket.readyState == web.WebSocket.OPEN) _socket.send(data.toJS);
  }

  @override
  void close([int code = 1000]) => _socket.close(code);
}
