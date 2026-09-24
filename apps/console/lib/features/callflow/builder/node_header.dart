import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../canvas/canvas.dart';
import 'local_validation.dart';
import 'lookups.dart';
import 'node_types.dart';

/// What a node shows inside its frame: the type's icon and name, a line about
/// how it is set up, a flag when a call can start here, and a badge when it
/// has problems.
class NodeHeader extends ConsumerWidget {
  const NodeHeader({
    super.key,
    required this.node,
    required this.issues,
    required this.startNames,
  });

  final CanvasNode node;
  final List<FlowIssue> issues;
  final List<String> startNames;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final type = flowNodeType(node.type);
    final summary = _summary(ref, type);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Row(
        children: [
          Icon(type?.icon ?? Icons.help_outline, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  type?.label ?? node.type,
                  style: theme.textTheme.labelLarge,
                  overflow: TextOverflow.ellipsis,
                ),
                if (summary != null)
                  Text(
                    summary.$1,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: summary.$2
                          ? theme.colorScheme.error
                          : theme.colorScheme.onSurfaceVariant,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
              ],
            ),
          ),
          if (startNames.isNotEmpty)
            Tooltip(
              message: 'Calls start here: ${startNames.join(', ')}',
              child: const Icon(Icons.flag_outlined, size: 18),
            ),
          if (issues.isNotEmpty)
            Tooltip(
              message: issues.map((i) => i.message).join('\n'),
              child: Icon(
                Icons.error_outline,
                size: 18,
                color: theme.colorScheme.error,
              ),
            ),
        ],
      ),
    );
  }

  /// The line under the name, and whether it is a "not set" warning.
  (String, bool)? _summary(WidgetRef ref, FlowNodeType? type) {
    final key = type?.summaryKey;
    if (type == null || key == null) return null;
    final value = node.config[key];
    if (value == null || '$value'.isEmpty) return ('Not set', true);
    final field = type.fields.firstWhere((f) => f.key == key);
    if (field.kind != ConfigKind.ref) return ('$value', false);
    final options = ref.watch(optionsProvider(field.resource!)).value;
    if (options == null) return ('…', false);
    final title = options['$value'];
    return title == null ? ('Missing', true) : (title, false);
  }
}
