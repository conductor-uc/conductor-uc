import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../cdr/call_records_page.dart' show formatWhen, parseDate;
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import '../voicemail/voicemail_api.dart' show openRecordingProvider;
import '../voicemail/voicemail_page.dart' show formatLength;
import 'policies_panel.dart';
import 'recordings_api.dart';

/// "1.2 MB", "88 KB", "512 B".
String formatBytes(num? bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return '${bytes.round()} B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

/// The tenant's call recordings and the rules that decide what is recorded.
/// Recordings are `private` tenant data, so this is for the tenant's own people
/// and the platform operator, never a reseller (rule H1). What each person may
/// do (listen, download, delete, edit the rules) follows the permissions they
/// hold; the service checks every request again, and a supervisor holding a
/// grant for one queue is shown only that queue's recordings.
class RecordingsPage extends ConsumerWidget {
  const RecordingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(tenantIdProvider) == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text('Choose a tenant to see its recordings.'),
      );
    }
    final canSee =
        ref.watch(canProvider('recording.listen')) ||
        ref.watch(canProvider('recording.download')) ||
        ref.watch(canProvider('recording.delete'));
    // The rules are shown to someone who can read them; changing them is the
    // panel's own check (recording.policy.manage).
    final canManage = ref.watch(canProvider('recording.policy.read'));
    if (!canSee && !canManage) {
      return const PageFrame(
        children: [
          PageHeader(
            title: 'Not available to you',
            subtitle: "Your role doesn't include recordings.",
          ),
        ],
      );
    }
    final tabs = [if (canSee) 'Recordings', if (canManage) 'Rules'];
    final header = const PageHeader(
      title: 'Recordings',
      subtitle:
          'Recorded calls, newest first, and the rules that decide which calls '
          'are recorded.',
    );
    if (tabs.length == 1) {
      return PageFrame(
        children: [
          header,
          const SizedBox(height: 12),
          Expanded(
            child: canSee ? const _RecordingsTab() : const PoliciesPanel(),
          ),
        ],
      );
    }
    return DefaultTabController(
      length: tabs.length,
      child: PageFrame(
        children: [
          header,
          TabBar(tabs: [for (final t in tabs) Tab(text: t)]),
          const SizedBox(height: 12),
          const Expanded(
            child: TabBarView(children: [_RecordingsTab(), PoliciesPanel()]),
          ),
        ],
      ),
    );
  }
}

class _RecordingsTab extends ConsumerWidget {
  const _RecordingsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(recordingListProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _FilterBar(),
        const SizedBox(height: 12),
        Expanded(
          child: AsyncBody<RecordingsResult>(
            value: list,
            emptyText: 'No recordings match.',
            isEmpty: (page) => page.rows.isEmpty,
            builder: (page) => _RecordingTable(page: page),
          ),
        ),
      ],
    );
  }
}

class _FilterBar extends ConsumerStatefulWidget {
  const _FilterBar();

  @override
  ConsumerState<_FilterBar> createState() => _FilterBarState();
}

class _FilterBarState extends ConsumerState<_FilterBar> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  String? _direction;
  String? _extensionId;
  String? _queueId;
  String? _error;

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    super.dispose();
  }

  void _apply() {
    DateTime? day(TextEditingController c, String label) {
      final text = c.text.trim();
      if (text.isEmpty) return null;
      final parsed = parseDate(text);
      if (parsed == null) _error = '$label must be a date such as 2026-09-24.';
      return parsed;
    }

    _error = null;
    final from = day(_from, 'From');
    final to = _error == null ? day(_to, 'To') : null;
    if (_error == null && from != null && to != null && to.isBefore(from)) {
      _error = 'To must not be before From.';
    }
    if (_error != null) {
      setState(() {});
      return;
    }
    ref
        .read(recordingFilterProvider.notifier)
        .set(
          RecordingFilter(
            from: from,
            to: to,
            direction: _direction,
            extensionId: _extensionId,
            queueId: _queueId,
          ),
        );
    setState(() {});
  }

  void _clear() {
    _from.clear();
    _to.clear();
    _direction = null;
    _extensionId = null;
    _queueId = null;
    _error = null;
    ref.read(recordingFilterProvider.notifier).set(const RecordingFilter());
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final extensions =
        ref.watch(rowsProvider('extensions')).asData?.value ?? const <Json>[];
    final queues =
        ref.watch(rowsProvider('queues')).asData?.value ?? const <Json>[];
    Widget box(Widget child, [double width = 150]) =>
        SizedBox(width: width, child: child);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            box(
              TextField(
                key: const ValueKey('rec-from'),
                controller: _from,
                decoration: const InputDecoration(
                  labelText: 'From date',
                  hintText: 'YYYY-MM-DD',
                ),
                onSubmitted: (_) => _apply(),
              ),
            ),
            box(
              TextField(
                key: const ValueKey('rec-to'),
                controller: _to,
                decoration: const InputDecoration(
                  labelText: 'To date',
                  hintText: 'YYYY-MM-DD',
                ),
                onSubmitted: (_) => _apply(),
              ),
            ),
            box(
              DropdownButtonFormField<String?>(
                key: const ValueKey('rec-direction'),
                initialValue: _direction,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Calls'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('All')),
                  for (final e in recordingDirections.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) => setState(() => _direction = v),
              ),
              190,
            ),
            if (extensions.isNotEmpty)
              box(
                DropdownButtonFormField<String?>(
                  key: const ValueKey('rec-extension'),
                  initialValue: _extensionId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Extension'),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Any')),
                    for (final e in extensions)
                      DropdownMenuItem(
                        value: '${e['id']}',
                        child: Text(extensionsDef.titleOf(e)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _extensionId = v),
                ),
                220,
              ),
            if (queues.isNotEmpty)
              box(
                DropdownButtonFormField<String?>(
                  key: const ValueKey('rec-queue'),
                  initialValue: _queueId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Queue'),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Any')),
                    for (final q in queues)
                      DropdownMenuItem(
                        value: '${q['id']}',
                        child: Text(queuesDef.titleOf(q)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _queueId = v),
                ),
                190,
              ),
            FilledButton(onPressed: _apply, child: const Text('Search')),
            TextButton(onPressed: _clear, child: const Text('Clear')),
          ],
        ),
        if (_error != null) ErrorText(_error!),
      ],
    );
  }
}

class _RecordingTable extends ConsumerStatefulWidget {
  const _RecordingTable({required this.page});

  final RecordingsResult page;

  @override
  ConsumerState<_RecordingTable> createState() => _RecordingTableState();
}

class _RecordingTableState extends ConsumerState<_RecordingTable> {
  bool _loading = false;

  Future<void> _more() async {
    setState(() => _loading = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(recordingListProvider.notifier).loadMore();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// What a recording was on: the extension, or the queue, or the number.
  String _where(Json r, Map<String, String> titles) {
    final parts = [
      for (final key in const ['extensionId', 'peerExtensionId', 'queueId'])
        if (r[key] != null) titles['${r[key]}'] ?? '${r[key]}',
    ];
    return parts.isEmpty ? '—' : parts.join(', ');
  }

  Future<void> _open(
    Json r,
    Future<String> Function(RecordingsApi api, String id) address,
    String failure,
  ) async {
    final api = ref.read(recordingsApiProvider);
    final open = ref.read(openRecordingProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (api == null) return;
    try {
      await open(await address(api, '${r['id']}'));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('$failure: ${problemMessage(e)}')),
      );
    }
  }

  Future<void> _delete(Json r) async {
    final api = ref.read(recordingsApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete recording?'),
        content: const Text(
          'The audio is removed and cannot be recovered. That it was deleted, '
          'and by whom, is kept in the audit trail.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.delete('${r['id']}');
      ref.invalidate(recordingListProvider);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not delete it: ${problemMessage(e)}')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = widget.page;
    final canListen = ref.watch(canProvider('recording.listen'));
    final canDownload = ref.watch(canProvider('recording.download'));
    final canDelete = ref.watch(canProvider('recording.delete'));
    final extensions =
        ref.watch(rowsProvider('extensions')).asData?.value ?? const <Json>[];
    final queues =
        ref.watch(rowsProvider('queues')).asData?.value ?? const <Json>[];
    final titles = {
      for (final e in extensions) '${e['id']}': extensionsDef.titleOf(e),
      for (final q in queues) '${q['id']}': queuesDef.titleOf(q),
    };
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minWidth: MediaQuery.sizeOf(context).width - 320,
              ),
              child: DataTable(
                showCheckboxColumn: false,
                columns: const [
                  DataColumn(label: Text('Started')),
                  DataColumn(label: Text('Calls')),
                  DataColumn(label: Text('On')),
                  DataColumn(label: Text('Length'), numeric: true),
                  DataColumn(label: Text('Size'), numeric: true),
                  DataColumn(label: Text('Status')),
                  DataColumn(label: Text('Kept until')),
                  DataColumn(label: Text('')),
                ],
                rows: [
                  for (final r in page.rows)
                    DataRow(
                      key: ValueKey('rec-${r['id']}'),
                      cells: [
                        DataCell(Text(formatWhen(r['startedAt']))),
                        DataCell(
                          Text(
                            recordingDirections['${r['direction']}'] ??
                                '${r['direction']}',
                          ),
                        ),
                        DataCell(Text(_where(r, titles))),
                        DataCell(Text(formatLength(r['durationMs'] as num?))),
                        DataCell(Text(formatBytes(r['sizeBytes'] as num?))),
                        DataCell(
                          Chip(
                            label: Text(
                              [
                                recordingStatuses['${r['status']}'] ??
                                    '${r['status']}',
                                if (r['onDemand'] == true) 'on demand',
                                if ((r['pauses'] as List?)?.isNotEmpty ?? false)
                                  'paused',
                              ].join(' · '),
                            ),
                          ),
                        ),
                        DataCell(
                          Text(
                            r['retentionDate'] == null
                                ? 'Until deleted'
                                : formatWhen(r['retentionDate'])
                                      .split(' ')
                                      .first,
                          ),
                        ),
                        DataCell(
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (canListen && r['status'] == 'ready')
                                IconButton(
                                  tooltip: 'Play',
                                  icon: const Icon(Icons.play_arrow),
                                  onPressed: () => _open(
                                    r,
                                    (api, id) => api.playUrl(id),
                                    'Could not play it',
                                  ),
                                ),
                              if (canDownload && r['status'] == 'ready')
                                IconButton(
                                  tooltip: 'Download',
                                  icon: const Icon(Icons.download_outlined),
                                  onPressed: () => _open(
                                    r,
                                    (api, id) => api.downloadUrl(id),
                                    'Could not download it',
                                  ),
                                ),
                              if (canDelete)
                                IconButton(
                                  tooltip: 'Delete',
                                  icon: const Icon(Icons.delete_outline),
                                  onPressed: () => _delete(r),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
          if (page.nextCursor != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: OutlinedButton(
                onPressed: _loading ? null : _more,
                child: const Text('Load more'),
              ),
            ),
        ],
      ),
    );
  }
}
