import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import '../pbx/resource_page.dart';

/// How a tenant's outgoing calls leave: the outbound routes (which trunk
/// carries which numbers) and the emergency route (which trunk and numbers are
/// dialed directly for emergencies). Each part shows only to someone who holds
/// its permission; the services decide independently.
class OutboundRoutesPage extends ConsumerWidget {
  const OutboundRoutesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(tenantIdProvider) == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text('Choose a tenant to configure its outbound routes.'),
      );
    }
    final routes = ref.watch(canProvider('trunk.manage'));
    final emergency = ref.watch(canProvider('emergency_route.manage'));
    final tabs = [
      if (routes) ('Outbound routes', ResourceView(def: outboundRoutesDef)),
      if (emergency) ('Emergency route', const EmergencyRoutePanel()),
    ];
    if (tabs.isEmpty) {
      return const PageFrame(
        children: [
          PageHeader(
            title: 'Not available to you',
            subtitle: "Your role doesn't include outbound routing.",
          ),
        ],
      );
    }
    if (tabs.length == 1) return tabs.single.$2;
    return DefaultTabController(
      length: tabs.length,
      child: Column(
        children: [
          TabBar(
            tabs: [for (final t in tabs) Tab(text: t.$1)],
            isScrollable: true,
          ),
          Expanded(child: TabBarView(children: [for (final t in tabs) t.$2])),
        ],
      ),
    );
  }
}

/// The tenant's emergency route: none, or one trunk and the numbers dialed
/// straight through it.
final emergencyRouteProvider = FutureProvider<Json?>((ref) async {
  final api = ref.watch(pbxApiProvider);
  return api?.emergencyRoute();
});

class EmergencyRoutePanel extends ConsumerWidget {
  const EmergencyRoutePanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final route = ref.watch(emergencyRouteProvider);
    final trunks = ref.watch(rowsProvider('trunks')).asData?.value;
    final canChange = ref.watch(canProvider('emergency_route.manage'));
    return PageFrame(
      children: [
        PageHeader(
          title: 'Emergency route',
          subtitle:
              'The trunk that carries emergency calls, and the numbers that '
              'count as emergencies. These are dialed exactly as typed.',
          actions: [
            if (canChange)
              FilledButton.icon(
                onPressed: () => _edit(context, ref, route.value),
                icon: Icon(
                  route.value == null ? Icons.add : Icons.edit_outlined,
                ),
                label: Text(
                  route.value == null ? 'Set emergency route' : 'Edit',
                ),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody<Json?>(
            value: route,
            emptyText: '',
            isEmpty: (_) => false,
            builder: (data) {
              if (data == null) {
                return const Align(
                  alignment: Alignment.topLeft,
                  child: Text(
                    'No emergency route is set. Emergency calls have no '
                    'trunk to leave through.',
                  ),
                );
              }
              final trunk = trunks?.where((t) => t['id'] == data['trunkId']);
              return Align(
                alignment: Alignment.topLeft,
                child: Card(
                  margin: EdgeInsets.zero,
                  child: SizedBox(
                    width: 440,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ListTile(
                          title: const Text('Trunk'),
                          subtitle: Text(
                            trunk == null || trunk.isEmpty
                                ? '${data['trunkId']}'
                                : trunksDef.titleOf(trunk.first),
                          ),
                        ),
                        ListTile(
                          title: const Text('Emergency numbers'),
                          subtitle: Text(
                            [...(data['numbers'] as List)].join(', '),
                          ),
                        ),
                        if (canChange)
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: () => _remove(context, ref),
                              child: const Text('Remove emergency route'),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref, Json? current) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => EmergencyRouteDialog(current: current),
    );
    if (saved == true) ref.invalidate(emergencyRouteProvider);
  }

  Future<void> _remove(BuildContext context, WidgetRef ref) async {
    final api = ref.read(pbxApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove the emergency route?'),
        content: const Text(
          'Emergency calls will have no trunk to leave through until a new '
          'route is set.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.deleteEmergencyRoute();
      ref.invalidate(emergencyRouteProvider);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }
}

class EmergencyRouteDialog extends ConsumerStatefulWidget {
  const EmergencyRouteDialog({super.key, this.current});

  final Json? current;

  @override
  ConsumerState<EmergencyRouteDialog> createState() =>
      _EmergencyRouteDialogState();
}

class _EmergencyRouteDialogState extends ConsumerState<EmergencyRouteDialog> {
  final _formKey = GlobalKey<FormState>();
  late final _numbers = TextEditingController(
    text: [...?(widget.current?['numbers'] as List?)].join(', '),
  );
  late String? _trunkId = widget.current?['trunkId'] as String?;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _numbers.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.saveEmergencyRoute({
        'trunkId': _trunkId,
        'numbers': [
          for (final n in _numbers.text.split(','))
            if (n.trim().isNotEmpty) n.trim(),
        ],
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final trunks = ref.watch(rowsProvider('trunks'));
    return AlertDialog(
      title: const Text('Emergency route'),
      content: SizedBox(
        width: 440,
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              trunks.when(
                loading: () => const LinearProgressIndicator(),
                error: (e, _) => ErrorText(problemMessage(e)),
                data: (rows) => DropdownButtonFormField<String?>(
                  key: const ValueKey('emergency-trunk'),
                  initialValue: rows.any((r) => r['id'] == _trunkId)
                      ? _trunkId
                      : null,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Trunk *'),
                  items: [
                    for (final r in rows)
                      DropdownMenuItem<String?>(
                        value: '${r['id']}',
                        child: Text(trunksDef.titleOf(r)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _trunkId = v),
                  validator: (v) => v == null ? 'Required' : null,
                ),
              ),
              TextFormField(
                controller: _numbers,
                decoration: const InputDecoration(
                  labelText: 'Emergency numbers *',
                  helperText:
                      'Comma-separated, digits only, such as 911 or 112.',
                ),
                validator: (v) =>
                    (v ?? '').split(',').any((w) => w.trim().isNotEmpty)
                    ? null
                    : 'Required',
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
}
