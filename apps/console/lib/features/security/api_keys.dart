import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';

/// identity-service's `/v1/orgs/{orgId}/api-keys` (S1-08, G-14), for the
/// signed-in person's own org.
class ApiKeysApi {
  ApiKeysApi(this._dio, this._token, this.orgId);

  final Dio _dio;
  final String _token;
  final String orgId;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<List<Json>> list() async {
    final response = await _dio.get<Object?>(
      '/v1/orgs/$orgId/api-keys',
      options: _options,
    );
    return [
      for (final row in ((response.data as Map)['rows'] as List))
        (row as Map).cast<String, dynamic>(),
    ];
  }

  /// Answers `{apiKey, key}`: `key` is the only time the secret is shown.
  Future<Json> create({
    required String name,
    required List<String> permissions,
    DateTime? expiresAt,
  }) async {
    final response = await _dio.post<Object?>(
      '/v1/orgs/$orgId/api-keys',
      data: {
        'name': name,
        'permissions': permissions,
        if (expiresAt != null) 'expiresAt': expiresAt.toUtc().toIso8601String(),
      },
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<void> revoke(String keyId) async {
    await _dio.delete<Object?>(
      '/v1/orgs/$orgId/api-keys/$keyId',
      options: _options,
    );
  }
}

final apiKeysApiProvider = Provider<ApiKeysApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return ApiKeysApi(
    ref.watch(apiProvider).dio,
    session.accessToken,
    session.orgId,
  );
});

final apiKeysProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  final api = ref.watch(apiKeysApiProvider);
  if (api == null) return const [];
  return api.list();
});

/// What H4 keeps from every key (07 §3.1): managing people, roles, grants and
/// other keys. The service refuses them too; they are simply not offered.
const _neverForKeys = {
  'user.manage',
  'role.manage',
  'grant.manage',
  'apikey.manage',
};

/// The org's API keys (S1-08): for software that works with the platform on
/// the org's behalf. Each key does only what it was given, never more than
/// the person who made it could, and never manages people or access.
class ApiKeysPage extends ConsumerWidget {
  const ApiKeysPage({super.key});

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final held = ref.read(knownPermissionsProvider) ?? const <String>{};
    final session = ref.read(sessionProvider);
    final offered = [
      for (final p in held)
        if (!_neverForKeys.contains(p) &&
            p != 'org.view' &&
            // H1: a reseller's key never reaches private data.
            !(session?.orgType == OrgType.reseller && privatePermission(p)))
          p,
    ]..sort();
    final created = await showDialog<Json>(
      context: context,
      builder: (_) => _CreateKeyDialog(offered: offered),
    );
    if (created == null || !context.mounted) return;
    ref.invalidate(apiKeysProvider);
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _NewKeyDialog(secret: '${created['key']}'),
    );
  }

  Future<void> _revoke(BuildContext context, WidgetRef ref, Json key) async {
    final l10n = context.l10n;
    final confirmed = await confirmAction(
      context,
      title: l10n.keyRevokeTitle('${key['name']}'),
      message: l10n.keyRevokeMessage,
      confirmLabel: l10n.keyRevoke,
    );
    if (!confirmed || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(apiKeysApiProvider)?.revoke('${key['id']}');
      showToast(messenger, currentL10n.keyRevoked('${key['name']}'));
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
    ref.invalidate(apiKeysProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final keys = ref.watch(apiKeysProvider);
    final theme = Theme.of(context);
    return PageFrame(
      children: [
        PageHeader(
          title: l10n.navApiKeys,
          subtitle: l10n.keySubtitle,
          actions: [
            FilledButton.icon(
              key: const ValueKey('api-key-new'),
              onPressed: () => _create(context, ref),
              icon: const Icon(Icons.add),
              label: Text(l10n.keyNew),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: keys,
            emptyText: l10n.keyEmpty,
            builder: (rows) => ListView(
              children: [
                for (final key in rows)
                  Card(
                    key: ValueKey('api-key-${key['id']}'),
                    child: ListTile(
                      leading: Icon(
                        key['active'] == true
                            ? Icons.key_outlined
                            : Icons.key_off_outlined,
                      ),
                      title: Text('${key['name']}'),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SelectableText(
                            _masked(key),
                            style: const TextStyle(fontFamily: 'monospace'),
                          ),
                          Text(
                            l10n.keyPermissionCount(
                              (key['permissions'] as List).length,
                            ),
                          ),
                          Text(
                            [
                              l10n.keyCreated(formatDate(key['createdAt'])),
                              key['lastUsedAt'] == null
                                  ? l10n.keyNeverUsed
                                  : l10n.keyLastUsed(
                                      formatDateTime(key['lastUsedAt']),
                                    ),
                              key['expiresAt'] == null
                                  ? l10n.keyNoEndDate
                                  : l10n.keyEnds(formatDate(key['expiresAt'])),
                            ].join(' · '),
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                      trailing: key['active'] == true
                          ? TextButton(
                              key: ValueKey('api-key-revoke-${key['id']}'),
                              onPressed: () => _revoke(context, ref, key),
                              child: Text(l10n.keyRevoke),
                            )
                          : Chip(
                              label: Text(
                                key['revokedAt'] != null
                                    ? l10n.keyStatusRevoked
                                    : l10n.keyStatusExpired,
                              ),
                            ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// A key as it can be told apart: its public id, the secret left out. The
/// key's own format, not words, so it is the same in every language.
String _masked(Json key) => 'key_${key['prefix']}_…';

/// Permissions that touch private data (07 §3.2), which a reseller's key
/// can never hold (H1). Matches `@cuc/authz`'s catalog.
bool privatePermission(String permission) => const {
  'recording.listen',
  'recording.download',
  'recording.delete',
  'recording.control',
  'call.control',
  'cdr.read',
  'cdr.export',
  'voicemail.access',
  'monitor.calls',
  'monitor.listen',
  'monitor.whisper',
  'monitor.barge',
  'analytics.view',
  'audit.read',
  'self.voicemail',
  'self.history',
  'self.recording',
  'self.calls',
}.contains(permission);

class _CreateKeyDialog extends ConsumerStatefulWidget {
  const _CreateKeyDialog({required this.offered});

  final List<String> offered;

  @override
  ConsumerState<_CreateKeyDialog> createState() => _CreateKeyDialogState();
}

class _CreateKeyDialogState extends ConsumerState<_CreateKeyDialog> {
  final _name = TextEditingController();
  final _chosen = <String>{};
  DateTime? _ends;
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickEnd() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _ends ?? now.add(const Duration(days: 365)),
      firstDate: now.add(const Duration(days: 1)),
      lastDate: now.add(const Duration(days: 365 * 5)),
    );
    if (picked != null) setState(() => _ends = picked);
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = l10n.keyNameRequired);
      return;
    }
    if (_chosen.isEmpty) {
      setState(() => _error = l10n.keyPermissionsRequired);
      return;
    }
    final api = ref.read(apiKeysApiProvider);
    if (api == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final created = await api.create(
        name: name,
        permissions: [..._chosen]..sort(),
        expiresAt: _ends,
      );
      if (mounted) Navigator.of(context).pop(created);
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final ends = _ends;
    return AlertDialog(
      title: Text(l10n.keyNew),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                key: const ValueKey('api-key-name'),
                controller: _name,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: l10n.keyName,
                  helperText: l10n.keyNameHelp,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                l10n.keyPermissions,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              Text(l10n.keyPermissionsHelp),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final p in widget.offered)
                    FilterChip(
                      key: ValueKey('api-key-permission-$p'),
                      label: Text(p),
                      selected: _chosen.contains(p),
                      onSelected: (on) => setState(
                        () => on ? _chosen.add(p) : _chosen.remove(p),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      ends == null
                          ? l10n.keyNoEndDate
                          : l10n.keyEnds(formatDate(ends.toIso8601String())),
                    ),
                  ),
                  TextButton(
                    key: const ValueKey('api-key-end'),
                    onPressed: _pickEnd,
                    child: Text(l10n.keySetEnd),
                  ),
                  if (ends != null)
                    TextButton(
                      onPressed: () => setState(() => _ends = null),
                      child: Text(l10n.keyClearEnd),
                    ),
                ],
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          key: const ValueKey('api-key-create'),
          onPressed: _saving ? null : _submit,
          child: Text(l10n.keyCreate),
        ),
      ],
    );
  }
}

/// The new key, shown this once, with a way to copy it.
class _NewKeyDialog extends StatelessWidget {
  const _NewKeyDialog({required this.secret});

  final String secret;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      title: Text(l10n.keyShownOnceTitle),
      content: SizedBox(
        width: 520,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.keyShownOnce),
            const SizedBox(height: 12),
            SelectableText(
              secret,
              key: const ValueKey('api-key-secret'),
              style: const TextStyle(fontFamily: 'monospace'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton.icon(
          key: const ValueKey('api-key-copy'),
          onPressed: () async {
            final messenger = ScaffoldMessenger.of(context);
            await Clipboard.setData(ClipboardData(text: secret));
            showToast(messenger, currentL10n.keyCopied);
          },
          icon: const Icon(Icons.copy),
          label: Text(l10n.keyCopy),
        ),
        FilledButton(
          key: const ValueKey('api-key-done'),
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.keyDone),
        ),
      ],
    );
  }
}
