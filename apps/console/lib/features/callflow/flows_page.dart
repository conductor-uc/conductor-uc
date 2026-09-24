import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';

/// Call flows (IVRs and auto-attendants): list, create, and open in the builder.
class FlowsPage extends ConsumerWidget {
  const FlowsPage({super.key});

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
    final rows = ref.watch(rowsProvider('flows'));
    return PageFrame(
      children: [
        PageHeader(
          title: 'Call flows',
          subtitle: 'Menus, time-of-day routing, and other call handling a number can point at.',
          actions: [
            FilledButton.icon(
              onPressed: () => _create(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('New call flow'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: 'No call flows yet.',
            builder: (data) => Material(
              type: MaterialType.transparency,
              child: ListView(
                children: [
                  for (final flow in data)
                    ListTile(
                      leading: const Icon(Icons.account_tree_outlined),
                      title: Text('${flow['name']}'),
                      subtitle: Text(
                        flow['currentPublishedVersionId'] == null
                            ? 'Not published'
                            : 'Published',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.go('/call-flows/${flow['id']}'),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final api = ref.read(pbxApiProvider);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _NameDialog(),
    );
    if (name == null || api == null) return;
    try {
      final flow = await api.create('flows', {'name': name});
      ref.invalidate(rowsProvider('flows'));
      if (context.mounted) context.go('/call-flows/${flow['id']}');
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(problemMessage(e))));
      }
    }
  }
}

class _NameDialog extends StatefulWidget {
  const _NameDialog();

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  final _name = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('New call flow'),
      content: TextField(
        controller: _name,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name'),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Create')),
      ],
    );
  }

  void _submit() {
    final name = _name.text.trim();
    if (name.isNotEmpty) Navigator.of(context).pop(name);
  }
}
