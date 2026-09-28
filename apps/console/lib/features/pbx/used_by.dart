import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import 'pbx_api.dart';
import 'resource.dart';

/// What points at row [id] of resource [key] (S9-08): each row of another
/// resource whose fields name it ("Phone number (415) 555-0100" for a ring
/// group a number rings), one line each, so deleting or changing it is never
/// a surprise. Resources this person may not read are skipped.
Future<List<String>> usedBy(WidgetRef ref, String key, String id) async {
  final l = currentL10n;
  final out = <String>{};
  for (final def in allResources) {
    if (def.key == key) continue;
    for (final f in def.fields) {
      final direct =
          f.ref == key &&
          (f.kind == FieldKind.ref || f.kind == FieldKind.refList);
      final dynamic_ =
          f.kind == FieldKind.dynamicRef && f.refMap.values.contains(key);
      if (!direct && !dynamic_) continue;
      final List<Json> rows;
      try {
        rows = await ref.read(rowsProvider(def.key).future);
      } catch (_) {
        continue;
      }
      for (final r in rows) {
        final v = r[f.key];
        final points = switch (f.kind) {
          FieldKind.refList => v is List && v.contains(id),
          FieldKind.dynamicRef => v == id && f.refMap[r[f.refByField]] == key,
          _ => v == id,
        };
        if (points) out.add(l.resUsedByItem(def.singular, def.titleOf(r)));
      }
    }
  }
  return out.toList();
}
