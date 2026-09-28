import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import 'certificates_api.dart';
import '../../core/format.dart';

/// The platform operator's certificate settings: the one Let's Encrypt account
/// every certificate is requested under, and the platform's own certificates.
class CertificatesPage extends ConsumerWidget {
  const CertificatesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(acmeSettingsProvider);
    final certificates = ref.watch(platformCertificatesProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: context.l10n.navCertificates,
          subtitle: context.l10n.certSubtitle,
        ),
        const SizedBox(height: 16),
        Expanded(
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AsyncBody<Json>(
                  value: settings,
                  emptyText: '',
                  isEmpty: (_) => false,
                  builder: (s) => LetsEncryptCard(
                    key: ValueKey(
                      '${s['contactEmail']}|${s['directory']}|${s['termsAgreed']}',
                    ),
                    settings: s,
                  ),
                ),
                const SizedBox(height: 16),
                AsyncBody<Json>(
                  value: ref.watch(networkSettingsProvider),
                  emptyText: '',
                  isEmpty: (_) => false,
                  builder: (n) => PublicAddressCard(
                    key: ValueKey('${n['publicAddress']}'),
                    settings: n,
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  context.l10n.certPlatformHeading,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                AsyncBody<List<Json>>(
                  value: certificates,
                  emptyText: context.l10n.certEmptyPlatform,
                  builder: (rows) => CertificateTable(rows: rows),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// The address the Let's Encrypt account is registered to, which Let's Encrypt
/// to use, and the agreement to its terms. Nothing is requested until an
/// address is saved and the agreement is accepted.
class LetsEncryptCard extends ConsumerStatefulWidget {
  const LetsEncryptCard({super.key, required this.settings});

  final Json settings;

  @override
  ConsumerState<LetsEncryptCard> createState() => _LetsEncryptCardState();
}

class _LetsEncryptCardState extends ConsumerState<LetsEncryptCard> {
  late final TextEditingController _email;
  late String _directory;
  late bool _agree;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _email = TextEditingController(
      text: '${widget.settings['contactEmail'] ?? ''}',
    );
    _directory = '${widget.settings['directory']}';
    _agree = widget.settings['termsAgreed'] == true;
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final api = ref.read(certificatesApiProvider);
    if (api == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final email = _email.text.trim();
      await api.saveAcmeSettings(
        contactEmail: email.isEmpty ? null : email,
        directory: _directory,
        agreeToTerms: _agree,
      );
      ref.invalidate(acmeSettingsProvider);
      ref.invalidate(platformCertificatesProvider);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.settings['ready'] == true;
    final scheme = Theme.of(context).colorScheme;
    final canChange = ref.watch(canProvider('domain.manage'));
    final termsUrl = '${widget.settings['termsUrl']}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              context.l10n.certLetsEncrypt,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(context.l10n.certLetsEncryptIntro),
            const SizedBox(height: 12),
            Container(
              key: const ValueKey('acme-status'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: ready
                    ? scheme.secondaryContainer
                    : scheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                ready
                    ? context.l10n.certAcmeReady
                    : context.l10n.certAcmeNotSetUp,
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _email,
              readOnly: !canChange,
              keyboardType: TextInputType.emailAddress,
              decoration: InputDecoration(
                labelText: context.l10n.certContactEmail,
                helperText: context.l10n.certContactEmailHelp,
              ),
            ),
            const SizedBox(height: 16),
            Text(context.l10n.certEnvironment),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(
                  value: 'production',
                  label: Text(context.l10n.certProduction),
                ),
                ButtonSegment(
                  value: 'staging',
                  label: Text(context.l10n.certStaging),
                ),
              ],
              selected: {_directory},
              onSelectionChanged: !canChange
                  ? null
                  : (v) => setState(() {
                      _directory = v.first;
                      // The agreement belongs to one environment, so a change asks again.
                      _agree = false;
                    }),
            ),
            if (_directory == 'staging')
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(context.l10n.certStagingNote),
              ),
            const SizedBox(height: 12),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _agree,
              onChanged: canChange
                  ? (v) => setState(() => _agree = v ?? false)
                  : null,
              title: Text(context.l10n.certAgree),
              subtitle: widget.settings['termsAgreedAt'] == null
                  ? null
                  : Text(
                      context.l10n.certAgreed(
                        formatDate(widget.settings['termsAgreedAt']),
                      ),
                    ),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                onPressed: () =>
                    launchUrl(Uri.parse(termsUrl), webOnlyWindowName: '_blank'),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(context.l10n.certReadAgreement),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: TextStyle(color: scheme.error)),
              ),
            const SizedBox(height: 8),
            if (canChange)
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(context.l10n.commonSave),
              ),
          ],
        ),
      ),
    );
  }
}

/// Where the platform is reached from the internet. Resellers are told to point
/// their names here, and Let's Encrypt has to be able to reach it on port 80.
class PublicAddressCard extends ConsumerStatefulWidget {
  const PublicAddressCard({super.key, required this.settings});

  final Json settings;

  @override
  ConsumerState<PublicAddressCard> createState() => _PublicAddressCardState();
}

class _PublicAddressCardState extends ConsumerState<PublicAddressCard> {
  late final TextEditingController _address;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _address = TextEditingController(
      text: '${widget.settings['publicAddress'] ?? ''}',
    );
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final api = ref.read(certificatesApiProvider);
    if (api == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final value = _address.text.trim();
      await api.savePublicAddress(value.isEmpty ? null : value);
      ref.invalidate(networkSettingsProvider);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final canChange = ref.watch(canProvider('domain.manage'));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              context.l10n.certPublicAddress,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(context.l10n.certPublicAddressIntro),
            const SizedBox(height: 12),
            TextField(
              controller: _address,
              readOnly: !canChange,
              decoration: InputDecoration(
                labelText: context.l10n.certPublicAddress,
                helperText: context.l10n.certPublicAddressHelp,
              ),
              onSubmitted: (_) => _save(),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: TextStyle(color: scheme.error)),
              ),
            const SizedBox(height: 12),
            if (canChange)
              FilledButton(
                key: const ValueKey('save-public-address'),
                onPressed: _saving ? null : _save,
                child: Text(context.l10n.certSaveAddress),
              ),
          ],
        ),
      ),
    );
  }
}

/// What a name's certificate is doing, and why if it is not working.
class CertificateTable extends StatelessWidget {
  const CertificateTable({super.key, required this.rows});

  final List<Json> rows;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final status = {
      'active': l10n.certStatusActive,
      'pending': l10n.certStatusPending,
      'failed': l10n.certStatusFailed,
    };
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: DataTable(
        columns: [
          DataColumn(label: Text(l10n.fieldName)),
          DataColumn(label: Text(l10n.certUsedFor)),
          DataColumn(label: Text(l10n.certColumnStatus)),
          DataColumn(label: Text(l10n.certColumnExpires)),
          DataColumn(label: Text(l10n.certColumnNotes)),
        ],
        rows: [
          for (final c in rows)
            DataRow(
              key: ValueKey('cert-${c['fqdn']}'),
              cells: [
                DataCell(Text('${c['fqdn']}')),
                DataCell(
                  Text(
                    c['purpose'] == 'sip'
                        ? l10n.certPurposeSip
                        : l10n.certPurposeConsole,
                  ),
                ),
                DataCell(
                  Chip(
                    label: Text(status['${c['status']}'] ?? '${c['status']}'),
                    backgroundColor: c['status'] == 'failed'
                        ? scheme.errorContainer
                        : c['status'] == 'active'
                        ? scheme.secondaryContainer
                        : null,
                  ),
                ),
                DataCell(Text(formatDate(c['notAfter']))),
                DataCell(
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: Text(
                      c['lastError'] == null
                          ? (c['status'] == 'pending'
                                ? l10n.certBeingRequested
                                : '')
                          : l10n.certLastError(
                              '${c['lastError']}',
                              formatDate(c['nextAttemptAt']),
                            ),
                    ),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// A reseller's certificates, with what they need from DNS.
class CertificatesPanel extends ConsumerWidget {
  const CertificatesPanel({super.key, required this.resellerId});

  final String resellerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rows = ref.watch(resellerCertificatesProvider(resellerId));
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(context.l10n.certResellerIntro),
            const SizedBox(height: 12),
            AsyncBody<Json>(
              value: ref.watch(resellerDnsRecordsProvider(resellerId)),
              emptyText: '',
              isEmpty: (_) => false,
              builder: (d) => DnsRecordsTable(records: d),
            ),
            const SizedBox(height: 12),
            AsyncBody<List<Json>>(
              value: rows,
              emptyText: context.l10n.certResellerEmpty,
              builder: (data) => CertificateTable(rows: data),
            ),
          ],
        ),
      ),
    );
  }
}

/// The DNS records a reseller publishes so its names reach the platform, to copy.
class DnsRecordsTable extends StatelessWidget {
  const DnsRecordsTable({super.key, required this.records});

  final Json records;

  @override
  Widget build(BuildContext context) {
    final rows = [
      for (final r in records['rows'] as List)
        (r as Map).cast<String, dynamic>(),
    ];
    final theme = Theme.of(context);
    if (records['publicAddress'] == null) {
      return Text(
        context.l10n.certDnsNoAddress,
        key: const ValueKey('dns-no-address'),
      );
    }
    if (rows.isEmpty) return const SizedBox.shrink();
    const mono = TextStyle(fontFamily: 'monospace');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(context.l10n.certDnsHeading, style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(context.l10n.certDnsIntro),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: DataTable(
            key: const ValueKey('dns-records'),
            columns: [
              DataColumn(label: Text(context.l10n.fieldName)),
              DataColumn(label: Text(context.l10n.certColumnType)),
              DataColumn(label: Text(context.l10n.certColumnValue)),
              DataColumn(label: Text(context.l10n.certUsedFor)),
            ],
            rows: [
              for (final r in rows)
                DataRow(
                  cells: [
                    DataCell(SelectableText('${r['name']}', style: mono)),
                    DataCell(Text('${r['type']}')),
                    DataCell(SelectableText('${r['value']}', style: mono)),
                    DataCell(
                      Text(
                        r['purpose'] == 'sip'
                            ? context.l10n.certPurposeSip
                            : context.l10n.certPurposeConsole,
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Text(context.l10n.navCertificates, style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
      ],
    );
  }
}
