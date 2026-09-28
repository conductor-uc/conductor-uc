import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
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
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(context.l10n.routeChooseTenant),
      );
    }
    final routes = ref.watch(canProvider('trunk.read'));
    final emergency = ref.watch(canProvider('emergency_route.read'));
    final l = context.l10n;
    final tabs = [
      if (routes) (l.orPlural, ResourceView(def: outboundRoutesDef)),
      if (emergency) (l.routeEmergency, const EmergencyRoutePanel()),
    ];
    if (tabs.isEmpty) {
      return PageFrame(
        children: [
          PageHeader(title: l.shellForbiddenTitle, subtitle: l.routeNotInRole),
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
    final l = context.l10n;
    return PageFrame(
      children: [
        PageHeader(
          title: l.routeEmergency,
          subtitle: l.routeEmergencyHelp,
          actions: [
            if (canChange)
              FilledButton.icon(
                onPressed: () => _edit(context, ref, route.value),
                icon: Icon(
                  route.value == null ? Icons.add : Icons.edit_outlined,
                ),
                label: Text(
                  route.value == null ? l.routeSetEmergency : l.commonEdit,
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
                return Align(
                  alignment: AlignmentDirectional.topStart,
                  child: Text(l.routeNoEmergency),
                );
              }
              final trunk = trunks?.where((t) => t['id'] == data['trunkId']);
              return Align(
                alignment: AlignmentDirectional.topStart,
                child: Card(
                  margin: EdgeInsets.zero,
                  child: SizedBox(
                    width: 440,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ListTile(
                          title: Text(l.trSingular),
                          subtitle: Text(
                            trunk == null || trunk.isEmpty
                                ? '${data['trunkId']}'
                                : trunksDef.titleOf(trunk.first),
                          ),
                        ),
                        ListTile(
                          title: Text(l.routeEmergencyNumbers),
                          subtitle: Text(
                            [...(data['numbers'] as List)].join(', '),
                          ),
                        ),
                        if (canChange)
                          Align(
                            alignment: AlignmentDirectional.centerEnd,
                            child: TextButton(
                              onPressed: () => _remove(context, ref),
                              child: Text(l.routeRemoveEmergency),
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
        title: Text(context.l10n.routeRemoveTitle),
        content: Text(context.l10n.routeRemoveBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(context.l10n.routeRemove),
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
    final l = context.l10n;
    return AlertDialog(
      title: Text(l.routeEmergency),
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
                  decoration: InputDecoration(labelText: l.routeTrunkRequired),
                  items: [
                    for (final r in rows)
                      DropdownMenuItem<String?>(
                        value: '${r['id']}',
                        child: Text(trunksDef.titleOf(r)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _trunkId = v),
                  validator: (v) =>
                      v == null ? context.l10n.fieldRequired : null,
                ),
              ),
              TextFormField(
                controller: _numbers,
                decoration: InputDecoration(
                  labelText: l.routeNumbersRequired,
                  helperText: l.routeNumbersHelp,
                ),
                validator: (v) =>
                    (v ?? '').split(',').any((w) => w.trim().isNotEmpty)
                    ? null
                    : context.l10n.fieldRequired,
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
          child: Text(l.commonCancel),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(l.commonSave),
        ),
      ],
    );
  }
}
