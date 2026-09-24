import 'package:console/dev/demo_backend.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';
import 'users_test.dart' show tapIn;

/// Signs in to the demo backend as a tenant user and opens [section].
Future<void> openSection(
  WidgetTester tester,
  String section, {
  List<Override> overrides = const [],
}) async {
  await pumpApp(tester, appWith(api: demoApi(), overrides: overrides));
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

  testWidgets('Connect a phone shows where to register, and reveals the '
      'password only after a reason', (tester) async {
    await openSection(tester, 'Extensions');
    await tapIn(tester, '102', find.byTooltip('Connect a phone'));

    expect(find.text('Connect a phone to 102'), findsOneWidget);
    expect(find.text('demo.voice.northwind.example'), findsWidgets);
    expect(find.text('5060'), findsOneWidget);
    expect(find.text('UDP or TCP'), findsOneWidget);
    expect(find.text('102'), findsWidgets);
    // Nothing secret until it is asked for.
    expect(find.text('demo-102-secret'), findsNothing);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Reveal password'));
    await tester.pumpAndSettle();
    // A reason is required.
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Reveal'))
          .onPressed,
      isNull,
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Why do you need it?'),
      'Setting up the desk phone',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Reveal'));
    await tester.pumpAndSettle();

    expect(find.text('demo-102-secret'), findsOneWidget);
    expect(
      find.widgetWithText(OutlinedButton, 'Reveal password'),
      findsNothing,
    );
  });

  testWidgets('resetting the password needs a reason and shows the new one', (
    tester,
  ) async {
    await openSection(tester, 'Extensions');
    await tapIn(tester, '102', find.byTooltip('Connect a phone'));
    await tester.tap(find.widgetWithText(TextButton, 'Reset password'));
    await tester.pumpAndSettle();

    expect(find.text('Reset this password?'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Reset'))
          .onPressed,
      isNull,
    );
    await tester.enterText(
      find.widgetWithText(TextField, 'Why are you resetting it?'),
      'Phone was lost',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
    await tester.pumpAndSettle();

    expect(find.textContaining('demo-102-reset-'), findsOneWidget);
    expect(find.text('demo-102-secret'), findsNothing);
    expect(
      find.text('Password reset. Enter the new one in the phone.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'someone who cannot reveal secrets still gets the server details',
    (tester) async {
      await completeSignIn(tester, 'limited@example.test');
      await tester.tap(
        find.descendant(
          of: find.byType(NavigationRail),
          matching: find.text('Extensions'),
        ),
      );
      await tester.pumpAndSettle();
      await tapIn(tester, '102', find.byTooltip('Connect a phone'));

      expect(find.text('5060'), findsOneWidget);
      expect(
        find.widgetWithText(OutlinedButton, 'Reveal password'),
        findsNothing,
      );
      expect(find.widgetWithText(TextButton, 'Reset password'), findsNothing);
      expect(
        find.text('The password is shown only to people allowed to reveal it.'),
        findsOneWidget,
      );
    },
  );

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
    // The row has more buttons now, so the last one can be off screen.
    await tester.ensureVisible(find.byTooltip('Delete').last);
    await tester.pumpAndSettle();
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

  testWidgets('call flows list opens the builder', (tester) async {
    await openSection(tester, 'Call flows');
    expect(find.text('Main menu'), findsOneWidget);
    await tester.tap(find.text('Main menu'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Save'
        'd',
      ),
      findsOneWidget,
    );
  });
}
