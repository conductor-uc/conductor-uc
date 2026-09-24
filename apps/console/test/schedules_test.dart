import 'package:console/features/pbx/schedule_fields.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show field, openSection, pickFromDropdown;

Future<void> tapKey(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> typeKey(WidgetTester tester, String key, String text) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.enterText(target, text);
  await tester.pumpAndSettle();
}

Future<void> save(WidgetTester tester) async {
  final button = find.widgetWithText(FilledButton, 'Save');
  await tester.ensureVisible(button);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

/// The row actions sit at the far right of a wide table.
Future<void> tapTooltip(WidgetTester tester, String tooltip) async {
  final target = find.byTooltip(tooltip);
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> openOfficeHours(WidgetTester tester) async {
  await openSection(tester, 'Schedules');
  await tapTooltip(tester, 'Edit');
}

void main() {
  testWidgets('lists schedules with their hours summarized', (tester) async {
    await openSection(tester, 'Schedules');
    expect(find.text('Office hours'), findsOneWidget);
    expect(find.text('America/Chicago'), findsOneWidget);
    expect(find.text('Mon–Fri 09:00–17:00 · Sat 10:00–14:00'), findsOneWidget);
    expect(find.text('2 holidays'), findsOneWidget);
  });

  testWidgets('a new schedule starts with weekday hours, then is saved', (
    tester,
  ) async {
    await openSection(tester, 'Schedules');
    await tester.tap(find.text('New schedule'));
    await tester.pumpAndSettle();
    // Weekdays 9 to 5 are already there to adjust.
    final start = tester.widget<TextField>(
      find.byKey(const ValueKey('hours-0-start')),
    );
    expect(start.controller!.text, '09:00');
    await tester.enterText(field('Name *'), 'Reception');
    await pickFromDropdown(tester, 'Time zone *', 'America/New_York');
    await save(tester);
    expect(find.text('Reception'), findsOneWidget);
    expect(find.text('America/New_York'), findsOneWidget);
    expect(find.text('Mon–Fri 09:00–17:00'), findsOneWidget);
    expect(find.text('None'), findsOneWidget);
  });

  testWidgets('changes the days and times of a window', (tester) async {
    await openOfficeHours(tester);
    // Add Sunday to the first window, and close an hour earlier.
    await tapKey(tester, 'day-0-0');
    await typeKey(tester, 'hours-0-end', '16:00');
    await save(tester);
    expect(
      find.text('Mon–Fri, Sun 09:00–16:00 · Sat 10:00–14:00'),
      findsOneWidget,
    );
  });

  testWidgets('adds and removes windows', (tester) async {
    await openOfficeHours(tester);
    await tester.ensureVisible(find.byTooltip('Remove these hours').last);
    await tester.tap(find.byTooltip('Remove these hours').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Add hours'));
    await tester.tap(find.text('Add hours'));
    await tester.pumpAndSettle();
    await typeKey(tester, 'hours-1-end', '12:00');
    await save(tester);
    expect(
      find.text('Mon–Fri 09:00–17:00 · Mon–Fri 09:00–12:00'),
      findsOneWidget,
    );
  });

  testWidgets('a schedule with no hours is never open', (tester) async {
    await openOfficeHours(tester);
    for (var i = 0; i < 2; i++) {
      await tester.ensureVisible(find.byTooltip('Remove these hours').last);
      await tester.tap(find.byTooltip('Remove these hours').last);
      await tester.pumpAndSettle();
    }
    expect(find.text('Never open. Add hours below.'), findsOneWidget);
    await save(tester);
    expect(find.text('Never open'), findsOneWidget);
  });

  testWidgets('holidays can be added and removed', (tester) async {
    await openOfficeHours(tester);
    await tester.ensureVisible(find.text('Add a holiday'));
    await tester.tap(find.text('Add a holiday'));
    await tester.pumpAndSettle();
    await typeKey(tester, 'holiday-2-date', '2026-07-04');
    await typeKey(tester, 'holiday-2-label', 'Independence Day');
    await save(tester);
    expect(find.text('3 holidays'), findsOneWidget);

    await tapTooltip(tester, 'Edit');
    for (var i = 0; i < 2; i++) {
      await tester.ensureVisible(find.byTooltip('Remove this holiday').first);
      await tester.tap(find.byTooltip('Remove this holiday').first);
      await tester.pumpAndSettle();
    }
    await save(tester);
    expect(find.text('1 holiday'), findsOneWidget);
  });

  testWidgets('a window that closes before it opens is refused, and not sent', (
    tester,
  ) async {
    await openOfficeHours(tester);
    await typeKey(tester, 'hours-0-end', '08:00');
    await save(tester);
    expect(
      find.text('Hours 1: closing must be after opening.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
  });

  testWidgets('a window with no days, or a bad time, is refused', (
    tester,
  ) async {
    await openOfficeHours(tester);
    for (final d in [1, 2, 3, 4, 5]) {
      await tapKey(tester, 'day-0-$d');
    }
    await save(tester);
    expect(find.text('Hours 1: choose at least one day.'), findsOneWidget);
    await tapKey(tester, 'day-0-1');
    await typeKey(tester, 'hours-0-start', '9am');
    await save(tester);
    expect(find.textContaining('times look like 09:00'), findsOneWidget);
  });

  testWidgets('a holiday that is not a date, or is listed twice, is refused', (
    tester,
  ) async {
    await openOfficeHours(tester);
    await typeKey(tester, 'holiday-0-date', '2026-02-30');
    await save(tester);
    expect(find.textContaining('is not a date'), findsOneWidget);
    await typeKey(tester, 'holiday-0-date', '2027-01-01');
    await save(tester);
    expect(find.textContaining('is listed twice'), findsOneWidget);
  });

  testWidgets('schedules can be deleted', (tester) async {
    await openSection(tester, 'Schedules');
    await tapTooltip(tester, 'Delete');
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Office hours'), findsNothing);
    expect(find.text('No schedules yet.'), findsOneWidget);
  });

  group('helpers', () {
    test('describeDays collapses runs of three or more, Monday first', () {
      expect(describeDays([1, 2, 3, 4, 5]), 'Mon–Fri');
      expect(describeDays([0, 1, 2, 3, 4, 5, 6]), 'Mon–Sun');
      expect(describeDays([6, 0]), 'Sat, Sun');
      expect(describeDays([1, 3, 5]), 'Mon, Wed, Fri');
      expect(describeDays([1, 2]), 'Mon, Tue');
      expect(describeDays([1, 2, 3, 5]), 'Mon–Wed, Fri');
      expect(describeDays([]), '');
    });

    test('summaries', () {
      expect(summarizeRules([]), 'Never open');
      expect(summarizeRules(null), 'Never open');
      expect(summarizeHolidays([]), 'None');
      expect(summarizeHolidays([1]), '1 holiday');
      expect(summarizeHolidays([1, 2, 3]), '3 holidays');
    });

    test('times and dates', () {
      for (final ok in ['00:00', '09:30', '23:59']) {
        expect(isValidTime(ok), isTrue, reason: ok);
      }
      for (final bad in ['24:00', '9:00', '09:60', '', '0900']) {
        expect(isValidTime(bad), isFalse, reason: bad);
      }
      expect(isValidDate('2028-02-29'), isTrue);
      for (final bad in ['2027-02-29', '2026-13-01', '26-01-01', '', 'x']) {
        expect(isValidDate(bad), isFalse, reason: bad);
      }
    });

    test('rulesError matches what the service refuses', () {
      Map<String, dynamic> r(List<int> days, String s, String e) => {
        'days': days,
        'start': s,
        'end': e,
      };
      expect(
        rulesError([
          r([1], '09:00', '17:00'),
        ]),
        isNull,
      );
      expect(rulesError([]), isNull);
      expect(
        rulesError([r([], '09:00', '17:00')]),
        contains('at least one day'),
      );
      expect(
        rulesError([
          r([1], '9:00', '17:00'),
        ]),
        contains('09:00'),
      );
      expect(
        rulesError([
          r([1], '09:00', '09:00'),
        ]),
        contains('after opening'),
      );
      expect(
        rulesError([
          r([1], '09:00', '17:00'),
          r([2], '17:00', '09:00'),
        ]),
        startsWith('Hours 2'),
      );
    });

    test('holidaysError', () {
      expect(
        holidaysError([
          {'date': '2026-12-25'},
        ]),
        isNull,
      );
      expect(
        holidaysError([
          {'date': ''},
        ]),
        contains('not a date'),
      );
      expect(
        holidaysError([
          {'date': '2026-12-25'},
          {'date': '2026-12-25'},
        ]),
        contains('twice'),
      );
    });
  });
}
