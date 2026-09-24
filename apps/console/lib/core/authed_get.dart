import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'session.dart';

/// A GET carrying the signed-in user's access token, for screens whose calls
/// are one-off reads (audit, platform health) rather than a resource.
Future<Object?> authedGet(
  Ref ref,
  String path, {
  Map<String, Object?>? query,
}) async {
  final session = ref.read(sessionProvider);
  if (session == null) throw StateError('Not signed in.');
  final response = await ref
      .watch(apiProvider)
      .dio
      .get<Object?>(
        path,
        queryParameters: query,
        options: Options(
          headers: {'Authorization': 'Bearer ${session.accessToken}'},
        ),
      );
  return response.data;
}
