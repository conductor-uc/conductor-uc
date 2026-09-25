import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/brand.dart';
import '../../core/file_pick.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import 'orgs_api.dart';

/// The brand fields typed into this editor, with labels and help. The three
/// images are uploaded separately (see [brandImages]).
const brandFields = <(String, String, String?)>[
  (
    'displayName',
    'Display name',
    'Shown in the console header and page title.',
  ),
  ('primaryColor', 'Primary color', 'Six-digit hex, like #4a148c.'),
  ('accentColor', 'Accent color', 'Six-digit hex, like #ffe082.'),
  ('supportEmail', 'Support email', null),
  ('supportUrl', 'Support URL', null),
  ('supportPhone', 'Support phone', null),
  ('emailFromName', 'Email sender name', null),
  (
    'emailFromAddress',
    'Email sender address',
    'Its domain must pass SPF and DKIM before use.',
  ),
  (
    'sipUserAgent',
    'SIP user agent',
    'Optional override for the SIP User-Agent header.',
  ),
  ('legalFooter', 'Legal footer', 'Shown at the bottom of sign-in and emails.'),
];

/// Opens the browser's file chooser for an image. A provider so tests can
/// choose a file without a browser.
final imagePickerProvider = Provider<Future<PickedFile?> Function()>(
  (ref) => pickImageFile,
);

/// The brand's images: the key each is saved under, its upload kind, and its
/// label.
const brandImages = <(String, String, String)>[
  ('logoLightKey', 'logoLight', 'Logo (for light backgrounds)'),
  ('logoDarkKey', 'logoDark', 'Logo (for dark backgrounds)'),
  ('faviconKey', 'favicon', 'Favicon'),
];

/// A reseller's brand (02 §5.4) and its console hostnames. A reseller edits
/// its own; the master opens one reseller's through [resellerId].
class BrandPage extends ConsumerStatefulWidget {
  const BrandPage({super.key, this.resellerId, this.pickImage = pickImageFile});

  final String? resellerId;

  /// Opens the file chooser; replaced in tests.
  final Future<PickedFile?> Function() pickImage;

  @override
  ConsumerState<BrandPage> createState() => _BrandPageState();
}

class _BrandPageState extends ConsumerState<BrandPage> {
  final _controllers = {
    for (final f in brandFields) f.$1: TextEditingController(),
  };
  final _assetKeys = <String, String?>{for (final i in brandImages) i.$1: null};
  bool _loaded = false;
  bool _busy = false;
  String? _error;
  String? _status;

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  String get _resellerId =>
      widget.resellerId ?? ref.read(sessionProvider)!.orgId;

  /// Live values as a [Brand], for the preview.
  Brand _draft() => Brand(
    displayName: _text('displayName'),
    primary: parseHex(_text('primaryColor')),
    accent: parseHex(_text('accentColor')),
    legalFooter: _text('legalFooter'),
  );

  String? _text(String key) {
    final t = _controllers[key]!.text.trim();
    return t.isEmpty ? null : t;
  }

  Future<void> _save() async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    for (final key in const ['primaryColor', 'accentColor']) {
      final value = _text(key);
      if (value != null && parseHex(value) == null) {
        setState(
          () => _error = 'Colors are six-digit hex values, like #4a148c.',
        );
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = null;
      _status = null;
    });
    try {
      await api.saveBrand(_resellerId, {
        for (final f in brandFields) f.$1: _text(f.$1),
        ..._assetKeys,
      });
      ref.invalidate(brandProviderFor(_resellerId));
      if (mounted) setState(() => _status = 'Brand saved.');
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _upload(String key, String kind) async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    final file = await ref.read(imagePickerProvider)();
    if (file == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _status = null;
    });
    try {
      final stored = await api.uploadBrandAsset(
        _resellerId,
        kind: kind,
        contentType: file.contentType,
        bytes: file.bytes,
      );
      if (mounted) {
        setState(() {
          _assetKeys[key] = stored;
          _status = 'Uploaded ${file.name}. Save the brand to use it.';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addHostname() async {
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    final fqdn = await showDialog<String>(
      context: context,
      builder: (_) => const _HostnameDialog(),
    );
    if (fqdn == null) return;
    try {
      await api.addConsoleHostname(_resellerId, fqdn);
      ref.invalidate(consoleHostnamesProvider(_resellerId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(problemMessage(e))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final master = session?.orgType == OrgType.master;
    if (session == null ||
        !(session.orgType == OrgType.reseller ||
            (master && widget.resellerId != null))) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text('Only a reseller has a brand to edit.'),
      );
    }
    final id = widget.resellerId ?? session.orgId;
    final saved = ref.watch(brandProviderFor(id));
    final hostnames = ref.watch(consoleHostnamesProvider(id));
    final textTheme = Theme.of(context).textTheme;
    // Someone who can read the brand but not change it sees it read-only.
    final canChange = ref.watch(canProvider('brand.manage'));

    // Not while it is reloading: the value then is the stale one from before
    // the last save.
    if (!_loaded && saved.hasValue && !saved.isLoading) {
      _loaded = true;
      final brand = saved.value;
      if (brand != null) {
        for (final f in brandFields) {
          _controllers[f.$1]!.text = (brand[f.$1] as String?) ?? '';
        }
        for (final i in brandImages) {
          _assetKeys[i.$1] = brand[i.$1] as String?;
        }
      }
    }
    if (saved.isLoading && !_loaded) {
      return const Center(child: CircularProgressIndicator());
    }

    final draft = _draft();
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Brand', style: textTheme.headlineSmall),
          const SizedBox(height: 4),
          const Text(
            'What your customers see: the console header, sign-in page, and emails. '
            'Leave everything blank for the neutral look.',
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 32,
            runSpacing: 16,
            crossAxisAlignment: WrapCrossAlignment.start,
            children: [
              SizedBox(
                width: 420,
                child: Column(
                  children: [
                    for (final f in brandFields)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: TextField(
                          controller: _controllers[f.$1],
                          readOnly: !canChange,
                          decoration: InputDecoration(
                            labelText: f.$2,
                            helperText: f.$3,
                          ),
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                    const SizedBox(height: 8),
                    for (final i in brandImages)
                      ListTile(
                        key: ValueKey('image-${i.$2}'),
                        contentPadding: EdgeInsets.zero,
                        title: Text(i.$3),
                        subtitle: Text(
                          _assetKeys[i.$1] == null
                              ? 'None'
                              : _assetKeys[i.$1]!.split('/').last,
                        ),
                        trailing: !canChange
                            ? null
                            : Wrap(
                                spacing: 4,
                                children: [
                                  OutlinedButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _upload(i.$1, i.$2),
                                    child: const Text('Upload'),
                                  ),
                                  if (_assetKeys[i.$1] != null)
                                    IconButton(
                                      tooltip: 'Remove ${i.$3}',
                                      icon: const Icon(Icons.close),
                                      onPressed: () => setState(
                                        () => _assetKeys[i.$1] = null,
                                      ),
                                    ),
                                ],
                              ),
                      ),
                    if (_error != null)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: ErrorText(_error!),
                      ),
                    if (_status != null)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text(_status!),
                      ),
                    const SizedBox(height: 8),
                    if (canChange)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: FilledButton(
                          onPressed: _busy ? null : _save,
                          child: const Text('Save brand'),
                        ),
                      ),
                  ],
                ),
              ),
              SizedBox(width: 320, child: _Preview(brand: draft)),
            ],
          ),
          const SizedBox(height: 32),
          Row(
            children: [
              Expanded(
                child: Text('Console hostnames', style: textTheme.titleMedium),
              ),
              if (canChange)
                OutlinedButton.icon(
                  onPressed: _addHostname,
                  icon: const Icon(Icons.add),
                  label: const Text('Add hostname'),
                ),
            ],
          ),
          const Text(
            'Point each name at the console with a DNS record; sign-in there shows this brand.',
          ),
          hostnames.when(
            loading: () => const LinearProgressIndicator(),
            error: (e, _) => Text(problemMessage(e)),
            data: (rows) => rows.isEmpty
                ? const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text('None yet.'),
                  )
                : Column(
                    children: [
                      for (final h in rows)
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.language),
                          title: Text('${h['fqdn']}'),
                          subtitle: Text('TLS: ${h['tlsStatus']}'),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

/// How the draft brand looks, drawn with the same theme builder the console uses.
class _Preview extends StatelessWidget {
  const _Preview({required this.brand});

  final Brand brand;

  @override
  Widget build(BuildContext context) {
    final theme = buildTheme(brand);
    return Theme(
      data: theme,
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              color: theme.colorScheme.primary,
              padding: const EdgeInsets.all(16),
              child: Text(
                brand.displayName ?? '',
                style: TextStyle(
                  color: theme.colorScheme.onPrimary,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Preview'),
                  const SizedBox(height: 12),
                  FilledButton(onPressed: () {}, child: const Text('Sign in')),
                  const SizedBox(height: 8),
                  Chip(
                    label: Text(
                      'Accent',
                      style: TextStyle(color: theme.colorScheme.onSecondary),
                    ),
                    backgroundColor: theme.colorScheme.secondary,
                  ),
                  if (brand.legalFooter != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      brand.legalFooter!,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HostnameDialog extends StatefulWidget {
  const _HostnameDialog();

  @override
  State<_HostnameDialog> createState() => _HostnameDialogState();
}

class _HostnameDialogState extends State<_HostnameDialog> {
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
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add hostname'),
      content: TextField(
        controller: _fqdn,
        autofocus: true,
        decoration: const InputDecoration(
          labelText: 'Hostname',
          helperText: 'For example portal.example.com',
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
}
