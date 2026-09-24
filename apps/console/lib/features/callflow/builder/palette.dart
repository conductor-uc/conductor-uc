import 'package:flutter/material.dart';

import 'node_types.dart';

/// The node types to build with. Drag one onto the canvas, or click it to add
/// it in the middle of what is showing.
class NodePalette extends StatelessWidget {
  const NodePalette({super.key, required this.onAdd});

  final void Function(FlowNodeType type) onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surface,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
              child: Text('Add a step', style: theme.textTheme.titleSmall),
            ),
            for (final t in flowNodeTypes)
              Draggable<FlowNodeType>(
                data: t,
                feedback: Material(
                  elevation: 4,
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(t.icon),
                        const SizedBox(width: 8),
                        Text(t.label),
                      ],
                    ),
                  ),
                ),
                child: ListTile(
                  key: ValueKey('palette-${t.type}'),
                  dense: true,
                  leading: Icon(t.icon),
                  title: Text(t.label),
                  subtitle: Text(t.description, maxLines: 2),
                  onTap: () => onAdd(t),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
