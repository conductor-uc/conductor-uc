import 'package:flutter/material.dart';

import 'pbx_api.dart' show Json;
import '../../core/format.dart';
import '../../l10n/l10n.dart';

/// Weekday order as a schedule shows it. The service numbers days 0 (Sunday)
/// to 6 (Saturday); people read a week from Monday.
const _weekOrder = [1, 2, 3, 4, 5, 6, 0];

final _timePattern = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');
final _datePattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

bool isValidTime(String v) => _timePattern.hasMatch(v);

bool isValidDate(String v) {
  if (!_datePattern.hasMatch(v)) return false;
  final parsed = DateTime.tryParse('${v}T00:00:00Z');
  return parsed != null && parsed.toIso8601String().startsWith(v);
}

/// Days as `Mon–Fri` or `Mon, Wed, Sat`: runs of three or more collapse.
String describeDays(Iterable<int> days) {
  final set = days.toSet();
  final ordered = [
    for (final d in _weekOrder)
      if (set.contains(d)) d,
  ];
  final parts = <String>[];
  var i = 0;
  while (i < ordered.length) {
    var j = i;
    while (j + 1 < ordered.length &&
        _weekOrder.indexOf(ordered[j + 1]) ==
            _weekOrder.indexOf(ordered[j]) + 1) {
      j++;
    }
    parts.add(
      j - i >= 2
          ? '${weekdayShort(ordered[i])}–${weekdayShort(ordered[j])}'
          : [for (var k = i; k <= j; k++) weekdayShort(ordered[k])].join(', '),
    );
    i = j + 1;
  }
  return parts.join(', ');
}

/// One line for the table: `Mon–Fri 09:00–17:00 · Sat 10:00–14:00`.
String summarizeRules(Object? rules) {
  final list = [...?(rules as List?)];
  if (list.isEmpty) return currentL10n.schedNeverOpen;
  return list
      .map((r) {
        final m = r as Map;
        final days = [...(m['days'] as List)].cast<int>();
        return '${describeDays(days)} ${m['start']}–${m['end']}';
      })
      .join(' · ');
}

String summarizeHolidays(Object? holidays) {
  final n = ((holidays as List?) ?? const []).length;
  return currentL10n.schedHolidayCount(n);
}

/// What is wrong with the weekly windows, or null. Mirrors the service.
String? rulesError(List<Json> rules) {
  final l = currentL10n;
  for (final (i, r) in rules.indexed) {
    if (((r['days'] as List?) ?? const []).isEmpty) {
      return l.schedNeedsDay(i + 1);
    }
    final start = '${r['start'] ?? ''}';
    final end = '${r['end'] ?? ''}';
    if (!isValidTime(start) || !isValidTime(end)) {
      return l.schedTimeFormat(i + 1);
    }
    if (end.compareTo(start) <= 0) {
      return l.schedCloseAfterOpen(i + 1);
    }
  }
  return null;
}

/// What is wrong with the holiday dates, or null. Mirrors the service.
String? holidaysError(List<Json> holidays) {
  final seen = <String>{};
  for (final h in holidays) {
    final date = '${h['date'] ?? ''}';
    if (!isValidDate(date)) return currentL10n.schedNotADate(date);
    if (!seen.add(date)) return currentL10n.schedDateTwice(date);
  }
  return null;
}

class _RuleRow {
  _RuleRow(this.id, Json rule)
    : days = {...((rule['days'] as List?) ?? const []).cast<int>()},
      start = TextEditingController(text: '${rule['start'] ?? ''}'),
      end = TextEditingController(text: '${rule['end'] ?? ''}');

  final int id;
  final Set<int> days;
  final TextEditingController start;
  final TextEditingController end;

  Json toJson() => {
    'days': [
      for (final d in _weekOrder)
        if (days.contains(d)) d,
    ]..sort(),
    'start': start.text.trim(),
    'end': end.text.trim(),
  };

  void dispose() {
    start.dispose();
    end.dispose();
  }
}

/// Edits a list of weekly windows: which days, and from when to when.
class WeeklyHoursEditor extends StatefulWidget {
  const WeeklyHoursEditor({
    super.key,
    required this.initial,
    required this.onChanged,
    this.errorText,
  });

  final List<Json> initial;
  final void Function(List<Json> rules) onChanged;
  final String? errorText;

  @override
  State<WeeklyHoursEditor> createState() => _WeeklyHoursEditorState();
}

class _WeeklyHoursEditorState extends State<WeeklyHoursEditor> {
  final _rows = <_RuleRow>[];
  var _nextId = 0;

  @override
  void initState() {
    super.initState();
    for (final r in widget.initial) {
      _rows.add(_RuleRow(_nextId++, r));
    }
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  void _changed() => widget.onChanged([for (final r in _rows) r.toJson()]);

  void _add() {
    setState(() {
      _rows.add(
        _RuleRow(_nextId++, {
          'days': [1, 2, 3, 4, 5],
          'start': '09:00',
          'end': '17:00',
        }),
      );
    });
    _changed();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l = context.l10n;
    return InputDecorator(
      decoration: InputDecoration(
        labelText: l.schRules,
        helperText: l.schedHoursHelp,
        helperMaxLines: 2,
        errorText: widget.errorText,
        border: const OutlineInputBorder(),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_rows.isEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(l.schedNeverOpenAdd),
            ),
          for (final (i, row) in _rows.indexed)
            Padding(
              key: ValueKey('hours-row-${row.id}'),
              padding: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 4,
                    children: [
                      for (final d in _weekOrder)
                        FilterChip(
                          key: ValueKey('day-$i-$d'),
                          label: Text(weekdayShort(d)),
                          selected: row.days.contains(d),
                          visualDensity: VisualDensity.compact,
                          onSelected: (on) {
                            setState(() {
                              on ? row.days.add(d) : row.days.remove(d);
                            });
                            _changed();
                          },
                        ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      SizedBox(
                        width: 100,
                        child: TextField(
                          key: ValueKey('hours-$i-start'),
                          controller: row.start,
                          decoration: InputDecoration(
                            labelText: l.mainNumberOpens,
                            hintText: '09:00',
                            isDense: true,
                          ),
                          onChanged: (_) => _changed(),
                        ),
                      ),
                      const SizedBox(width: 12),
                      SizedBox(
                        width: 100,
                        child: TextField(
                          key: ValueKey('hours-$i-end'),
                          controller: row.end,
                          decoration: InputDecoration(
                            labelText: l.mainNumberCloses,
                            hintText: '17:00',
                            isDense: true,
                          ),
                          onChanged: (_) => _changed(),
                        ),
                      ),
                      IconButton(
                        tooltip: l.schedRemoveHours,
                        icon: const Icon(Icons.close),
                        onPressed: () {
                          setState(() => _rows.removeAt(i).dispose());
                          _changed();
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ),
          TextButton.icon(
            onPressed: _add,
            icon: const Icon(Icons.add),
            label: Text(l.schedAddHours),
            style: TextButton.styleFrom(
              foregroundColor: theme.colorScheme.primary,
            ),
          ),
        ],
      ),
    );
  }
}

class _HolidayRow {
  _HolidayRow(this.id, Json holiday)
    : date = TextEditingController(text: '${holiday['date'] ?? ''}'),
      label = TextEditingController(text: '${holiday['label'] ?? ''}');

  final int id;
  final TextEditingController date;
  final TextEditingController label;

  Json toJson() {
    final l = label.text.trim();
    return {'date': date.text.trim(), if (l.isNotEmpty) 'label': l};
  }

  void dispose() {
    date.dispose();
    label.dispose();
  }
}

/// Edits a list of dates the schedule is closed, each with an optional name.
class DateListEditor extends StatefulWidget {
  const DateListEditor({
    super.key,
    required this.initial,
    required this.onChanged,
    this.errorText,
  });

  final List<Json> initial;
  final void Function(List<Json> holidays) onChanged;
  final String? errorText;

  @override
  State<DateListEditor> createState() => _DateListEditorState();
}

class _DateListEditorState extends State<DateListEditor> {
  final _rows = <_HolidayRow>[];
  var _nextId = 0;

  @override
  void initState() {
    super.initState();
    for (final h in widget.initial) {
      _rows.add(_HolidayRow(_nextId++, h));
    }
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }

  void _changed() => widget.onChanged([for (final r in _rows) r.toJson()]);

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return InputDecorator(
      decoration: InputDecoration(
        labelText: l.schedHolidays,
        helperText: l.schedHolidaysHelp,
        helperMaxLines: 2,
        errorText: widget.errorText,
        border: const OutlineInputBorder(),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (i, row) in _rows.indexed)
            Padding(
              key: ValueKey('holiday-row-${row.id}'),
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 130,
                    child: TextField(
                      key: ValueKey('holiday-$i-date'),
                      controller: row.date,
                      decoration: InputDecoration(
                        labelText: l.schedDate,
                        hintText: '2026-12-25',
                        isDense: true,
                      ),
                      onChanged: (_) => _changed(),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      key: ValueKey('holiday-$i-label'),
                      controller: row.label,
                      decoration: InputDecoration(
                        labelText: l.schedNameOptional,
                        isDense: true,
                      ),
                      onChanged: (_) => _changed(),
                    ),
                  ),
                  IconButton(
                    tooltip: l.schedRemoveHoliday,
                    icon: const Icon(Icons.close),
                    onPressed: () {
                      setState(() => _rows.removeAt(i).dispose());
                      _changed();
                    },
                  ),
                ],
              ),
            ),
          TextButton.icon(
            onPressed: () {
              setState(() => _rows.add(_HolidayRow(_nextId++, {})));
              _changed();
            },
            icon: const Icon(Icons.add),
            label: Text(l.schedAddHoliday),
          ),
        ],
      ),
    );
  }
}
