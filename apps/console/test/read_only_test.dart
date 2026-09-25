import 'dart:io';

import 'package:console/core/permissions.dart';
import 'package:console/core/session.dart';
import 'package:console/features/shell/sections.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'reseller_screens_test.dart' show signInAndOpen, tapVisible;
import 'support.dart';

/// Read permissions (decision G-10): a screen is shown to someone who holds its
/// `.read` permission, and its changes only to someone who holds `.manage`.
void main() {
  group('the .manage permission implies the .read one', () {
    test('holds() applies the twin, never the reverse', () {
      expect(holds({'extension.manage'}, 'extension.read'), isTrue);
      expect(holds({'extension.read'}, 'extension.read'), isTrue);
      expect(holds({'extension.read'}, 'extension.manage'), isFalse);
      expect(holds({'extension.manage'}, 'did.read'), isFalse);
      expect(holds({'callflow.publish'}, 'callflow.read'), isTrue);
      expect(holds({'tenant.create'}, 'tenant.read'), isFalse);
    });

    test('the table is the one @cuc/authz enforces', () {
      // READ_TWINS in packages/authz/src/permissions.ts, read as text so the
      // console and the services cannot drift apart.
      final source = File('../../packages/authz/src/permissions.ts')
          .readAsStringSync();
      final block = source.substring(
        source.indexOf('export const READ_TWINS'),
        source.indexOf('};', source.indexOf('export const READ_TWINS')),
      );
      final pairs = {
        for (final m in RegExp(r"'([a-z_.]+)': '([a-z_.]+)'").allMatches(block))
          m.group(1)!: m.group(2)!,
      };
      expect(pairs, isNotEmpty);
      expect(readTwins, pairs);
    });

    test('a section asks for the read, which the manage permission gives', () {
      const session = Session(
        accessToken: 't',
        expiresIn: 900,
        orgId: 'r1',
        orgType: OrgType.reseller,
        permissions: [],
      );
      List<String> paths(Set<String> held) => [
        for (final s in visibleSections(session, null, held)) s.path,
      ];
      expect(paths({'org.view', 'trunk.read'}), contains('/trunks'));
      expect(paths({'org.view', 'trunk.manage'}), contains('/trunks'));
      expect(paths({'org.view'}), isNot(contains('/trunks')));
    });
  });

  group('a tenant person who can only read the configuration', () {
    testWidgets('sees the extensions, without create, edit or delete', (
      tester,
    ) async {
      await signInAndOpen(tester, 'support@example.test', 'Extensions');
      expect(find.text('Alice Kim'), findsOneWidget);
      expect(find.text('New extension'), findsNothing);
      expect(find.byTooltip('Edit'), findsNothing);
      expect(find.byTooltip('Delete'), findsNothing);
      expect(find.byTooltip('Call handling'), findsNothing);
    });

    testWidgets('has the configuration sections, read-only', (tester) async {
      await signInAndOpen(tester, 'support@example.test', 'Ring groups');
      final rail = find.byType(NavigationRail);
      for (final label in [
        'Extensions',
        'Phone numbers',
        'Call flows',
        'Queues',
        'Outbound routes',
      ]) {
        expect(
          find.descendant(of: rail, matching: find.text(label)),
          findsOneWidget,
          reason: label,
        );
      }
      expect(find.text('New ring group'), findsNothing);
      expect(find.byTooltip('Edit'), findsNothing);
    });
  });

  testWidgets('recording rules can be read without being changed', (
    tester,
  ) async {
    await signInAndOpen(tester, 'support@example.test', 'Recordings');
    expect(find.text('Keeping recordings'), findsOneWidget);
    expect(find.text('Add rule'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
    expect(find.byTooltip('Edit rule'), findsNothing);
  });

  testWidgets('someone holding only extension.manage still sees Extensions, '
      'and can change them', (tester) async {
    await completeSignIn(tester, 'limited@example.test');
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationRail),
        matching: find.text('Extensions'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Alice Kim'), findsOneWidget);
    expect(find.text('New extension'), findsOneWidget);
  });

  group('reseller support', () {
    Future<void> openTrunks(WidgetTester tester) async {
      await signInAndOpen(tester, 'reseller-support@example.test', 'Trunks');
      await tester.tap(find.byKey(const ValueKey('trunk-tenant')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Acme Dental').last);
      await tester.pumpAndSettle();
    }

    testWidgets('sees a tenant\'s trunks, without create, edit or delete', (
      tester,
    ) async {
      await openTrunks(tester);
      expect(find.text('Primary trunk'), findsOneWidget);
      expect(find.text('New trunk'), findsNothing);
      expect(find.byTooltip('Edit'), findsNothing);
      expect(find.byTooltip('Delete'), findsNothing);
    });

    testWidgets('sees a trunk\'s addresses and status but cannot change them', (
      tester,
    ) async {
      await openTrunks(tester);
      await tapVisible(tester, find.byTooltip('IP addresses and status').first);
      expect(find.text('Status: Registered'), findsOneWidget);
      expect(find.text('203.0.113.0/24'), findsOneWidget);
      expect(find.byTooltip('Remove 203.0.113.0/24'), findsNothing);
      expect(find.widgetWithText(TextField, 'Address or range'), findsNothing);
    });

    testWidgets('sees the tenants without New tenant', (tester) async {
      await signInAndOpen(tester, 'reseller-support@example.test', 'Tenants');
      expect(find.text('Acme Dental'), findsOneWidget);
      expect(find.text('New tenant'), findsNothing);
    });
  });
}
