import 'package:console/dev/demo_backend.dart';
import 'package:console/core/realtime.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test.dart' show FakeHub, FakeSocket;
import 'support.dart';

/// Signs in as [email] with the test driving the realtime hub, and answers
/// the connection's sign-in.
Future<FakeHub> signInLive(WidgetTester tester, String email) async {
  final hub = FakeHub();
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [realtimeConnectorProvider.overrideWithValue(hub.connect)],
    ),
  );
  await submitSignIn(tester, email);
  await tester.pumpAndSettle();
  return hub;
}

/// The emergencies topic [socket] subscribed to, if any.
String? emergencyTopicOf(FakeSocket socket) => [
  for (final m in socket.sent)
    if (m['type'] == 'subscribe') m['topic'] as String,
].where((t) => t.endsWith(':emergencies')).firstOrNull;

void main() {
  group('the emergency alert (S2-06)', () {
    testWidgets('appears on any screen when someone dials an emergency number, '
        'and is dismissed', (tester) async {
      final hub = await signInLive(tester, 'tenant@example.test');
      final socket = hub.last;
      socket.reply({'type': 'authenticated'});
      await tester.pumpAndSettle();
      final topic = emergencyTopicOf(socket);
      expect(topic, isNotNull);
      socket
        ..reply({'type': 'subscribed', 'topic': topic})
        ..reply({
          'type': 'snapshot',
          'topic': topic,
          'data': {'alerts': <Object>[]},
        });
      await tester.pumpAndSettle();
      expect(find.textContaining('Emergency call'), findsNothing);

      socket.reply({
        'type': 'event',
        'topic': topic,
        'event': {
          'type': 'emergency.initiated',
          'id': 'e-1',
          'at': '2026-09-24T19:20:00.000Z',
          'dialedNumber': '911',
          'callingNumber': '101',
          'callingName': 'Front Desk',
          'location': {
            'label': 'Head office',
            'addressLine1': '123 Main St',
            'addressLine2': null,
            'city': 'Springfield',
            'state': 'IL',
            'postalCode': '62701',
            'country': 'US',
          },
        },
      });
      await tester.pumpAndSettle();
      expect(
        find.textContaining(
          'Emergency call: 911 dialled from 101 (Front Desk)',
        ),
        findsOneWidget,
      );
      expect(
        find.text('Head office, 123 Main St, Springfield, IL 62701, US'),
        findsOneWidget,
      );

      // A second one from a caller the platform does not know, with no location.
      socket.reply({
        'type': 'event',
        'topic': topic,
        'event': {
          'type': 'emergency.initiated',
          'id': 'e-2',
          'at': '2026-09-24T19:21:00.000Z',
          'dialedNumber': '112',
          'callingNumber': null,
          'callingName': null,
          'location': null,
        },
      });
      await tester.pumpAndSettle();
      expect(
        find.textContaining('112 dialled from an unknown extension'),
        findsOneWidget,
      );
      expect(
        find.text('No location was found for this extension.'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('emergency-dismiss-e-1')));
      await tester.pumpAndSettle();
      expect(find.textContaining('dialled from 101'), findsNothing);
      expect(find.textContaining('dialled from an unknown'), findsOneWidget);
    });

    testWidgets('is not watched by someone who does not hold emergency.alert', (
      tester,
    ) async {
      final hub = await signInLive(tester, 'user@example.test');
      for (final socket in hub.sockets) {
        socket.reply({'type': 'authenticated'});
      }
      await tester.pumpAndSettle();
      expect([for (final s in hub.sockets) ?emergencyTopicOf(s)], isEmpty);
    });
  });
}
