import 'dart:async';
import 'dart:convert';

import 'package:console/core/api_client.dart';
import 'package:console/core/permissions.dart';
import 'package:console/core/realtime.dart';
import 'package:console/core/session.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/dev/demo_realtime.dart';
import 'package:console/features/monitoring/live_calls.dart';
import 'package:console/features/monitoring/monitor_controls.dart';
import 'package:console/features/monitoring/monitoring_page.dart';
import 'package:console/features/monitoring/presence.dart';
import 'package:console/features/monitoring/presence_board.dart';
import 'package:console/features/monitoring/recording_controls.dart';
import 'package:console/features/pbx/pbx_api.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem;
import 'support.dart';

/// A socket the test drives: it records what the console sent and lets the
/// test answer as the gateway would.
class FakeSocket implements RealtimeSocket {
  final sent = <Map<String, dynamic>>[];
  final _messages = StreamController<String>();
  final _done = Completer<int>();

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<int> get done => _done.future;

  @override
  void send(String data) =>
      sent.add((jsonDecode(data) as Map).cast<String, dynamic>());

  @override
  void close([int code = 1000]) => drop(code);

  void reply(Map<String, Object?> message) =>
      _messages.add(jsonEncode(message));

  void drop(int code) {
    if (!_done.isCompleted) _done.complete(code);
    unawaited(_messages.close());
  }

  List<String> sentTypes() => [for (final m in sent) m['type'] as String];
}

/// Hands out a new [FakeSocket] per connection.
class FakeHub {
  final sockets = <FakeSocket>[];
  final urls = <Uri>[];

  Future<RealtimeSocket> connect(Uri url) async {
    urls.add(url);
    final socket = FakeSocket();
    sockets.add(socket);
    return socket;
  }

  FakeSocket get last => sockets.last;
}

Map<String, Object?> leg(
  String id, {
  String direction = 'inbound',
  String state = 'answered',
  String from = '101',
  String to = '102',
  String? bridgedTo,
  String recording = 'off',
  String controls = 'none',
  String? extension,
  int startedSecondsAgo = 65,
}) => {
  'callUuid': id,
  'direction': direction,
  'state': state,
  'from': from,
  'to': to,
  'startedAt': fixedNow
      .subtract(Duration(seconds: startedSecondsAgo))
      .toUtc()
      .toIso8601String(),
  'answeredAt': state == 'ringing'
      ? null
      : fixedNow
            .subtract(Duration(seconds: startedSecondsAgo - 5))
            .toUtc()
            .toIso8601String(),
  'bridgedTo': bridgedTo,
  'recording': recording,
  'controls': controls,
  'extension': extension,
};

final fixedNow = DateTime.utc(2026, 9, 25, 12);

/// Taps a recording button, scrolling the table to it first.
Future<void> tapVisible(WidgetTester tester, String key) async {
  final button = find.byKey(ValueKey(key));
  await tester.ensureVisible(button);
  await tester.pumpAndSettle();
  await tester.tap(button);
}

/// Signs in to the demo backend as [email] and opens Monitoring, with the
/// test driving the realtime hub.
Future<FakeHub> openMonitoring(
  WidgetTester tester, {
  String email = 'tenant@example.test',
}) async {
  final hub = FakeHub();
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        realtimeConnectorProvider.overrideWithValue(hub.connect),
        clockProvider.overrideWith((ref) => Stream.value(fixedNow)),
      ],
    ),
  );
  await submitSignIn(tester, email);
  await tester.ensureVisible(navItem('Monitoring'));
  await tester.tap(navItem('Monitoring'));
  await tester.pumpAndSettle();
  return hub;
}

/// The topic ending in [kind] (`calls`, `presence`) that [socket] subscribed
/// to: the Monitoring page watches both.
String subscribedTopic(FakeSocket socket, String kind) => [
  for (final m in socket.sent)
    if (m['type'] == 'subscribe') m['topic'] as String,
].firstWhere((t) => t.endsWith(':$kind'));

/// The listen, whisper and barge buttons on screen.
Finder monitorButtons() => find.byWidgetPredicate((w) {
  final key = w.key;
  return key is ValueKey<String> &&
      key.value.startsWith('monitor-') &&
      !key.value.startsWith('monitor-pending-');
});

/// The extensions on the presence board, in the order shown.
List<String> boardOrder(WidgetTester tester) => [
  for (final tile in tester.widgetList<PresenceTile>(find.byType(PresenceTile)))
    tile.presence.extension,
];

/// Whether the board's tile for [extension] shows [text].
Finder onTile(String extension, String text) => find.descendant(
  of: find.byKey(ValueKey('presence-$extension')),
  matching: find.text(text),
);

/// The recording buttons on screen.
Finder recordingButtons() => find.byWidgetPredicate((w) {
  final key = w.key;
  return key is ValueKey<String> && key.value.startsWith('recording-');
});

void main() {
  group('the realtime client', () {
    late FakeHub hub;
    late RealtimeClient client;
    var token = 'token-1';

    setUp(() {
      hub = FakeHub();
      token = 'token-1';
      client = RealtimeClient(
        connect: hub.connect,
        url: Uri.parse('wss://console.example.test/v1/ws'),
        token: () => token,
        backoff: (_) => Duration.zero,
      );
    });

    tearDown(() => client.dispose());

    test(
      'connects on first use, authenticates first, then subscribes',
      () async {
        final messages = <TopicMessage>[];
        final sub = client.watch('tenant:t1:calls').listen(messages.add);
        await pumpEventQueue();
        expect(hub.urls.single.toString(), 'wss://console.example.test/v1/ws');
        expect(hub.last.sent, [
          {'type': 'auth', 'token': 'token-1'},
        ]);

        hub.last.reply({'type': 'authenticated', 'v': 1, 'expiresAt': 'x'});
        await pumpEventQueue();
        expect(hub.last.sent.last, {
          'type': 'subscribe',
          'topic': 'tenant:t1:calls',
        });

        hub.last
          ..reply({'type': 'subscribed', 'topic': 'tenant:t1:calls'})
          ..reply({
            'type': 'snapshot',
            'topic': 'tenant:t1:calls',
            'data': {'calls': []},
          })
          ..reply({
            'type': 'event',
            'topic': 'tenant:t1:calls',
            'event': {'type': 'call.ended', 'callUuid': 'c'},
          })
          // Another topic's message is not this stream's.
          ..reply({
            'type': 'event',
            'topic': 'tenant:t2:calls',
            'event': {'type': 'call.ended', 'callUuid': 'd'},
          });
        await pumpEventQueue();
        expect(messages.map((m) => m.runtimeType), [
          TopicSubscribed,
          TopicSnapshot,
          TopicEvent,
        ]);

        await sub.cancel();
        expect(hub.last.sent.last, {
          'type': 'unsubscribe',
          'topic': 'tenant:t1:calls',
        });
      },
    );

    test('hands a refreshed token to the open connection', () async {
      final sub = client.watch('tenant:t1:calls').listen((_) {});
      await pumpEventQueue();
      hub.last.reply({'type': 'authenticated'});
      await pumpEventQueue();
      client.updateToken('token-2');
      expect(hub.last.sent.last, {'type': 'auth', 'token': 'token-2'});
      // A renewal does not subscribe again.
      hub.last.reply({'type': 'authenticated'});
      await pumpEventQueue();
      expect(hub.last.sentTypes().where((t) => t == 'subscribe').length, 1);
      await sub.cancel();
    });

    test(
      'reconnects after a drop, with the current token, and subscribes again',
      () async {
        final messages = <TopicMessage>[];
        final sub = client.watch('tenant:t1:calls').listen(messages.add);
        await pumpEventQueue();
        hub.last.reply({'type': 'authenticated'});
        await pumpEventQueue();

        token = 'token-2';
        hub.last.drop(4401);
        await pumpEventQueue();
        expect(messages.last, isA<TopicStopped>());
        expect((messages.last as TopicStopped).code, 'offline');
        expect(hub.sockets, hasLength(2));
        expect(hub.last.sent, [
          {'type': 'auth', 'token': 'token-2'},
        ]);
        hub.last.reply({'type': 'authenticated'});
        await pumpEventQueue();
        expect(hub.last.sentTypes(), ['auth', 'subscribe']);
        await sub.cancel();
      },
    );

    test('says it is offline when the connection cannot be opened, and keeps trying', () async {
      var attempts = 0;
      final failing = RealtimeClient(
        connect: (url) async {
          attempts += 1;
          if (attempts < 3) throw StateError('refused');
          return hub.connect(url);
        },
        url: Uri.parse('wss://console.example.test/v1/ws'),
        token: () => token,
        backoff: (_) => Duration.zero,
      );
      addTearDown(failing.dispose);
      final messages = <TopicMessage>[];
      final sub = failing.watch('tenant:t1:calls').listen(messages.add);
      await pumpEventQueue();
      expect(messages.whereType<TopicStopped>().map((m) => m.code), [
        'offline',
        'offline',
      ]);
      expect(attempts, 3);
      expect(hub.last.sent.single['type'], 'auth');
      await sub.cancel();
    });

    test('stops for good when told the identity changed (4403)', () async {
      final sub = client.watch('tenant:t1:calls').listen((_) {});
      await pumpEventQueue();
      hub.last.drop(4403);
      await pumpEventQueue();
      expect(hub.sockets, hasLength(1));
      await sub.cancel();
    });

    test('subscribes again later when the server says unavailable, not when it refuses', () async {
      final messages = <TopicMessage>[];
      final calls = client.watch('tenant:t1:calls').listen(messages.add);
      final presence = client.watch('tenant:t1:presence').listen((_) {});
      await pumpEventQueue();
      hub.last.reply({'type': 'authenticated'});
      await pumpEventQueue();
      hub.last
        ..reply({
          'type': 'unsubscribed',
          'topic': 'tenant:t1:calls',
          'code': 'unavailable',
        })
        ..reply({
          'type': 'error',
          'topic': 'tenant:t1:presence',
          'code': 'permission_denied',
          'message': 'no',
        });
      await pumpEventQueue();
      final subscribes = [
        for (final m in hub.last.sent)
          if (m['type'] == 'subscribe') m['topic'],
      ];
      expect(subscribes, [
        'tenant:t1:calls',
        'tenant:t1:presence',
        'tenant:t1:calls',
      ]);
      expect((messages.last as TopicStopped).willRetry, isTrue);
      await calls.cancel();
      await presence.cancel();
    });

    test('builds the endpoint address from the page or the configured API', () {
      expect(
        realtimeUrl('', Uri.parse('https://console.brand.test/monitoring')),
        Uri.parse('wss://console.brand.test/v1/ws'),
      );
      expect(
        realtimeUrl('http://localhost:8080', Uri.parse('http://x/')),
        Uri.parse('ws://localhost:8080/v1/ws'),
      );
    });
  });

  group('live calls', () {
    test('pairs the two legs of a bridged call, caller first', () {
      final rows = groupLegs([
        LiveCall.fromJson(
          leg(
            'b',
            direction: 'outbound',
            bridgedTo: 'a',
            startedSecondsAgo: 60,
          ),
        ),
        LiveCall.fromJson(leg('a', from: '+15550142', to: '+15550100')),
        LiveCall.fromJson(leg('c', state: 'ringing', startedSecondsAgo: 5)),
      ]);
      expect(rows.map((r) => r.legs.map((l) => l.callUuid).toList()), [
        ['a', 'b'],
        ['c'],
      ]);
      expect(rows.first.from, '+15550142');
      expect(rows.first.to, '102');
    });

    test('keeps the list from a snapshot and the changes after it', () {
      final book = LiveCallBook();
      var view = book.apply(
        TopicSnapshot({
          'calls': [leg('a')],
        }),
      );
      expect(view.loaded, isTrue);
      expect(view.calls.single.id, 'a');

      view = book.apply(
        TopicEvent({
          'type': 'call.started',
          'call': leg('b', state: 'ringing', from: '103', to: '104'),
        }),
      );
      expect(view.calls.map((r) => r.id), ['a', 'b']);
      view = book.apply(
        const TopicEvent({
          'type': 'call.updated',
          'callUuid': 'b',
          'changes': {'state': 'held', 'recording': 'on'},
        }),
      );
      expect(view.calls.last.state, 'held');
      expect(view.calls.last.recording, isTrue);
      view = book.apply(
        const TopicEvent({'type': 'call.ended', 'callUuid': 'a'}),
      );
      expect(view.calls.map((r) => r.id), ['b']);

      view = book.apply(const TopicStopped('offline'));
      expect(view.stopped, 'offline');
      expect(view.loaded, isFalse);
    });

    test('S5-15: a paused recording, and the controls either leg says', () {
      final book = LiveCallBook();
      var view = book.apply(
        TopicSnapshot({
          'calls': [
            leg('a', bridgedTo: 'b', controls: 'pause', recording: 'on'),
            leg('b', direction: 'outbound'),
          ],
        }),
      );
      expect(view.calls.single.recordingState, 'on');
      expect(view.calls.single.controls, 'pause');
      view = book.apply(
        const TopicEvent({
          'type': 'call.updated',
          'callUuid': 'a',
          'changes': {'recording': 'paused'},
        }),
      );
      expect(view.calls.single.recordingState, 'paused');
      expect(view.calls.single.recording, isTrue);
    });

    test('S5-15: the buttons follow the feature codes rules', () {
      List<String> labels(String controls, String recording) => [
        for (final a in recordingActionsFor(controls, recording)) a.label,
      ];
      expect(labels('on_demand', 'off'), ['Record']);
      expect(labels('on_demand', 'on'), ['Stop', 'Pause']);
      expect(labels('on_demand', 'paused'), ['Stop', 'Resume']);
      // A rule recording is never stopped.
      expect(labels('pause', 'on'), ['Pause']);
      expect(labels('pause', 'paused'), ['Resume']);
      expect(labels('pause', 'off'), isEmpty);
      expect(labels('none', 'on'), isEmpty);
    });

    test('shows durations as minutes and seconds', () {
      expect(
        liveDuration(fixedNow.subtract(const Duration(seconds: 65)), fixedNow),
        '1:05',
      );
      expect(
        liveDuration(
          fixedNow.subtract(const Duration(hours: 1, seconds: 3)),
          fixedNow,
        ),
        '1:00:03',
      );
    });
  });

  group('the live calls panel', () {
    /// Each row's cells as text; a cell that is not text (the recording
    /// buttons) reads as ''.
    List<List<String>> tableRows(WidgetTester tester) => [
      for (final row in tester.widget<DataTable>(find.byType(DataTable)).rows)
        [
          for (final cell in row.cells)
            cell.child is Text ? (cell.child as Text).data! : '',
        ],
    ];

    testWidgets(
      'lists the tenant calls from the snapshot and follows the changes',
      (tester) async {
        final hub = await openMonitoring(tester);
        expect(find.text('Live calls'), findsOneWidget);
        final socket = hub.last;
        expect(socket.sent.first['type'], 'auth');
        socket.reply({'type': 'authenticated'});
        await tester.pumpAndSettle();
        final topic = subscribedTopic(socket, 'calls');
        expect(socket.sentTypes().skip(1), everyElement('subscribe'));

        socket
          ..reply({'type': 'subscribed', 'topic': topic})
          ..reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {
              'calls': [
                leg('a', bridgedTo: 'b'),
                leg('b', direction: 'outbound', startedSecondsAgo: 64),
                leg(
                  'c',
                  from: '+15550142',
                  to: '+15550100',
                  state: 'ringing',
                  startedSecondsAgo: 8,
                ),
              ],
            },
          });
        await tester.pumpAndSettle();
        expect(tableRows(tester), [
          ['101', '102', 'Talking', '1:00', '—', ''],
          ['+15550142', '+15550100', 'Ringing', '0:08', '—', ''],
        ]);

        socket
          ..reply({
            'type': 'event',
            'topic': topic,
            'event': {
              'type': 'call.updated',
              'callUuid': 'a',
              'changes': {'recording': 'on', 'state': 'held'},
            },
          })
          ..reply({
            'type': 'event',
            'topic': topic,
            'event': {
              'type': 'call.ended',
              'callUuid': 'c',
              'hangupCause': 'NORMAL_CLEARING',
            },
          });
        await tester.pumpAndSettle();
        expect(tableRows(tester), [
          ['101', '102', 'On hold', '1:00', 'Recording', ''],
        ]);

        socket.reply({
          'type': 'event',
          'topic': topic,
          'event': {'type': 'call.ended', 'callUuid': 'a'},
        });
        socket.reply({
          'type': 'event',
          'topic': topic,
          'event': {'type': 'call.ended', 'callUuid': 'b'},
        });
        await tester.pumpAndSettle();
        expect(find.text('No calls right now.'), findsOneWidget);

        // Leaving the page stops watching.
        await tester.ensureVisible(navItem('Dashboard'));
        await tester.tap(navItem('Dashboard'));
        await tester.pumpAndSettle();
        expect(find.byType(MonitoringPage), findsNothing);
        expect(
          socket.sent,
          contains(equals({'type': 'unsubscribe', 'topic': topic})),
        );
      },
    );

    /// Opens Monitoring as the demo tenant administrator (who holds
    /// `recording.control`), or as [email], and hands it `calls` as the
    /// snapshot.
    Future<FakeSocket> monitoringWith(
      WidgetTester tester,
      List<Map<String, Object?>> calls, {
      String email = 'tenant@example.test',
    }) async {
      resetDemoRecordings();
      final hub = await openMonitoring(tester, email: email);
      final socket = hub.last;
      socket.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      final topic = subscribedTopic(socket, 'calls');
      socket
        ..reply({'type': 'subscribed', 'topic': topic})
        ..reply({
          'type': 'snapshot',
          'topic': topic,
          'data': {'calls': calls},
        });
      await tester.pumpAndSettle();
      return socket;
    }

    testWidgets('S5-15: offers only the recording buttons each call allows', (
      tester,
    ) async {
      await monitoringWith(tester, [
        // Allows on demand, not recording: Record.
        leg('demo-a1', bridgedTo: 'demo-a2', controls: 'on_demand'),
        leg('demo-a2', direction: 'outbound', controls: 'on_demand'),
        // Recorded by a rule that allows pausing: Pause only, never Stop.
        leg(
          'demo-c1',
          from: '103',
          to: '+15550199',
          controls: 'pause',
          recording: 'on',
          startedSecondsAgo: 30,
        ),
        // Nothing allowed.
        leg('demo-b1', from: '+15550142', startedSecondsAgo: 10),
      ]);
      expect(find.text('Actions'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('recording-start-demo-a1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('recording-pause-demo-c1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('recording-stop-demo-c1')),
        findsNothing,
      );
      expect(recordingButtons(), findsNWidgets(2));
    });

    testWidgets(
      'S5-15: a press shows as pending, and the new state only once the live feed says so',
      (tester) async {
        final socket = await monitoringWith(tester, [
          leg('demo-a1', bridgedTo: 'demo-a2', controls: 'on_demand'),
          leg('demo-a2', direction: 'outbound', controls: 'on_demand'),
        ]);
        final topic = subscribedTopic(socket, 'calls');
        await tapVisible(tester, 'recording-start-demo-a1');
        await tester.pump();
        expect(find.text('Starting…'), findsOneWidget);
        // The service has answered, but the feed has not shown it yet: still
        // pending, and not claiming to record.
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.text('Starting…'), findsOneWidget);
        expect(tableRows(tester).single[4], '—');

        socket.reply({
          'type': 'event',
          'topic': topic,
          'event': {
            'type': 'call.updated',
            'callUuid': 'demo-a1',
            'changes': {'recording': 'on'},
          },
        });
        await tester.pumpAndSettle();
        expect(find.text('Starting…'), findsNothing);
        expect(tableRows(tester).single[4], 'Recording');
        expect(
          find.byKey(const ValueKey('recording-stop-demo-a1')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('recording-pause-demo-a1')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'S5-15: a refused press says why, in neutral words, and brings the buttons back',
      (tester) async {
        // The feed says on-demand, but the call's rule records it: the
        // service refuses to stop a rule recording.
        await monitoringWith(tester, [
          leg(
            'demo-c1',
            from: '103',
            to: '+15550199',
            controls: 'on_demand',
            recording: 'on',
          ),
        ]);
        await tapVisible(tester, 'recording-stop-demo-c1');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(
          find.text(
            'A recording made by a rule cannot be stopped. It can be paused, if the rule allows.',
          ),
          findsOneWidget,
        );
        expect(find.text('Stopping…'), findsNothing);
        expect(
          find.byKey(const ValueKey('recording-stop-demo-c1')),
          findsOneWidget,
        );
        await tester.pumpAndSettle(const Duration(seconds: 5));
      },
    );

    testWidgets(
      'S5-15: no recording buttons without recording.control (monitor.calls only watches)',
      (tester) async {
        final hub = FakeHub();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              sessionProvider.overrideWith(
                () => _FixedSession(
                  const Session(
                    accessToken: 'x',
                    expiresIn: 600,
                    orgId: 'tenant-1',
                    orgType: OrgType.tenant,
                    permissions: [],
                  ),
                ),
              ),
              knownPermissionsProvider.overrideWithValue({'monitor.calls'}),
              realtimeConnectorProvider.overrideWithValue(hub.connect),
              clockProvider.overrideWith((ref) => Stream.value(fixedNow)),
            ],
            child: const MaterialApp(home: Scaffold(body: LiveCallsPanel())),
          ),
        );
        await tester.pumpAndSettle();
        final socket = hub.last;
        socket.reply({'type': 'authenticated'});
        await tester.pumpAndSettle();
        final topic = socket.sent.last['topic'] as String;
        socket
          ..reply({'type': 'subscribed', 'topic': topic})
          ..reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {
              'calls': [leg('a', controls: 'on_demand')],
            },
          });
        await tester.pumpAndSettle();
        expect(find.text('Actions'), findsNothing);
        expect(recordingButtons(), findsNothing);
        expect(tableRows(tester).single, hasLength(5));
      },
    );

    testWidgets('says so when the connection is lost', (tester) async {
      final hub = await openMonitoring(tester);
      final socket = hub.last;
      socket.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      socket.reply({
        'type': 'error',
        'topic': subscribedTopic(socket, 'calls'),
        'code': 'unavailable',
        'message': 'x',
      });
      await tester.pump();
      await tester.pump();
      expect(
        find.text('Live updates are unavailable. Reconnecting…'),
        findsOneWidget,
      );
      // The retry is due later; end the test before it fires.
      await tester.pump(const Duration(minutes: 1));
    });

    testWidgets('is not offered to someone without monitor.calls', (
      tester,
    ) async {
      final hub = await openMonitoring(tester, email: 'limited@example.test');
      expect(
        find.text("Your role doesn't include live calls."),
        findsOneWidget,
      );
      // The presence board is theirs (monitor.presence); the calls are not.
      hub.last.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      expect(
        [
          for (final m in hub.last.sent)
            if (m['type'] == 'subscribe') m['topic'],
        ],
        [endsWith(':presence')],
      );
    });

    testWidgets('is never offered to a reseller, whatever it holds (H1)', (
      tester,
    ) async {
      // A reseller reaches Monitoring only through a custom role with
      // monitor.presence, inside one of its tenants; even holding
      // monitor.calls, it is not shown the calls.
      final hub = FakeHub();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionProvider.overrideWith(
              () => _FixedSession(
                const Session(
                  accessToken: 'x',
                  expiresIn: 600,
                  orgId: 'reseller-1',
                  orgType: OrgType.reseller,
                  permissions: [],
                ),
              ),
            ),
            tenantIdProvider.overrideWithValue('tenant-1'),
            knownPermissionsProvider.overrideWithValue({
              'monitor.presence',
              'monitor.calls',
            }),
            realtimeConnectorProvider.overrideWithValue(hub.connect),
          ],
          child: const MaterialApp(home: Scaffold(body: LiveCallsPanel())),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text("Your role doesn't include live calls."),
        findsOneWidget,
      );
      expect(hub.sockets, isEmpty);
    });

    testWidgets('shows the demo calls in demo mode', (tester) async {
      await pumpApp(
        tester,
        appWith(
          api: demoApi(),
          overrides: [
            realtimeConnectorProvider.overrideWithValue(demoRealtimeConnector),
            clockProvider.overrideWith((ref) => Stream.value(DateTime.now())),
          ],
        ),
      );
      await submitSignIn(tester, 'tenant@example.test');
      await tester.tap(navItem('Monitoring'));
      await tester.pumpAndSettle();
      expect(find.byType(MonitoringPage), findsOneWidget);
      final rows = tableRows(tester);
      expect(rows.map((r) => r.take(3).toList()), [
        ['103', '+15550199', 'On hold'],
        ['101', '102', 'Talking'],
        ['+15550142', '+15550100', 'Ringing'],
      ]);
      expect(rows.first[4], 'Recording');

      // S5-15: Record on the internal call; the demo hub follows it.
      resetDemoRecordings();
      await tapVisible(tester, 'recording-start-demo-a1');
      await tester.pump();
      expect(find.text('Starting…'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      expect(tableRows(tester)[1][4], 'Recording');
      await tapVisible(tester, 'recording-pause-demo-a1');
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      expect(tableRows(tester)[1][4], 'Paused');
      resetDemoRecordings();
    });

    /// Pumps the live calls panel alone, as a tenant person holding [held]
    /// (or a reseller inside a tenant), with [calls] as the snapshot. A press
    /// is answered by [answer].
    Future<void> panelWith(
      WidgetTester tester,
      Set<String> held,
      List<Map<String, Object?>> calls, {
      OrgType orgType = OrgType.tenant,
      ResponseBody Function(RequestOptions options)? answer,
    }) async {
      final hub = FakeHub();
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter(
          answer ?? (_) => jsonBody(const {}, status: 500),
        );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionProvider.overrideWith(
              () => _FixedSession(
                Session(
                  accessToken: 'x',
                  expiresIn: 600,
                  orgId: 'org-1',
                  orgType: orgType,
                  permissions: const [],
                ),
              ),
            ),
            tenantIdProvider.overrideWithValue('tenant-1'),
            knownPermissionsProvider.overrideWithValue(held),
            realtimeConnectorProvider.overrideWithValue(hub.connect),
            clockProvider.overrideWith((ref) => Stream.value(fixedNow)),
            monitorApiProvider.overrideWithValue(MonitorApi(dio, 'x')),
          ],
          child: const MaterialApp(home: Scaffold(body: LiveCallsPanel())),
        ),
      );
      await tester.pumpAndSettle();
      if (hub.sockets.isEmpty) return;
      final socket = hub.last;
      socket.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      final topic = subscribedTopic(socket, 'calls');
      socket
        ..reply({'type': 'subscribed', 'topic': topic})
        ..reply({
          'type': 'snapshot',
          'topic': topic,
          'data': {'calls': calls},
        });
      await tester.pumpAndSettle();
    }

    testWidgets(
      'S5-10: offers each monitor button to its permission, on answered and held calls only',
      (tester) async {
        await panelWith(
          tester,
          {'monitor.calls', 'monitor.listen', 'monitor.barge'},
          [
            leg('a', bridgedTo: 'b'),
            leg('b', direction: 'outbound', startedSecondsAgo: 64),
            leg('h', state: 'held', from: '103', startedSecondsAgo: 30),
            leg('r', state: 'ringing', from: '+15550142', startedSecondsAgo: 8),
          ],
        );
        expect(find.text('Actions'), findsOneWidget);
        for (final call in ['a', 'h']) {
          expect(find.byKey(ValueKey('monitor-listen-$call')), findsOneWidget);
          expect(find.byKey(ValueKey('monitor-barge-$call')), findsOneWidget);
          // Not held: whisper.
          expect(find.byKey(ValueKey('monitor-whisper-$call')), findsNothing);
        }
        // The service refuses a call still ringing.
        expect(find.byKey(const ValueKey('monitor-listen-r')), findsNothing);
        expect(monitorButtons(), findsNWidgets(4));
        // No recording.control: no recording buttons.
        expect(recordingButtons(), findsNothing);
      },
    );

    testWidgets('S5-10: no monitor buttons with monitor.calls alone', (
      tester,
    ) async {
      await panelWith(tester, {'monitor.calls'}, [leg('a')]);
      expect(monitorButtons(), findsNothing);
      expect(find.text('Actions'), findsNothing);
    });

    testWidgets('S5-10: never offered to a reseller, whatever it holds (H1)', (
      tester,
    ) async {
      await panelWith(
        tester,
        {
          'monitor.presence',
          'monitor.calls',
          'monitor.listen',
          'monitor.whisper',
          'monitor.barge',
        },
        [leg('a')],
        orgType: OrgType.reseller,
      );
      expect(monitorButtons(), findsNothing);
      expect(
        find.text("Your role doesn't include live calls."),
        findsOneWidget,
      );
    });

    testWidgets(
      "S5-10: a refusal outside a scoped grant says why in the service's words",
      (tester) async {
        final asked = <String>[];
        await panelWith(
          tester,
          {'monitor.calls', 'monitor.whisper'},
          [leg('a')],
          answer: (options) {
            asked.add('${options.method} ${options.path}');
            return jsonBody({
              'title': 'Forbidden',
              'status': 403,
              'code': 'insufficient_permission',
              'detail': 'You do not have permission to do that.',
            }, status: 403);
          },
        );
        await tapVisible(tester, 'monitor-whisper-a');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(asked, ['POST /v1/tenants/tenant-1/calls/a/whisper']);
        expect(
          find.text('You do not have permission to do that.'),
          findsOneWidget,
        );
        expect(find.text('Ringing your phone…'), findsNothing);
        expect(find.byKey(const ValueKey('monitor-whisper-a')), findsOneWidget);
        await tester.pumpAndSettle(const Duration(seconds: 5));
      },
    );

    testWidgets(
      "S5-10: a press rings the supervisor's phone, shows as pending, then says what it is doing",
      (tester) async {
        await monitoringWith(tester, [
          leg('demo-a1', bridgedTo: 'demo-a2'),
          leg('demo-a2', direction: 'outbound'),
          leg(
            'demo-c1',
            from: '103',
            to: '+15550199',
            state: 'held',
            startedSecondsAgo: 30,
          ),
        ], email: 'supervisor@example.test');
        expect(monitorButtons(), findsNWidgets(6));
        await tapVisible(tester, 'monitor-listen-demo-a1');
        await tester.pump();
        expect(find.text('Ringing your phone…'), findsOneWidget);
        // That call's buttons wait; the other call's do not.
        for (final mode in MonitorMode.values) {
          expect(
            find.byKey(ValueKey('monitor-${mode.wire}-demo-a1')),
            findsNothing,
          );
          expect(
            find.byKey(ValueKey('monitor-${mode.wire}-demo-c1')),
            findsOneWidget,
          );
        }
        // Still ringing a second later.
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('Ringing your phone…'), findsOneWidget);
        expect(find.text('Listening on your phone'), findsNothing);

        await tester.pump(const Duration(milliseconds: 600));
        await tester.pump();
        expect(find.text('Listening on your phone'), findsOneWidget);
        expect(find.text('Ringing your phone…'), findsNothing);
        expect(
          find.byKey(const ValueKey('monitor-listen-demo-a1')),
          findsOneWidget,
        );
        await tester.pumpAndSettle(const Duration(seconds: 5));
      },
    );

    testWidgets('S5-10: a refused press says why and brings the buttons back', (
      tester,
    ) async {
      // The feed says answered, but the demo's call is still ringing: the
      // service refuses.
      await monitoringWith(tester, [
        leg('demo-b1', from: '+15550142', to: '+15550100'),
      ], email: 'supervisor@example.test');
      await tapVisible(tester, 'monitor-barge-demo-b1');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('This call has not been answered yet.'), findsOneWidget);
      expect(find.text('Ringing your phone…'), findsNothing);
      expect(
        find.byKey(const ValueKey('monitor-barge-demo-b1')),
        findsOneWidget,
      );
      await tester.pumpAndSettle(const Duration(seconds: 5));
    });

    test(
      'S5-10: asks call-control with no body, and waits for the phone',
      () async {
        RequestOptions? sent;
        final dio = Dio()
          ..httpClientAdapter = FakeAdapter((options) {
            sent = options;
            return jsonBody({
              'mode': 'barge',
              'callUuid': 'b',
              'monitorCallUuid': 'm',
            });
          });
        await MonitorApi(
          dio,
          'token-1',
        ).monitor(tenantId: 't1', callUuid: 'b', mode: MonitorMode.barge);
        expect(sent!.method, 'POST');
        expect(sent!.path, '/v1/tenants/t1/calls/b/barge');
        expect(sent!.data, isNull);
        expect(sent!.headers['Authorization'], 'Bearer token-1');
        // The phone rings for up to 30 s before the service answers.
        expect(sent!.receiveTimeout, greaterThan(const Duration(seconds: 40)));
      },
    );

    testWidgets('S5-10: the demo supervisor joins a call from their phone', (
      tester,
    ) async {
      await pumpApp(
        tester,
        appWith(
          api: demoApi(),
          overrides: [
            realtimeConnectorProvider.overrideWithValue(demoRealtimeConnector),
            clockProvider.overrideWith((ref) => Stream.value(DateTime.now())),
          ],
        ),
      );
      await submitSignIn(tester, 'supervisor@example.test');
      await tester.tap(navItem('Monitoring'));
      await tester.pumpAndSettle();
      // Answered and held calls; not the one still ringing.
      expect(find.byKey(const ValueKey('monitor-whisper-demo-a1')), findsOne);
      expect(find.byKey(const ValueKey('monitor-whisper-demo-c1')), findsOne);
      expect(
        find.byKey(const ValueKey('monitor-whisper-demo-b1')),
        findsNothing,
      );
      await tapVisible(tester, 'monitor-whisper-demo-a1');
      await tester.pump();
      expect(find.text('Ringing your phone…'), findsOneWidget);
      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      expect(find.text('Whispering on your phone'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(seconds: 5));
    });
  });

  group('presence', () {
    test('keeps every extension from the snapshot, in number order, and the changes after it', () {
      final book = PresenceBook();
      var view = book.apply(
        const TopicSnapshot({
          'extensions': [
            {'extension': '110', 'state': 'idle'},
            {'extension': '101', 'state': 'on_call'},
            {'extension': '9', 'state': 'offline'},
            {'extension': 'lobby', 'state': 'dnd'},
            {'extension': '102', 'state': 'ringing'},
          ],
        }),
      );
      expect(view.loaded, isTrue);
      expect(view.extensions.map((p) => p.extension), [
        '9',
        '101',
        '102',
        '110',
        'lobby',
      ]);

      view = book.apply(
        const TopicEvent({
          'type': 'presence.changed',
          'extension': '110',
          'state': 'on_call',
        }),
      );
      expect(view.extensions[3].state, 'on_call');
      // An extension only a change names is added.
      view = book.apply(
        const TopicEvent({
          'type': 'presence.changed',
          'extension': '105',
          'state': 'ringing',
        }),
      );
      expect(view.extensions.map((p) => p.extension), [
        '9',
        '101',
        '102',
        '105',
        '110',
        'lobby',
      ]);
      // A state the console does not know is kept; other events are not
      // presence.
      view = book.apply(
        const TopicEvent({
          'type': 'presence.changed',
          'extension': '9',
          'state': 'on_break',
        }),
      );
      view = book.apply(const TopicEvent({'type': 'something.else'}));
      expect(view.extensions.first.state, 'on_break');
      expect(view.extensions, hasLength(6));

      // A new snapshot replaces everything.
      view = book.apply(
        const TopicSnapshot({
          'extensions': [
            {'extension': '101', 'state': 'idle'},
          ],
        }),
      );
      expect(view.extensions.map((p) => '${p.extension} ${p.state}'), [
        '101 idle',
      ]);

      view = book.apply(const TopicStopped('offline'));
      expect(view.stopped, 'offline');
      expect(view.loaded, isFalse);
    });

    test(
      'each state has its own word, icon and color; an unknown one is neutral',
      () {
        const known = ['idle', 'ringing', 'on_call', 'dnd', 'offline'];
        final looks = [for (final s in known) presenceLook(s)];
        expect(looks.map((l) => l.label), [
          'Available',
          'Ringing',
          'On a call',
          'Do not disturb',
          'Offline',
        ]);
        expect(looks.map((l) => l.icon).toSet(), hasLength(5));
        expect(looks.map((l) => l.color).toSet(), hasLength(5));
        expect(looks.map((l) => l.color), everyElement(isNotNull));

        expect(presenceLook('on_break').label, 'On break');
        expect(presenceLook('on_break').color, isNull);
        expect(presenceLook('').label, 'Unknown');
      },
    );
  });

  group('the presence board', () {
    testWidgets(
      'shows every extension with its name and state, and follows the changes',
      (tester) async {
        final hub = await openMonitoring(tester);
        expect(find.text('Presence'), findsOneWidget);
        final socket = hub.last;
        socket.reply({'type': 'authenticated'});
        await tester.pumpAndSettle();
        final topic = subscribedTopic(socket, 'presence');
        socket
          ..reply({'type': 'subscribed', 'topic': topic})
          ..reply({
            'type': 'snapshot',
            'topic': topic,
            'data': {
              'extensions': [
                {'extension': '110', 'state': 'idle'},
                {'extension': '101', 'state': 'on_call'},
                {'extension': '102', 'state': 'ringing'},
                {'extension': '103', 'state': 'dnd'},
                {'extension': '104', 'state': 'offline'},
                {'extension': '105', 'state': 'on_break'},
                {'extension': '106'},
              ],
            },
          });
        await tester.pumpAndSettle();
        expect(boardOrder(tester), [
          '101',
          '102',
          '103',
          '104',
          '105',
          '106',
          '110',
        ]);
        // The administrator reads extensions: the demo's names.
        expect(onTile('101', 'Alice Kim'), findsOneWidget);
        expect(onTile('101', 'On a call'), findsOneWidget);
        expect(onTile('102', 'Bob Osei'), findsOneWidget);
        expect(onTile('102', 'Ringing'), findsOneWidget);
        expect(onTile('103', 'Do not disturb'), findsOneWidget);
        expect(onTile('104', 'Offline'), findsOneWidget);
        expect(onTile('105', 'On break'), findsOneWidget);
        expect(onTile('106', 'Unknown'), findsOneWidget);
        expect(onTile('110', 'Available'), findsOneWidget);

        socket
          ..reply({
            'type': 'event',
            'topic': topic,
            'event': {
              'type': 'presence.changed',
              'extension': '110',
              'state': 'ringing',
            },
          })
          ..reply({
            'type': 'event',
            'topic': topic,
            'event': {
              'type': 'presence.changed',
              'extension': '107',
              'state': 'idle',
            },
          });
        await tester.pumpAndSettle();
        expect(onTile('110', 'Ringing'), findsOneWidget);
        expect(onTile('107', 'Available'), findsOneWidget);
        expect(boardOrder(tester), [
          '101',
          '102',
          '103',
          '104',
          '105',
          '106',
          '107',
          '110',
        ]);

        // Leaving the page stops watching.
        await tester.ensureVisible(navItem('Dashboard'));
        await tester.tap(navItem('Dashboard'));
        await tester.pumpAndSettle();
        expect(
          socket.sent,
          contains(equals({'type': 'unsubscribe', 'topic': topic})),
        );
      },
    );

    /// Pumps the Monitoring page for someone holding [held], of [orgType],
    /// inside tenant `tenant-1`; the extension list, when asked for, has 101.
    Future<(FakeSocket, List<String>)> pageFor(
      WidgetTester tester,
      Set<String> held, {
      OrgType orgType = OrgType.tenant,
    }) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final hub = FakeHub();
      final asked = <String>[];
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter((options) {
          asked.add(options.path);
          return jsonBody({
            'rows': [
              {'id': 'e1', 'number': '101', 'displayName': 'Front desk'},
            ],
          });
        });
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionProvider.overrideWith(
              () => _FixedSession(
                Session(
                  accessToken: 'x',
                  expiresIn: 600,
                  orgId: 'org-1',
                  orgType: orgType,
                  permissions: const [],
                ),
              ),
            ),
            tenantIdProvider.overrideWithValue('tenant-1'),
            knownPermissionsProvider.overrideWithValue(held),
            realtimeConnectorProvider.overrideWithValue(hub.connect),
            apiProvider.overrideWithValue(ConsoleApi(dio: dio)),
          ],
          child: const MaterialApp(home: Scaffold(body: MonitoringPage())),
        ),
      );
      await tester.pumpAndSettle();
      final socket = hub.last;
      socket.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      final topic = subscribedTopic(socket, 'presence');
      socket
        ..reply({'type': 'subscribed', 'topic': topic})
        ..reply({
          'type': 'snapshot',
          'topic': topic,
          'data': {
            'extensions': [
              {'extension': '101', 'state': 'idle'},
              {'extension': '102', 'state': 'dnd'},
            ],
          },
        });
      await tester.pumpAndSettle();
      return (socket, asked);
    }

    testWidgets('numbers only, without extension.read', (tester) async {
      final (socket, asked) = await pageFor(tester, {'monitor.presence'});
      expect(boardOrder(tester), ['101', '102']);
      expect(onTile('101', 'Available'), findsOneWidget);
      expect(onTile('102', 'Do not disturb'), findsOneWidget);
      expect(find.text('Front desk'), findsNothing);
      expect(asked, isEmpty);
      // Presence without monitor.calls: no calls are watched.
      expect(
        find.text("Your role doesn't include live calls."),
        findsOneWidget,
      );
      expect(
        [
          for (final m in socket.sent)
            if (m['type'] == 'subscribe') m['topic'],
        ],
        ['tenant:tenant-1:presence'],
      );
    });

    testWidgets(
      'shown to a reseller inside a tenant (config data), never the calls or their buttons (H1)',
      (tester) async {
        final (socket, _) = await pageFor(tester, {
          'monitor.presence',
          'monitor.calls',
          'monitor.listen',
          'monitor.whisper',
          'monitor.barge',
          'extension.read',
        }, orgType: OrgType.reseller);
        expect(onTile('101', 'Front desk'), findsOneWidget);
        expect(onTile('101', 'Available'), findsOneWidget);
        expect(
          find.text("Your role doesn't include live calls."),
          findsOneWidget,
        );
        expect(monitorButtons(), findsNothing);
        expect(
          [
            for (final m in socket.sent)
              if (m['type'] == 'subscribe') m['topic'],
          ],
          ['tenant:tenant-1:presence'],
        );
      },
    );

    testWidgets('shows the demo board in demo mode', (tester) async {
      await pumpApp(
        tester,
        appWith(
          api: demoApi(),
          overrides: [
            realtimeConnectorProvider.overrideWithValue(demoRealtimeConnector),
            clockProvider.overrideWith((ref) => Stream.value(DateTime.now())),
          ],
        ),
      );
      await submitSignIn(tester, 'tenant@example.test');
      await tester.tap(navItem('Monitoring'));
      await tester.pumpAndSettle();
      expect(boardOrder(tester), [
        for (final e in demoPresence) e['extension'],
      ]);
      for (final label in [
        'Available',
        'Ringing',
        'On a call',
        'Do not disturb',
        'Offline',
      ]) {
        expect(
          find.descendant(
            of: find.byType(PresenceTile),
            matching: find.text(label),
          ),
          findsWidgets,
          reason: label,
        );
      }
      expect(onTile('101', 'Alice Kim'), findsOneWidget);
    });
  });
}

class _FixedSession extends SessionController {
  _FixedSession(this._session);

  final Session _session;

  @override
  Session? build() => _session;
}
