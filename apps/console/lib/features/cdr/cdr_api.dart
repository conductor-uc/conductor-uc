import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// What the call records list is narrowed to. Empty means no narrowing.
class CdrFilter {
  const CdrFilter({this.from, this.to, this.direction, this.number, this.did});

  /// First and last day to include (local dates, whole days).
  final DateTime? from;
  final DateTime? to;
  final String? direction;

  /// Calls from, to or dialed as this number (an extension or a full number).
  final String? number;

  /// Calls that came in on this phone number.
  final String? did;

  bool get isEmpty =>
      from == null &&
      to == null &&
      direction == null &&
      number == null &&
      did == null;

  /// The query the service takes. Day bounds become instants: the start of
  /// [from]'s day and the last millisecond of [to]'s day, in the viewer's zone.
  Map<String, Object> toQuery({String? cursor, int? limit}) => {
    if (from != null)
      'from': DateTime(
        from!.year,
        from!.month,
        from!.day,
      ).toUtc().toIso8601String(),
    if (to != null)
      'to': DateTime(
        to!.year,
        to!.month,
        to!.day,
        23,
        59,
        59,
        999,
      ).toUtc().toIso8601String(),
    'direction': ?direction,
    'number': ?number,
    'did': ?did,
    'cursor': ?cursor,
    'limit': ?limit,
  };
}

/// One page of call records and where the next one starts (null at the end).
class CdrPage {
  const CdrPage(this.rows, this.nextCursor);

  final List<Json> rows;
  final String? nextCursor;
}

/// The call records and export routes of one tenant.
class CdrApi {
  CdrApi(this._dio, this.tenantId, this._token);

  final Dio _dio;
  final String tenantId;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});
  String _path(String tail) => '/v1/tenants/$tenantId/$tail';

  Future<CdrPage> list(
    CdrFilter filter, {
    String? cursor,
    int limit = 50,
  }) async {
    final response = await _dio.get<Object?>(
      _path('cdrs'),
      queryParameters: filter.toQuery(cursor: cursor, limit: limit),
      options: _options,
    );
    final body = response.data as Map;
    return CdrPage([
      for (final r in body['rows'] as List) (r as Map).cast<String, dynamic>(),
    ], body['nextCursor'] as String?);
  }

  Future<Json> get(String id) async {
    final response = await _dio.get<Object?>(
      _path('cdrs/$id'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  /// Starts an export of the calls between two instants.
  Future<Json> startExport(DateTime from, DateTime to) async {
    final response = await _dio.post<Object?>(
      _path('cdr-exports'),
      data: {
        'from': from.toUtc().toIso8601String(),
        'to': to.toUtc().toIso8601String(),
      },
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> getExport(String id) async {
    final response = await _dio.get<Object?>(
      _path('cdr-exports/$id'),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }
}

final cdrApiProvider = Provider<CdrApi?>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final session = ref.watch(sessionProvider);
  if (tenant == null || session == null) return null;
  return CdrApi(ref.watch(apiProvider).dio, tenant, session.accessToken);
});

class CdrFilterNotifier extends Notifier<CdrFilter> {
  @override
  CdrFilter build() => const CdrFilter();

  void set(CdrFilter next) => state = next;
}

/// The filter the list is showing. Changing it reloads from the first page.
final cdrFilterProvider = NotifierProvider<CdrFilterNotifier, CdrFilter>(
  CdrFilterNotifier.new,
);

/// The records loaded so far for the current filter, newest first; [loadMore]
/// adds the next page.
class CdrListController extends AsyncNotifier<CdrPage> {
  @override
  Future<CdrPage> build() async {
    final api = ref.watch(cdrApiProvider);
    final filter = ref.watch(cdrFilterProvider);
    if (api == null) return const CdrPage([], null);
    return api.list(filter);
  }

  Future<void> loadMore() async {
    final current = state.value;
    final api = ref.read(cdrApiProvider);
    final cursor = current?.nextCursor;
    if (current == null || api == null || cursor == null) return;
    final next = await AsyncValue.guard(
      () => api.list(ref.read(cdrFilterProvider), cursor: cursor),
    );
    // Keep what is on screen if the next page fails; the caller shows why.
    if (next.hasError) {
      state = AsyncData(current);
      throw next.error!;
    }
    final page = next.requireValue;
    state = AsyncData(
      CdrPage([...current.rows, ...page.rows], page.nextCursor),
    );
  }
}

final cdrListProvider = AsyncNotifierProvider<CdrListController, CdrPage>(
  CdrListController.new,
);

/// One call record, fetched by id.
final cdrDetailProvider = FutureProvider.family<Json, String>((ref, id) async {
  final api = ref.watch(cdrApiProvider);
  if (api == null) throw StateError('No tenant.');
  return api.get(id);
});
