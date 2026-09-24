import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import 'orgs_api.dart';

/// A reseller's own page for its base domains.
class DomainsPage extends ConsumerWidget {
  const DomainsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session == null || session.orgType != OrgType.reseller) {
      return const PageFrame(
        children: [Text('Only a reseller has base domains.')],
      );
    }
    return PageFrame(children: [BaseDomainsPanel(resellerId: session.orgId)]);
  }
}

/// A reseller's base domains: the names tenants' own domains are made under.
/// A new one is proved by publishing a DNS TXT record, then asking the service
/// to check for it.
class BaseDomainsPanel extends ConsumerWidget {
  const BaseDomainsPanel({super.key, required this.resellerId});

  final String resellerId;

  Future<void> _add(BuildContext context, WidgetRef ref) async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    final fqdn = await showDialog<String>(
      context: context,
      builder: (_) => const _DomainDialog(),
    );
    if (fqdn == null) return;
    try {
      await api.addBaseDomain(resellerId, fqdn);
      ref.invalidate(baseDomainsProvider(resellerId));
    } catch (e) {
      if (context.mounted) _say(context, problemMessage(e));
    }
  }

  Future<void> _verify(BuildContext context, WidgetRef ref, Json domain) async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    try {
      await api.verifyBaseDomain(resellerId, '${domain['id']}');
      ref.invalidate(baseDomainsProvider(resellerId));
      if (context.mounted) _say(context, '${domain['fqdn']} is verified.');
    } catch (e) {
      if (context.mounted) _say(context, problemMessage(e));
    }
  }

  void _say(BuildContext context, String text) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final domains = ref.watch(baseDomainsProvider(resellerId));
    final theme = Theme.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            title: 'Domains',
            subtitle: 'Base domains your tenants get their own names under. Prove you control one by publishing a DNS record, then verify it.',
            actions: [
              FilledButton.icon(
                onPressed: () => _add(context, ref),
                icon: const Icon(Icons.add),
                label: const Text('Add domain'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: AsyncBody(
              value: domains,
              emptyText: 'No base domains yet.',
              builder: (rows) => ListView(
                children: [
                  for (final d in rows)
                    Card(
                      key: ValueKey('domain-${d['fqdn']}'),
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    '${d['fqdn']}',
                                    style: theme.textTheme.titleMedium,
                                  ),
                                ),
                                Chip(
                                  label: Text(
                                    d['status'] == 'active'
                                        ? 'Verified'
                                        : 'Waiting for DNS',
                                  ),
                                  visualDensity: VisualDensity.compact,
                                ),
                              ],
                            ),
                            if (d['status'] != 'active') ...[
                              const SizedBox(height: 8),
                              const Text('Publish this TXT record:'),
                              SelectableText(
                                '${d['verificationRecordName']}  →  ${d['verificationToken']}',
                                style: const TextStyle(fontFamily: 'monospace'),
                              ),
                              const SizedBox(height: 8),
                              OutlinedButton(
                                onPressed: () => _verify(context, ref, d),
                                child: const Text('Verify now'),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DomainDialog extends StatefulWidget {
  const _DomainDialog();

  @override
  State<_DomainDialog> createState() => _DomainDialogState();
}

class _DomainDialogState extends State<_DomainDialog> {
  final _fqdn = TextEditingController();

  @override
  void dispose() {
    _fqdn.dispose();
    super.dispose();
  }

  void _submit() {
    final value = _fqdn.text.trim().toLowerCase();
    if (value.isNotEmpty) Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Add domain'),
    content: TextField(
      controller: _fqdn,
      autofocus: true,
      decoration: const InputDecoration(
        labelText: 'Domain',
        helperText: 'For example voice.example.com',
      ),
      onSubmitted: (_) => _submit(),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(onPressed: _submit, child: const Text('Add')),
    ],
  );
}
