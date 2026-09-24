import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import 'certificates_api.dart';

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
        const PageHeader(
          title: 'Certificates',
          subtitle:
              'The certificates that secure phone connections and consoles are '
              'requested and renewed automatically.',
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
                const SizedBox(height: 24),
                Text(
                  'Platform certificates',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                AsyncBody<List<Json>>(
                  value: certificates,
                  emptyText: 'No certificates are wanted yet.',
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
    final termsUrl = '${widget.settings['termsUrl']}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "Let's Encrypt",
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            const Text(
              'One account for the whole platform. Let’s Encrypt writes to this '
              'address before a certificate expires.',
            ),
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
                    ? 'Ready. Certificates are requested and renewed automatically.'
                    : 'Not set up. No certificates are requested until an email '
                          'address is saved and the agreement is accepted.',
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Contact email',
                helperText: 'A mailbox someone reads.',
              ),
            ),
            const SizedBox(height: 16),
            const Text('Environment'),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'production', label: Text('Production')),
                ButtonSegment(
                  value: 'staging',
                  label: Text('Staging (testing)'),
                ),
              ],
              selected: {_directory},
              onSelectionChanged: (v) => setState(() {
                _directory = v.first;
                // The agreement belongs to one environment, so a change asks again.
                _agree = false;
              }),
            ),
            if (_directory == 'staging')
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  'Staging certificates are not trusted by any phone or browser. '
                  'Use it to try the setup, then switch to Production.',
                ),
              ),
            const SizedBox(height: 12),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _agree,
              onChanged: (v) => setState(() => _agree = v ?? false),
              title: const Text(
                'I agree to the Let’s Encrypt Subscriber Agreement',
              ),
              subtitle: widget.settings['termsAgreedAt'] == null
                  ? null
                  : Text('Agreed ${_date(widget.settings['termsAgreedAt'])}'),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () =>
                    launchUrl(Uri.parse(termsUrl), webOnlyWindowName: '_blank'),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: const Text('Read the agreement'),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: TextStyle(color: scheme.error)),
              ),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }
}

String _date(Object? iso) {
  final t = iso == null ? null : DateTime.tryParse('$iso')?.toLocal();
  if (t == null) return '—';
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.year}-${two(t.month)}-${two(t.day)}';
}

/// What a name's certificate is doing, and why if it is not working.
class CertificateTable extends StatelessWidget {
  const CertificateTable({super.key, required this.rows});

  final List<Json> rows;

  static const _status = {
    'active': 'Active',
    'pending': 'Waiting',
    'failed': 'Failing',
  };

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: DataTable(
        columns: const [
          DataColumn(label: Text('Name')),
          DataColumn(label: Text('Used for')),
          DataColumn(label: Text('Status')),
          DataColumn(label: Text('Expires')),
          DataColumn(label: Text('Notes')),
        ],
        rows: [
          for (final c in rows)
            DataRow(
              key: ValueKey('cert-${c['fqdn']}'),
              cells: [
                DataCell(Text('${c['fqdn']}')),
                DataCell(
                  Text(c['purpose'] == 'sip' ? 'Phones (SIP)' : 'Console'),
                ),
                DataCell(
                  Chip(
                    label: Text(_status['${c['status']}'] ?? '${c['status']}'),
                    backgroundColor: c['status'] == 'failed'
                        ? scheme.errorContainer
                        : c['status'] == 'active'
                        ? scheme.secondaryContainer
                        : null,
                  ),
                ),
                DataCell(Text(_date(c['notAfter']))),
                DataCell(
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: Text(
                      c['lastError'] == null
                          ? (c['status'] == 'pending' ? 'Being requested.' : '')
                          : '${c['lastError']} Trying again ${_date(c['nextAttemptAt'])}.',
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
            const Text(
              'Phones connect to sip.<your base domain> and sign in with their '
              'own domain. Each active base domain gets a certificate for that '
              'name automatically. For one to be issued, the name has to point '
              'at the platform’s address; a certificate that keeps failing '
              'usually means it does not yet.',
            ),
            const SizedBox(height: 12),
            AsyncBody<List<Json>>(
              value: rows,
              emptyText: 'No certificates yet. They appear once a base domain is verified.',
              builder: (data) => CertificateTable(rows: data),
            ),
          ],
        ),
      ),
    );
  }
}
