import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'pbx_api.dart';

/// A leading `+`, a non-zero first digit, 7 to 15 digits in all. The service
/// applies the same rule; checking here saves a round trip.
final _e164 = RegExp(r'^\+[1-9]\d{6,14}$');

const _maxRing = 5;

/// One place a call can be sent, as it is edited: nothing, an extension, an
/// extension's voicemail, or an outside number.
class _Dest {
  _Dest({this.type = 'none', this.extensionId, String number = ''})
    : number = TextEditingController(text: number);

  /// `none`, `extension`, `voicemail`, or `external`.
  String type;

  /// The extension for `extension`; for `voicemail`, whose mailbox (null: this
  /// extension's own).
  String? extensionId;
  final TextEditingController number;

  factory _Dest.fromJson(Object? json) {
    if (json is! Map) return _Dest();
    return switch (json['type']) {
      'extension' => _Dest(
        type: 'extension',
        extensionId: json['extensionId'] as String?,
      ),
      'voicemail' => _Dest(
        type: 'voicemail',
        extensionId: json['extensionId'] as String?,
      ),
      'external' => _Dest(type: 'external', number: '${json['e164']}'),
      _ => _Dest(),
    };
  }

  /// The request shape, or null when nothing is set.
  Json? toJson() => switch (type) {
    'extension' => {'type': 'extension', 'extensionId': extensionId},
    'voicemail' => {
      'type': 'voicemail',
      if (extensionId != null) 'extensionId': extensionId,
    },
    'external' => {'type': 'external', 'e164': number.text.trim()},
    _ => null,
  };

  /// What is wrong with this destination, or null.
  String? problem(String slot) {
    if (type == 'extension' && extensionId == null) {
      return '$slot: choose an extension.';
    }
    if (type == 'external' && !_e164.hasMatch(number.text.trim())) {
      return '$slot: enter the number with a leading + and country code, '
          'for example +14155552671.';
    }
    return null;
  }

  void dispose() => number.dispose();
}

/// Do not disturb, forwarding and simultaneous ring for one extension (the
/// "answering rules" a hosted PBX offers each user). Reads and replaces the
/// extension's call handling as a whole.
class CallHandlingDialog extends ConsumerStatefulWidget {
  const CallHandlingDialog({super.key, required this.extension});

  final Json extension;

  @override
  ConsumerState<CallHandlingDialog> createState() => _CallHandlingDialogState();
}

class _CallHandlingDialogState extends ConsumerState<CallHandlingDialog> {
  final _always = _Dest();
  final _busy = _Dest();
  final _noAnswer = _Dest();
  final _unreachable = _Dest();
  final _seconds = TextEditingController(text: '20');
  final _ring = <_Dest>[];
  var _dnd = false;
  var _dndAction = 'voicemail';

  var _loaded = false;
  var _saving = false;
  String? _error;

  String get _extensionId => '${widget.extension['id']}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final d in [_always, _busy, _noAnswer, _unreachable, ..._ring]) {
      d.dispose();
    }
    _seconds.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = ref.read(pbxApiProvider);
    if (api == null) {
      setState(() => _error = 'Sign in again to continue.');
      return;
    }
    try {
      final got = await api.callHandling(_extensionId);
      if (!mounted) return;
      setState(() {
        _dnd = got['dnd'] == true;
        _dndAction = got['dndAction'] == 'busy' ? 'busy' : 'voicemail';
        _copy(_always, _Dest.fromJson(got['forwardAlways']));
        _copy(_busy, _Dest.fromJson(got['forwardBusy']));
        _copy(_noAnswer, _Dest.fromJson(got['forwardNoAnswer']));
        _copy(_unreachable, _Dest.fromJson(got['forwardUnreachable']));
        _seconds.text = '${got['noAnswerSeconds'] ?? 20}';
        _ring
          ..clear()
          ..addAll([
            for (final r in (got['simultaneousRing'] as List? ?? const []))
              _Dest.fromJson(r),
          ]);
        _loaded = true;
      });
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  void _copy(_Dest into, _Dest from) {
    into.type = from.type;
    into.extensionId = from.extensionId;
    into.number.text = from.number.text;
    from.dispose();
  }

  Future<void> _save() async {
    final slots = {
      'Forward all calls': _always,
      'Forward when busy': _busy,
      'Forward when there is no answer': _noAnswer,
      'Forward when unreachable': _unreachable,
    };
    String? bad;
    for (final e in slots.entries) {
      bad ??= e.value.problem(e.key);
    }
    for (var i = 0; i < _ring.length; i++) {
      bad ??= _ring[i].problem('Also ring ${i + 1}');
    }
    final seconds = int.tryParse(_seconds.text.trim());
    if (seconds == null || seconds < 5 || seconds > 120) {
      bad ??= 'Ring for: enter a whole number of seconds from 5 to 120.';
    }
    if (bad != null) {
      setState(() => _error = bad);
      return;
    }
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await api.saveCallHandling(_extensionId, {
        'dnd': _dnd,
        'dndAction': _dndAction,
        'forwardAlways': _always.toJson(),
        'forwardBusy': _busy.toJson(),
        'forwardNoAnswer': _noAnswer.toJson(),
        'noAnswerSeconds': seconds,
        'forwardUnreachable': _unreachable.toJson(),
        'simultaneousRing': [
          for (final r in _ring)
            if (r.toJson() != null) r.toJson(),
        ],
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final number = '${widget.extension['number']}';
    final extensions =
        ref.watch(rowsProvider('extensions')).asData?.value ?? const <Json>[];
    final others = [
      for (final e in extensions)
        if ('${e['id']}' != _extensionId) e,
    ];
    return AlertDialog(
      title: Text('Call handling for $number'),
      content: SizedBox(
        width: 560,
        child: !_loaded
            ? SizedBox(
                height: 96,
                child: Center(
                  child: _error == null
                      ? const CircularProgressIndicator()
                      : Text(_error!),
                ),
              )
            : SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SwitchListTile(
                      key: const Key('call-handling-dnd'),
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Do not disturb'),
                      subtitle: const Text(
                        'Calls do not ring this extension, and nothing below applies.',
                      ),
                      value: _dnd,
                      onChanged: (v) => setState(() => _dnd = v),
                    ),
                    if (_dnd)
                      DropdownButtonFormField<String>(
                        key: const Key('call-handling-dnd-action'),
                        initialValue: _dndAction,
                        decoration: const InputDecoration(
                          labelText: 'Send callers to',
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'voicemail',
                            child: Text('Voicemail'),
                          ),
                          DropdownMenuItem(
                            value: 'busy',
                            child: Text('A busy signal'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _dndAction = v ?? 'voicemail'),
                      ),
                    const Divider(height: 32),
                    _slot(
                      'always',
                      'Forward all calls',
                      _always,
                      others,
                      help: 'Replaces ringing this extension.',
                    ),
                    _slot('busy', 'Forward when busy', _busy, others),
                    _slot(
                      'no-answer',
                      'Forward when there is no answer',
                      _noAnswer,
                      others,
                      extra: SizedBox(
                        width: 160,
                        child: TextFormField(
                          key: const Key('call-handling-seconds'),
                          controller: _seconds,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Ring for (seconds)',
                          ),
                        ),
                      ),
                    ),
                    _slot(
                      'unreachable',
                      'Forward when unreachable',
                      _unreachable,
                      others,
                      help: 'The phone is not registered.',
                    ),
                    const Divider(height: 32),
                    Text(
                      'Also ring at the same time',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Up to $_maxRing extensions or outside numbers ring '
                      'together with this one.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    for (var i = 0; i < _ring.length; i++)
                      Padding(
                        // Tied to the destination, not its position, so
                        // removing one does not hand its state to the next.
                        key: ObjectKey(_ring[i]),
                        padding: const EdgeInsets.only(top: 8),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: _DestinationEditor(
                                slotKey: 'ring-$i',
                                dest: _ring[i],
                                others: others,
                                allowNone: false,
                                allowVoicemail: false,
                                onChanged: () => setState(() {}),
                              ),
                            ),
                            IconButton(
                              key: Key('call-handling-ring-$i-remove'),
                              tooltip: 'Remove',
                              icon: const Icon(Icons.close),
                              onPressed: () => setState(() {
                                _ring.removeAt(i).dispose();
                              }),
                            ),
                          ],
                        ),
                      ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        key: const Key('call-handling-ring-add'),
                        onPressed: _ring.length >= _maxRing
                            ? null
                            : () => setState(
                                () => _ring.add(_Dest(type: 'extension')),
                              ),
                        icon: const Icon(Icons.add),
                        label: const Text('Add destination'),
                      ),
                    ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          _error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: !_loaded || _saving ? null : _save,
          child: const Text('Save'),
        ),
      ],
    );
  }

  Widget _slot(
    String slotKey,
    String title,
    _Dest dest,
    List<Json> others, {
    String? help,
    Widget? extra,
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          if (help != null)
            Text(help, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 4),
          _DestinationEditor(
            slotKey: slotKey,
            dest: dest,
            others: others,
            allowNone: true,
            allowVoicemail: true,
            onChanged: () => setState(() {}),
          ),
          if (extra != null && dest.type != 'none') ...[
            const SizedBox(height: 8),
            extra,
          ],
        ],
      ),
    );
  }
}

/// The type picker and the field that goes with it.
class _DestinationEditor extends StatelessWidget {
  const _DestinationEditor({
    required this.slotKey,
    required this.dest,
    required this.others,
    required this.allowNone,
    required this.allowVoicemail,
    required this.onChanged,
  });

  final String slotKey;
  final _Dest dest;

  /// The tenant's other extensions.
  final List<Json> others;
  final bool allowNone;
  final bool allowVoicemail;
  final VoidCallback onChanged;

  String _title(Json e) => '${e['number']} · ${e['displayName']}';

  @override
  Widget build(BuildContext context) {
    final ids = {for (final e in others) '${e['id']}'};
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 200,
          child: DropdownButtonFormField<String>(
            key: Key('call-handling-$slotKey-type'),
            isExpanded: true,
            initialValue: dest.type,
            decoration: const InputDecoration(labelText: 'Send to'),
            items: [
              if (allowNone)
                const DropdownMenuItem(value: 'none', child: Text('Not set')),
              const DropdownMenuItem(
                value: 'extension',
                child: Text('An extension'),
              ),
              if (allowVoicemail)
                const DropdownMenuItem(
                  value: 'voicemail',
                  child: Text('A voicemail'),
                ),
              const DropdownMenuItem(
                value: 'external',
                child: Text('An outside number'),
              ),
            ],
            onChanged: (v) {
              if (v != dest.type) dest.extensionId = null;
              dest.type = v ?? 'none';
              onChanged();
            },
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: switch (dest.type) {
            'extension' => DropdownButtonFormField<String>(
              key: Key('call-handling-$slotKey-extension'),
              initialValue: ids.contains(dest.extensionId)
                  ? dest.extensionId
                  : null,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Extension'),
              items: [
                for (final e in others)
                  DropdownMenuItem(value: '${e['id']}', child: Text(_title(e))),
              ],
              onChanged: (v) {
                dest.extensionId = v;
                onChanged();
              },
            ),
            'voicemail' => DropdownButtonFormField<String?>(
              key: Key('call-handling-$slotKey-voicemail'),
              initialValue: ids.contains(dest.extensionId)
                  ? dest.extensionId
                  : null,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Voicemail of'),
              items: [
                const DropdownMenuItem<String?>(
                  value: null,
                  child: Text('This extension'),
                ),
                for (final e in others)
                  DropdownMenuItem<String?>(
                    value: '${e['id']}',
                    child: Text(_title(e)),
                  ),
              ],
              onChanged: (v) {
                dest.extensionId = v;
                onChanged();
              },
            ),
            'external' => TextFormField(
              key: Key('call-handling-$slotKey-number'),
              controller: dest.number,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Number',
                hintText: '+14155552671',
              ),
            ),
            _ => const SizedBox.shrink(),
          },
        ),
      ],
    );
  }
}
