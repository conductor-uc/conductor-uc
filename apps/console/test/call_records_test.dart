import 'package:console/app/router.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/features/cdr/call_records_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem, signInAs;
import 'support.dart';

/// Signs in as [email] and opens Call records.
Future<void> openCalls(
  WidgetTester tester, {
  String email = 'tenant@example.test',
  List<String>? urls,
}) async {
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        if (urls != null)
          urlOpenerProvider.overrideWithValue((url) async => urls.add(url)),
      ],
    ),
  );
  await submitSignIn(tester, email);
  await tester.ensureVisible(navItem('Call records'));
  await tester.tap(navItem('Call records'));
  await tester.pumpAndSettle();
}

/// The text of each cell of the list, row by row.
List<List<String>> tableRows(WidgetTester tester) => [
  for (final row in tester.widget<DataTable>(find.byType(DataTable)).rows)
    [for (final cell in row.cells) (cell.child as Text).data!],
];

Finder input(String key) => find.byKey(ValueKey(key));

Future<void> search(WidgetTester tester) async {
  await tester.ensureVisible(find.widgetWithText(FilledButton, 'Search'));
  await tester.tap(find.widgetWithText(FilledButton, 'Search'));
  await tester.pumpAndSettle();
}

Future<void> pickDirection(WidgetTester tester, String label) async {
  await tester.tap(input('cdr-direction'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Future<void> openExportDialog(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(OutlinedButton, 'Export CSV'));
  await tester.pumpAndSettle();
}

Future<void> startExport(
  WidgetTester tester, {
  required String from,
  required String to,
}) async {
  await openExportDialog(tester);
  await tester.enterText(input('export-from'), from);
  await tester.enterText(input('export-to'), to);
  await tester.tap(find.widgetWithText(FilledButton, 'Start export'));
  // Not pumpAndSettle: the new export's spinner never settles, and time
  // passing would move the export along before it can be looked at.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

void main() {
  group('the list', () {
    testWidgets('shows the newest calls first, a page at a time', (
      tester,
    ) async {
      await openCalls(tester);
      expect(find.text('Call records'), findsWidgets);
      var rows = tableRows(tester);
      expect(rows, hasLength(50));
      // Newest first: 2026-09-24 09:00 UTC is the newest call.
      final newest = formatWhen('2026-09-24T09:00:00.000Z');
      expect(rows.first.first, newest);
      // An inbound call, then an outbound one, then an internal one.
      expect(rows[0].sublist(1, 4), ['Inbound', '+14155551000', '101']);
      expect(rows[1][1], 'Outbound');
      expect(rows[1][2], '102 (Ext 102)');
      expect(rows[2][1], 'Internal');
      expect(rows.first[4], '0:36'); // 30 s of talk plus 6 s of ringing

      await tester.ensureVisible(find.text('Load more'));
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      rows = tableRows(tester);
      expect(rows, hasLength(65));
      expect(find.text('Load more'), findsNothing);
    });

    testWidgets('unanswered calls say how they ended', (tester) async {
      await openCalls(tester);
      final results = {for (final r in tableRows(tester)) r[5]};
      expect(results, containsAll(['Answered', 'Busy', 'No answer']));
    });

    testWidgets('filters by direction', (tester) async {
      await openCalls(tester);
      await pickDirection(tester, 'Outbound');
      await search(tester);
      final rows = tableRows(tester);
      expect(rows, isNotEmpty);
      expect(rows.every((r) => r[1] == 'Outbound'), isTrue);
      // 65 calls, every third outbound: 22 of them.
      expect(rows, hasLength(22));
    });

    testWidgets('filters by a number, or by picking an extension', (
      tester,
    ) async {
      await openCalls(tester);
      await tester.enterText(input('cdr-number'), '+12125552001');
      await search(tester);
      var rows = tableRows(tester);
      expect(rows, hasLength(1));
      expect(rows.single[3], '+12125552001');

      // Choosing an extension fills its number in.
      await tester.tap(input('cdr-extension'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('102 · Bob Osei').last);
      await tester.pumpAndSettle();
      expect(find.text('102'), findsWidgets);
      await search(tester);
      rows = tableRows(tester);
      expect(rows, isNotEmpty);
      expect(
        rows.every((r) => r[2].startsWith('102') || r[3] == '102'),
        isTrue,
      );
    });

    testWidgets('filters by the phone number that was called', (tester) async {
      await openCalls(tester);
      await tester.enterText(input('cdr-did'), '+14155550100');
      await search(tester);
      final rows = tableRows(tester);
      expect(rows, isNotEmpty);
      expect(rows.every((r) => r[1] == 'Inbound'), isTrue);
    });

    testWidgets('filters by day, whole days in the viewer\'s time zone', (
      tester,
    ) async {
      await openCalls(tester);
      await tester.enterText(input('cdr-from'), '2026-09-22');
      await tester.enterText(input('cdr-to'), '2026-09-22');
      await search(tester);
      final rows = tableRows(tester);
      final expected = [
        for (var i = 0; i < 65; i++)
          DateTime.utc(
            2026,
            9,
            24,
            9,
          ).subtract(Duration(hours: 3 * i)).toLocal(),
      ].where((d) => d.year == 2026 && d.month == 9 && d.day == 22).length;
      expect(rows, hasLength(expected));
      expect(rows.every((r) => r[0].startsWith('2026-09-22')), isTrue);
    });

    testWidgets('says so when nothing matches, and Clear starts over', (
      tester,
    ) async {
      await openCalls(tester);
      await tester.enterText(input('cdr-number'), '999');
      await search(tester);
      expect(find.text('No calls match.'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Clear'));
      await tester.pumpAndSettle();
      expect(tableRows(tester), hasLength(50));
    });

    testWidgets('refuses a date that is not one, and a range backwards', (
      tester,
    ) async {
      await openCalls(tester);
      await tester.enterText(input('cdr-from'), 'last week');
      await search(tester);
      expect(
        find.text('From must be a date such as 2026-09-24.'),
        findsOneWidget,
      );
      expect(tableRows(tester), hasLength(50));

      await tester.enterText(input('cdr-from'), '2026-09-22');
      await tester.enterText(input('cdr-to'), '2026-09-20');
      await search(tester);
      expect(find.text('To must not be before From.'), findsOneWidget);
    });
  });

  group('a call', () {
    testWidgets('opens to show everything recorded about it', (tester) async {
      await openCalls(tester);
      await tester.tap(find.text('+14155551000'));
      await tester.pumpAndSettle();
      expect(find.text('Call details'), findsOneWidget);
      for (final text in [
        'Inbound',
        'Answered',
        '+14155550100', // the phone number that was called
        'Primary trunk', // the trunk's name, not its id
        'Main menu', // the call flow's name
        '101 · Alice Kim',
        'NORMAL_CLEARING',
        'None', // no recordings
      ]) {
        expect(find.text(text), findsWidgets, reason: text);
      }
      await tester.tap(find.widgetWithText(TextButton, 'Close'));
      await tester.pumpAndSettle();
      expect(find.text('Call details'), findsNothing);
    });
  });

  group('exporting', () {
    testWidgets('starts an export, follows it, and downloads when ready', (
      tester,
    ) async {
      final opened = <String>[];
      await openCalls(tester, urls: opened);
      expect(find.text('Export CSV'), findsOneWidget);
      await startExport(tester, from: '2026-09-01', to: '2026-09-24');
      expect(find.text('Export, 2026-09-01 to 2026-09-24'), findsOneWidget);
      expect(find.text('Waiting to start…'), findsOneWidget);
      expect(find.text('Download'), findsNothing);

      await tester.pump(const Duration(seconds: 3));
      expect(find.text('Preparing the file…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('Ready'), findsOneWidget);
      // It stops asking once ready.
      await tester.pumpAndSettle();

      await tester.tap(find.text('Download'));
      await tester.pumpAndSettle();
      expect(opened, hasLength(1));
      expect(opened.single, startsWith('https://storage.demo.invalid/'));
      expect(opened.single, endsWith('.csv'));
    });

    testWidgets('shows why an export failed', (tester) async {
      await openCalls(tester);
      await startExport(tester, from: '2019-01-01', to: '2019-02-01');
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      expect(
        find.text('Failed: The file could not be written.'),
        findsOneWidget,
      );
      expect(find.text('Download'), findsNothing);
      await tester.pumpAndSettle();
    });

    testWidgets('shows the service\'s reason for a period it refuses', (
      tester,
    ) async {
      await openCalls(tester);
      await startExport(tester, from: '2025-01-01', to: '2026-09-24');
      expect(
        find.text('from/to cannot span more than 366 days.'),
        findsOneWidget,
      );
      // The dialog stays open so the dates can be fixed.
      expect(find.text('Export call records'), findsOneWidget);
      await tester.enterText(input('export-from'), '2026-09-01');
      await tester.tap(find.widgetWithText(FilledButton, 'Start export'));
      await tester.pumpAndSettle();
      expect(find.text('Export call records'), findsNothing);
      expect(find.textContaining('Export, 2026-09-01'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
    });

    testWidgets('checks the dates before asking', (tester) async {
      await openCalls(tester);
      await startExport(tester, from: 'soon', to: '2026-09-24');
      expect(find.text('Enter both dates as YYYY-MM-DD.'), findsOneWidget);
      await tester.enterText(input('export-from'), '2026-09-24');
      await tester.enterText(input('export-to'), '2026-09-01');
      await tester.tap(find.widgetWithText(FilledButton, 'Start export'));
      await tester.pumpAndSettle();
      expect(find.text('to must be after from.'), findsOneWidget);
    });

    testWidgets('someone who can read but not export sees no export', (
      tester,
    ) async {
      await openCalls(tester, email: 'reader@example.test');
      expect(tableRows(tester), hasLength(50));
      expect(find.text('Export CSV'), findsNothing);
    });
  });

  group('who sees it (rule H1)', () {
    testWidgets('a tenant admin does', (tester) async {
      await signInAs(tester, 'tenant@example.test');
      expect(navItem('Call records'), findsOneWidget);
    });

    testWidgets('someone without cdr.read does not', (tester) async {
      await signInAs(tester, 'limited@example.test');
      expect(navItem('Call records'), findsNothing);
      expect(navItem('Extensions'), findsOneWidget);
    });

    testWidgets('a reseller acting as a tenant does not, even by address', (
      tester,
    ) async {
      await signInAs(tester, 'reseller@example.test');
      await actAs(tester, 'Acme Dental');
      expect(navItem('Extensions'), findsOneWidget);
      expect(navItem('Call records'), findsNothing);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(NavigationRail)),
      );
      container.read(routerProvider).go('/call-records');
      await tester.pumpAndSettle();
      expect(container.read(routerProvider).state.uri.path, '/forbidden');
      expect(find.text('Not available to you'), findsOneWidget);
      expect(find.text('Call records'), findsNothing);
    });

    testWidgets('the platform operator acting as a tenant does', (
      tester,
    ) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('Northwind Telecom'));
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      expect(navItem('Call records'), findsOneWidget);
      await tester.ensureVisible(navItem('Call records'));
      await tester.tap(navItem('Call records'));
      await tester.pumpAndSettle();
      expect(tableRows(tester), hasLength(50));
    });
  });
}
