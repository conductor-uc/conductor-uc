import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../core/format.dart';
import '../../core/time_zone.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/editor_page.dart';
import '../../widgets/feedback.dart';
import 'main_number_graph.dart';
import 'pbx_api.dart';
import 'resource.dart';
import 'resource_form.dart' show tenantCountryProvider;

enum _Hours { always, schedule, newHours }

enum _Who { person, group, menu }

/// "Set up your main number" (S9-09): when you're open, who answers, and
/// what happens when you're closed or no one does, on one page, without the
/// call flow editor. It makes an ordinary call flow (and a schedule, when
/// the hours are typed here), publishes it, and points the number at it; the
/// flow then opens in the editor like any other.
class MainNumberPage extends ConsumerStatefulWidget {
  const MainNumberPage({super.key, this.numberId});

  /// The number to set up; null picks the first one no one answers.
  final String? numberId;

  @override
  ConsumerState<MainNumberPage> createState() => _MainNumberPageState();
}

class _MainNumberPageState extends ConsumerState<MainNumberPage> {
  final _form = GlobalKey<FormState>();
  String? _numberId;
  _Hours _hours = _Hours.newHours;
  String? _scheduleId;
  final Set<int> _days = {1, 2, 3, 4, 5};
  final _opens = TextEditingController(text: '09:00');
  final _closes = TextEditingController(text: '17:00');

  /// Where the hours are kept: the person's own time zone, unless they say.
  String _timeZone = browserTimeZone() ?? 'UTC';
  _Who _who = _Who.person;
  String? _extensionId;
  String? _groupId;
  String? _promptId;
  final Map<String, (bool, String?)> _options = {
    '1': (true, null),
    '2': (false, null),
  };
  bool _takeMessage = true;
  String? _mailboxId;
  bool _busy = false;
  String? _error;
  bool _picked = false;

  /// Whether the person chose how hours work, so a default doesn't overrule.
  bool _touchedHours = false;

  @override
  void dispose() {
    _opens.dispose();
    _closes.dispose();
    super.dispose();
  }

  List<Json> _rows(String key) =>
      ref.watch(rowsProvider(key)).asData?.value ?? const [];

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final numbers = _rows('dids');
    final schedules = _rows('schedules');
    final extensions = _rows('extensions');
    final groups = _rows('ring-groups');
    final prompts = [
      for (final m in _rows('media-assets'))
        if (m['status'] == 'ready') m,
    ];
    final mailboxes = _rows('voicemail/mailboxes');
    final country = ref.watch(tenantCountryProvider);

    if (!_picked && numbers.isNotEmpty) {
      _picked = true;
      _numberId =
          widget.numberId ??
          '${(numbers.where((d) => d['destinationId'] == null).firstOrNull ?? numbers.first)['id']}';
    }
    // Sensible defaults once each list arrives (they load at their own pace).
    if (_scheduleId == null && schedules.isNotEmpty) {
      _scheduleId = '${schedules.first['id']}';
      if (!_touchedHours) _hours = _Hours.schedule;
    }
    _mailboxId ??= mailboxes.isEmpty ? null : '${mailboxes.first['id']}';

    String extensionName(String? id) => extensionsDef.titleOf(
      extensions.firstWhere((e) => e['id'] == id, orElse: () => const {}),
    );

    DropdownButtonFormField<String> picker(
      String label,
      String? value,
      List<(String, String)> options,
      void Function(String?) onChanged, {
      Key? key,
      bool required = true,
    }) => DropdownButtonFormField<String>(
      key: key,
      initialValue: options.any((o) => o.$1 == value) ? value : null,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final (id, text) in options)
          DropdownMenuItem(value: id, child: Text(text)),
      ],
      onChanged: (v) => setState(() => onChanged(v)),
      validator: (v) => required && v == null ? l10n.fieldRequired : null,
    );

    List<(String, String)> people = [
      for (final e in extensions) ('${e['id']}', extensionsDef.titleOf(e)),
    ];
    List<(String, String)> groupOptions = [
      for (final g in groups) ('${g['id']}', '${g['label']}'),
    ];

    Widget whoFor(String digit) {
      final (isPerson, id) = _options[digit]!;
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 90,
            child: Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(l10n.mainNumberPress(digit)),
            ),
          ),
          Expanded(
            flex: 2,
            child: DropdownButtonFormField<bool>(
              initialValue: isPerson,
              isExpanded: true,
              decoration: InputDecoration(labelText: l10n.mainNumberRings),
              items: [
                DropdownMenuItem(value: true, child: Text(l10n.destExtension)),
                if (groups.isNotEmpty)
                  DropdownMenuItem(
                    value: false,
                    child: Text(l10n.destRingGroup),
                  ),
              ],
              onChanged: (v) =>
                  setState(() => _options[digit] = (v ?? true, null)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 3,
            child: picker(
              l10n.destWhich,
              id,
              isPerson ? people : groupOptions,
              (v) => _options[digit] = (isPerson, v),
              key: ValueKey('option-$digit-$isPerson'),
              // An option left empty just isn't offered.
              required: false,
            ),
          ),
        ],
      );
    }

    return Form(
      key: _form,
      child: EditorPage(
        title: l10n.mainNumberTitle,
        subtitle: l10n.mainNumberSubtitle,
        busy: _busy,
        error: _error,
        saveLabel: l10n.mainNumberFinish,
        onCancel: () => context.go('/phone-numbers'),
        onSave: numbers.isEmpty ? null : _finish,
        sections: [
          EditorSection(
            title: l10n.mainNumberWhich,
            children: [
              if (numbers.isEmpty)
                Text(l10n.mainNumberNoNumbers)
              else
                picker(l10n.didNumber, _numberId, [
                  for (final d in numbers)
                    (
                      '${d['id']}',
                      formatPhone('${d['e164']}', country: country),
                    ),
                ], (v) => _numberId = v),
            ],
          ),
          EditorSection(
            title: l10n.mainNumberHoursTitle,
            children: [
              RadioGroup<_Hours>(
                groupValue: _hours,
                onChanged: (v) => setState(() {
                  _hours = v ?? _hours;
                  _touchedHours = true;
                }),
                child: Column(
                  children: [
                    if (schedules.isNotEmpty)
                      RadioListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _Hours.schedule,
                        title: Text(l10n.mainNumberUseSchedule),
                      ),
                    RadioListTile(
                      key: const ValueKey('hours-new'),
                      contentPadding: EdgeInsets.zero,
                      value: _Hours.newHours,
                      title: Text(l10n.mainNumberSetHours),
                    ),
                    RadioListTile(
                      key: const ValueKey('hours-always'),
                      contentPadding: EdgeInsets.zero,
                      value: _Hours.always,
                      title: Text(l10n.mainNumberAlwaysOpen),
                    ),
                  ],
                ),
              ),
              if (_hours == _Hours.schedule)
                picker(
                  l10n.schSingular,
                  _scheduleId,
                  [for (final s in schedules) ('${s['id']}', '${s['label']}')],
                  (v) => _scheduleId = v,
                  key: ValueKey('schedule-$_scheduleId'),
                ),
              if (_hours == _Hours.newHours) ...[
                Wrap(
                  spacing: 8,
                  children: [
                    for (final d in [1, 2, 3, 4, 5, 6, 0])
                      FilterChip(
                        label: Text(weekdayShort(d)),
                        selected: _days.contains(d),
                        onSelected: (on) =>
                            setState(() => on ? _days.add(d) : _days.remove(d)),
                      ),
                  ],
                ),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _opens,
                        decoration: InputDecoration(
                          labelText: l10n.mainNumberOpens,
                          hintText: '09:00',
                        ),
                        validator: _time,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _closes,
                        decoration: InputDecoration(
                          labelText: l10n.mainNumberCloses,
                          hintText: '17:00',
                        ),
                        validator: _time,
                      ),
                    ),
                  ],
                ),
                DropdownButtonFormField<String>(
                  initialValue: _timeZone,
                  isExpanded: true,
                  decoration: InputDecoration(labelText: l10n.schTimezone),
                  items: [
                    for (final z in {_timeZone, ...commonTimezones})
                      DropdownMenuItem(value: z, child: Text(z)),
                  ],
                  onChanged: (v) => setState(() => _timeZone = v ?? _timeZone),
                ),
              ],
            ],
          ),
          EditorSection(
            title: _hours == _Hours.always
                ? l10n.mainNumberWhoAlways
                : l10n.mainNumberWhoOpen,
            children: [
              RadioGroup<_Who>(
                groupValue: _who,
                onChanged: (v) => setState(() => _who = v ?? _who),
                child: Column(
                  children: [
                    RadioListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _Who.person,
                      title: Text(l10n.destExtension),
                      subtitle: Text(l10n.destExtensionHelp),
                    ),
                    if (groups.isNotEmpty)
                      RadioListTile(
                        contentPadding: EdgeInsets.zero,
                        value: _Who.group,
                        title: Text(l10n.destRingGroup),
                        subtitle: Text(l10n.destRingGroupHelp),
                      ),
                    RadioListTile(
                      key: const ValueKey('who-menu'),
                      contentPadding: EdgeInsets.zero,
                      value: _Who.menu,
                      title: Text(l10n.mainNumberMenu),
                      subtitle: Text(l10n.mainNumberMenuHelp),
                    ),
                  ],
                ),
              ),
              if (_who == _Who.person)
                picker(
                  l10n.destWhich,
                  _extensionId,
                  people,
                  (v) => _extensionId = v,
                  key: const ValueKey('who-person'),
                ),
              if (_who == _Who.group)
                picker(
                  l10n.destWhich,
                  _groupId,
                  groupOptions,
                  (v) => _groupId = v,
                ),
              if (_who == _Who.menu) ...[
                if (prompts.isEmpty)
                  Row(
                    children: [
                      Expanded(child: Text(l10n.mainNumberNeedsGreeting)),
                      TextButton(
                        onPressed: () => context.go('/media'),
                        child: Text(l10n.navMedia),
                      ),
                    ],
                  )
                else
                  picker(
                    l10n.mainNumberGreeting,
                    _promptId,
                    [for (final m in prompts) ('${m['id']}', '${m['label']}')],
                    (v) => _promptId = v,
                    key: const ValueKey('menu-greeting'),
                  ),
                for (final digit in _options.keys) whoFor(digit),
                if (_options.length < 9)
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: TextButton.icon(
                      onPressed: () => setState(
                        () => _options['${_options.length + 1}'] = (true, null),
                      ),
                      icon: const Icon(Icons.add),
                      label: Text(l10n.mainNumberAddOption),
                    ),
                  ),
              ],
            ],
          ),
          EditorSection(
            title: _hours == _Hours.always
                ? l10n.mainNumberUnansweredTitle
                : l10n.mainNumberClosedTitle,
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.mainNumberTakeMessage),
                subtitle: Text(l10n.mainNumberTakeMessageHelp),
                value: _takeMessage && mailboxes.isNotEmpty,
                onChanged: mailboxes.isEmpty
                    ? null
                    : (v) => setState(() => _takeMessage = v),
              ),
              if (_takeMessage && mailboxes.isNotEmpty)
                picker(
                  l10n.mainNumberWhoseVoicemail,
                  _mailboxId,
                  [
                    for (final m in mailboxes)
                      ('${m['id']}', extensionName('${m['extensionId']}')),
                  ],
                  (v) => _mailboxId = v,
                  key: ValueKey('mailbox-$_mailboxId'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  String? _time(String? v) =>
      RegExp(r'^([01]\d|2[0-3]):[0-5]\d$').hasMatch((v ?? '').trim())
      ? null
      : context.l10n.mainNumberTimeFormat;

  Future<void> _finish() async {
    final l10n = context.l10n;
    if (!_form.currentState!.validate()) return;
    if (_hours == _Hours.newHours && _days.isEmpty) {
      setState(() => _error = l10n.mainNumberNeedsDays);
      return;
    }
    if (_who == _Who.menu && _promptId == null) {
      setState(() => _error = l10n.mainNumberNeedsGreeting);
      return;
    }
    if (_who == _Who.menu && _options.values.every((o) => o.$2 == null)) {
      setState(() => _error = l10n.mainNumberNeedsOption);
      return;
    }
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    final numbers = _rows('dids');
    final number = numbers.firstWhere((d) => '${d['id']}' == _numberId);
    final shown = formatPhone(
      '${number['e164']}',
      country: ref.read(tenantCountryProvider),
    );
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      String? scheduleId = switch (_hours) {
        _Hours.always => null,
        _Hours.schedule => _scheduleId,
        _Hours.newHours =>
          '${(await api.create('schedules', {
            'label': l10n.mainNumberScheduleName(shown),
            'timezone': _timeZone,
            'rules': [
              {'days': _days.toList()..sort(), 'start': _opens.text.trim(), 'end': _closes.text.trim()},
            ],
            'holidays': const <Object>[],
          }))['id']}',
      };
      final answer = switch (_who) {
        _Who.person => PersonAnswer(_extensionId!),
        _Who.group => GroupAnswer(_groupId!),
        _Who.menu => MenuAnswer(_promptId!, {
          for (final MapEntry(key: digit, value: (isPerson, id))
              in _options.entries)
            if (id != null)
              digit: isPerson ? PersonAnswer(id) : GroupAnswer(id),
        }),
      };
      final graph = mainNumberGraph(
        MainNumberPlan(
          answer: answer,
          scheduleId: scheduleId,
          mailboxId: _takeMessage ? _mailboxId : null,
        ),
      );
      final flow = await api.create('flows', {
        'name': l10n.mainNumberFlowName(shown),
      });
      final flowId = '${flow['id']}';
      await api.saveFlowDraft(flowId, graph);
      final canPublish = ref.read(canProvider('callflow.publish'));
      if (canPublish) await api.publishFlow(flowId);
      await api.update('dids', '${number['id']}', {
        'destinationType': 'flow',
        'destinationId': flowId,
      });
      ref.invalidate(rowsProvider('dids'));
      ref.invalidate(rowsProvider('flows'));
      ref.invalidate(rowsProvider('schedules'));
      if (!mounted) return;
      showToastOnNextPage(
        canPublish
            ? l10n.mainNumberDone(shown)
            : l10n.mainNumberDraftOnly(shown),
      );
      context.go('/call-flows/$flowId');
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemMessage(e);
        });
      }
    }
  }
}
