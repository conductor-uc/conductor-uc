import 'package:dio/dio.dart';

/// The machine-readable `code` of a problem+json response (RFC 9457), or null.
String? problemCode(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map && data['code'] is String) return data['code'] as String;
  }
  return null;
}

/// The server's own explanation of a rejected request (for example, why a
/// password was refused), or null.
String? problemDetail(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    if (data is Map && data['detail'] is String) {
      return data['detail'] as String;
    }
  }
  return null;
}

/// Whether the request failed before reaching the server.
bool isOffline(Object error) => error is DioException && error.response == null;
