import 'package:flutter/material.dart';

import '../l10n/l10n.dart';

/// What a page shows when it has nothing to list (S9-03): what the thing is
/// for, and the one step that gets started. Never just "No items".
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });

  final IconData icon;
  final String title;

  /// A sentence on what these are for, or what to do first.
  final String? message;

  /// The step that gets started, usually a FilledButton.
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 48, color: theme.colorScheme.primary),
              const SizedBox(height: 12),
              Text(
                title,
                style: theme.textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              if (message != null) ...[
                const SizedBox(height: 8),
                Text(
                  message!,
                  style: theme.textTheme.bodyMedium,
                  textAlign: TextAlign.center,
                ),
              ],
              if (action != null) ...[const SizedBox(height: 16), action!],
            ],
          ),
        ),
      ),
    );
  }
}

/// Asks before something that can't be taken back (S9-03), naming what else
/// it affects ([impact], one line each: "Phone number +1 415 555 0100 rings
/// this group"). Resolves true when confirmed.
Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  String? message,
  List<String> impact = const [],
  required String confirmLabel,
  bool destructive = true,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return AlertDialog(
        title: Text(title),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (message != null) Text(message),
              if (impact.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(context.l10n.confirmAlsoAffects),
                const SizedBox(height: 4),
                for (final line in impact)
                  Padding(
                    padding: const EdgeInsetsDirectional.only(start: 8, top: 2),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(Icons.link, size: 16, color: scheme.error),
                        const SizedBox(width: 6),
                        Expanded(child: Text(line)),
                      ],
                    ),
                  ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            style: destructive
                ? FilledButton.styleFrom(
                    backgroundColor: scheme.error,
                    foregroundColor: scheme.onError,
                  )
                : null,
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return confirmed == true;
}

/// A short note at the bottom of the screen that something worked (S9-03),
/// with Undo when [undo] is given. Takes the messenger, not a context, so it
/// can be called after an await.
void showToast(
  ScaffoldMessengerState messenger,
  String message, {
  VoidCallback? undo,
  String? undoLabel,
}) {
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        behavior: SnackBarBehavior.floating,
        action: undo == null
            ? null
            : SnackBarAction(
                label: undoLabel ?? currentL10n.commonUndo,
                onPressed: undo,
              ),
      ),
    );
}
