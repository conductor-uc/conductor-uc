import 'package:dio/dio.dart';

/// The message to show for a failed call: the server's own `detail` (RFC 9457)
/// when it sent one, so "extension number already in use" reads as that. A
/// request that failed validation also says which fields and why, so "The body
/// failed validation." is followed by "admin password must NOT have fewer than
/// 12 characters".
String problemMessage(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map) {
      final detail = data['detail'] ?? data['title'] ?? data['message'];
      if (detail is String && detail.isNotEmpty) {
        final fields = _fieldErrors(data['errors']);
        return fields.isEmpty ? detail : '$detail $fields';
      }
    }
    if (error.response == null) return 'Could not reach the server.';
    return 'The server rejected that (${error.response!.statusCode}).';
  }
  return 'Something went wrong.';
}

/// `[{field: '/adminPassword', message: 'must NOT have ...'}]` as one line.
String _fieldErrors(Object? errors) {
  if (errors is! List) return '';
  final lines = <String>[];
  for (final e in errors) {
    if (e is! Map) continue;
    final message = e['message'];
    if (message is! String || message.isEmpty) continue;
    final field = '${e['field'] ?? ''}'
        .replaceAll(RegExp(r'^/+'), '')
        .replaceAllMapped(RegExp(r'[A-Z]'), (m) => ' ${m[0]!.toLowerCase()}')
        .replaceAll('/', ' ');
    lines.add(field.isEmpty ? message : '$field $message.');
  }
  return lines.join(' ');
}
