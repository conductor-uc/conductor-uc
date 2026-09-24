import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../pbx/pbx_api.dart';
import '../../pbx/resource.dart';

/// The name to show for row [row] of [resource] in a picker or a node.
/// A voicemail mailbox has no name of its own: it is its extension's.
String optionTitle(String resource, Json row, List<Json> extensions) {
  if (resource == 'voicemail/mailboxes') {
    final ext = extensions.where((e) => e['id'] == row['extensionId']);
    return ext.isEmpty
        ? 'Mailbox ${row['id']}'
        : 'Mailbox for ${resourceByKey('extensions').titleOf(ext.first)}';
  }
  return resourceByKey(resource).titleOf(row);
}

/// `{value: title}` for each row a picker for [resource] offers.
final optionsProvider = FutureProvider.family<Map<String, String>, String>((
  ref,
  resource,
) async {
  final rows = await ref.watch(rowsProvider(resource).future);
  final extensions = resource == 'voicemail/mailboxes'
      ? await ref.watch(rowsProvider('extensions').future)
      : const <Json>[];
  return {
    for (final r in rows) '${r['id']}': optionTitle(resource, r, extensions),
  };
});

/// The entry point names of another call flow, for "Go to flow".
final flowEntryPointsProvider = FutureProvider.family<List<String>, String>((
  ref,
  flowId,
) async {
  final api = ref.watch(pbxApiProvider);
  if (api == null) return const [];
  final flow = await api.get('flows', flowId);
  final entry = (flow['draftGraph'] as Map?)?['entryPoints'] as Map?;
  return [...?entry?.keys.cast<String>()];
});
