import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;

Future<void> openTiers(WidgetTester tester) async {
  await openSection(tester, 'Queues');
  await tester.tap(find.byTooltip('Agents and tiers'));
  await tester.pumpAndSettle();
}

Finder levelField(String rowKey) => find.descendant(
  of: find.byKey(ValueKey(rowKey)),
  matching: find.widgetWithText(TextField, 'Level'),
);

void main() {
  testWidgets('shows who answers the queue, named by their extension', (
    tester,
  ) async {
    await openTiers(tester);
    expect(find.text('Agents in Support'), findsOneWidget);
    expect(find.text('103 · Carol Diaz'), findsOneWidget);
    expect(find.byKey(const ValueKey('tier-tier-1')), findsOneWidget);
    // The only agent is already in the queue.
    expect(find.text('Every agent is already in this queue.'), findsOneWidget);
  });

  testWidgets('changing a level is saved', (tester) async {
    await openTiers(tester);
    await tester.enterText(levelField('tier-tier-1'), '2');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(levelField('tier-tier-1')).controller!.text,
      '2',
    );
    // Close and reopen: it was stored, not just shown.
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Agents and tiers'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(levelField('tier-tier-1')).controller!.text,
      '2',
    );
  });

  testWidgets('a level outside 1 to 100 is refused', (tester) async {
    await openTiers(tester);
    await tester.enterText(levelField('tier-tier-1'), '0');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('Enter a whole number from 1 to 100.'), findsOneWidget);
  });

  testWidgets('an agent is removed from the queue and can be added back', (
    tester,
  ) async {
    await openTiers(tester);
    await tester.tap(find.byTooltip('Remove from queue'));
    await tester.pumpAndSettle();
    expect(find.text('No agents yet. Add one below.'), findsOneWidget);
    expect(find.byKey(const ValueKey('tier-tier-1')), findsNothing);

    await tester.tap(
      find.widgetWithText(DropdownButtonFormField<String>, 'Add an agent'),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('103 · Carol Diaz').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pumpAndSettle();
    expect(find.text('No agents yet. Add one below.'), findsNothing);
    expect(find.text('103 · Carol Diaz'), findsOneWidget);
    expect(find.text('Every agent is already in this queue.'), findsOneWidget);
  });

  testWidgets('Add needs an agent chosen first', (tester) async {
    await openTiers(tester);
    await tester.tap(find.byTooltip('Remove from queue'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Add'))
          .onPressed,
      isNull,
    );
  });

  testWidgets('phone numbers show which trunk they arrive on', (tester) async {
    await openSection(tester, 'Phone numbers');
    expect(find.text('Trunk'), findsOneWidget);
    expect(find.text('Primary trunk'), findsOneWidget);
  });
}
