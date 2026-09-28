import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;
import 'support.dart';
import 'users_test.dart' show tapIn;

/// S9-06: a tenant's home says what is left to set up, what needs attention,
/// and the latest calls.
void main() {
  Future<void> bigWindow(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1600, 1600);
    addTearDown(tester.view.resetPhysicalSize);
  }

  testWidgets('a tenant that is set up sees no checklist, and its calls', (
    tester,
  ) async {
    await bigWindow(tester);
    await completeSignIn(tester, 'tenant@example.test');
    await tester.pumpAndSettle();
    expect(find.text('Acme Dental'), findsWidgets);
    expect(find.byKey(const ValueKey('setup-checklist')), findsNothing);
    expect(find.text('Nothing needs your attention.'), findsOneWidget);
    // Outside numbers read as people write them.
    expect(find.text('(415) 555-1000 → 101'), findsOneWidget);
    expect(find.text('At a glance'), findsOneWidget);
  });

  testWidgets('with no phone number, the checklist says what to do next', (
    tester,
  ) async {
    await bigWindow(tester);
    await openSection(tester, 'Phone numbers');
    await tapIn(tester, '(415) 555-0100', find.byTooltip('Delete'));
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    await tapNav(tester, 'Dashboard');

    expect(find.byKey(const ValueKey('setup-checklist')), findsOneWidget);
    expect(find.text('3 of 5 done'), findsOneWidget);
    // The next step is the one to press.
    await tester.tap(find.widgetWithText(FilledButton, 'Add number'));
    await tester.pumpAndSettle();
    expect(find.text('No phone numbers yet.'), findsOneWidget);
  });

  testWidgets('a call flow never published needs attention', (tester) async {
    await bigWindow(tester);
    await openSection(tester, 'Call flows');
    await tester.tap(find.text('New call flow'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Holidays');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();
    await tapNav(tester, 'Dashboard');
    expect(find.text("1 call flow hasn't been published"), findsOneWidget);
    await tester.tap(find.text("1 call flow hasn't been published"));
    await tester.pumpAndSettle();
    expect(find.text('Holidays'), findsOneWidget);
  });
}
