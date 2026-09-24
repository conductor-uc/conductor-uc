import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../widgets/page.dart';
import '../orgs/orgs_api.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import '../pbx/resource_page.dart';

/// A reseller's trunks screen. Trunks belong to the tenants they serve, so the
/// page works on one tenant at a time: pick it, then add, edit, and remove its
/// trunks and manage each one's IP allowlist.
class TrunksPage extends ConsumerWidget {
  const TrunksPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session == null) return const SizedBox.shrink();
    final picked = ref.watch(tenantIdProvider);
    final picker = _TenantPicker(resellerId: session.orgId);
    if (picked == null) {
      return PageFrame(
        children: [
          PageHeader(title: trunksDef.plural, subtitle: trunksDef.blurb),
          const SizedBox(height: 16),
          picker,
          const SizedBox(height: 16),
          const Text('Choose a tenant to see and manage its trunks.'),
        ],
      );
    }
    return ResourceView(
      key: ValueKey(picked),
      def: trunksDef,
      header: Padding(padding: const EdgeInsets.only(top: 12), child: picker),
      rowActions: [
        (
          icon: Icons.lan_outlined,
          tooltip: 'IP addresses and status',
          onPressed: (context, ref, row) => showDialog<void>(
            context: context,
            builder: (_) => TrunkIpsDialog(trunk: row),
          ),
        ),
      ],
    );
  }
}

class _TenantPicker extends ConsumerWidget {
  const _TenantPicker({required this.resellerId});

  final String resellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tenants = ref.watch(tenantsProvider(resellerId));
    final picked = ref.watch(pickedTenantProvider);
    return Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: 320,
        child: tenants.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => ErrorText(problemMessage(e)),
          data: (rows) => DropdownButtonFormField<String>(
            key: const ValueKey('trunk-tenant'),
            initialValue: rows.any((r) => r['id'] == picked) ? picked : null,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Tenant',
              helperText: 'Trunks belong to the tenant they serve.',
            ),
            items: [
              for (final t in rows)
                DropdownMenuItem(
                  value: '${t['id']}',
                  child: Text('${t['name']}'),
                ),
            ],
            onChanged: (v) => ref.read(pickedTenantProvider.notifier).pick(v),
          ),
        ),
      ),
    );
  }
}

/// A trunk's registration status and the carrier IP addresses allowed to send
/// calls to it.
class TrunkIpsDialog extends ConsumerStatefulWidget {
  const TrunkIpsDialog({super.key, required this.trunk});

  final Json trunk;

  @override
  ConsumerState<TrunkIpsDialog> createState() => _TrunkIpsDialogState();
}

class _TrunkIpsDialogState extends ConsumerState<TrunkIpsDialog> {
  final _cidr = TextEditingController();
  List<Json>? _ips;
  String? _status;
  String? _error;

  String get _id => '${widget.trunk['id']}';
  PbxApi get _api => ref.read(pbxApiProvider)!;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _cidr.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final ips = await _api.call('GET', 'trunks', _id, 'ips') as Map;
      final status = await _api.call('GET', 'trunks', _id, 'status') as Map;
      if (!mounted) return;
      setState(() {
        _ips = [
          for (final r in ips['rows'] as List)
            (r as Map).cast<String, dynamic>(),
        ];
        _status = '${status['registrationStatus']}';
      });
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  Future<void> _add() async {
    final value = _cidr.text.trim();
    if (value.isEmpty) return;
    try {
      await _api.call('POST', 'trunks', _id, 'ips', body: {'cidr': value});
      _cidr.clear();
      setState(() => _error = null);
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  Future<void> _remove(String ipId) async {
    try {
      await _api.call('DELETE', 'trunks', _id, 'ips/$ipId');
      await _load();
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  static const _statusText = {
    'registered': 'Registered',
    'registering': 'Registering…',
    'failed': 'Registration failed',
    'not_registered': 'Not registered',
    'not_applicable': 'Not applicable (IP authentication)',
  };

  @override
  Widget build(BuildContext context) {
    final ips = _ips;
    return AlertDialog(
      title: Text('${widget.trunk['name']}'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_status != null)
              Text('Status: ${_statusText[_status] ?? _status}'),
            const SizedBox(height: 12),
            Text(
              'Allowed carrier addresses',
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (ips == null && _error == null) const LinearProgressIndicator(),
            if (ips != null && ips.isEmpty) const Text('None yet.'),
            for (final ip in ips ?? const <Json>[])
              ListTile(
                key: ValueKey('ip-${ip['id']}'),
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text('${ip['cidr']}'),
                trailing: IconButton(
                  tooltip: 'Remove ${ip['cidr']}',
                  icon: const Icon(Icons.close),
                  onPressed: () => _remove('${ip['id']}'),
                ),
              ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _cidr,
                    decoration: const InputDecoration(
                      labelText: 'Address or range',
                      helperText: 'For example 203.0.113.0/24',
                    ),
                    onSubmitted: (_) => _add(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _add, child: const Text('Add')),
              ],
            ),
            if (_error != null) ErrorText(_error!),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }
}
