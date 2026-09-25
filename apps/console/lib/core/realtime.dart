import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../dev/demo_realtime.dart';
import 'config.dart';
import 'realtime_socket.dart';
import 'realtime_socket_stub.dart'
    if (dart.library.js_interop) 'realtime_socket_web.dart';
import 'session.dart';

export 'realtime_socket.dart';

/// What a topic's stream carries (the gateway's realtime protocol, 06
/// api-gateway "Realtime hub").
sealed class TopicMessage {
  const TopicMessage();
}

/// Everything the topic shows now. Replaces whatever came before: it arrives
/// on every (re)subscribe, including after a reconnect.
class TopicSnapshot extends TopicMessage {
  const TopicSnapshot(this.data);
  final Map<String, dynamic> data;
}

/// One change after the snapshot, in order.
class TopicEvent extends TopicMessage {
  const TopicEvent(this.event);
  final Map<String, dynamic> event;
}

/// The subscription was accepted (a snapshot follows, for topics that have one).
class TopicSubscribed extends TopicMessage {
  const TopicSubscribed();
}

/// The topic is not being received, and why: refused (`permission_denied`,
/// `forbidden`, `reseller_private_data_denied`, …), ended by the server, or
/// the connection is down (`offline`). Codes that may clear up by themselves
/// (`unavailable`, `offline`) are retried; the others are not.
class TopicStopped extends TopicMessage {
  const TopicStopped(this.code);
  final String code;

  bool get willRetry => code == 'unavailable' || code == 'offline';
}

/// The address of the gateway's realtime endpoint: the API's own origin with a
/// WebSocket scheme. The console is served from the gateway (08 §1), so that is
/// the page's own origin unless `API_BASE_URL` points elsewhere.
Uri realtimeUrl(String apiBase, Uri page) {
  final base = apiBase.isEmpty ? page : Uri.parse(apiBase);
  final secure = base.scheme == 'https';
  return Uri(
    scheme: secure ? 'wss' : 'ws',
    host: base.host,
    port: base.hasPort ? base.port : null,
    path: '/v1/ws',
  );
}

/// The console's live connection to the gateway's realtime hub.
///
/// One per signed-in session. It connects on first use, authenticates with the
/// current access token (in the first message, never in the URL), sends a
/// fresh token whenever the session refreshes it (before the old one expires),
/// and subscribes to whatever is being watched. When the connection drops it
/// reconnects with a growing, jittered delay and subscribes again; each topic
/// then gets a fresh snapshot. A close for a changed identity (4403) stops it:
/// that needs a new sign-in.
class RealtimeClient {
  RealtimeClient({
    required this._connect,
    required this._url,
    required this._token,
    Duration Function(int attempt)? backoff,
  }) : _backoff = backoff ?? defaultBackoff;

  final RealtimeConnector _connect;
  final Uri _url;
  final String? Function() _token;
  final Duration Function(int attempt) _backoff;

  final _topics = <String, StreamController<TopicMessage>>{};
  final _retries = <String, Timer>{};
  RealtimeSocket? _socket;
  StreamSubscription<String>? _reading;
  bool _authenticated = false;
  bool _connecting = false;
  bool _stopped = false;
  int _attempt = 0;
  Timer? _reconnect;

  /// Delay before reconnect attempt [attempt] (0-based): 1 s doubling to 30 s,
  /// each with up to a quarter more at random so a restarted gateway is not
  /// met by every console at the same instant.
  static Duration defaultBackoff(int attempt) {
    final base = min(30000, 1000 * pow(2, min(attempt, 5)).toInt());
    return Duration(milliseconds: base + Random().nextInt(base ~/ 4 + 1));
  }

  /// Whether the connection is up and authenticated.
  bool get isLive => _authenticated;

  /// The messages of [topic], for as long as the stream is listened to.
  /// Listening subscribes; cancelling unsubscribes.
  Stream<TopicMessage> watch(String topic) {
    final existing = _topics[topic];
    if (existing != null) return existing.stream;
    late final StreamController<TopicMessage> controller;
    controller = StreamController<TopicMessage>.broadcast(
      onListen: () {
        if (_authenticated) _subscribe(topic);
        _ensureConnected();
      },
      onCancel: () {
        _topics.remove(topic);
        _retries.remove(topic)?.cancel();
        if (_authenticated) _send({'type': 'unsubscribe', 'topic': topic});
        unawaited(controller.close());
      },
    );
    _topics[topic] = controller;
    return controller.stream;
  }

  /// Sends a fresh access token on the open connection (the session refreshed it).
  void updateToken(String token) {
    if (_socket != null) _send({'type': 'auth', 'token': token});
  }

  void dispose() {
    _stopped = true;
    _reconnect?.cancel();
    for (final timer in _retries.values) {
      timer.cancel();
    }
    _retries.clear();
    unawaited(_reading?.cancel());
    _socket?.close();
    _socket = null;
    for (final controller in _topics.values) {
      unawaited(controller.close());
    }
    _topics.clear();
  }

  void _ensureConnected() {
    if (_stopped || _socket != null || _connecting || _reconnect != null) {
      return;
    }
    if (_topics.isEmpty) return;
    unawaited(_open());
  }

  Future<void> _open() async {
    final token = _token();
    if (token == null) return;
    _connecting = true;
    RealtimeSocket socket;
    try {
      socket = await _connect(_url);
    } catch (_) {
      _connecting = false;
      _markOffline();
      _scheduleReconnect();
      return;
    }
    _connecting = false;
    if (_stopped) {
      socket.close();
      return;
    }
    _socket = socket;
    _reading = socket.messages.listen(_onMessage);
    unawaited(socket.done.then((code) => _onClosed(socket, code)));
    _send({'type': 'auth', 'token': _token() ?? token});
  }

  void _onClosed(RealtimeSocket socket, int code) {
    if (!identical(socket, _socket)) return;
    _socket = null;
    _authenticated = false;
    unawaited(_reading?.cancel());
    _reading = null;
    _markOffline();
    if (_stopped) return;
    // A different person or organization: only signing in again helps.
    if (code == 4403) {
      _stopped = true;
      return;
    }
    _scheduleReconnect();
  }

  void _markOffline() {
    for (final controller in _topics.values) {
      controller.add(const TopicStopped('offline'));
    }
  }

  void _scheduleReconnect() {
    if (_stopped || _topics.isEmpty) return;
    final delay = _backoff(_attempt);
    _attempt += 1;
    _reconnect = Timer(delay, () {
      _reconnect = null;
      _ensureConnected();
    });
  }

  void _subscribe(String topic) => _send({'type': 'subscribe', 'topic': topic});

  void _send(Map<String, Object?> message) =>
      _socket?.send(jsonEncode(message));

  void _onMessage(String raw) {
    Map<String, dynamic> message;
    try {
      message = (jsonDecode(raw) as Map).cast<String, dynamic>();
    } catch (_) {
      return;
    }
    final topic = message['topic'] as String?;
    final controller = topic == null ? null : _topics[topic];
    switch (message['type']) {
      case 'authenticated':
        final first = !_authenticated;
        _authenticated = true;
        _attempt = 0;
        if (first) _topics.keys.forEach(_subscribe);
      case 'subscribed':
        controller?.add(const TopicSubscribed());
      case 'snapshot':
        controller?.add(
          TopicSnapshot((message['data'] as Map).cast<String, dynamic>()),
        );
      case 'event':
        controller?.add(
          TopicEvent((message['event'] as Map).cast<String, dynamic>()),
        );
      case 'error' || 'unsubscribed':
        final code = message['code'] as String?;
        if (controller == null || code == null) return;
        final stopped = TopicStopped(code);
        controller.add(stopped);
        if (stopped.willRetry) _retryLater(topic!);
    }
  }

  void _retryLater(String topic) {
    _retries.remove(topic)?.cancel();
    _retries[topic] = Timer(_backoff(1), () {
      _retries.remove(topic);
      if (_topics.containsKey(topic) && _authenticated) _subscribe(topic);
    });
  }
}

/// How the console opens a live connection: the browser's WebSocket, or the
/// demo's canned one. Tests replace it.
final realtimeConnectorProvider = Provider<RealtimeConnector>(
  (ref) => demoMode ? demoRealtimeConnector : connectBrowserSocket,
);

/// The live connection of the signed-in session, or null when signed out. A new
/// one for each person; a refreshed token is handed to the open one.
final realtimeClientProvider = Provider<RealtimeClient?>((ref) {
  final identity = ref.watch(
    sessionProvider.select((s) => s == null ? null : '${s.orgId}/${s.userId}'),
  );
  if (identity == null) return null;
  final client = RealtimeClient(
    connect: ref.watch(realtimeConnectorProvider),
    url: realtimeUrl(apiBaseUrl, Uri.base),
    token: () => ref.read(sessionProvider)?.accessToken,
  );
  ref.listen(sessionProvider, (previous, next) {
    if (next != null && next.accessToken != previous?.accessToken) {
      client.updateToken(next.accessToken);
    }
  });
  ref.onDispose(client.dispose);
  return client;
});
