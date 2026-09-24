import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import 'cdr_api.dart';

/// Opens a download address in a new tab. A provider so tests can watch it
/// instead of leaving the app.
final urlOpenerProvider = Provider<Future<void> Function(String url)>(
  (ref) =>
      (url) => launchUrl(Uri.parse(url), webOnlyWindowName: '_blank'),
);

const _directions = {
  'inbound': 'Inbound',
  'outbound': 'Outbound',
  'internal': 'Internal',
};

const _dispositions = {
  'answered': 'Answered',
  'no_answer': 'No answer',
  'busy': 'Busy',
  'failed': 'Failed',
  'cancelled': 'Cancelled',
  'node_failure': 'Failed (platform)',
};

String _two(int n) => n.toString().padLeft(2, '0');

/// A date as the filter fields write it: `2026-09-24`.
String formatDate(DateTime d) => '${d.year}-${_two(d.month)}-${_two(d.day)}';

/// An instant from the service, shown in the viewer's own time zone.
String formatWhen(Object? iso) {
  final d = iso is String ? DateTime.tryParse(iso)?.toLocal() : null;
  if (d == null) return '—';
  return '${formatDate(d)} ${_two(d.hour)}:${_two(d.minute)}:${_two(d.second)}';
}

String formatDuration(Object? seconds) {
  final s = seconds is num ? seconds.toInt() : 0;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  return h > 0 ? '$h:${_two(m)}:${_two(s % 60)}' : '$m:${_two(s % 60)}';
}

/// A whole-day date typed as `YYYY-MM-DD`, or null when it is not one.
DateTime? parseDate(String text) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(text.trim());
  if (m == null) return null;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  final date = DateTime(y, mo, d);
  return date.month == mo && date.day == d ? date : null;
}

/// The tenant's call records: a filtered, paged list, a detail view for each
/// call, and CSV exports. Call records are `private` tenant data, so this is
/// for the tenant's own people and the platform operator, never a reseller
/// (rule H1); the navigation hides it from them and the service refuses them.
class CallRecordsPage extends ConsumerWidget {
  const CallRecordsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (ref.watch(tenantIdProvider) == null) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Text('Choose a tenant to see its call records.'),
      );
    }
    if (!ref.watch(canProvider('cdr.read'))) {
      return const PageFrame(
        children: [
          PageHeader(
            title: 'Not available to you',
            subtitle: "Your role doesn't include call records.",
          ),
        ],
      );
    }
    final canExport = ref.watch(canProvider('cdr.export'));
    final list = ref.watch(cdrListProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: 'Call records',
          subtitle: 'Every call to, from and inside this tenant, newest first.',
          actions: [
            if (canExport)
              OutlinedButton.icon(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => const ExportDialog(),
                ),
                icon: const Icon(Icons.download_outlined),
                label: const Text('Export CSV'),
              ),
          ],
        ),
        const SizedBox(height: 12),
        const _FilterBar(),
        if (canExport) const ExportsPanel(),
        const SizedBox(height: 12),
        Expanded(
          child: AsyncBody<CdrPage>(
            value: list,
            emptyText: 'No calls match.',
            isEmpty: (page) => page.rows.isEmpty,
            builder: (page) => _CallTable(page: page),
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
  final _number = TextEditingController();
  final _did = TextEditingController();
  String? _direction;
  String? _error;

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    _number.dispose();
    _did.dispose();
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
    String? text(TextEditingController c) =>
        c.text.trim().isEmpty ? null : c.text.trim();
    ref
        .read(cdrFilterProvider.notifier)
        .set(
          CdrFilter(
            from: from,
            to: to,
            direction: _direction,
            number: text(_number),
            did: text(_did),
          ),
        );
    setState(() {});
  }

  void _clear() {
    for (final c in [_from, _to, _number, _did]) {
      c.clear();
    }
    _direction = null;
    _error = null;
    ref.read(cdrFilterProvider.notifier).set(const CdrFilter());
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final extensions =
        ref.watch(rowsProvider('extensions')).asData?.value ?? const <Json>[];
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
                key: const ValueKey('cdr-from'),
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
                key: const ValueKey('cdr-to'),
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
                key: const ValueKey('cdr-direction'),
                initialValue: _direction,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Direction'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('All')),
                  for (final e in _directions.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) => setState(() => _direction = v),
              ),
            ),
            box(
              TextField(
                key: const ValueKey('cdr-number'),
                controller: _number,
                decoration: const InputDecoration(
                  labelText: 'Number',
                  helperText: 'Caller, callee or dialed',
                ),
                onSubmitted: (_) => _apply(),
              ),
              170,
            ),
            if (extensions.isNotEmpty)
              box(
                DropdownButtonFormField<String?>(
                  key: const ValueKey('cdr-extension'),
                  initialValue: null,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Extension',
                    helperText: 'Fills in its number',
                  ),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Any')),
                    for (final e in extensions)
                      DropdownMenuItem(
                        value: '${e['number']}',
                        child: Text(extensionsDef.titleOf(e)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _number.text = v ?? ''),
                ),
                220,
              ),
            box(
              TextField(
                key: const ValueKey('cdr-did'),
                controller: _did,
                decoration: const InputDecoration(
                  labelText: 'Phone number called',
                  hintText: '+14155550100',
                ),
                onSubmitted: (_) => _apply(),
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

class _CallTable extends ConsumerStatefulWidget {
  const _CallTable({required this.page});

  final CdrPage page;

  @override
  ConsumerState<_CallTable> createState() => _CallTableState();
}

class _CallTableState extends ConsumerState<_CallTable> {
  bool _loading = false;

  Future<void> _more() async {
    setState(() => _loading = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(cdrListProvider.notifier).loadMore();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final page = widget.page;
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
                  DataColumn(label: Text('Direction')),
                  DataColumn(label: Text('From')),
                  DataColumn(label: Text('To')),
                  DataColumn(label: Text('Duration')),
                  DataColumn(label: Text('Result')),
                ],
                rows: [
                  for (final r in page.rows)
                    DataRow(
                      key: ValueKey('cdr-${r['id']}'),
                      onSelectChanged: (_) => showDialog<void>(
                        context: context,
                        builder: (_) => CallDetailDialog(id: '${r['id']}'),
                      ),
                      cells: [
                        DataCell(Text(formatWhen(r['startAt']))),
                        DataCell(
                          Text(
                            _directions['${r['direction']}'] ??
                                '${r['direction']}',
                          ),
                        ),
                        DataCell(Text(_party(r['fromNumber'], r['fromName']))),
                        DataCell(Text('${r['toNumber']}')),
                        DataCell(Text(formatDuration(r['durationSec']))),
                        DataCell(
                          Text(
                            _dispositions['${r['disposition']}'] ??
                                '${r['disposition']}',
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

String _party(Object? number, Object? name) =>
    name is String && name.isNotEmpty ? '$number ($name)' : '$number';

/// Everything the service recorded about one call.
class CallDetailDialog extends ConsumerWidget {
  const CallDetailDialog({super.key, required this.id});

  final String id;

  String _named(WidgetRef ref, String resource, Object? id) {
    if (id == null) return '—';
    final rows = ref.watch(rowsProvider(resource)).asData?.value;
    final match = rows?.where((r) => r['id'] == id);
    if (match == null || match.isEmpty) return '$id';
    return resourceByKey(resource).titleOf(match.first);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final call = ref.watch(cdrDetailProvider(id));
    return AlertDialog(
      title: const Text('Call details'),
      content: SizedBox(
        width: 460,
        child: call.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => ErrorText(problemMessage(e)),
          data: (c) {
            final extensions = [...?(c['extensionIds'] as List?)];
            final recordings = [...?(c['recordingIds'] as List?)];
            final rows = <(String, String)>[
              (
                'Direction',
                _directions['${c['direction']}'] ?? '${c['direction']}',
              ),
              (
                'Result',
                _dispositions['${c['disposition']}'] ?? '${c['disposition']}',
              ),
              ('Started', formatWhen(c['startAt'])),
              ('Answered', formatWhen(c['answerAt'])),
              ('Ended', formatWhen(c['endAt'])),
              ('Duration', formatDuration(c['durationSec'])),
              ('Billable time', formatDuration(c['billableSec'])),
              ('From', _party(c['fromNumber'], c['fromName'])),
              ('To', '${c['toNumber']}'),
              ('Dialed', '${c['dialedNumber']}'),
              ('Phone number', '${c['did'] ?? '—'}'),
              ('Trunk', _named(ref, 'trunks', c['trunkId'])),
              (
                'Extensions',
                extensions.isEmpty
                    ? '—'
                    : extensions
                          .map((e) => _named(ref, 'extensions', e))
                          .join(', '),
              ),
              ('Queue', _named(ref, 'queues', c['queueId'])),
              ('Call flow', _named(ref, 'flows', c['flowId'])),
              ('Ended because', '${c['hangupCause']}'),
              ('Hung up by', '${c['hangupBy']}'),
              (
                'Recordings',
                recordings.isEmpty ? 'None' : '${recordings.length}',
              ),
            ];
            return SingleChildScrollView(
              child: Table(
                columnWidths: const {0: FixedColumnWidth(130)},
                children: [
                  for (final (label, value) in rows)
                    TableRow(
                      children: [
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text(
                            label,
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text(value),
                        ),
                      ],
                    ),
                ],
              ),
            );
          },
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

/// The exports started from this page, most recent first. The service has no
/// list of past exports, so a reload forgets them (the files stay in storage).
class ExportsNotifier extends Notifier<List<Json>> {
  @override
  List<Json> build() {
    ref.listen(cdrApiProvider, (_, _) => state = const []);
    return const [];
  }

  void add(Json export) => state = [export, ...state];

  void update(Json export) =>
      state = [for (final e in state) e['id'] == export['id'] ? export : e];
}

final cdrExportsProvider = NotifierProvider<ExportsNotifier, List<Json>>(
  ExportsNotifier.new,
);

class ExportDialog extends ConsumerStatefulWidget {
  const ExportDialog({super.key});

  @override
  ConsumerState<ExportDialog> createState() => _ExportDialogState();
}

class _ExportDialogState extends ConsumerState<ExportDialog> {
  late final _from = TextEditingController(
    text: formatDate(DateTime.now().subtract(const Duration(days: 30))),
  );
  late final _to = TextEditingController(text: formatDate(DateTime.now()));
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final from = parseDate(_from.text);
    final to = parseDate(_to.text);
    if (from == null || to == null) {
      setState(() => _error = 'Enter both dates as YYYY-MM-DD.');
      return;
    }
    final api = ref.read(cdrApiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // Whole days: from the start of the first to the end of the last.
      final started = await api.startExport(
        from,
        DateTime(to.year, to.month, to.day + 1),
      );
      ref.read(cdrExportsProvider.notifier).add(started);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Export call records'),
    content: SizedBox(
      width: 380,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'A CSV of every call in the period, up to a year. It is prepared '
            'in the background; the download appears on this page when ready.',
          ),
          TextField(
            key: const ValueKey('export-from'),
            controller: _from,
            decoration: const InputDecoration(
              labelText: 'From date',
              hintText: 'YYYY-MM-DD',
            ),
          ),
          TextField(
            key: const ValueKey('export-to'),
            controller: _to,
            decoration: const InputDecoration(
              labelText: 'To date (included)',
              hintText: 'YYYY-MM-DD',
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: ErrorText(_error!),
            ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: _busy ? null : _start,
        child: const Text('Start export'),
      ),
    ],
  );
}

/// The exports started here, each with its state and, once ready, a download.
class ExportsPanel extends ConsumerWidget {
  const ExportsPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final exports = ref.watch(cdrExportsProvider);
    if (exports.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(
          children: [
            for (final e in exports)
              ExportTile(key: ValueKey('export-${e['id']}'), initial: e),
          ],
        ),
      ),
    );
  }
}

/// One export. While the service is still preparing it, asks again every few
/// seconds; stops once it is ready or has failed.
class ExportTile extends ConsumerStatefulWidget {
  const ExportTile({super.key, required this.initial});

  final Json initial;

  @override
  ConsumerState<ExportTile> createState() => _ExportTileState();
}

class _ExportTileState extends ConsumerState<ExportTile> {
  static const _interval = Duration(seconds: 3);
  late Json _export = widget.initial;
  Timer? _timer;
  String? _error;

  bool get _working =>
      _export['status'] == 'pending' || _export['status'] == 'processing';

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _schedule() {
    if (!_working) return;
    _timer = Timer(_interval, _poll);
  }

  Future<void> _poll() async {
    final api = ref.read(cdrApiProvider);
    if (api == null || !mounted) return;
    try {
      final next = await api.getExport('${_export['id']}');
      if (!mounted) return;
      setState(() {
        _export = next;
        _error = null;
      });
      ref.read(cdrExportsProvider.notifier).update(next);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
    _schedule();
  }

  @override
  Widget build(BuildContext context) {
    final status = '${_export['status']}';
    final url = _export['downloadUrl'];
    final period =
        '${formatDate(DateTime.parse('${_export['fromAt']}').toLocal())} to '
        '${formatDate(DateTime.parse('${_export['toAt']}').toLocal().subtract(const Duration(milliseconds: 1)))}';
    return ListTile(
      dense: true,
      leading: switch (status) {
        'ready' => const Icon(Icons.check_circle_outline),
        'failed' => Icon(
          Icons.error_outline,
          color: Theme.of(context).colorScheme.error,
        ),
        _ => const SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      },
      title: Text('Export, $period'),
      subtitle: Text(
        _error ??
            switch (status) {
              'pending' => 'Waiting to start…',
              'processing' => 'Preparing the file…',
              'ready' => 'Ready',
              'failed' =>
                'Failed: ${_export['errorMessage'] ?? 'the export could not be completed.'}',
              _ => status,
            },
      ),
      trailing: status == 'ready' && url is String
          ? FilledButton.icon(
              onPressed: () => ref.read(urlOpenerProvider)(url),
              icon: const Icon(Icons.download),
              label: const Text('Download'),
            )
          : null,
    );
  }
}
