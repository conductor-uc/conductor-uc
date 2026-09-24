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

  testWidgets(
    'a reseller acting as a tenant is told users are the tenant\'s own',
    (tester) async {
      await signInAs(tester, 'reseller@example.test');
      await tester.tap(find.text('Acme Dental').first);
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      await tester.tap(navItem('Users'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining("tenant's own administrators"),
        findsOneWidget,
      );
      expect(find.text('Invite user'), findsNothing);
    },
  );
}
