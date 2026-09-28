import 'dart:convert';

import 'package:console/dev/demo_backend.dart';
import 'package:console/features/cdr/call_records_page.dart'
    show urlOpenerProvider;
import 'package:console/features/export/export_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// Signs in as [email] and opens Export data, remembering what was saved or
/// opened.
Future<({List<(String, String)> saved, List<String> opened})> openExport(
  WidgetTester tester,
  String email,
) async {
  final saved = <(String, String)>[];
  final opened = <String>[];
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        fileSaverProvider.overrideWithValue(
          (name, _, bytes) => saved.add((name, utf8.decode(bytes))),
        ),
        urlOpenerProvider.overrideWithValue((url) async => opened.add(url)),
      ],
    ),
  );
  tester.view.physicalSize = const Size(1400, 1000);
  await submitSignIn(tester, email);
  await tapNav(tester, 'Export data');
  await tester.pumpAndSettle();
  expect(find.byType(ExportPage), findsOneWidget);
  return (saved: saved, opened: opened);
}

/// Lets the page ask again (every 3 s) until the demo says it is ready.
Future<void> waitForReady(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  }
}

void main() {
  testWidgets(
    "S1-16: a tenant's administrator downloads its settings, calls and files",
    (tester) async {
      final seen = await openExport(tester, 'tenant@example.test');

      await tester.tap(find.byKey(const ValueKey('export-settings-download')));
      await tester.pumpAndSettle();
      expect(seen.saved.single.$1, 'settings.json');
      final settings = jsonDecode(seen.saved.single.$2) as Map;
      expect((settings['settings'] as Map).keys, contains('extensions'));
      expect(find.text('Settings downloaded.'), findsOneWidget);

      for (final (name, suffix) in [('calls', '.csv'), ('files', '.zip')]) {
        final prepare = find.byKey(ValueKey('export-$name-prepare'));
        await tester.ensureVisible(prepare);
        await tester.tap(prepare);
        // Right after asking (settling would run the 3 s check until it is done).
        await tester.pump(const Duration(milliseconds: 500));
        expect(
          find.text('Preparing… You can leave this page and come back.'),
          findsOneWidget,
        );
        await waitForReady(tester);
        final download = find.byKey(ValueKey('export-$name-download'));
        await tester.ensureVisible(download);
        await tester.tap(download);
        await tester.pumpAndSettle();
        expect(seen.opened.last, endsWith(suffix));
      }
      expect(find.text('Prepare again'), findsNWidgets(2));
    },
  );

  testWidgets(
    'without access to calls and files, only the settings are offered',
    (tester) async {
      await openExport(tester, 'supervisor@example.test');
      expect(
        find.byKey(const ValueKey('export-settings-download')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('export-calls')), findsNothing);
      expect(find.byKey(const ValueKey('export-files')), findsNothing);
    },
  );
}
