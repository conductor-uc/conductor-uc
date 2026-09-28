import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../cdr/call_records_page.dart' show parseDate;
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import '../voicemail/voicemail_api.dart' show openRecordingProvider;
import 'policies_panel.dart';
import 'recordings_api.dart';
import '../../core/format.dart';

/// "1.2 MB", "88 KB", "512 B".

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
    final l10n = context.l10n;
    if (ref.watch(tenantIdProvider) == null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(l10n.recChooseTenant),
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
      return PageFrame(
        children: [
          PageHeader(
            title: l10n.shellForbiddenTitle,
            subtitle: l10n.recForbiddenBody,
          ),
        ],
      );
    }
    final tabs = [
      if (canSee) l10n.recTabRecordings,
      if (canManage) l10n.recTabRules,
    ];
    final header = PageHeader(title: l10n.recTitle, subtitle: l10n.recSubtitle);
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
            emptyText: context.l10n.recNoMatches,
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
    final l10n = context.l10n;
    DateTime? day(TextEditingController c, String notADate) {
      final text = c.text.trim();
      if (text.isEmpty) return null;
      final parsed = parseDate(text);
      if (parsed == null) _error = notADate;
      return parsed;
    }

    _error = null;
    final from = day(_from, l10n.cdrFromNotDate);
    final to = _error == null ? day(_to, l10n.cdrToNotDate) : null;
    if (_error == null && from != null && to != null && to.isBefore(from)) {
      _error = l10n.cdrToBeforeFrom;
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
    final l10n = context.l10n;
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
                decoration: InputDecoration(
                  labelText: l10n.cdrFromDate,
                  hintText: context.l10n.commonDateHint,
                ),
                onSubmitted: (_) => _apply(),
              ),
            ),
            box(
              TextField(
                key: const ValueKey('rec-to'),
                controller: _to,
                decoration: InputDecoration(
                  labelText: l10n.cdrToDate,
                  hintText: context.l10n.commonDateHint,
                ),
                onSubmitted: (_) => _apply(),
              ),
            ),
            box(
              DropdownButtonFormField<String?>(
                key: const ValueKey('rec-direction'),
                initialValue: _direction,
                isExpanded: true,
                decoration: InputDecoration(labelText: l10n.recCalls),
                items: [
                  DropdownMenuItem(value: null, child: Text(l10n.cdrAll)),
                  for (final e in recordingDirectionsOf(l10n).entries)
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
                  decoration: InputDecoration(labelText: l10n.cdrExtension),
                  items: [
                    DropdownMenuItem(value: null, child: Text(l10n.cdrAny)),
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
                  decoration: InputDecoration(labelText: l10n.recQueue),
                  items: [
                    DropdownMenuItem(value: null, child: Text(l10n.cdrAny)),
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
            FilledButton(onPressed: _apply, child: Text(l10n.cdrSearch)),
            TextButton(onPressed: _clear, child: Text(l10n.cdrClear)),
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
    String Function(String reason) failure,
  ) async {
    final api = ref.read(recordingsApiProvider);
    final open = ref.read(openRecordingProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (api == null) return;
    try {
      await open(await address(api, '${r['id']}'));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(failure(problemMessage(e)))),
      );
    }
  }

  Future<void> _delete(Json r) async {
    final api = ref.read(recordingsApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.recDeleteTitle),
        content: Text(l10n.recDeleteBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.commonDelete),
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
        SnackBar(content: Text(l10n.recCouldNotDelete(problemMessage(e)))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
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
                columns: [
                  DataColumn(label: Text(l10n.cdrStarted)),
                  DataColumn(label: Text(l10n.recCalls)),
                  DataColumn(label: Text(l10n.recOn)),
                  DataColumn(label: Text(l10n.recLength), numeric: true),
                  DataColumn(label: Text(l10n.recSize), numeric: true),
                  DataColumn(label: Text(l10n.recStatus)),
                  DataColumn(label: Text(l10n.recKeptUntil)),
                  const DataColumn(label: Text('')),
                ],
                rows: [
                  for (final r in page.rows)
                    DataRow(
                      key: ValueKey('rec-${r['id']}'),
                      cells: [
                        DataCell(Text(formatDateTime(r['startedAt']))),
                        DataCell(
                          Text(
                            recordingDirectionsOf(l10n)['${r['direction']}'] ??
                                '${r['direction']}',
                          ),
                        ),
                        DataCell(Text(_where(r, titles))),
                        DataCell(Text(formatClockMs(r['durationMs'] as num?))),
                        DataCell(Text(formatBytes(r['sizeBytes'] as num?))),
                        DataCell(
                          Chip(
                            label: Text(
                              [
                                recordingStatusesOf(l10n)['${r['status']}'] ??
                                    '${r['status']}',
                                if (r['onDemand'] == true) l10n.recOnDemand,
                                if ((r['pauses'] as List?)?.isNotEmpty ?? false)
                                  l10n.recPaused,
                              ].join(' · '),
                            ),
                          ),
                        ),
                        DataCell(
                          Text(
                            r['retentionDate'] == null
                                ? l10n.recUntilDeleted
                                : formatDate(r['retentionDate']),
                          ),
                        ),
                        DataCell(
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (canListen && r['status'] == 'ready')
                                IconButton(
                                  tooltip: l10n.recPlay,
                                  icon: const Icon(Icons.play_arrow),
                                  onPressed: () => _open(
                                    r,
                                    (api, id) => api.playUrl(id),
                                    l10n.recCouldNotPlay,
                                  ),
                                ),
                              if (canDownload && r['status'] == 'ready')
                                IconButton(
                                  tooltip: l10n.recDownload,
                                  icon: const Icon(Icons.download_outlined),
                                  onPressed: () => _open(
                                    r,
                                    (api, id) => api.downloadUrl(id),
                                    l10n.recCouldNotDownload,
                                  ),
                                ),
                              if (canDelete)
                                IconButton(
                                  tooltip: l10n.commonDelete,
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
                child: Text(l10n.cdrLoadMore),
              ),
            ),
        ],
      ),
    );
  }
}
