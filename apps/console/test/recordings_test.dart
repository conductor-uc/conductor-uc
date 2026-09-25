import 'package:console/app/router.dart';
import 'package:console/core/session.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/features/cdr/call_records_page.dart' show formatWhen;
import 'package:console/features/recordings/recordings_api.dart';
import 'package:console/features/recordings/recordings_page.dart';
import 'package:console/features/shell/sections.dart';
import 'package:console/features/voicemail/voicemail_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show actAs, navItem, signInAs;
import 'support.dart';

/// Signs in as [email] and opens Recordings. Addresses a person plays or
/// downloads from are collected in the returned list instead of opening a tab.
Future<List<String>> openRecordings(
  WidgetTester tester, {
  String email = 'tenant@example.test',
}) async {
  final opened = <String>[];
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        openRecordingProvider.overrideWithValue((url) async => opened.add(url)),
      ],
    ),
  );
  await submitSignIn(tester, email);
  await tester.tap(navItem('Recordings'));
  await tester.pumpAndSettle();
  // The test font is wide; give the table room so every action is on screen.
  tester.view.physicalSize = const Size(2600, 1200);
  await tester.pumpAndSettle();
  return opened;
}

Future<void> openRules(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(Tab, 'Rules'));
  await tester.pumpAndSettle();
}

Finder inDialog(Finder finder) =>
    find.descendant(of: find.byType(AlertDialog), matching: finder);

/// Opens a dropdown in the dialog by its label and picks [option].
Future<void> pickIn(WidgetTester tester, String label, String option) async {
  await tester.tap(
    inDialog(find.widgetWithText(DropdownButtonFormField<String>, label)),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

/// Rows on screen: a tenant administrator has a Delete button on each.
int get _rows => find.byTooltip('Delete').evaluate().length;

String _when(DateTime utc) => formatWhen(utc.toIso8601String());

void main() {
  group('formatting', () {
    test('a size is bytes, kilobytes or megabytes', () {
      expect(formatBytes(null), '—');
      expect(formatBytes(512), '512 B');
      expect(formatBytes(160000), '156 KB');
      expect(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
    });

    test('the filter sends whole days and the number of rows as text', () {
      final query = RecordingFilter(
        from: DateTime(2026, 9, 24),
        to: DateTime(2026, 9, 24),
        direction: 'inbound',
        queueId: 'q-1',
      ).toQuery(cursor: 'c', limit: 25);
      expect(query['direction'], 'inbound');
      expect(query['queueId'], 'q-1');
      expect(query['limit'], '25');
      expect(query['cursor'], 'c');
      // `to` is the start of the next day, which the service treats as exclusive.
      expect(
        DateTime.parse('${query['to']}')
            .difference(DateTime.parse('${query['from']}')),
        const Duration(days: 1),
      );
      expect(const RecordingFilter().toQuery(), isEmpty);
    });

    test(
      'a rule round-trips its fields, and drops the asset when not announcing',
      () {
        final form = PolicyForm.fromPolicy({
          'scopeType': 'queue',
          'scopeId': 'q-1',
          'direction': 'inbound',
          'action': 'record',
          'announce': true,
          'consentAssetId': 'media-1',
        });
        expect(form.toJson(), {
          'scopeType': 'queue',
          'scopeId': 'q-1',
          'direction': 'inbound',
          'action': 'record',
          'announce': true,
          'consentAssetId': 'media-1',
        });
        expect(
          PolicyForm(
            announce: false,
            consentAssetId: 'x',
          ).toJson()['consentAssetId'],
          isNull,
        );
        expect(const PolicyForm().toJson().containsKey('scopeId'), isFalse);
      },
    );
  });

  test(
    'Recordings is private data and needs a recording permission (rule H1)',
    () {
      final section = sectionsByOrgType[OrgType.tenant]!.firstWhere(
        (s) => s.path == '/recordings',
      );
      expect(section.privateData, isTrue);
      expect(
        section.requires,
        containsAll([
          'recording.listen',
          'recording.download',
          'recording.delete',
          'recording.policy.manage',
        ]),
      );
    },
  );

  group('who sees it', () {
    testWidgets('a tenant administrator does', (tester) async {
      await signInAs(tester, 'tenant@example.test');
      expect(navItem('Recordings'), findsOneWidget);
    });

    testWidgets('someone with no recording permission does not', (
      tester,
    ) async {
      await signInAs(tester, 'limited@example.test');
      expect(navItem('Recordings'), findsNothing);
      await tester.pumpAndSettle();
    });

    testWidgets('a reseller acting as a tenant does not, even by address', (
      tester,
    ) async {
      await signInAs(tester, 'reseller@example.test');
      await actAs(tester, 'Acme Dental');
      expect(navItem('Extensions'), findsOneWidget);
      expect(navItem('Recordings'), findsNothing);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(NavigationRail)),
      );
      container.read(routerProvider).go('/recordings');
      await tester.pumpAndSettle();
      expect(container.read(routerProvider).state.uri.path, '/forbidden');
      expect(find.text('Not available to you'), findsOneWidget);
    });

    testWidgets('the platform operator acting as a tenant does', (
      tester,
    ) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('Northwind Telecom'));
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      expect(navItem('Recordings'), findsOneWidget);
    });
  });

  group('recordings', () {
    testWidgets(
      'lists the newest first, with who was on the call, length, size and status',
      (tester) async {
        await openRecordings(tester);

        expect(_rows, recordingsPageSize);
        // rec-1, an incoming call to Alice on the Support queue, is first.
        expect(find.text(_when(DateTime.utc(2026, 9, 24, 18))), findsOneWidget);
        expect(find.text('101 · Alice Kim, Support'), findsWidgets);
        expect(find.text('0:20'), findsOneWidget);
        expect(find.text('156 KB'), findsOneWidget);
        expect(find.text('Incoming'), findsWidgets);
        expect(find.text('Outgoing'), findsWidgets);
        expect(find.text('Between extensions'), findsWidgets);
        // Two hours earlier is the next one.
        expect(find.text(_when(DateTime.utc(2026, 9, 24, 16))), findsOneWidget);
        // An internal call names both people.
        expect(find.text('103 · Carol Diaz, 101 · Alice Kim'), findsWidgets);
        // Kept until 90 days after it started.
        expect(find.text('2026-12-23'), findsWidgets);
      },
    );

    testWidgets(
      'a recording still uploading, or that failed, cannot be played',
      (tester) async {
        await openRecordings(tester);
        expect(find.text('Uploading'), findsOneWidget);
        expect(find.text('Failed'), findsOneWidget);
        // 25 rows, of which two have no audio.
        expect(_rows, 25);
        expect(find.byTooltip('Play'), findsNWidgets(23));
        expect(find.byTooltip('Download'), findsNWidgets(23));
      },
    );

    testWidgets('Load more adds the next page', (tester) async {
      await openRecordings(tester);
      expect(_rows, 25);
      await tester.ensureVisible(find.text('Load more'));
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      expect(_rows, 30);
      expect(find.text('Load more'), findsNothing);
    });

    testWidgets(
      'narrowing to outgoing calls asks the service, and Clear brings them all back',
      (tester) async {
        await openRecordings(tester);
        await tester.tap(find.byKey(const ValueKey('rec-direction')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Outgoing').last);
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Search'));
        await tester.pumpAndSettle();
        // Every third of the 30 is outgoing.
        expect(_rows, 10);
        expect(find.text('Incoming'), findsNothing);

        await tester.tap(find.widgetWithText(TextButton, 'Clear'));
        await tester.pumpAndSettle();
        expect(_rows, 25);
      },
    );

    testWidgets('narrowing to an extension or a queue', (tester) async {
      await openRecordings(tester);
      await tester.tap(find.byKey(const ValueKey('rec-queue')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Support').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Search'));
      await tester.pumpAndSettle();
      // Even-numbered incoming calls: 0, 6, 12, 18, 24.
      expect(_rows, 5);

      await tester.tap(find.widgetWithText(TextButton, 'Clear'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('rec-extension')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('103 · Carol Diaz').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Search'));
      await tester.pumpAndSettle();
      expect(_rows, lessThan(25));
      expect(_rows, greaterThan(0));
    });

    testWidgets(
      'a date filter with nothing in it says so, and a bad date is refused',
      (tester) async {
        await openRecordings(tester);
        await tester.enterText(
          find.byKey(const ValueKey('rec-from')),
          'yesterday',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Search'));
        await tester.pumpAndSettle();
        expect(
          find.text('From must be a date such as 2026-09-24.'),
          findsOneWidget,
        );
        expect(_rows, 25);

        await tester.enterText(
          find.byKey(const ValueKey('rec-from')),
          '2027-01-01',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Search'));
        await tester.pumpAndSettle();
        expect(find.text('No recordings match.'), findsOneWidget);
      },
    );

    testWidgets('Play and Download open the short-lived addresses', (
      tester,
    ) async {
      final opened = await openRecordings(tester);

      await tester.tap(find.byTooltip('Play').first);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Download').first);
      await tester.pumpAndSettle();

      expect(opened, [
        'https://storage.demo.invalid/recordings/rec-1.wav?X-Amz-Expires=300',
        'https://storage.demo.invalid/recordings/rec-1.wav?download=1',
      ]);
    });

    testWidgets('Delete asks first, and then removes the recording', (
      tester,
    ) async {
      await openRecordings(tester);
      final first = find.text(_when(DateTime.utc(2026, 9, 24, 18)));
      expect(first, findsOneWidget);

      await tester.tap(find.byTooltip('Delete').first);
      await tester.pumpAndSettle();
      expect(find.text('Delete recording?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(first, findsOneWidget);

      await tester.tap(find.byTooltip('Delete').first);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(first, findsNothing);
      // The list reloads: the next one is now first, and a page is full again.
      expect(find.text(_when(DateTime.utc(2026, 9, 24, 16))), findsOneWidget);
      expect(_rows, 25);
    });

    testWidgets(
      'someone who may only listen sees Play, and no Download, Delete or Rules',
      (tester) async {
        await openRecordings(tester, email: 'listener@example.test');
        expect(find.byTooltip('Play'), findsWidgets);
        expect(find.byTooltip('Download'), findsNothing);
        expect(find.byTooltip('Delete'), findsNothing);
        expect(find.widgetWithText(Tab, 'Rules'), findsNothing);
        expect(find.byTooltip('Play'), findsNWidgets(23));
      },
    );
  });

  group('rules', () {
    testWidgets('lists what applies to whom, and how it is announced', (
      tester,
    ) async {
      await openRecordings(tester);
      await openRules(tester);

      expect(find.byTooltip('Edit rule'), findsNWidgets(2));
      expect(find.text('Whole organization'), findsOneWidget);
      expect(find.text('Extension 103 · Carol Diaz'), findsOneWidget);
      expect(find.text('Every call'), findsNWidgets(2));
      // Record with a spoken announcement, and do not record with none.
      expect(find.text('Record'), findsOneWidget);
      expect(find.text('Recording'), findsOneWidget);
      expect(find.text('Do not record'), findsOneWidget);
      expect(find.text('None'), findsOneWidget);
    });

    testWidgets('adds a rule for a queue', (tester) async {
      await openRecordings(tester);
      await openRules(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Add rule'));
      await tester.pumpAndSettle();
      expect(find.text('Add rule'), findsWidgets);

      await pickIn(tester, 'Applies to', 'Queue');
      await tester.tap(inDialog(find.widgetWithText(FilledButton, 'Save')));
      await tester.pumpAndSettle();
      expect(find.text('Choose which queue it covers.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('policy-target-queue')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Support').last);
      await tester.pumpAndSettle();
      await pickIn(tester, 'Calls', 'Incoming calls');
      await tester.tap(inDialog(find.widgetWithText(FilledButton, 'Save')));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Queue Support'), findsOneWidget);
      expect(find.text('Incoming calls'), findsOneWidget);
    });

    testWidgets(
      'a second rule for the same scope and calls is refused with the service’s reason',
      (tester) async {
        await openRecordings(tester);
        await openRules(tester);
        await tester.tap(find.widgetWithText(FilledButton, 'Add rule'));
        await tester.pumpAndSettle();
        // Whole organization, every call: the demo already has that.
        await tester.tap(inDialog(find.widgetWithText(FilledButton, 'Save')));
        await tester.pumpAndSettle();

        expect(
          find.text(
            'A policy for that scope and direction already exists; change it instead.',
          ),
          findsOneWidget,
        );
        expect(find.byType(AlertDialog), findsOneWidget);
      },
    );

    testWidgets(
      'an announcement needs a rule that records, and offers only prompts',
      (tester) async {
        await openRecordings(tester);
        await openRules(tester);
        await tester.tap(find.widgetWithText(FilledButton, 'Add rule'));
        await tester.pumpAndSettle();

        final announceFinder = inDialog(
          find.widgetWithText(SwitchListTile, 'Play an announcement first'),
        );
        SwitchListTile announce() =>
            tester.widget<SwitchListTile>(announceFinder);
        expect(announce().value, isFalse);
        await tester.tap(announceFinder);
        await tester.pumpAndSettle();
        expect(announce().value, isTrue);

        // Only ready prompts are choices: the hold music is not.
        await tester.tap(
          inDialog(
            find.widgetWithText(
              DropdownButtonFormField<String?>,
              'Announcement recording',
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Welcome greeting'), findsWidgets);
        expect(find.text('Hold music'), findsNothing);
        expect(find.text('Short tone'), findsWidgets);
        await tester.tap(find.text('Welcome greeting').last);
        await tester.pumpAndSettle();

        // Switching to "do not record" switches the announcement off and locks it.
        await pickIn(tester, 'Action', 'Do not record');
        expect(announce().value, isFalse);
        expect(announce().onChanged, isNull);
        expect(find.text('Announcement recording'), findsNothing);
      },
    );

    testWidgets('edits a rule', (tester) async {
      await openRecordings(tester);
      await openRules(tester);
      // The second rule: nobody records Carol's calls.
      await tester.tap(find.byTooltip('Edit rule').at(1));
      await tester.pumpAndSettle();
      expect(find.text('Edit rule'), findsOneWidget);
      // Prefilled from the saved rule.
      expect(inDialog(find.text('Do not record')), findsWidgets);
      await pickIn(tester, 'Action', 'Record');
      await tester.tap(inDialog(find.widgetWithText(FilledButton, 'Save')));
      await tester.pumpAndSettle();

      expect(find.text('Record'), findsNWidgets(2));
      expect(find.text('Do not record'), findsNothing);
    });

    testWidgets('deletes a rule after asking', (tester) async {
      await openRecordings(tester);
      await openRules(tester);
      // The second rule is Carol's.
      final tap = find.byTooltip('Delete rule').at(1);
      await tester.tap(tap);
      await tester.pumpAndSettle();
      expect(find.text('Delete rule?'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(find.text('Extension 103 · Carol Diaz'), findsOneWidget);

      await tester.tap(tap);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();
      expect(find.text('Extension 103 · Carol Diaz'), findsNothing);
      expect(find.text('Whole organization'), findsOneWidget);
    });

    testWidgets('shows how long recordings are kept, and changes it', (
      tester,
    ) async {
      await openRecordings(tester);
      await openRules(tester);
      TextField days() => tester.widget<TextField>(
        find.byKey(const ValueKey('retention-days')),
      );
      expect(days().controller!.text, '90');

      await tester.enterText(
        find.byKey(const ValueKey('retention-days')),
        'lots',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(
        find.text('Enter a whole number of days from 0 to 3650.'),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const ValueKey('retention-days')),
        '30',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Recordings are now kept for 30 days.'), findsOneWidget);

      await tester.enterText(find.byKey(const ValueKey('retention-days')), '0');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(
        find.text('Recordings are now kept until they are deleted.'),
        findsOneWidget,
      );
    });

    testWidgets('says nothing is recorded when there are no rules', (
      tester,
    ) async {
      await openRecordings(tester);
      await openRules(tester);
      for (var i = 0; i < 2; i++) {
        await tester.tap(find.byTooltip('Delete rule').first);
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
        await tester.pumpAndSettle();
      }
      expect(
        find.text('No rules yet, so no calls are recorded.'),
        findsOneWidget,
      );
    });
  });
}
