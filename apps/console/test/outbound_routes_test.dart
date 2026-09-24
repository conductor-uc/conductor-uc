import 'package:console/app/router.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem, signInAs;
import 'support.dart';
import 'users_test.dart' show tapIn;

Future<void> openRoutes(
  WidgetTester tester, {
  String email = 'tenant@example.test',
}) async {
  await pumpApp(tester, appWith(api: demoApi()));
  await submitSignIn(tester, email);
  await tester.ensureVisible(navItem('Outbound routes'));
  await tester.tap(navItem('Outbound routes'));
  await tester.pumpAndSettle();
}

/// The text of each cell of the routes table, row by row.
List<List<String>> tableRows(WidgetTester tester) => [
  for (final row in tester.widget<DataTable>(find.byType(DataTable)).rows)
    [for (final cell in row.cells.take(5)) (cell.child as Text).data!],
];

Finder field(String label) => find.widgetWithText(TextFormField, label);

Future<void> save(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Save'));
  await tester.pumpAndSettle();
}

Future<void> openEmergency(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(Tab, 'Emergency route'));
  await tester.pumpAndSettle();
}

void main() {
  group('outbound routes', () {
    testWidgets('are listed in the order they are tried', (tester) async {
      await openRoutes(tester);
      expect(find.text('Outbound routes'), findsWidgets);
      expect(tableRows(tester), [
        ['10', '+1', 'Primary trunk', '0', '—'],
        ['100', 'Everything else', 'Primary trunk, Overflow trunk', '0', '—'],
      ]);
    });

    testWidgets('a new one is added in its place by priority', (tester) async {
      await openRoutes(tester);
      await tester.tap(find.text('New outbound route'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Priority *'), '50');
      await tester.enterText(field('Number prefix *'), '+44');
      await tester.enterText(field('Digits to add'), '0');
      await tester.tap(find.widgetWithText(FilterChip, 'Overflow trunk'));
      await tester.pumpAndSettle();
      await save(tester);

      expect(tableRows(tester), [
        ['10', '+1', 'Primary trunk', '0', '—'],
        ['50', '+44', 'Overflow trunk', '0', '0'],
        ['100', 'Everything else', 'Primary trunk, Overflow trunk', '0', '—'],
      ]);
    });

    testWidgets('one for every other number is made with an empty prefix', (
      tester,
    ) async {
      await openRoutes(tester);
      await tapIn(tester, '+1', find.byTooltip('Delete'));
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      await tapIn(tester, 'Everything else', find.byTooltip('Delete'));
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(find.text('No outbound routes yet.'), findsOneWidget);

      await tester.tap(find.text('New outbound route'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Priority *'), '1');
      await tester.tap(find.widgetWithText(FilterChip, 'Primary trunk'));
      await tester.pumpAndSettle();
      await save(tester);
      expect(tableRows(tester), [
        ['1', 'Everything else', 'Primary trunk', '0', '—'],
      ]);
    });

    testWidgets('need a priority and a trunk', (tester) async {
      await openRoutes(tester);
      await tester.tap(find.text('New outbound route'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Priority *'), '');
      await save(tester);
      // The dialog stays, saying what is missing.
      expect(find.text('New outbound route'), findsWidgets);
      expect(find.text('Required'), findsNWidgets(2));
      expect(tableRows(tester), hasLength(2));

      await tester.enterText(field('Priority *'), '-1');
      await save(tester);
      expect(find.text('At least 0'), findsOneWidget);
    });

    testWidgets('show the service\'s reason for a prefix it refuses', (
      tester,
    ) async {
      await openRoutes(tester);
      await tester.tap(find.text('New outbound route'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Number prefix *'), '44abc');
      await tester.tap(find.widgetWithText(FilterChip, 'Primary trunk'));
      await tester.pumpAndSettle();
      await save(tester);
      expect(
        find.textContaining("'44abc' is not a valid outbound route pattern"),
        findsOneWidget,
      );
      expect(tableRows(tester), hasLength(2));

      // Fixing it and saving again works.
      await tester.enterText(field('Number prefix *'), '+44');
      await save(tester);
      expect(find.text('+44'), findsOneWidget);
    });

    testWidgets('changing the priority reorders them', (tester) async {
      await openRoutes(tester);
      await tapIn(tester, 'Everything else', find.byTooltip('Edit'));
      expect(find.text('Edit outbound route'), findsOneWidget);
      // The form starts from what is saved.
      expect(
        tester.widget<TextFormField>(field('Priority *')).controller!.text,
        '100',
      );
      await tester.enterText(field('Priority *'), '5');
      await tester.enterText(field('Digits to remove'), '1');
      await save(tester);
      expect(tableRows(tester), [
        ['5', 'Everything else', 'Primary trunk, Overflow trunk', '1', '—'],
        ['10', '+1', 'Primary trunk', '0', '—'],
      ]);
    });

    testWidgets('can be removed after confirming', (tester) async {
      await openRoutes(tester);
      await tapIn(tester, '+1', find.byTooltip('Delete'));
      expect(find.text('Delete outbound route?'), findsOneWidget);
      expect(find.text('Calls to +1'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(tableRows(tester), hasLength(2));

      await tapIn(tester, '+1', find.byTooltip('Delete'));
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(tableRows(tester), [
        ['100', 'Everything else', 'Primary trunk, Overflow trunk', '0', '—'],
      ]);
    });
  });

  group('the emergency route', () {
    testWidgets('starts unset and is set with a trunk and numbers', (
      tester,
    ) async {
      await openRoutes(tester);
      await openEmergency(tester);
      expect(find.textContaining('No emergency route is set'), findsOneWidget);

      await tester.tap(find.text('Set emergency route'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('emergency-trunk')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Primary trunk').last);
      await tester.pumpAndSettle();
      await tester.enterText(field('Emergency numbers *'), '911, 112');
      await save(tester);

      expect(find.textContaining('No emergency route is set'), findsNothing);
      expect(find.text('Primary trunk'), findsOneWidget);
      expect(find.text('911, 112'), findsOneWidget);
    });

    testWidgets('needs a trunk and a number, and shows what the service '
        'refuses', (tester) async {
      await openRoutes(tester);
      await openEmergency(tester);
      await tester.tap(find.text('Set emergency route'));
      await tester.pumpAndSettle();
      await save(tester);
      expect(find.text('Required'), findsNWidgets(2));

      await tester.tap(find.byKey(const ValueKey('emergency-trunk')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Overflow trunk').last);
      await tester.pumpAndSettle();
      await tester.enterText(field('Emergency numbers *'), '+911');
      await save(tester);
      expect(
        find.textContaining("'+911' is not a valid emergency number"),
        findsOneWidget,
      );
      expect(find.text('Emergency route'), findsWidgets);
    });

    testWidgets('can be changed and removed', (tester) async {
      await openRoutes(tester);
      await openEmergency(tester);
      await tester.tap(find.text('Set emergency route'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('emergency-trunk')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Primary trunk').last);
      await tester.pumpAndSettle();
      await tester.enterText(field('Emergency numbers *'), '911');
      await save(tester);

      await tester.tap(find.widgetWithText(FilledButton, 'Edit'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextFormField>(field('Emergency numbers *'))
            .controller!
            .text,
        '911',
      );
      await tester.enterText(field('Emergency numbers *'), '911, 933');
      await save(tester);
      expect(find.text('911, 933'), findsOneWidget);

      await tester.tap(find.text('Remove emergency route'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await tester.pumpAndSettle();
      expect(find.textContaining('No emergency route is set'), findsOneWidget);
    });
  });

  group('who sees what', () {
    testWidgets('a tenant admin sees both parts', (tester) async {
      await openRoutes(tester);
      expect(find.widgetWithText(Tab, 'Outbound routes'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'Emergency route'), findsOneWidget);
    });

    testWidgets('someone who manages trunks but not the emergency route sees '
        'only the routes', (tester) async {
      await openRoutes(tester, email: 'routes@example.test');
      expect(find.byType(Tab), findsNothing);
      expect(tableRows(tester), hasLength(2));
      expect(find.text('Emergency route'), findsNothing);
      expect(find.text('New outbound route'), findsOneWidget);
    });

    testWidgets('someone with neither has no such page', (tester) async {
      await signInAs(tester, 'limited@example.test');
      expect(navItem('Outbound routes'), findsNothing);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(NavigationRail)),
      );
      container.read(routerProvider).go('/outbound-routes');
      await tester.pumpAndSettle();
      expect(container.read(routerProvider).state.uri.path, '/forbidden');
    });

    testWidgets('a reseller acting as a tenant can configure them (config '
        'data, not private)', (tester) async {
      await signInAs(tester, 'reseller@example.test');
      await actAs(tester, 'Acme Dental');
      expect(navItem('Outbound routes'), findsOneWidget);
      await tester.ensureVisible(navItem('Outbound routes'));
      await tester.tap(navItem('Outbound routes'));
      await tester.pumpAndSettle();
      expect(tableRows(tester), hasLength(2));
    });
  });
}
