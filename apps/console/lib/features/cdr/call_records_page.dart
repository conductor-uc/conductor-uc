import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import 'cdr_api.dart';
import '../../core/format.dart';

/// Opens a download address in a new tab. A provider so tests can watch it
/// instead of leaving the app.
final urlOpenerProvider = Provider<Future<void> Function(String url)>(
  (ref) =>
      (url) => launchUrl(Uri.parse(url), webOnlyWindowName: '_blank'),
);

/// Call directions by wire value, in the viewer's language.
Map<String, String> directionLabelsOf(AppLocalizations l) => {
  'inbound': l.cdrDirInbound,
  'outbound': l.cdrDirOutbound,
  'internal': l.cdrDirInternal,
};

/// How calls ended, by wire value, in the viewer's language.
Map<String, String> dispositionLabelsOf(AppLocalizations l) => {
  'answered': l.cdrDispAnswered,
  'no_answer': l.cdrDispNoAnswer,
  'busy': l.cdrDispBusy,
  'failed': l.cdrDispFailed,
  'cancelled': l.cdrDispCancelled,
  'node_failure': l.cdrDispNodeFailure,
};

/// [directionLabelsOf] for code with no [BuildContext].
Map<String, String> get directionLabels => directionLabelsOf(currentL10n);

/// [dispositionLabelsOf] for code with no [BuildContext].
Map<String, String> get dispositionLabels => dispositionLabelsOf(currentL10n);

/// The label of a call direction; an unknown one is shown as sent.
String directionLabel(AppLocalizations l, String code) =>
    directionLabelsOf(l)[code] ?? code;

/// The label of how a call ended; an unknown one is shown as sent.
String dispositionLabel(AppLocalizations l, String code) =>
    dispositionLabelsOf(l)[code] ?? code;

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
    final l10n = context.l10n;
    if (ref.watch(tenantIdProvider) == null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(l10n.cdrChooseTenant),
      );
    }
    if (!ref.watch(canProvider('cdr.read'))) {
      return PageFrame(
        children: [
          PageHeader(
            title: l10n.shellForbiddenTitle,
            subtitle: l10n.cdrForbiddenBody,
          ),
        ],
      );
    }
    final canExport = ref.watch(canProvider('cdr.export'));
    final list = ref.watch(cdrListProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: l10n.cdrTitle,
          subtitle: l10n.cdrSubtitle,
          actions: [
            if (canExport)
              OutlinedButton.icon(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => const ExportDialog(),
                ),
                icon: const Icon(Icons.download_outlined),
                label: Text(l10n.cdrExportCsv),
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
            emptyText: l10n.cdrNoMatches,
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
    final l10n = context.l10n;
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
                decoration: InputDecoration(
                  labelText: l10n.cdrFromDate,
                  hintText: context.l10n.commonDateHint,
                ),
                onSubmitted: (_) => _apply(),
              ),
            ),
            box(
              TextField(
                key: const ValueKey('cdr-to'),
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
                key: const ValueKey('cdr-direction'),
                initialValue: _direction,
                isExpanded: true,
                decoration: InputDecoration(labelText: l10n.cdrDirection),
                items: [
                  DropdownMenuItem(value: null, child: Text(l10n.cdrAll)),
                  for (final e in directionLabelsOf(l10n).entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) => setState(() => _direction = v),
              ),
            ),
            box(
              TextField(
                key: const ValueKey('cdr-number'),
                controller: _number,
                decoration: InputDecoration(
                  labelText: l10n.cdrNumber,
                  helperText: l10n.cdrNumberHelp,
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
                  decoration: InputDecoration(
                    labelText: l10n.cdrExtension,
                    helperText: l10n.cdrExtensionHelp,
                  ),
                  items: [
                    DropdownMenuItem(value: null, child: Text(l10n.cdrAny)),
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
                decoration: InputDecoration(
                  labelText: l10n.cdrDidFilter,
                  hintText: '+14155550100',
                ),
                onSubmitted: (_) => _apply(),
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
    final l10n = context.l10n;
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
                columns: [
                  DataColumn(label: Text(l10n.cdrStarted)),
                  DataColumn(label: Text(l10n.cdrDirection)),
                  DataColumn(label: Text(l10n.cdrFrom)),
                  DataColumn(label: Text(l10n.cdrTo)),
                  DataColumn(label: Text(l10n.cdrDuration)),
                  DataColumn(label: Text(l10n.cdrResult)),
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
                        DataCell(Text(formatDateTime(r['startAt']))),
                        DataCell(
                          Text(directionLabel(l10n, '${r['direction']}')),
                        ),
                        DataCell(
                          Text(partyLabel(r['fromNumber'], r['fromName'])),
                        ),
                        DataCell(Text('${r['toNumber']}')),
                        DataCell(Text(formatClock(r['durationSec']))),
                        DataCell(
                          Text(dispositionLabel(l10n, '${r['disposition']}')),
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

String partyLabel(Object? number, Object? name) =>
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
    final l10n = context.l10n;
    final call = ref.watch(cdrDetailProvider(id));
    return AlertDialog(
      title: Text(l10n.cdrDetailsTitle),
      content: SizedBox(
        width: 460,
        child: call.when(
          loading: () => const LinearProgressIndicator(),
          error: (e, _) => ErrorText(problemMessage(e)),
          data: (c) {
            final extensions = [...?(c['extensionIds'] as List?)];
            final recordings = [...?(c['recordingIds'] as List?)];
            final rows = <(String, String)>[
              (l10n.cdrDirection, directionLabel(l10n, '${c['direction']}')),
              (l10n.cdrResult, dispositionLabel(l10n, '${c['disposition']}')),
              (l10n.cdrStarted, formatDateTime(c['startAt'])),
              (l10n.cdrAnsweredAt, formatDateTime(c['answerAt'])),
              (l10n.cdrEnded, formatDateTime(c['endAt'])),
              (l10n.cdrDuration, formatClock(c['durationSec'])),
              (l10n.cdrBillable, formatClock(c['billableSec'])),
              (l10n.cdrFrom, partyLabel(c['fromNumber'], c['fromName'])),
              (l10n.cdrTo, '${c['toNumber']}'),
              (l10n.cdrDialed, '${c['dialedNumber']}'),
              (l10n.cdrPhoneNumber, '${c['did'] ?? '—'}'),
              (l10n.cdrTrunk, _named(ref, 'trunks', c['trunkId'])),
              (
                l10n.cdrExtensions,
                extensions.isEmpty
                    ? '—'
                    : extensions
                          .map((e) => _named(ref, 'extensions', e))
                          .join(', '),
              ),
              (l10n.cdrQueue, _named(ref, 'queues', c['queueId'])),
              (l10n.cdrCallFlow, _named(ref, 'flows', c['flowId'])),
              (l10n.cdrEndedBecause, '${c['hangupCause']}'),
              (l10n.cdrHungUpBy, '${c['hangupBy']}'),
              (
                l10n.cdrRecordings,
                recordings.isEmpty ? l10n.cdrNone : '${recordings.length}',
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
          child: Text(l10n.commonClose),
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
    text: isoDate(DateTime.now().subtract(const Duration(days: 30))),
  );
  late final _to = TextEditingController(text: isoDate(DateTime.now()));
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
      setState(() => _error = context.l10n.cdrExportBothDates);
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
    title: Text(context.l10n.cdrExportTitle),
    content: SizedBox(
      width: 380,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(context.l10n.cdrExportBody),
          TextField(
            key: const ValueKey('export-from'),
            controller: _from,
            decoration: InputDecoration(
              labelText: context.l10n.cdrFromDate,
              hintText: context.l10n.commonDateHint,
            ),
          ),
          TextField(
            key: const ValueKey('export-to'),
            controller: _to,
            decoration: InputDecoration(
              labelText: context.l10n.cdrToDateIncluded,
              hintText: context.l10n.commonDateHint,
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
        child: Text(context.l10n.commonCancel),
      ),
      FilledButton(
        onPressed: _busy ? null : _start,
        child: Text(context.l10n.cdrStartExport),
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
    final l10n = context.l10n;
    final status = '${_export['status']}';
    final url = _export['downloadUrl'];
    final firstDay = formatDate(
      DateTime.parse('${_export['fromAt']}').toLocal(),
    );
    final lastDay = formatDate(
      DateTime.parse('${_export['toAt']}')
          .toLocal()
          .subtract(const Duration(milliseconds: 1)),
    );
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
      title: Text(l10n.cdrExportRow(firstDay, lastDay)),
      subtitle: Text(
        _error ??
            switch (status) {
              'pending' => l10n.cdrExportPending,
              'processing' => l10n.cdrExportProcessing,
              'ready' => l10n.cdrExportReady,
              'failed' => l10n.cdrExportFailed(
                '${_export['errorMessage'] ?? l10n.cdrExportFailedUnknown}',
              ),
              _ => status,
            },
      ),
      trailing: status == 'ready' && url is String
          ? FilledButton.icon(
              onPressed: () => ref.read(urlOpenerProvider)(url),
              icon: const Icon(Icons.download),
              label: Text(l10n.cdrDownload),
            )
          : null,
    );
  }
}
