import 'package:console/core/format.dart';
import 'package:flutter_test/flutter_test.dart';

/// S9-01: every date, time, duration and number goes through core/format.dart,
/// in the viewer's locale. These pin the English output (ICU puts a narrow
/// no-break space, U+202F, before AM and PM).
void main() {
  test('dates and times read the way the locale writes them', () {
    final at = DateTime(2026, 9, 4, 7, 5, 9);
    expect(formatDate(at), 'Sep 4, 2026');
    expect(formatDateTime(at), 'Sep 4, 2026, 7:05\u202fAM');
    expect(formatDateTime(at, seconds: true), 'Sep 4, 2026, 7:05:09\u202fAM');
    expect(formatTime(DateTime(2026, 9, 4, 19, 20)), '7:20\u202fPM');
    expect(formatDateTime(null), '—');
    expect(formatDateTime('not a date'), '—');
  });

  test('a date field keeps the ISO form it is typed in', () {
    expect(isoDate(DateTime(2026, 9, 4)), '2026-09-04');
  });

  test('operators read platform clocks in UTC', () {
    expect(formatUtcClock(DateTime.utc(2026, 9, 4, 19, 20, 5)), '19:20:05');
  });

  test('a call length is a clock', () {
    expect(formatClock(42), '0:42');
    expect(formatClock(725), '12:05');
    expect(formatClock(3725), '1:02:05');
    expect(formatClockMs(95000), '1:35');
    expect(formatClock(null), '—');
  });

  test('a span is its two largest units', () {
    expect(formatSpan(42), '42 s');
    expect(formatSpan(600), '10 min');
    expect(formatSpan(8200), '2 h 16 min');
    expect(formatSpan(273600), '3 d 4 h');
    expect(formatSpan(86400), '1 d');
  });

  test('numbers, sizes, percentages and rates', () {
    expect(formatCount(18240), '18,240');
    expect(formatBytes(512), '512 B');
    expect(formatBytes(1536), '1.5 KB');
    expect(formatBytes(160000), '156 KB');
    expect(formatBytes(null), '—');
    expect(formatPercent(28.4), '28%');
    expect(formatPercent(4.25), '4.3%');
    expect(formatMs(12), '12 ms');
    expect(formatMs(2.5), '2.5 ms');
    expect(formatRate(3.5), '3.5/s');
  });

  test('weekday names come from the locale', () {
    expect(
      [for (var d = 0; d < 7; d++) weekdayShort(d)],
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    );
  });
}
