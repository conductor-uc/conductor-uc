import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import 'pbx_api.dart';
import 'resource.dart';
import 'schedule_fields.dart';
import 'used_by.dart';

/// Create or edit one row of [def], drawn from its fields. Pops the saved row
/// (the service's response) when a change was saved, and null on cancel.
/// Sends a create (`id` null) or an edit. The default talks to the tenant's
/// PBX routes; org screens pass their own.
typedef SaveRow = Future<Json> Function(String? id, Json body);

/// The country phone numbers are read in when typed without a country code:
/// the tenant's first emergency location's, the country its phones are in,
/// until tenants have a country setting of their own (S9-06).
final tenantCountryProvider = Provider<String>((ref) {
  if (ref.watch(tenantIdProvider) == null) return 'US';
  final rows = ref.watch(rowsProvider('emergency-locations')).asData?.value;
  final country = rows == null || rows.isEmpty ? null : rows.first['country'];
  return country is String && country.isNotEmpty ? country : 'US';
});

/// The value the "Create new…" item stands for in a picker.
const _createNew = '\u0000create';

class ResourceFormDialog extends ConsumerStatefulWidget {
  const ResourceFormDialog({super.key, required this.def, this.row, this.save});

  final ResourceDef def;

  /// The row being edited; null creates a new one.
  final Json? row;

  /// Overrides where the request goes; null uses the tenant PBX routes.
  final SaveRow? save;

  @override
  ConsumerState<ResourceFormDialog> createState() => _ResourceFormDialogState();
}

class _ResourceFormDialogState extends ConsumerState<ResourceFormDialog> {
  final _formKey = GlobalKey<FormState>();
  final _values = <String, Object?>{};
  final _controllers = <String, TextEditingController>{};
  final _filters = <String, String>{};
  String? _error;

  /// What the service said about each field on the last save (S9-02), shown
  /// under the field until it is edited.
  Map<String, String> _serverErrors = const {};
  bool _busy = false;

  /// Whether "Advanced settings" is open; it opens by itself when a field in
  /// it has a problem.
  bool _advancedOpen = false;

  bool get _editing => widget.row != null;

  /// The fields that apply to this create or edit.
  List<Field> get _fields {
    final reseller = ref.read(sessionProvider)?.orgType == OrgType.reseller;
    return [
      for (final f in widget.def.fields)
        if (f.inScope(editing: _editing) &&
            !(f.notForReseller && reseller) &&
            ref.read(canProvider(f.needs)))
          f,
    ];
  }

  String get _country => ref.read(tenantCountryProvider);

  @override
  void initState() {
    super.initState();
    for (final f in _fields) {
      final existing = widget.row?[f.key];
      final value = _editing && !f.writeOnly
          ? existing
          : (_editing ? null : f.initial);
      switch (f.kind) {
        case FieldKind.text || FieldKind.integer:
          _controllers[f.key] = TextEditingController(
            text: value == null
                ? ''
                : f.format == FieldFormat.phone
                ? formatPhone('$value', country: _country)
                : '$value',
          );
        case FieldKind.toggle:
          _values[f.key] = value as bool? ?? false;
        case FieldKind.textList:
          _controllers[f.key] = TextEditingController(
            text: [...?(value as List?)].join(', '),
          );
        case FieldKind.refList:
          _values[f.key] = [...?(value as List?)?.cast<String>()];
        case FieldKind.weeklyHours || FieldKind.dateList:
          // Deep copies: the editors change these in place.
          _values[f.key] = [
            for (final r in (value as List?) ?? const [])
              _copy((r as Map).cast<String, dynamic>()),
          ];
        case FieldKind.choice || FieldKind.ref || FieldKind.dynamicRef:
          _values[f.key] = value as String?;
      }
    }
  }

  static Json _copy(Json m) => {
    for (final e in m.entries)
      e.key: e.value is List ? [...(e.value as List)] : e.value,
  };

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  /// A text field's value as it will be sent: a phone number in E.164.
  Object? _textValue(Field f) {
    final text = _controllers[f.key]!.text.trim();
    if (text.isEmpty) return f.allowEmpty ? '' : null;
    if (f.format == FieldFormat.phone) {
      return parsePhone(text, country: _country).value ?? text;
    }
    return text;
  }

  /// Every value as it stands, for rules across fields ([Field.check]).
  Map<String, Object?> get _current => {
    for (final f in _fields)
      f.key: switch (f.kind) {
        FieldKind.text => _textValue(f),
        FieldKind.integer => int.tryParse(_controllers[f.key]!.text.trim()),
        FieldKind.textList => _controllers[f.key]!.text,
        _ => _values[f.key],
      },
  };

  /// The request body. A create sends only what was filled in; an edit sends
  /// every editable field, with null clearing an optional one.
  Json _body() {
    final body = <String, dynamic>{};
    for (final f in _fields) {
      Object? value;
      switch (f.kind) {
        case FieldKind.text:
          value = _textValue(f);
        case FieldKind.integer:
          final text = _controllers[f.key]!.text.trim();
          value = text.isEmpty ? null : int.parse(text);
        case FieldKind.textList:
          value = [
            for (final w in _controllers[f.key]!.text.split(','))
              if (w.trim().isNotEmpty) w.trim(),
          ];
        default:
          value = _values[f.key];
      }
      if (f.writeOnly && value == null) continue;
      if (_editing && value == null && !f.nullable) continue;
      if (value == null && !_editing) continue;
      if (value is List && value.isEmpty && !_editing && !f.required) continue;
      body[f.key] = value;
    }
    return body;
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) {
      // A problem hidden in the folded section has to be seen to be fixed.
      if (!_advancedOpen && _fields.any((f) => f.advanced)) {
        setState(() => _advancedOpen = true);
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _formKey.currentState?.validate(),
        );
      }
      return;
    }
    final custom = widget.save;
    final api = ref.read(pbxApiProvider);
    if (custom == null && api == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _serverErrors = const {};
    });
    try {
      final key = widget.def.key;
      final id = _editing ? '${widget.row!['id']}' : null;
      final Json result;
      if (custom != null) {
        result = await custom(id, _body());
      } else if (id != null) {
        result = await api!.update(key, id, _body());
      } else {
        result = await api!.create(key, _body());
      }
      if (mounted) Navigator.of(context).pop(result);
    } catch (e) {
      if (!mounted) return;
      final fields = {for (final f in _fields) f.key: f};
      final byField = {
        for (final entry in problemFieldMessages(e).entries)
          if (fields.containsKey(entry.key)) entry.key: entry.value,
      };
      setState(() {
        _serverErrors = byField;
        _error = problemMessage(e, shownFields: byField.keys.toSet());
        if (byField.keys.any((k) => fields[k]!.advanced)) _advancedOpen = true;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final def = widget.def;
    final basic = [
      for (final f in _fields)
        if (!f.advanced) f,
    ];
    final advanced = [
      for (final f in _fields)
        if (f.advanced) f,
    ];
    Widget fieldBox(Field f) =>
        Padding(padding: const EdgeInsets.only(bottom: 12), child: _input(f));
    return AlertDialog(
      title: Text(
        _editing ? l10n.resEdit(def.selectKey) : l10n.resNew(def.selectKey),
      ),
      content: SizedBox(
        width: 480,
        child: Form(
          key: _formKey,
          // Checked as each field is left, not only on Save (S9-04).
          autovalidateMode: AutovalidateMode.onUnfocus,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_editing && widget.save == null)
                  _UsedBy(def: def, id: '${widget.row!['id']}'),
                if (_fields.any((f) => f.required))
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      l10n.formRequiredLegend,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                for (final f in basic) fieldBox(f),
                if (advanced.isNotEmpty)
                  ExpansionTile(
                    key: ValueKey('advanced-$_advancedOpen'),
                    initiallyExpanded: _advancedOpen,
                    onExpansionChanged: (open) => _advancedOpen = open,
                    tilePadding: EdgeInsets.zero,
                    childrenPadding: const EdgeInsets.only(top: 8),
                    title: Text(l10n.formAdvanced),
                    subtitle: Text(l10n.formAdvancedHint),
                    // Kept alive while folded, so their checks still run.
                    maintainState: true,
                    children: [for (final f in advanced) fieldBox(f)],
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: ErrorText(_error!),
                  ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(l10n.commonSave),
        ),
      ],
    );
  }

  /// The field's decoration, carrying what the service said about it.
  InputDecoration _decoration(Field f, String label, {String? helper}) =>
      InputDecoration(
        labelText: label,
        helperText: helper ?? f.help,
        helperMaxLines: 3,
        hintText: f.placeholder,
        errorText: _serverErrors[f.key],
        errorMaxLines: 3,
      );

  /// Forgets what the service said about [f] once it is changed.
  void _edited(Field f) {
    if (_serverErrors.containsKey(f.key)) {
      setState(() => _serverErrors = {..._serverErrors}..remove(f.key));
    }
  }

  String? _requiredMessage(Field f, bool empty) =>
      f.required && empty ? context.l10n.fieldRequired : null;

  /// The field's own rule across fields, if it has one.
  String? _checked(Field f) => f.check?.call(_current);

  /// A text field's checks: filled in, in the right format, and its rule.
  String? _validateText(Field f, String? raw) {
    final text = (raw ?? '').trim();
    if (text.isEmpty) {
      return f.allowEmpty ? null : _requiredMessage(f, true);
    }
    final formatProblem = switch (f.format) {
      FieldFormat.phone => parsePhone(text, country: _country).error,
      FieldFormat.mac => parseMac(text).error,
      FieldFormat.email => parseEmail(text).error,
      null => null,
    };
    return formatProblem ?? _checked(f);
  }

  Widget _input(Field f) {
    final l10n = context.l10n;
    final label = f.required ? '${f.label} *' : f.label;
    switch (f.kind) {
      case FieldKind.text:
        return TextFormField(
          controller: _controllers[f.key],
          obscureText: f.secret,
          keyboardType: switch (f.format) {
            FieldFormat.phone => TextInputType.phone,
            FieldFormat.email => TextInputType.emailAddress,
            _ => null,
          },
          decoration: _decoration(f, label),
          onChanged: (_) => _edited(f),
          validator: (v) => _validateText(f, v),
        );
      case FieldKind.textList:
        return TextFormField(
          controller: _controllers[f.key],
          decoration: _decoration(f, label),
          onChanged: (_) => _edited(f),
          validator: (v) =>
              _requiredMessage(
                f,
                !(v ?? '').split(',').any((w) => w.trim().isNotEmpty),
              ) ??
              _checked(f),
        );
      case FieldKind.integer:
        return TextFormField(
          controller: _controllers[f.key],
          keyboardType: TextInputType.number,
          decoration: _decoration(f, label),
          onChanged: (_) => _edited(f),
          validator: (v) {
            final text = (v ?? '').trim();
            if (text.isEmpty) return _requiredMessage(f, true);
            final n = int.tryParse(text);
            if (n == null) return l10n.formWholeNumber;
            if (f.min != null && n < f.min!) {
              return l10n.fieldMinimum('${f.min}');
            }
            if (f.max != null && n > f.max!) {
              return l10n.fieldMaximum('${f.max}');
            }
            return _checked(f);
          },
        );
      case FieldKind.toggle:
        final problem = _serverErrors[f.key];
        return SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(f.label),
          subtitle: problem != null
              ? ErrorText(problem)
              : (f.help == null ? null : Text(f.help!)),
          value: _values[f.key] as bool,
          onChanged: (v) {
            _edited(f);
            setState(() => _values[f.key] = v);
          },
        );
      case FieldKind.choice:
        return _dropdown(
          f,
          label,
          [for (final c in f.choices) (c, f.choiceLabels[c] ?? c)],
          onChanged: (v) => setState(() {
            _values[f.key] = v;
            // A dependent destination id no longer applies to the new type.
            for (final other in widget.def.fields) {
              if (other.refByField == f.key) _values[other.key] = null;
            }
          }),
        );
      case FieldKind.ref:
        return _refDropdown(f, label, f.ref!);
      case FieldKind.dynamicRef:
        final type = _values[f.refByField] as String?;
        final target = type == null ? null : f.refMap[type];
        if (target == null) {
          return InputDecorator(
            decoration: InputDecoration(
              labelText: f.label,
              helperText: l10n.formChooseTypeFirst,
            ),
            child: const SizedBox(height: 20),
          );
        }
        return _refDropdown(
          f,
          label,
          target,
          key: ValueKey('${f.key}:$target'),
        );
      case FieldKind.refList:
        return _refChecklist(f, label);
      case FieldKind.weeklyHours:
        return _listField(
          f,
          rulesError,
          (initial, onChanged, error) => WeeklyHoursEditor(
            initial: initial,
            onChanged: onChanged,
            errorText: error,
          ),
        );
      case FieldKind.dateList:
        return _listField(
          f,
          holidaysError,
          (initial, onChanged, error) => DateListEditor(
            initial: initial,
            onChanged: onChanged,
            errorText: error,
          ),
        );
    }
  }

  /// A list edited by its own widget, checked by [check] when saving.
  Widget _listField(
    Field f,
    String? Function(List<Json>) check,
    Widget Function(
      List<Json> initial,
      void Function(List<Json>) onChanged,
      String? error,
    )
    editor,
  ) {
    final initial = (_values[f.key] as List).cast<Json>();
    return FormField<List<Json>>(
      key: ValueKey('list-${f.key}'),
      initialValue: initial,
      validator: (v) => check(v ?? const []) ?? _checked(f),
      builder: (state) => editor(initial, (next) {
        _values[f.key] = next;
        _edited(f);
        state.didChange(next);
      }, state.errorText ?? _serverErrors[f.key]),
    );
  }

  /// A pick-one list. Each choice can carry a line of explanation
  /// ([Field.choiceHelp]), shown under it in the list and under the field
  /// once chosen. With [onCreate], the last item makes a new one.
  Widget _dropdown(
    Field f,
    String label,
    List<(String, String)> options, {
    required void Function(String?) onChanged,
    Future<void> Function()? onCreate,
    Key? key,
  }) {
    final l10n = context.l10n;
    final current = _values[f.key] as String?;
    final chosenHelp = current == null ? null : f.choiceHelp[current];
    return DropdownButtonFormField<String?>(
      key: key,
      initialValue: options.any((o) => o.$1 == current) ? current : null,
      isExpanded: true,
      itemHeight: f.choiceHelp.isEmpty ? kMinInteractiveDimension : null,
      decoration: _decoration(
        f,
        label,
        helper: chosenHelp ?? (options.isEmpty ? l10n.formNoneYet : null),
      ),
      selectedItemBuilder: (context) => [
        if (!f.required) Text(l10n.formNone),
        for (final (_, text) in options)
          Text(text, overflow: TextOverflow.ellipsis),
        if (onCreate != null) const SizedBox.shrink(),
      ],
      items: [
        if (!f.required)
          DropdownMenuItem<String?>(value: null, child: Text(l10n.formNone)),
        for (final (value, text) in options)
          DropdownMenuItem<String?>(
            value: value,
            child: f.choiceHelp[value] == null
                ? Text(text)
                : Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(text),
                        Text(
                          f.choiceHelp[value]!,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
          ),
        if (onCreate != null)
          DropdownMenuItem<String?>(
            value: _createNew,
            child: Row(
              children: [
                const Icon(Icons.add, size: 18),
                const SizedBox(width: 8),
                Text(l10n.formCreateNew),
              ],
            ),
          ),
      ],
      onChanged: (v) {
        if (v == _createNew) {
          onCreate?.call();
          return;
        }
        _edited(f);
        onChanged(v);
      },
      validator: (v) =>
          _requiredMessage(f, v == null || v == _createNew) ?? _checked(f),
    );
  }

  /// Opens the form for a new [target] row from inside this one, and hands
  /// back its id once saved (S9-04: a picker never dead-ends).
  Future<String?> _createIn(String target) async {
    final saved = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(def: resourceByKey(target)),
    );
    if (saved == null) return null;
    ref.invalidate(rowsProvider(target));
    return saved['id'] == null ? null : '${saved['id']}';
  }

  /// Whether this person may make a new [target] row from a picker.
  bool _canCreate(String target) {
    final def = resourceByKey(target);
    return !def.readOnly &&
        widget.save == null &&
        ref.read(canProvider(def.permission));
  }

  Widget _refDropdown(Field f, String label, String target, {Key? key}) {
    final rows = ref.watch(rowsProvider(target));
    return rows.when(
      loading: () => InputDecorator(
        decoration: InputDecoration(labelText: f.label),
        child: const LinearProgressIndicator(),
      ),
      error: (e, _) => InputDecorator(
        decoration: InputDecoration(
          labelText: f.label,
          errorText: problemMessage(e),
        ),
        child: const SizedBox(height: 20),
      ),
      data: (data) {
        final def = resourceByKey(target);
        return _dropdown(
          f,
          label,
          [for (final r in data) ('${r['id']}', def.titleOf(r))],
          onChanged: (v) => setState(() => _values[f.key] = v),
          onCreate: _canCreate(target)
              ? () async {
                  final id = await _createIn(target);
                  if (id != null && mounted) {
                    _edited(f);
                    setState(() => _values[f.key] = id);
                  }
                }
              : null,
          key: ValueKey('${key ?? f.key}:${_values[f.key]}:${data.length}'),
        );
      },
    );
  }

  Widget _refChecklist(Field f, String label) {
    final l10n = context.l10n;
    final rows = ref.watch(rowsProvider(f.ref!));
    final selected = (_values[f.key] as List).cast<String>();
    return FormField<List<String>>(
      initialValue: selected,
      validator: (_) => _requiredMessage(f, selected.isEmpty) ?? _checked(f),
      builder: (state) => InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          helperText: f.help,
          helperMaxLines: 3,
          errorText: state.errorText ?? _serverErrors[f.key],
        ),
        child: rows.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => Text(problemMessage(e)),
          data: (data) {
            final def = resourceByKey(f.ref!);
            final filter = (_filters[f.key] ?? '').toLowerCase();
            final shown = [
              for (final r in data)
                if (filter.isEmpty ||
                    selected.contains('${r['id']}') ||
                    def.titleOf(r).toLowerCase().contains(filter))
                  r,
            ];
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // A long list gets a box to narrow it.
                if (data.length > 12)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: TextField(
                      decoration: InputDecoration(
                        isDense: true,
                        prefixIcon: const Icon(Icons.filter_list),
                        hintText: l10n.formFilter,
                      ),
                      onChanged: (v) => setState(() => _filters[f.key] = v),
                    ),
                  ),
                if (data.isEmpty) Text(l10n.formNoneYet),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    for (final r in shown)
                      FilterChip(
                        label: Text(def.titleOf(r)),
                        selected: selected.contains('${r['id']}'),
                        onSelected: (on) => setState(() {
                          on
                              ? selected.add('${r['id']}')
                              : selected.remove('${r['id']}');
                          _edited(f);
                          state.didChange(selected);
                        }),
                      ),
                    if (_canCreate(f.ref!))
                      ActionChip(
                        avatar: const Icon(Icons.add, size: 18),
                        label: Text(l10n.formCreateNew),
                        onPressed: () async {
                          final id = await _createIn(f.ref!);
                          if (id != null && mounted) {
                            setState(() => selected.add(id));
                            _edited(f);
                            state.didChange(selected);
                          }
                        },
                      ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// What points at the row being edited (S9-08), so changing it isn't a
/// surprise: "Used by: Phone number (415) 555-0100".
class _UsedBy extends ConsumerWidget {
  const _UsedBy({required this.def, required this.id});

  final ResourceDef def;
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return FutureBuilder<List<String>>(
      future: usedBy(ref, def.key, id),
      builder: (context, snapshot) {
        final uses = snapshot.data ?? const [];
        if (uses.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.link, size: 18),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${l10n.resUsedBy}: ${[...uses.take(5), if (uses.length > 5) l10n.resUsedByMore(uses.length - 5)].join(', ')}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
