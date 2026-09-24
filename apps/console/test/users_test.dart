import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem, signInAs;
import 'pbx_test.dart' show field, openSection, pickFromDropdown;

/// [what], but only where it sits on the same table row as the text [anchor].
/// (A `DataRow` is data, not a widget, so rows are told apart by position.)
Finder inRow(WidgetTester tester, String anchor, Finder what) {
  final y = tester.getCenter(find.text(anchor)).dy;
  final hits = what.evaluate().where((e) {
    final center = tester.getCenter(find.byElementPredicate((x) => x == e));
    return (center.dy - y).abs() < 20;
  }).toSet();
  return find.byElementPredicate(hits.contains);
}

/// Taps [what] on [anchor]'s row; the actions sit at the far right of a wide
/// table, so scroll them into view first.
Future<void> tapIn(WidgetTester tester, String anchor, Finder what) async {
  final target = inRow(tester, anchor, what);
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists the organization\'s people with role and access', (
    tester,
  ) async {
    await openSection(tester, 'Users');
    expect(find.text('Alex Admin (you)'), findsOneWidget);
    expect(find.text('Sam Support'), findsOneWidget);
    expect(
      inRow(tester, 'sam@example.test', find.text('User')),
      findsOneWidget,
    );
    expect(
      inRow(tester, 'admin@example.test', find.text('Administrator')),
      findsOneWidget,
    );
    // Dana was invited, has no role, and has never signed in.
    expect(
      inRow(tester, 'dana@example.test', find.text('No role')),
      findsOneWidget,
    );
    expect(
      inRow(tester, 'dana@example.test', find.text('Never')),
      findsOneWidget,
    );
  });

  testWidgets('you cannot disable yourself, but can everyone else', (
    tester,
  ) async {
    await openSection(tester, 'Users');
    expect(
      inRow(tester, 'admin@example.test', find.byTooltip('Disable')),
      findsNothing,
    );
    expect(
      inRow(tester, 'sam@example.test', find.byTooltip('Disable')),
      findsOneWidget,
    );
  });

  testWidgets('resetting two-step verification asks first, then clears it', (
    tester,
  ) async {
    await openSection(tester, 'Users');
    // Only someone else who has set one up can be reset: not you, and not
    // Dana, who has not.
    final reset = find.byTooltip('Reset two-step verification');
    expect(inRow(tester, 'admin@example.test', reset), findsNothing);
    expect(inRow(tester, 'dana@example.test', reset), findsNothing);
    expect(inRow(tester, 'sam@example.test', reset), findsOneWidget);

    await tapIn(tester, 'sam@example.test', reset);
    expect(
      find.text('Reset two-step verification for Sam Support?'),
      findsOneWidget,
    );
    expect(find.textContaining('We email them'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
    await tester.pumpAndSettle();

    expect(
      find.text('Two-step verification reset for Sam Support.'),
      findsOneWidget,
    );
    // There is now nothing left to reset.
    expect(inRow(tester, 'sam@example.test', reset), findsNothing);
  });

  testWidgets('cancelling the reset changes nothing', (tester) async {
    await openSection(tester, 'Users');
    final reset = find.byTooltip('Reset two-step verification');
    await tapIn(tester, 'sam@example.test', reset);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(inRow(tester, 'sam@example.test', reset), findsOneWidget);
  });

  testWidgets('invites someone by email', (tester) async {
    await openSection(tester, 'Users');
    await tester.tap(find.text('Invite user'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Email *'), 'New.Person@example.test');
    await tester.enterText(field('Name *'), 'New Person');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(
      find.text('Invitation sent to new.person@example.test.'),
      findsOneWidget,
    );
  });

  testWidgets('an email that already has an account is explained', (
    tester,
  ) async {
    await openSection(tester, 'Users');
    await tester.tap(find.text('Invite user'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Email *'), 'sam@example.test');
    await tester.enterText(field('Name *'), 'Sam Again');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('That email already has an account.'), findsOneWidget);
    // The form stays open to fix it.
    expect(find.text('Cancel'), findsOneWidget);
  });

  testWidgets('both fields are needed to invite', (tester) async {
    await openSection(tester, 'Users');
    await tester.tap(find.text('Invite user'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Required'), findsNWidgets(2));
  });

  testWidgets('gives someone a role', (tester) async {
    await openSection(tester, 'Users');
    await tapIn(tester, 'dana@example.test', find.byTooltip('Edit'));
    await pickFromDropdown(tester, 'Role', 'Supervisor');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(
      inRow(tester, 'dana@example.test', find.text('Supervisor')),
      findsOneWidget,
    );
  });

  testWidgets('changes a role, taking the old one away', (tester) async {
    await openSection(tester, 'Users');
    await tapIn(tester, 'sam@example.test', find.byTooltip('Edit'));
    await pickFromDropdown(tester, 'Role', 'Administrator');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(
      inRow(tester, 'sam@example.test', find.text('Administrator')),
      findsOneWidget,
    );
    expect(inRow(tester, 'sam@example.test', find.text('User')), findsNothing);
  });

  testWidgets('renames someone', (tester) async {
    await openSection(tester, 'Users');
    await tapIn(tester, 'sam@example.test', find.byTooltip('Edit'));
    await tester.enterText(field('Name *'), 'Samantha Support');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Samantha Support'), findsOneWidget);
    expect(find.text('Sam Support'), findsNothing);
  });

  testWidgets('disabling asks first, then can be undone', (tester) async {
    await openSection(tester, 'Users');
    await tapIn(tester, 'sam@example.test', find.byTooltip('Disable'));
    expect(find.text('Disable Sam Support?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(
      inRow(tester, 'sam@example.test', find.text('Can sign in')),
      findsOneWidget,
    );

    await tapIn(tester, 'sam@example.test', find.byTooltip('Disable'));
    await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
    await tester.pumpAndSettle();
    expect(
      inRow(tester, 'sam@example.test', find.text('Disabled')),
      findsOneWidget,
    );

    await tapIn(tester, 'sam@example.test', find.byTooltip('Allow sign-in'));
    expect(
      inRow(tester, 'sam@example.test', find.text('Can sign in')),
      findsOneWidget,
    );
  });

  group('a reseller managing a tenant\'s people', () {
    Future<void> enterTenantUsers(WidgetTester tester) async {
      await signInAs(tester, 'reseller@example.test');
      await tester.tap(find.text('Acme Dental').first);
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      await tester.tap(navItem('Users'));
      await tester.pumpAndSettle();
    }

    testWidgets('sees the tenant\'s people, not their own', (tester) async {
      await enterTenantUsers(tester);
      expect(find.textContaining('sign in to Acme Dental'), findsOneWidget);
      expect(find.text('Riley Owner'), findsOneWidget);
      expect(find.text('Jo Front Desk'), findsOneWidget);
      expect(find.text('Alex Admin'), findsNothing);
      expect(find.text('Invite user'), findsOneWidget);
    });

    testWidgets('can invite, rename, give a tenant role, and disable', (
      tester,
    ) async {
      await enterTenantUsers(tester);

      await tester.tap(find.text('Invite user'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Email *'), 'new@tenant.example.test');
      await tester.enterText(field('Name *'), 'Nia New');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(
        find.text('Invitation sent to new@tenant.example.test.'),
        findsOneWidget,
      );

      await tapIn(tester, 'Jo Front Desk', find.byTooltip('Edit'));
      // The roles offered are a tenant's, whoever is signed in.
      await pickFromDropdown(tester, 'Role', 'Supervisor');
      await tester.enterText(field('Name *'), 'Jo Reception');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Jo Reception'), findsOneWidget);
      expect(find.text('Supervisor'), findsOneWidget);

      await tapIn(tester, 'Riley Owner', find.byTooltip('Disable'));
      await tester.tap(find.widgetWithText(FilledButton, 'Disable'));
      await tester.pumpAndSettle();
      expect(
        inRow(tester, 'desk@tenant.example.test', find.text('Can sign in')),
        findsOneWidget,
      );
      expect(
        inRow(tester, 'owner@tenant.example.test', find.text('Disabled')),
        findsOneWidget,
      );
    });

    testWidgets('leaving the tenant returns to one\'s own people', (
      tester,
    ) async {
      await enterTenantUsers(tester);
      await tester.tap(find.widgetWithText(TextButton, 'Exit'));
      await tester.pumpAndSettle();
      await tester.tap(navItem('Users'));
      await tester.pumpAndSettle();
      expect(find.text('Riley Owner'), findsNothing);
      expect(find.text('Alex Admin (you)'), findsOneWidget);
    });

    testWidgets('People on a tenant opens its people directly', (tester) async {
      await signInAs(tester, 'reseller@example.test');
      final tile = find.ancestor(
        of: find.text('Acme Dental').first,
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: tile, matching: find.byTooltip('More')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('People'));
      await tester.pumpAndSettle();
      expect(find.text('Acting as Acme Dental'), findsOneWidget);
      expect(find.text('Riley Owner'), findsOneWidget);
    });
  });
}
