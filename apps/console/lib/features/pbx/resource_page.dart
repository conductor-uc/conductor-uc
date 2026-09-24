import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../widgets/page.dart';
import 'pbx_api.dart';
import 'resource.dart';
import 'resource_form.dart';

/// A table of one resource with create, edit, and delete.
class ResourceView extends ConsumerWidget {
  const ResourceView({super.key, required this.def});

  final ResourceDef def;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rows = ref.watch(rowsProvider(def.key));
    final columns = [
      for (final f in def.fields)
        if (f.showInList) f,
    ];
    return PageFrame(
      children: [
        PageHeader(
          title: def.plural,
          subtitle: def.blurb,
          actions: [
            if (!def.readOnly)
              FilledButton.icon(
                onPressed: () => _openForm(context, ref),
                icon: const Icon(Icons.add),
                label: Text('New ${def.singular.toLowerCase()}'),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: 'No ${def.plural.toLowerCase()} yet.',
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minWidth: MediaQuery.sizeOf(context).width - 320,
                  ),
                  child: DataTable(
                    columns: [
                      for (final c in columns) DataColumn(label: Text(c.label)),
                      const DataColumn(label: Text('')),
                    ],
                    rows: [
                      for (final row in data) _row(context, ref, row, columns),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  DataRow _row(
    BuildContext context,
    WidgetRef ref,
    Json row,
    List<Field> columns,
  ) {
    return DataRow(
      cells: [
        for (final c in columns) DataCell(_cell(ref, c, row[c.key], row)),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!def.readOnly)
                IconButton(
                  tooltip: 'Edit',
                  icon: const Icon(Icons.edit_outlined),
                  onPressed: () => _openForm(context, ref, row),
                ),
              IconButton(
                tooltip: 'Delete',
                icon: const Icon(Icons.delete_outline),
                onPressed: () => _confirmDelete(context, ref, row),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _cell(WidgetRef ref, Field f, Object? value, Json row) {
    switch (f.kind) {
      case FieldKind.toggle:
        return Icon(value == true ? Icons.check : Icons.remove, size: 18);
      case FieldKind.ref:
        return Text(_lookup(ref, f.ref!, value));
      case FieldKind.dynamicRef:
        final type = row[f.refByField] as String?;
        final target = type == null ? null : f.refMap[type];
        return Text(target == null ? '—' : _lookup(ref, target, value));
      case FieldKind.refList:
        final ids = [...?(value as List?)];
        return Text(
          ids.isEmpty
              ? '—'
              : ids.map((id) => _lookup(ref, f.ref!, id)).join(', '),
        );
      default:
        return Text(value == null ? '—' : '$value');
    }
  }

  /// The display title of the row `id` in `resource`, or the raw id while that
  /// resource is still loading or the row is gone.
  String _lookup(WidgetRef ref, String resource, Object? id) {
    if (id == null) return '—';
    final rows = ref.watch(rowsProvider(resource)).asData?.value;
    final match = rows?.where((r) => r['id'] == id);
    if (match == null || match.isEmpty) return '$id';
    return resourceByKey(resource).titleOf(match.first);
  }

  Future<void> _openForm(
    BuildContext context,
    WidgetRef ref, [
    Json? row,
  ]) async {
    final saved = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(def: def, row: row),
    );
    if (saved != null) ref.invalidate(rowsProvider(def.key));
  }

  Future<void> _confirmDelete(
    BuildContext context,
    WidgetRef ref,
    Json row,
  ) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete ${def.singular.toLowerCase()}?'),
        content: Text(def.titleOf(row)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.delete(def.key, '${row['id']}');
      ref.invalidate(rowsProvider(def.key));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }
}

/// A page of one or more resources, as tabs when there is more than one.
class ResourcePage extends ConsumerWidget {
  const ResourcePage({super.key, required this.defs});

  final List<ResourceDef> defs;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(tenantIdProvider) == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text(
          'Choose a tenant to configure. Acting as a tenant arrives with the app shell.',
        ),
      );
    }
    if (defs.length == 1) return ResourceView(def: defs.single);
    return DefaultTabController(
      length: defs.length,
      child: Column(
        children: [
          TabBar(
            tabs: [for (final d in defs) Tab(text: d.plural)],
            isScrollable: true,
          ),
          Expanded(
            child: TabBarView(
              children: [for (final d in defs) ResourceView(def: d)],
            ),
          ),
        ],
      ),
    );
  }
}
