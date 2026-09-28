import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/permissions.dart';
import '../../core/save_file.dart' as platform;
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
import '../cdr/call_records_page.dart' show urlOpenerProvider;
import '../cdr/cdr_api.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';

/// Saves bytes the console made as a file the browser downloads. Tests
/// replace it to see what would have been saved.
final fileSaverProvider =
    Provider<void Function(String name, String mimeType, Uint8List bytes)>(
      (ref) => platform.saveFile,
    );

/// org-service's `/v1/tenants/{t}/file-exports` (S1-16): a zip of the
/// tenant's recordings and voicemail.
class FileExportApi {
  FileExportApi(this._dio, this._token, this.tenantId);

  final Dio _dio;
  final String _token;
  final String tenantId;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  Future<Json> start() async {
    final response = await _dio.post<Object?>(
      '/v1/tenants/$tenantId/file-exports',
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> get(String id) async {
    final response = await _dio.get<Object?>(
      '/v1/tenants/$tenantId/file-exports/$id',
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }
}

final fileExportApiProvider = Provider<FileExportApi?>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final session = ref.watch(sessionProvider);
  if (tenant == null || session == null) return null;
  return FileExportApi(ref.watch(apiProvider).dio, session.accessToken, tenant);
});

/// Everything an organization has, to take away (S1-16, G-11 (2)), above all
/// before it is deleted: its settings, its call records and its recordings and
/// voicemail. Settings are configuration, so whoever may read them may export
/// them (a reseller too, acting as the tenant); calls and files are private,
/// so only the tenant's own administrator (or the master) sees those two (H1).
class ExportPage extends ConsumerWidget {
  const ExportPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return PageFrame(
      children: [
        PageHeader(title: l10n.navExportData, subtitle: l10n.expSubtitle),
        const SizedBox(height: 16),
        Expanded(
          child: ListView(
            children: [
              const _SettingsCard(),
              if (ref.watch(canProvider('cdr.export')))
                _JobCard(
                  key: const ValueKey('export-calls'),
                  name: 'calls',
                  icon: Icons.receipt_long_outlined,
                  title: l10n.expCallsTitle,
                  help: l10n.expCallsHelp,
                  start: () => ref.read(cdrApiProvider)!.startFullExport(),
                  poll: (id) => ref.read(cdrApiProvider)!.getExport(id),
                ),
              if (ref.watch(canProvider('data.export')))
                _JobCard(
                  key: const ValueKey('export-files'),
                  name: 'files',
                  icon: Icons.folder_zip_outlined,
                  title: l10n.expFilesTitle,
                  help: l10n.expFilesHelp,
                  start: () => ref.read(fileExportApiProvider)!.start(),
                  poll: (id) => ref.read(fileExportApiProvider)!.get(id),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    required this.icon,
    required this.title,
    required this.help,
    required this.children,
  });

  final IconData icon;
  final String title;
  final String help;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(help),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    ),
  );
}

/// The settings, gathered here from the same lists the console shows (every
/// PBX resource, trunks, routes and call flows), as one JSON file. Nothing
/// secret is in those lists, so nothing secret is in the file.
class _SettingsCard extends ConsumerStatefulWidget {
  const _SettingsCard();

  @override
  ConsumerState<_SettingsCard> createState() => _SettingsCardState();
}

class _SettingsCardState extends ConsumerState<_SettingsCard> {
  bool _busy = false;

  Future<void> _download() async {
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    final settings = <String, Object?>{};
    for (final def in allResources) {
      try {
        settings[def.key] = await api.list(def.key);
      } catch (_) {
        // Not readable by this person, or not there: left out.
      }
    }
    final body = const JsonEncoder.withIndent('  ').convert({
      'organization': api.tenantId,
      'exportedAt': DateTime.now().toUtc().toIso8601String(),
      'settings': settings,
    });
    ref.read(fileSaverProvider)(
      'settings.json',
      'application/json',
      Uint8List.fromList(utf8.encode(body)),
    );
    if (mounted) setState(() => _busy = false);
    showToast(messenger, currentL10n.expSettingsSaved);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return _Card(
      icon: Icons.settings_outlined,
      title: l10n.expSettingsTitle,
      help: l10n.expSettingsHelp,
      children: [
        FilledButton.icon(
          key: const ValueKey('export-settings-download'),
          onPressed: _busy ? null : _download,
          icon: const Icon(Icons.download_outlined),
          label: Text(l10n.expDownload),
        ),
      ],
    );
  }
}

/// An export built by a service in the background: start it, watch it, and
/// download it once it is ready. It can be built again at any time.
class _JobCard extends ConsumerStatefulWidget {
  const _JobCard({
    super.key,
    required this.name,
    required this.icon,
    required this.title,
    required this.help,
    required this.start,
    required this.poll,
  });

  /// For the buttons' keys: `export-<name>-prepare`, `export-<name>-download`.
  final String name;
  final IconData icon;
  final String title;
  final String help;
  final Future<Json> Function() start;
  final Future<Json> Function(String id) poll;

  @override
  ConsumerState<_JobCard> createState() => _JobCardState();
}

class _JobCardState extends ConsumerState<_JobCard> {
  Json? _job;
  Timer? _timer;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  bool get _working =>
      _job != null &&
      (_job!['status'] == 'pending' || _job!['status'] == 'processing');

  Future<void> _start() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final job = await widget.start();
      if (!mounted) return;
      setState(() => _job = job);
      _watch();
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  void _watch() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) async {
      final id = _job?['id'];
      if (id == null) return;
      try {
        final job = await widget.poll('$id');
        if (!mounted) return;
        setState(() => _job = job);
        if (!_working) _timer?.cancel();
      } catch (_) {
        // Asked again at the next tick.
      }
    });
  }

  Future<void> _download() async {
    final id = _job?['id'];
    if (id == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      // A fresh short-lived link each time (and each is audited).
      final job = await widget.poll('$id');
      final url = job['downloadUrl'];
      if (url is String) await ref.read(urlOpenerProvider)(url);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final job = _job;
    final status = job?['status'];
    return _Card(
      icon: widget.icon,
      title: widget.title,
      help: widget.help,
      children: [
        if (_working) ...[
          Text(l10n.expPreparing),
          const SizedBox(height: 8),
          const LinearProgressIndicator(),
        ] else if (status == 'failed')
          Text(
            l10n.expFailed,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          )
        else if (status == 'ready')
          Text(
            job?['sizeBytes'] is num
                ? l10n.expReadySize(formatBytes(job!['sizeBytes'] as num))
                : l10n.expReady,
          ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            if (status == 'ready')
              FilledButton.icon(
                key: ValueKey('export-${widget.name}-download'),
                onPressed: _download,
                icon: const Icon(Icons.download_outlined),
                label: Text(l10n.expDownload),
              ),
            OutlinedButton(
              key: ValueKey('export-${widget.name}-prepare'),
              onPressed: _working ? null : _start,
              child: Text(job == null ? l10n.expPrepare : l10n.expPrepareAgain),
            ),
          ],
        ),
      ],
    );
  }
}
