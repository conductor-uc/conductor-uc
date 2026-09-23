import 'package:console/dev/demo_backend.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// Signs in to the demo backend as a tenant user and opens [section].
Future<void> openSection(WidgetTester tester, String section) async {
  await pumpApp(tester, appWith(api: demoApi()));
  await tester.enterText(
    find.widgetWithText(TextField, 'Organization ID'),
    'demo',
  );
  await tester.enterText(
    find.widgetWithText(TextField, 'Email'),
    'tenant@example.test',
  );
  await tester.enterText(find.widgetWithText(TextField, 'Password'), 'pw');
  await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
  await tester.pumpAndSettle();
  await tester.tap(
    find.descendant(
      of: find.byType(NavigationRail),
      matching: find.text(section),
    ),
  );
  await tester.pumpAndSettle();
}

Finder field(String label) => find.widgetWithText(TextFormField, label);

Future<void> pickFromDropdown(
  WidgetTester tester,
  String label,
  String option,
) async {
  await tester.tap(
    find.widgetWithText(DropdownButtonFormField<String?>, label),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('extensions list shows the tenant\'s extensions', (tester) async {
    await openSection(tester, 'Extensions');
    expect(find.text('Alice Kim'), findsOneWidget);
    expect(find.text('102'), findsOneWidget);
    // The emergency location column shows the location's name, not its id.
    expect(find.text('Head office'), findsWidgets);
  });

  testWidgets('creating an extension adds a row', (tester) async {
    await openSection(tester, 'Extensions');
    await tester.tap(find.text('New extension'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Number *'), '104');
    await tester.enterText(field('Name *'), 'Dan Ito');
    await pickFromDropdown(tester, 'Emergency location *', 'Head office');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Dan Ito'), findsOneWidget);
  });

  testWidgets('required fields are checked before anything is sent', (
    tester,
  ) async {
    await openSection(tester, 'Extensions');
    await tester.tap(find.text('New extension'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Required'), findsWidgets);
    expect(find.text('Dan Ito'), findsNothing);
  });

  testWidgets('a server rejection is shown in the form', (tester) async {
    await openSection(tester, 'Extensions');
    await tester.tap(find.text('New extension'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Number *'), '101'); // already taken
    await tester.enterText(field('Name *'), 'Duplicate');
    await pickFromDropdown(tester, 'Emergency location *', 'Head office');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('101 is already in use.'), findsOneWidget);
    expect(find.text('Save'), findsOneWidget); // still in the form
  });

  testWidgets('editing an extension updates its row', (tester) async {
    await openSection(tester, 'Extensions');
    await tester.tap(find.byTooltip('Edit').first);
    await tester.pumpAndSettle();
    await tester.enterText(field('Name *'), 'Alice K.');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Alice K.'), findsOneWidget);
    expect(find.text('Alice Kim'), findsNothing);
  });

  testWidgets('deleting asks first, then removes the row', (tester) async {
    await openSection(tester, 'Extensions');
    await tester.tap(find.byTooltip('Delete').last);
    await tester.pumpAndSettle();
    expect(find.text('Delete extension?'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Carol Diaz'), findsNothing);
    expect(find.text('Alice Kim'), findsOneWidget);
  });

  testWidgets('a ring group needs at least one member', (tester) async {
    await openSection(tester, 'Ring groups');
    expect(find.text('Sales'), findsOneWidget);
    // Members render as their extension titles.
    expect(find.textContaining('101 · Alice Kim'), findsWidgets);

    await tester.tap(find.text('New ring group'));
    await tester.pumpAndSettle();
    await tester.enterText(field('Name *'), 'Support');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Required'), findsWidgets);

    await tester.tap(find.widgetWithText(FilterChip, '103 · Carol Diaz'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Support'), findsOneWidget);
  });

  testWidgets('a phone number shows what it rings by name', (tester) async {
    await openSection(tester, 'Phone numbers');
    expect(find.text('+14155550100'), findsOneWidget);
    expect(
      find.text('Main menu'),
      findsOneWidget,
    ); // the call flow it points at
  });

  testWidgets('queues page has a tab for agents', (tester) async {
    await openSection(tester, 'Queues');
    expect(find.text('Support'), findsWidgets);
    await tester.tap(find.widgetWithText(Tab, 'Agents'));
    await tester.pumpAndSettle();
    expect(find.text('103 · Carol Diaz'), findsOneWidget);
  });

  testWidgets('media is read-only but can be deleted', (tester) async {
    await openSection(tester, 'Media');
    expect(find.text('Hold music'), findsOneWidget);
    expect(find.byTooltip('Edit'), findsNothing);
    expect(find.byTooltip('Delete'), findsWidgets);
  });

  testWidgets('call flow: create, validate an empty graph, publish', (
    tester,
  ) async {
    await openSection(tester, 'Call flows');
    expect(find.text('Main menu'), findsOneWidget);

    await tester.tap(find.text('New call flow'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'After hours');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    // Now in the editor for the new flow.
    expect(find.text('After hours'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Validate'));
    await tester.pumpAndSettle();
    expect(find.text('The flow has no nodes yet.'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();
    expect(find.text('Published version 1.'), findsOneWidget);
    expect(find.text('Version 1'), findsOneWidget);
  });

  testWidgets('invalid JSON in the flow editor is reported, not sent', (
    tester,
  ) async {
    await openSection(tester, 'Call flows');
    await tester.tap(find.text('Main menu'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Flow graph'),
      '{ not json',
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Save draft'));
    await tester.pumpAndSettle();
    expect(find.textContaining('not valid JSON'), findsOneWidget);
  });
}
