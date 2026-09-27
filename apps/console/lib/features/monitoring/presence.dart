import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/realtime.dart';
import '../pbx/pbx_api.dart';

/// One extension on the presence board, as the `tenant:{t}:presence` topic
/// sends it.
class Presence {
  const Presence(this.extension, this.state);

  /// The extension's number.
  final String extension;

  /// `idle` (a phone is registered and not on a call), `ringing`, `on_call`,
  /// `dnd` (do not disturb is set) or `offline` (no phone registered). Anything
  /// else is shown as it comes, never refused.
  final String state;
}

/// What the presence board shows: the extensions, or why there are none to
/// show.
class PresenceView {
  const PresenceView({
    this.extensions = const [],
    this.stopped,
    this.loaded = false,
  });

  /// In number order.
  final List<Presence> extensions;

  /// Why presence is not being received, when it is not (a
  /// [TopicStopped.code]).
  final String? stopped;

  /// A snapshot has arrived since the last (re)subscribe.
  final bool loaded;
}

/// The tenant's extensions and their presence, kept from the topic's snapshot
/// and changes. The snapshot lists every extension of the tenant; an extension
/// a change names that the snapshot did not (one added since) is added.
class PresenceBook {
  final _states = <String, String>{};
  String? _stopped;
  bool _loaded = false;

  PresenceView apply(TopicMessage message) {
    switch (message) {
      case TopicSubscribed():
        _stopped = null;
      case TopicSnapshot(:final data):
        _states
          ..clear()
          ..addEntries([
            for (final json in (data['extensions'] as List? ?? const []))
              if (json is Map && json['extension'] != null)
                MapEntry('${json['extension']}', '${json['state'] ?? ''}'),
          ]);
        _stopped = null;
        _loaded = true;
      case TopicEvent(:final event):
        if (event['type'] == 'presence.changed' && event['extension'] != null) {
          _states['${event['extension']}'] = '${event['state'] ?? ''}';
        }
      case TopicStopped(:final code):
        _stopped = code;
        _loaded = false;
    }
    return view();
  }

  PresenceView view() => PresenceView(
    extensions: [
      for (final e
          in _states.entries.toList()
            ..sort((a, b) => compareExtensions(a.key, b.key)))
        Presence(e.key, e.value),
    ],
    stopped: _stopped,
    loaded: _loaded,
  );
}

/// Orders extension numbers as numbers (`9` before `10`), then as text; a
/// number that is not all digits comes after those that are.
int compareExtensions(String a, String b) {
  final x = int.tryParse(a);
  final y = int.tryParse(b);
  if (x != null && y != null && x != y) return x.compareTo(y);
  if (x != null && y == null) return -1;
  if (x == null && y != null) return 1;
  return a.compareTo(b);
}

/// The topic name for a tenant's extension presence.
String presenceTopic(String tenantId) => 'tenant:$tenantId:presence';

/// The presence of the tenant being looked at, from the realtime hub. Only
/// watched while a screen shows it: leaving the screen unsubscribes.
final presenceProvider = StreamProvider.autoDispose<PresenceView>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final client = ref.watch(realtimeClientProvider);
  if (tenant == null || client == null) return const Stream.empty();
  final book = PresenceBook();
  return client.watch(presenceTopic(tenant)).map(book.apply);
});
