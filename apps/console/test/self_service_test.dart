import 'package:console/app/router.dart';
import 'package:console/core/permissions.dart';
import 'package:console/core/acting.dart';
import 'package:console/core/session.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/dev/demo_access.dart';
import 'package:console/features/shell/sections.dart';
import 'package:console/features/voicemail/voicemail_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem;
import 'pbx_test.dart' show field;
import 'support.dart';
import 'users_test.dart' show tapIn;

/// An ordinary person of a tenant: the `tenant_user` role, so only their own
/// phone (extension 101, Alice Kim's).
const user = 'user@example.test';

/// The same, but nobody has linked an extension to them.
const nophone = 'nophone@example.test';

/// A tenant administrator who is also linked to extension 101.
const linked = 'linked@example.test';

const selfSections = ['My call handling', 'My voicemail', 'My call history'];

Future<List<String>> signInTo(WidgetTester tester, String email) async {
  final opened = <String>[];
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        openRecordingProvider.overrideWithValue((url) async => opened.add(url)),
      ],
    ),
  );
  await submitSignIn(tester, email);
  return opened;
}

ProviderContainer containerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(NavigationRail)));

Future<void> open(WidgetTester tester, String section) async {
  // An administrator's navigation is longer than the window.
  await tester.ensureVisible(navItem(section));
  await tester.pumpAndSettle();
  await tester.tap(navItem(section));
  await tester.pumpAndSettle();
}

void main() {
  group('who is offered the phone-only console', () {
    test('a person with only self-service permissions', () {
      expect(isSelfOnly({...demoSelfService}), isTrue);
      expect(isSelfOnly({'org.view', 'self.history'}), isTrue);
    });

    test('not an administrator, not a person with nothing, not unknown', () {
      expect(isSelfOnly({...demoPermissions('tenant', 'admin@x')!}), isFalse);
      expect(isSelfOnly({'org.view'}), isFalse);
      expect(isSelfOnly(<String>{}), isFalse);
      expect(isSelfOnly(null), isFalse);
    });

    test('one permission beyond the phone makes them a person with a role', () {
      expect(isSelfOnly({...demoSelfService, 'cdr.read'}), isFalse);
      expect(isSelfOnly({...demoSelfService, 'extension.manage'}), isFalse);
    });

    Session session(OrgType type) => Session(
      accessToken: 't',
      expiresIn: 900,
      orgId: 'o',
      userId: 'u',
      orgType: type,
      permissions: const [],
    );

    test('visibleSections: only their phone, whatever the org type holds', () {
      final only = {...demoSelfService};
      final sections = visibleSections(session(OrgType.tenant), null, only);
      expect([for (final s in sections) s.label], selfSections);
    });

    test('an administrator keeps the administrator navigation', () {
      final admin = {...demoPermissions('tenant', 'admin@x')!};
      final plain = visibleSections(session(OrgType.tenant), null, admin);
      expect(plain.map((s) => s.label), isNot(contains('My phone')));
      expect(plain.map((s) => s.label), contains('Extensions'));
      // Linked to an extension: also My phone.
      final withPhone = visibleSections(
        session(OrgType.tenant),
        null,
        admin,
        true,
      );
      expect(withPhone.map((s) => s.label), contains('My phone'));
      expect(withPhone.map((s) => s.label), contains('Extensions'));
    });

    test('My phone needs a self permission, even with an extension', () {
      final without = {...demoPermissions('tenant', 'limited@x')!};
      final sections = visibleSections(
        session(OrgType.tenant),
        null,
        without,
        true,
      );
      expect(sections.map((s) => s.label), isNot(contains('My phone')));
    });

    test('a reseller or the master has no phone of their own', () {
      for (final type in [OrgType.reseller, OrgType.master]) {
        final held = {
          ...demoPermissions(type.name, 'x@x')!,
          ...demoSelfService,
        };
        final sections = visibleSections(session(type), null, held, true);
        expect(sections.map((s) => s.label), isNot(contains('My phone')));
        for (final label in selfSections) {
          expect(sections.map((s) => s.label), isNot(contains(label)));
        }
      }
    });

    test('acting as a tenant is never a phone, even for a reseller', () {
      // (`ActingTenant` is what "act as" sets.)
      const acting = ActingTenant(id: 't', name: 'Acme');
      final held = {...demoPermissions('reseller', 'x@x')!, ...demoSelfService};
      final sections = visibleSections(
        session(OrgType.reseller),
        acting,
        held,
        true,
      );
      expect(sections.map((s) => s.label), isNot(contains('My phone')));
      // And a reseller never gets the private-data sections of the tenant (H1).
      expect(sections.map((s) => s.label), isNot(contains('Voicemail')));
    });

    test(
      'every my-phone section is private, so a reseller is walled off (H1)',
      () {
        expect(myPhoneEntry.privateData, isTrue);
        expect(myPhoneSections.where((s) => s.privateData).length, 2);
        // Not in any org type's own list: they are reached only through the
        // self-service rules above.
        for (final list in sectionsByOrgType.values) {
          for (final s in list) {
            expect(s.path, isNot(startsWith('/my-phone')));
          }
        }
      },
    );
  });

  group('a person with only a phone', () {
    testWidgets(
      'sees My call handling, My voicemail and My call history, and nothing administrative',
      (tester) async {
        await signInTo(tester, user);

        for (final label in selfSections) {
          expect(navItem(label), findsOneWidget);
        }
        for (final label in [
          'Dashboard',
          'Users',
          'Extensions',
          'Voicemail',
          'Call records',
          'Call flows',
          'Settings',
          'My phone',
        ]) {
          expect(navItem(label), findsNothing, reason: label);
        }
        // Lands on the first, about their own extension.
        expect(find.text('My call handling'), findsWidgets);
        expect(
          find.textContaining('What happens to calls to extension 101'),
          findsOneWidget,
        );
      },
    );

    testWidgets('cannot reach an administrator page by its address', (
      tester,
    ) async {
      await signInTo(tester, user);
      final router = containerOf(tester).read(routerProvider);
      for (final path in [
        '/users',
        '/extensions',
        '/call-records',
        '/voicemail',
        '/forbidden',
        '/dashboard',
      ]) {
        router.go(path);
        await tester.pumpAndSettle();
        expect(router.state.uri.path, '/my-phone/call-handling', reason: path);
        expect(find.text('Users'), findsNothing);
      }
    });

    testWidgets('sees no administrator tabs on their pages', (tester) async {
      await signInTo(tester, user);
      // The navigation has all three, so the pages do not repeat them as tabs.
      expect(find.byType(ChoiceChip), findsNothing);
    });

    testWidgets('sees the current call handling, and can change it', (
      tester,
    ) async {
      await signInTo(tester, user);
      expect(find.text('Off'), findsOneWidget); // do not disturb
      expect(find.text('Nobody'), findsOneWidget); // also ring

      await tester.tap(find.widgetWithText(FilledButton, 'Change'));
      await tester.pumpAndSettle();
      expect(find.text('Call handling for 101'), findsOneWidget);
      await tester.tap(find.byKey(const Key('call-handling-dnd')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      expect(find.text('Call handling for 101'), findsNothing);
      expect(find.text('On: callers go to voicemail'), findsOneWidget);
    });

    testWidgets('can forward to a colleague, but not to themselves', (
      tester,
    ) async {
      await signInTo(tester, user);
      tester.view.physicalSize = const Size(1280, 2000);
      await tester.tap(find.widgetWithText(FilledButton, 'Change'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('call-handling-busy-type')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('An extension').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('call-handling-busy-extension')));
      await tester.pumpAndSettle();
      // The directory: everyone else, and not me.
      expect(find.text('102 · Bob Osei'), findsOneWidget);
      expect(find.text('103 · Carol Diaz'), findsOneWidget);
      expect(find.text('101 · Alice Kim'), findsNothing);
      await tester.tap(find.text('102 · Bob Osei'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      expect(find.text('102 · Bob Osei'), findsOneWidget);
    });

    testWidgets('the service refusing a number is said, not hidden', (
      tester,
    ) async {
      await signInTo(tester, user);
      tester.view.physicalSize = const Size(1280, 2000);
      await tester.tap(find.widgetWithText(FilledButton, 'Change'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('call-handling-always-type')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('An outside number').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('call-handling-always-number')),
        '12345',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.textContaining('leading + and country code'), findsOneWidget);
      // Still open, nothing saved.
      expect(find.text('Call handling for 101'), findsOneWidget);
    });

    testWidgets(
      'lists only their own messages, and hearing one marks it read',
      (tester) async {
        final opened = await signInTo(tester, user);
        await open(tester, 'My voicemail');
        tester.view.physicalSize = const Size(2400, 900);
        await tester.pumpAndSettle();

        expect(find.text('My voicemail'), findsWidgets);
        expect(find.text('Pat Caller · +15005550123'), findsOneWidget);
        expect(find.text('+15005550188'), findsOneWidget);
        expect(find.text('Dr. Lee · +15005550199'), findsOneWidget);
        expect(find.textContaining('2 new.'), findsOneWidget);
        expect(
          find.textContaining('alice@acme-dental.example'),
          findsOneWidget,
        );
        // No mailbox picker, no other person's mailbox.
        expect(find.text('102 · Bob Osei'), findsNothing);
        expect(find.byTooltip('Back to mailboxes'), findsNothing);

        await tester.tap(find.byTooltip('Play').first);
        await tester.pumpAndSettle();
        expect(opened, ['https://storage.demo.invalid/voicemail/vm-1.wav']);
        expect(find.textContaining('1 new.'), findsOneWidget);
      },
    );

    testWidgets('deletes a message of their own after being asked', (
      tester,
    ) async {
      await signInTo(tester, user);
      await open(tester, 'My voicemail');
      tester.view.physicalSize = const Size(2400, 900);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Delete').last);
      await tester.pumpAndSettle();
      expect(find.text('Delete message?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(find.text('Dr. Lee · +15005550199'), findsNothing);
      expect(find.text('Pat Caller · +15005550123'), findsOneWidget);
    });

    testWidgets('changes their own PIN and email settings', (tester) async {
      await signInTo(tester, user);
      await open(tester, 'My voicemail');
      tester.view.physicalSize = const Size(2400, 900);
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(OutlinedButton, 'Change PIN'));
      await tester.pumpAndSettle();
      expect(
        find.text('The PIN you enter on your phone to hear your messages.'),
        findsOneWidget,
      );
      await tester.enterText(find.byType(TextField), '12');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('The PIN must be 4 to 8 digits.'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '246810');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('PIN changed.'), findsOneWidget);

      await tester.tap(find.widgetWithText(OutlinedButton, 'Email settings'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Email address'),
        'me@example.test',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Emailed to: me@example.test'),
        findsOneWidget,
      );
    });

    testWidgets('sees only calls to or from their own extension', (
      tester,
    ) async {
      await signInTo(tester, user);
      await open(tester, 'My call history');

      expect(find.text('My call history'), findsWidgets);
      // Every row involves 101, and none involves anyone else's calls only.
      final table = tester.widget<DataTable>(find.byType(DataTable));
      for (final row in table.rows) {
        final texts = [
          for (final c in row.cells.skip(2).take(2)) (c.child as Text).data!,
        ];
        expect(texts.any((t) => t.startsWith('101')), isTrue, reason: '$texts');
      }
      // Nothing an administrator's list shows and a person has no use for.
      expect(find.text('Export CSV'), findsNothing);
      expect(find.text('Number'), findsNothing);
    });

    testWidgets('pages through more history and filters by direction', (
      tester,
    ) async {
      await signInTo(tester, user);
      await open(tester, 'My call history');
      final table0 = tester.widget<DataTable>(find.byType(DataTable));
      final first = table0.rows.length;
      expect(first, 25);
      await tester.ensureVisible(
        find.widgetWithText(OutlinedButton, 'Load more'),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Load more'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<DataTable>(find.byType(DataTable)).rows.length,
        greaterThan(first),
      );
      // 65 calls, every third from 101: 22 in all, so there is nothing more.
      expect(find.widgetWithText(OutlinedButton, 'Load more'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('my-calls-direction')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Inbound').last);
      await tester.pumpAndSettle();
      final inbound = tester.widget<DataTable>(find.byType(DataTable));
      expect(inbound.rows, isNotEmpty);
      expect([
        for (final r in inbound.rows) (r.cells[1].child as Text).data,
      ], everyElement('Inbound'));
    });
  });

  group('a person nobody has linked an extension to', () {
    testWidgets('says so on every screen instead of failing', (tester) async {
      await signInTo(tester, nophone);
      const message =
          'No phone is linked to your account yet. Ask an administrator to '
          'link your extension.';
      for (final label in selfSections) {
        await open(tester, label);
        expect(find.text(message), findsOneWidget, reason: label);
      }
      // Nothing to change without an extension.
      await open(tester, 'My call handling');
      expect(find.widgetWithText(FilledButton, 'Change'), findsNothing);
    });
  });

  group('an administrator', () {
    testWidgets('who is not linked to an extension is not offered My phone', (
      tester,
    ) async {
      await signInTo(tester, 'tenant@example.test');
      expect(navItem('Extensions'), findsOneWidget);
      expect(navItem('My phone'), findsNothing);
    });

    testWidgets(
      'keeps the administrator navigation, and linked to one also gets My phone with its three tabs',
      (tester) async {
        await signInTo(tester, linked);
        expect(navItem('Extensions'), findsOneWidget);
        expect(navItem('Users'), findsOneWidget);
        expect(navItem('My phone'), findsOneWidget);
        for (final label in selfSections) {
          expect(navItem(label), findsNothing);
        }

        await open(tester, 'My phone');
        expect(find.text('My call handling'), findsOneWidget);
        // The three screens as tabs.
        expect(
          find.widgetWithText(ChoiceChip, 'Call handling'),
          findsOneWidget,
        );
        await tester.tap(find.widgetWithText(ChoiceChip, 'Call history'));
        await tester.pumpAndSettle();
        expect(find.text('My call history'), findsOneWidget);
        await tester.tap(find.widgetWithText(ChoiceChip, 'Voicemail'));
        await tester.pumpAndSettle();
        expect(find.text('My voicemail'), findsWidgets);
        expect(find.text('Pat Caller · +15005550123'), findsOneWidget);
        // Their administrator's Voicemail screen is still the whole tenant's.
        await open(tester, 'Voicemail');
        expect(find.text('102 · Bob Osei'), findsOneWidget);
      },
    );

    testWidgets('a reseller acting as a tenant has no My phone', (
      tester,
    ) async {
      await completeSignIn(tester, 'reseller@example.test');
      await tester.tap(navItem('Tenants'));
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      expect(navItem('Extensions'), findsOneWidget);
      expect(navItem('My phone'), findsNothing);
      expect(navItem('Voicemail'), findsNothing);

      // Nor by typing the address (H1).
      final router = containerOf(tester).read(routerProvider);
      router.go('/my-phone/voicemail');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/forbidden');
    });
  });

  group('linking a person to an extension', () {
    testWidgets('the extension form offers people, and saves the choice', (
      tester,
    ) async {
      await signInTo(tester, 'tenant@example.test');
      await open(tester, 'Extensions');
      tester.view.physicalSize = const Size(1280, 2000);
      await tapIn(tester, '103', find.byTooltip('Edit'));
      expect(find.text('Person'), findsOneWidget);

      await tester.tap(
        find.widgetWithText(DropdownButtonFormField<String?>, 'Person'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Alex Admin (admin@example.test)'), findsOneWidget);
      await tester.tap(find.text('Sam Support (sam@example.test)').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Sam Support (sam@example.test)'), findsNothing);
      expect(find.text('Person'), findsNothing);

      // It stuck.
      await tapIn(tester, '103', find.byTooltip('Edit'));
      expect(find.text('Sam Support (sam@example.test)'), findsOneWidget);
    });

    testWidgets('a reseller acting for the tenant is not offered the field', (
      tester,
    ) async {
      await completeSignIn(tester, 'reseller@example.test');
      await tester.tap(navItem('Tenants'));
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      await open(tester, 'Extensions');
      tester.view.physicalSize = const Size(1280, 2000);
      await tapIn(tester, '103', find.byTooltip('Edit'));
      expect(field('Name *'), findsOneWidget);
      expect(find.text('Person'), findsNothing);
    });

    testWidgets('nor is someone who cannot read the people', (tester) async {
      await signInTo(tester, 'limited@example.test'); // extension.manage only
      await open(tester, 'Extensions');
      tester.view.physicalSize = const Size(1280, 2000);
      await tapIn(tester, '103', find.byTooltip('Edit'));
      expect(field('Name *'), findsOneWidget);
      expect(find.text('Person'), findsNothing);
    });
  });
}
