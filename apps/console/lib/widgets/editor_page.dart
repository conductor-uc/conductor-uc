import 'package:flutter/material.dart';

import '../l10n/l10n.dart';

/// One titled part of an [EditorPage]: "Basics", "Voicemail", "Advanced".
class EditorSection extends StatelessWidget {
  const EditorSection({
    super.key,
    required this.title,
    this.description,
    required this.children,
    this.initiallyExpanded = true,
    this.collapsible = false,
  });

  final String title;
  final String? description;
  final List<Widget> children;

  /// Advanced settings start folded away, and say so.
  final bool collapsible;
  final bool initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final body = Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, child) in children.indexed) ...[
            if (i > 0) const SizedBox(height: 12),
            child,
          ],
        ],
      ),
    );
    return Card(
      clipBehavior: Clip.antiAlias,
      child: collapsible
          ? ExpansionTile(
              initiallyExpanded: initiallyExpanded,
              title: Text(title, style: theme.textTheme.titleMedium),
              subtitle: description == null ? null : Text(description!),
              children: [body],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ListTile(
                  title: Text(title, style: theme.textTheme.titleMedium),
                  subtitle: description == null ? null : Text(description!),
                ),
                body,
              ],
            ),
    );
  }
}

/// A full page for editing something with more than a handful of settings
/// (S9-03), in place of a dialog: sections down the page, and Save and Cancel
/// always in reach at the bottom.
class EditorPage extends StatelessWidget {
  const EditorPage({
    super.key,
    required this.title,
    this.subtitle,
    required this.sections,
    required this.onSave,
    required this.onCancel,
    this.busy = false,
    this.error,
    this.saveLabel,
  });

  final String title;
  final String? subtitle;
  final List<Widget> sections;

  /// Null while saving is not possible (nothing changed, say).
  final VoidCallback? onSave;
  final VoidCallback onCancel;
  final bool busy;

  /// Shown above the buttons: what went wrong with the last save.
  final String? error;
  final String? saveLabel;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    return Column(
      children: [
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Align(
              alignment: AlignmentDirectional.topStart,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(title, style: theme.textTheme.headlineSmall),
                    if (subtitle != null) ...[
                      const SizedBox(height: 4),
                      Text(subtitle!),
                    ],
                    for (final section in sections) ...[
                      const SizedBox(height: 16),
                      section,
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        Material(
          elevation: 3,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
            child: Row(
              children: [
                Expanded(
                  child: error == null
                      ? const SizedBox.shrink()
                      : Text(
                          error!,
                          style: TextStyle(color: theme.colorScheme.error),
                        ),
                ),
                TextButton(
                  onPressed: busy ? null : onCancel,
                  child: Text(l10n.commonCancel),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: busy ? null : onSave,
                  child: busy
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(saveLabel ?? l10n.commonSave),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
