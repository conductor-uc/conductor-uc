import 'package:intl/intl.dart';

import '../l10n/l10n.dart';

/// Every date, time, duration and number the console shows, in the viewer's
/// locale (S9-01, D-018). Nothing else formats these by hand.

/// Shown in place of a value nobody reported.
String get noValue => currentL10n.commonNoValue;

DateTime? _instant(Object? value) => switch (value) {
  DateTime d => d.toLocal(),
  String s => DateTime.tryParse(s)?.toLocal(),
  _ => null,
};

/// "Sep 24, 2026" in the viewer's own time zone; [noValue] for nothing.
String formatDate(Object? value) {
  final d = _instant(value);
  return d == null ? noValue : DateFormat.yMMMd().format(d);
}

/// "Sep 24, 2026, 7:20 PM" in the viewer's own time zone, with seconds when
/// [seconds] is set; [noValue] for nothing.
String formatDateTime(Object? value, {bool seconds = false}) {
  final d = _instant(value);
  if (d == null) return noValue;
  final time = seconds ? DateFormat.jms() : DateFormat.jm();
  return DateFormat.yMMMd().addPattern(time.pattern, ', ').format(d);
}

/// "7:20 PM" in the viewer's own time zone.
String formatTime(DateTime at, {bool seconds = false}) =>
    (seconds ? DateFormat.jms() : DateFormat.jm()).format(at.toLocal());

/// "19:20:05 UTC"-style clock for the platform's operators, who compare
/// across nodes and logs in UTC.
String formatUtcClock(DateTime at) => DateFormat.Hms().format(at.toUtc());

/// The value of a date field: `2026-09-24`. A data format, not a display one.
String isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-'
    '${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// A call's length as a clock: "0:42", "12:05", "1:02:05".
String formatClock(num? seconds) {
  if (seconds == null) return noValue;
  final s = seconds.round().clamp(0, 1 << 31);
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final two = NumberFormat('00');
  return h > 0
      ? '$h:${two.format(m)}:${two.format(s % 60)}'
      : '$m:${two.format(s % 60)}';
}

/// "3 d 4 h": the two largest units, as an operator reads uptime.
String formatSpan(num? seconds) {
  if (seconds == null) return noValue;
  final l10n = currentL10n;
  final s = seconds.round();
  if (s < 60) return l10n.formatSeconds(s);
  final minutes = s ~/ 60;
  if (minutes < 60) return l10n.formatMinutes(minutes);
  final hours = minutes ~/ 60;
  if (hours < 24) {
    final m = minutes % 60;
    return m == 0 ? l10n.formatHours(hours) : l10n.formatHoursMinutes(hours, m);
  }
  final days = hours ~/ 24;
  final h = hours % 24;
  return h == 0 ? l10n.formatDays(days) : l10n.formatDaysHours(days, h);
}

/// "1,234".
String formatCount(num? value) => value == null
    ? noValue
    : NumberFormat.decimalPattern().format(value.round());

String _decimal(num value) =>
    (NumberFormat.decimalPattern()
          ..minimumFractionDigits = value < 10 ? 1 : 0
          ..maximumFractionDigits = value < 10 ? 1 : 0)
        .format(value);

/// 1536 → "1.5 KB": binary units, as memory is counted.
String formatBytes(num? bytes) {
  if (bytes == null) return noValue;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  final digits = unit == 0 || value >= 100 ? 0 : 1;
  final number =
      (NumberFormat.decimalPattern()
            ..minimumFractionDigits = digits
            ..maximumFractionDigits = digits)
          .format(value);
  return currentL10n.formatBytes(number, units[unit]);
}

/// 42.5 → "42.5%"; [value] is already a percentage, not a fraction.
String formatPercent(num? value) {
  if (value == null) return noValue;
  final digits = value < 10 ? 1 : 0;
  // Rounded half away from zero first, as people round (28.5 → 29%).
  final rounded = double.parse(value.toStringAsFixed(digits));
  return (NumberFormat.percentPattern()
        ..minimumFractionDigits = digits
        ..maximumFractionDigits = digits)
      .format(rounded / 100);
}

/// "12 ms".
String formatMs(num? ms) =>
    ms == null ? noValue : currentL10n.formatMilliseconds(_decimal(ms));

/// "3.5/s".
String formatRate(num? perSecond) => perSecond == null
    ? noValue
    : currentL10n.formatPerSecond(_decimal(perSecond));

/// A recording's or message's length from milliseconds, as a clock.
String formatClockMs(num? ms) => formatClock(ms == null ? null : ms / 1000);

/// A short weekday name ("Mon") for the service's day numbers, 0 = Sunday.
String weekdayShort(int day) =>
    DateFormat.E().format(DateTime(2023, 1, 1 + day)); // 2023-01-01: a Sunday
