import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem, signInAs;
import 'pbx_test.dart' show openSection;
import 'support.dart';
import 'users_test.dart' show tapIn;

/// S9-10: the call flow list: templates, rename, copy, delete, the numbers
/// each answers, and resellers building their customers' flows (D-020).
void main() {
  Future<void> wide(WidgetTester tester) async {
    tester.view.physicalSize = const Size(2400, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('says which numbers each flow answers, and whether it is live', (
    tester,
  ) async {
    await wide(tester);
    await openSection(tester, 'Call flows');
    expect(find.text('(415) 555-0100'), findsOneWidget);
    expect(find.text('Live'), findsWidgets);
  });

  testWidgets('a new flow can start from the business hours template', (
    tester,
  ) async {
    await wide(tester);
    await openSection(tester, 'Call flows');
    await tester.tap(find.text('New call flow').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('flow-name')), 'Main');
    await tester.tap(find.text('Business hours'));
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();
    // In the builder, with the template's steps laid out.
    expect(find.text('Time condition'), findsWidgets);
    expect(find.text('Ring group'), findsWidgets);
    expect(find.text('Voicemail'), findsWidgets);
  });

  testWidgets('a flow is renamed and copied', (tester) async {
    await wide(tester);
    await openSection(tester, 'Call flows');
    await tester.tap(find.byTooltip('Rename').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Front door');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Front door'), findsOneWidget);

    await tester.tap(find.byTooltip('Make a copy').first);
    await tester.pumpAndSettle();
    expect(find.text('Copy of Front door'), findsOneWidget);
  });

  testWidgets('deleting says which numbers it answers', (tester) async {
    await wide(tester);
    await openSection(tester, 'Call flows');
    await tapIn(tester, 'Main menu', find.byTooltip('Delete'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Phone number: (415) 555-0100'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
  });

  testWidgets('a phone number that a flow answers opens it', (tester) async {
    await wide(tester);
    await openSection(tester, 'Phone numbers');
    await tapIn(tester, '(415) 555-0100', find.byTooltip('Open its call flow'));
    await tester.pumpAndSettle();
    expect(find.text('Validate'), findsOneWidget);
  });

  testWidgets('a reseller visiting a tenant builds its call flows (D-020)', (
    tester,
  ) async {
    await wide(tester);
    await signInAs(tester, 'reseller@example.test');
    await actAs(tester, 'Acme Dental');
    expect(navItem('Call flows'), findsOneWidget);
    await tapNav(tester, 'Call flows');
    expect(find.text('New call flow'), findsOneWidget);
  });
}
