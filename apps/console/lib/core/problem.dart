import 'package:dio/dio.dart';

/// The message to show for a failed call: the server's own `detail` (RFC 9457)
/// when it sent one, so "extension number already in use" reads as that.
String problemMessage(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map) {
      final detail = data['detail'] ?? data['title'] ?? data['message'];
      if (detail is String && detail.isNotEmpty) return detail;
    }
    if (error.response == null) return 'Could not reach the server.';
    return 'The server rejected that (${error.response!.statusCode}).';
  }
  return 'Something went wrong.';
}
