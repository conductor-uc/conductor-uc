import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/authed_get.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';

/// The signed-in user's own organization's audit trail: what its people did,
/// and what anyone did to its data (07 §4), newest first.
final auditEventsProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  final session = ref.watch(sessionProvider);
  if (session == null) return const [];
  final body = await authedGet(
    ref,
    '/v1/orgs/${session.orgId}/audit-events',
    query: {'limit': '200'},
  ) as Map;
  return [
    for (final r in body['rows'] as List) (r as Map).cast<String, dynamic>(),
  ];
});

/// `2026-09-24T03:12:45.000Z` as `2026-09-24 03:12` (UTC, as stored).
String shortTime(Object? iso) {
  final text = '$iso';
  return text.length >= 16
      ? text.substring(0, 16).replaceFirst('T', ' ')
      : text;
}

class AuditPage extends ConsumerStatefulWidget {
  const AuditPage({super.key});

  @override
  ConsumerState<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends ConsumerState<AuditPage> {
  var _filter = '';

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final events = ref.watch(auditEventsProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: l10n.audTitle,
          subtitle: l10n.audSubtitle,
          actions: [
            IconButton(
              tooltip: l10n.audRefresh,
              icon: const Icon(Icons.refresh),
              onPressed: () => ref.invalidate(auditEventsProvider),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: 320,
          child: TextField(
            decoration: InputDecoration(
              labelText: l10n.audFilter,
              prefixIcon: const Icon(Icons.search),
            ),
            onChanged: (v) => setState(() => _filter = v.trim().toLowerCase()),
          ),
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: events,
            emptyText: l10n.audEmpty,
            builder: (all) {
              final rows = [
                for (final e in all)
                  if (_filter.isEmpty ||
                      '${e['action']}'.toLowerCase().contains(_filter) ||
                      '${e['resource']}'.toLowerCase().contains(_filter))
                    e,
              ];
              if (rows.isEmpty) {
                return Center(child: Text(l10n.audNoMatches));
              }
              return SingleChildScrollView(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    columns: [
                      DataColumn(label: Text(l10n.audWhen)),
                      DataColumn(label: Text(l10n.audWho)),
                      DataColumn(label: Text(l10n.audAction)),
                      DataColumn(label: Text(l10n.audResource)),
                      DataColumn(label: Text(l10n.audData)),
                      DataColumn(label: Text(l10n.audReason)),
                    ],
                    rows: [
                      for (final e in rows)
                        DataRow(
                          cells: [
                            DataCell(Text(shortTime(e['at']))),
                            DataCell(Text(_who(l10n, e))),
                            DataCell(Text('${e['action']}')),
                            DataCell(Text('${e['resource']}')),
                            DataCell(Text('${e['dataClass']}')),
                            DataCell(Text('${e['reason'] ?? '—'}')),
                          ],
                        ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  /// "user 3f9a1c2b", plus where they are from when it is not this org.
  String _who(AppLocalizations l10n, Json e) {
    final id = '${e['actorId']}';
    final short = id.length > 8 ? id.substring(0, 8) : id;
    final own = ref.read(sessionProvider)?.orgId;
    final type = '${e['actorType']}';
    return e['actorOrgId'] == own
        ? l10n.audActor(type, short)
        : l10n.audActorOtherOrg(type, short);
  }
}
