import 'package:console/dev/demo_backend.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';
import 'users_test.dart' show tapIn;

/// S9-07 (D-019): one screen and one flow for a person, with their
/// extension, voicemail, desk phone and sign-in.
void main() {
  /// Signs in as a tenant admin on the demo, recording what is sent.
  Future<List<RequestOptions>> openPeople(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1600, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = demoApi();
    final sent = <RequestOptions>[];
    api.dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (o, h) {
          if (o.method != 'GET' && !o.path.startsWith('/v1/auth')) sent.add(o);
          h.next(o);
        },
      ),
    );
    await pumpApp(tester, appWith(api: api));
    await submitSignIn(tester, 'tenant@example.test');
    await tapNav(tester, 'People');
    return sent;
  }

  Finder field(String key) => find.byKey(ValueKey(key));

  /// The text box inside the field keyed [key], to type into.
  Finder box(String key) => find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(EditableText),
  );

  testWidgets('lists everyone with what they have', (tester) async {
    await openPeople(tester);
    expect(find.text('Alice Kim'), findsOneWidget);
    expect(find.text('Signs in as'), findsOneWidget);
    expect(find.text('Voicemail'), findsWidgets);
  });

  testWidgets(
    'adds a person with voicemail, a desk phone and an invitation, on one page',
    (tester) async {
      final sent = await openPeople(tester);
      await tester.tap(find.text('Add a person').first);
      await tester.pumpAndSettle();
      // The next free extension number is already filled in.
      final number = tester.widget<TextFormField>(field('person-number'));
      expect(number.controller!.text, isNotEmpty);

      await tester.enterText(box('person-name'), 'Maria Lopez');
      await tester.ensureVisible(field('person-desk-phone'));
      await tester.tap(field('person-desk-phone'));
      await tester.pumpAndSettle();
      await tester.enterText(box('person-mac'), '00:15:65:12:34:56');
      await tester.ensureVisible(field('person-invite'));
      await tester.tap(field('person-invite'));
      await tester.pumpAndSettle();
      await tester.enterText(box('person-email'), 'maria@example.test');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      // Back on People, with Maria and her phone, and nothing else to visit.
      expect(find.text('Maria Lopez added.'), findsOneWidget);
      expect(find.text('Maria Lopez'), findsOneWidget);
      final paths = [for (final o in sent) '${o.method} ${o.path}'];
      expect(paths, [
        'POST /v1/tenants/demo-org/extensions',
        'POST /v1/tenants/demo-org/voicemail/mailboxes',
        'POST /v1/tenants/demo-org/devices',
        'POST /v1/orgs/demo-org/invitations',
      ]);
      // The invitation names the new extension, so it's linked once accepted.
      final mailbox = sent[1].data as Map;
      expect((sent.last.data as Map)['extensionId'], mailbox['extensionId']);
      expect(mailbox['extensionId'], isNotNull);
    },
  );

  testWidgets(
    'a failure part-way keeps what was made, and Finish does only the rest',
    (tester) async {
      final sent = await openPeople(tester);
      await tester.tap(find.text('Add a person').first);
      await tester.pumpAndSettle();
      await tester.enterText(box('person-name'), 'Sam Reed');
      await tester.ensureVisible(field('person-desk-phone'));
      await tester.tap(field('person-desk-phone'));
      await tester.pumpAndSettle();
      // Alice's phone already has this address.
      await tester.enterText(box('person-mac'), '00:15:65:AA:BB:CC');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('person-progress')), findsOneWidget);
      expect(find.textContaining('Some of it is done'), findsOneWidget);
      expect(
        find.textContaining(
          'A phone with that MAC address has already been added.',
        ),
        findsOneWidget,
      );

      await tester.enterText(box('person-mac'), '00:15:65:65:43:21');
      await tester.tap(find.text('Finish'));
      await tester.pumpAndSettle();

      expect(find.text('Sam Reed added.'), findsOneWidget);
      final paths = [for (final o in sent) '${o.method} ${o.path}'];
      // Made once, then corrected: never a second extension or mailbox.
      expect(
        paths.where((p) => p.startsWith('POST') && p.endsWith('/extensions')),
        hasLength(1),
      );
      expect(
        paths.where((p) => p.endsWith('/voicemail/mailboxes')),
        hasLength(1),
      );
      expect(
        paths.where((p) => p.startsWith('POST') && p.endsWith('/devices')),
        hasLength(2),
      );
    },
  );

  testWidgets('removing a person says what goes with them', (tester) async {
    await openPeople(tester);
    await tapIn(tester, 'Alice Kim', find.byTooltip('Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Remove Alice Kim?'), findsOneWidget);
    expect(
      find.text('Their voicemail box stops taking messages.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
  });

  testWidgets('extensions and phones are still there, under Advanced', (
    tester,
  ) async {
    await openPeople(tester);
    expect(find.text('Advanced'), findsOneWidget);
    await tapNav(tester, 'Extensions');
    expect(find.text('Alice Kim'), findsOneWidget);
  });
}
