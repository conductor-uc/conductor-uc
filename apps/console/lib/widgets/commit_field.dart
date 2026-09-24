import 'package:flutter/material.dart';

/// A text or number field that reports its value when it loses focus or is
/// submitted, so typing is one undo step rather than one per key.
class CommitField extends StatefulWidget {
  const CommitField({
    super.key,
    required this.label,
    required this.value,
    required this.onCommit,
    this.number = false,
    this.error,
    this.helper,
  });

  final String label;
  final String value;
  final void Function(String text) onCommit;
  final bool number;
  final String? error;
  final String? helper;

  @override
  State<CommitField> createState() => _CommitFieldState();
}

class _CommitFieldState extends State<CommitField> {
  late final _text = TextEditingController(text: widget.value);
  final _focus = FocusNode();

  /// The last text handed to [CommitField.onCommit], or the value it was
  /// given, so a submit followed by losing focus reports once.
  late String _committed = widget.value;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (!_focus.hasFocus) _commit();
    });
  }

  @override
  void didUpdateWidget(CommitField old) {
    super.didUpdateWidget(old);
    // Undo, redo, or another edit changed it; keep what is being typed.
    final changedUnderneath =
        widget.value != old.value && _text.text == old.value;
    if (widget.value != old.value) _committed = widget.value;
    if (widget.value != _text.text && (!_focus.hasFocus || changedUnderneath)) {
      _text.text = widget.value;
    }
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _commit() {
    if (_text.text == _committed) return;
    _committed = _text.text;
    widget.onCommit(_text.text);
  }

  @override
  Widget build(BuildContext context) => TextField(
    controller: _text,
    focusNode: _focus,
    keyboardType: widget.number ? TextInputType.number : null,
    decoration: InputDecoration(
      labelText: widget.label,
      errorText: widget.error,
      helperText: widget.helper,
      helperMaxLines: 3,
    ),
    onSubmitted: (_) => _commit(),
  );
}
