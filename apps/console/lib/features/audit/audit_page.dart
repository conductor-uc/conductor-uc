import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/authed_get.dart';
import '../../core/session.dart';
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
    final events = ref.watch(auditEventsProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: 'Audit',
          subtitle: 'What your people did, and what anyone did to your data. Newest first, times in UTC.',
          actions: [
            IconButton(
              tooltip: 'Refresh',
              icon: const Icon(Icons.refresh),
              onPressed: () => ref.invalidate(auditEventsProvider),
            ),
          ],
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: 320,
          child: TextField(
            decoration: const InputDecoration(
              labelText: 'Filter by action or resource',
              prefixIcon: Icon(Icons.search),
            ),
            onChanged: (v) => setState(() => _filter = v.trim().toLowerCase()),
          ),
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: events,
            emptyText: 'Nothing has been recorded yet.',
            builder: (all) {
              final rows = [
                for (final e in all)
                  if (_filter.isEmpty ||
                      '${e['action']}'.toLowerCase().contains(_filter) ||
                      '${e['resource']}'.toLowerCase().contains(_filter))
                    e,
              ];
              if (rows.isEmpty) {
                return const Center(child: Text('No events match that.'));
              }
              return SingleChildScrollView(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    columns: const [
                      DataColumn(label: Text('When')),
                      DataColumn(label: Text('Who')),
                      DataColumn(label: Text('Action')),
                      DataColumn(label: Text('Resource')),
                      DataColumn(label: Text('Data')),
                      DataColumn(label: Text('Reason')),
                    ],
                    rows: [
                      for (final e in rows)
                        DataRow(
                          cells: [
                            DataCell(Text(shortTime(e['at']))),
                            DataCell(Text(_who(e))),
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
  String _who(Json e) {
    final id = '${e['actorId']}';
    final short = id.length > 8 ? id.substring(0, 8) : id;
    final own = ref.read(sessionProvider)?.orgId;
    return '${e['actorType']} $short${e['actorOrgId'] == own ? '' : ' (other org)'}';
  }
}
