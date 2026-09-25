/// One open WebSocket, reduced to what the realtime client needs, so the client
/// runs (and is tested) the same over the browser's socket and a fake one.
abstract class RealtimeSocket {
  /// Text frames from the server. Closes when the socket does.
  Stream<String> get messages;

  /// Completes with the close code when the socket has closed (1006 when it
  /// dropped with none).
  Future<int> get done;

  void send(String data);

  void close([int code = 1000]);
}

/// Opens a socket to [url]. Fails when it cannot be opened (the server
/// refused the upgrade, or is not there).
typedef RealtimeConnector = Future<RealtimeSocket> Function(Uri url);
