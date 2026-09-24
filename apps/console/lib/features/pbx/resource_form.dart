import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../widgets/page.dart';
import 'pbx_api.dart';
import 'resource.dart';

/// Create or edit one row of [def], drawn from its fields. Pops the saved row
/// (the service's response) when a change was saved, and null on cancel.
/// Sends a create (`id` null) or an edit. The default talks to the tenant's
/// PBX routes; org screens pass their own.
typedef SaveRow = Future<Json> Function(String? id, Json body);

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
  String? _error;
  bool _busy = false;

  bool get _editing => widget.row != null;

  /// The fields that apply to this create or edit.
  List<Field> get _fields => [
    for (final f in widget.def.fields)
      if (f.inScope(editing: _editing)) f,
  ];

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
            text: value == null ? '' : '$value',
          );
        case FieldKind.toggle:
          _values[f.key] = value as bool? ?? false;
        case FieldKind.refList:
          _values[f.key] = [...?(value as List?)?.cast<String>()];
        case FieldKind.choice || FieldKind.ref || FieldKind.dynamicRef:
          _values[f.key] = value as String?;
      }
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  /// The request body. A create sends only what was filled in; an edit sends
  /// every editable field, with null clearing an optional one.
  Json _body() {
    final body = <String, dynamic>{};
    for (final f in _fields) {
      Object? value;
      switch (f.kind) {
        case FieldKind.text:
          final text = _controllers[f.key]!.text.trim();
          value = text.isEmpty ? null : text;
        case FieldKind.integer:
          final text = _controllers[f.key]!.text.trim();
          value = text.isEmpty ? null : int.parse(text);
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
    if (!_formKey.currentState!.validate()) return;
    final custom = widget.save;
    final api = ref.read(pbxApiProvider);
    if (custom == null && api == null) return;
    setState(() {
      _busy = true;
      _error = null;
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
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final def = widget.def;
    return AlertDialog(
      title: Text(
        _editing
            ? 'Edit ${def.singular.toLowerCase()}'
            : 'New ${def.singular.toLowerCase()}',
      ),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final f in _fields)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _input(f),
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
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: const Text('Save'),
        ),
      ],
    );
  }

  String? _requiredMessage(Field f, bool empty) =>
      f.required && empty ? 'Required' : null;

  Widget _input(Field f) {
    final label = f.required ? '${f.label} *' : f.label;
    switch (f.kind) {
      case FieldKind.text:
        return TextFormField(
          controller: _controllers[f.key],
          obscureText: f.secret,
          decoration: InputDecoration(labelText: label, helperText: f.help),
          validator: (v) => _requiredMessage(f, (v ?? '').trim().isEmpty),
        );
      case FieldKind.integer:
        return TextFormField(
          controller: _controllers[f.key],
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: label, helperText: f.help),
          validator: (v) {
            final text = (v ?? '').trim();
            if (text.isEmpty) return _requiredMessage(f, true);
            final n = int.tryParse(text);
            if (n == null) return 'Enter a whole number';
            if (f.min != null && n < f.min!) return 'At least ${f.min}';
            if (f.max != null && n > f.max!) return 'At most ${f.max}';
            return null;
          },
        );
      case FieldKind.toggle:
        return SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(f.label),
          value: _values[f.key] as bool,
          onChanged: (v) => setState(() => _values[f.key] = v),
        );
      case FieldKind.choice:
        return _dropdown(
          f,
          label,
          [for (final c in f.choices) (c, c)],
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
              helperText: 'Choose a type first.',
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
    }
  }

  Widget _dropdown(
    Field f,
    String label,
    List<(String, String)> options, {
    required void Function(String?) onChanged,
    Key? key,
  }) {
    final current = _values[f.key] as String?;
    return DropdownButtonFormField<String?>(
      key: key,
      initialValue: options.any((o) => o.$1 == current) ? current : null,
      isExpanded: true,
      decoration: InputDecoration(labelText: label, helperText: f.help),
      items: [
        if (!f.required)
          const DropdownMenuItem<String?>(value: null, child: Text('None')),
        for (final (value, text) in options)
          DropdownMenuItem<String?>(value: value, child: Text(text)),
      ],
      onChanged: onChanged,
      validator: (v) => _requiredMessage(f, v == null),
    );
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
          key: key,
        );
      },
    );
  }

  Widget _refChecklist(Field f, String label) {
    final rows = ref.watch(rowsProvider(f.ref!));
    final selected = (_values[f.key] as List).cast<String>();
    return FormField<List<String>>(
      initialValue: selected,
      validator: (_) => _requiredMessage(f, selected.isEmpty),
      builder: (state) => InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          helperText: f.help,
          errorText: state.errorText,
        ),
        child: rows.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => Text(problemMessage(e)),
          data: (data) {
            final def = resourceByKey(f.ref!);
            if (data.isEmpty) {
              return Text('No ${def.plural.toLowerCase()} yet.');
            }
            return Wrap(
              spacing: 8,
              children: [
                for (final r in data)
                  FilterChip(
                    label: Text(def.titleOf(r)),
                    selected: selected.contains('${r['id']}'),
                    onSelected: (on) => setState(() {
                      on
                          ? selected.add('${r['id']}')
                          : selected.remove('${r['id']}');
                      state.didChange(selected);
                    }),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}
