import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';

/// How many recordings one page asks for.
const recordingsPageSize = 25;

const recordingDirections = {
  'inbound': 'Incoming',
  'outbound': 'Outgoing',
  'internal': 'Between extensions',
};

const recordingStatuses = {
  'pending': 'Uploading',
  'ready': 'Ready',
  'failed': 'Failed',
  'expired': 'Expired',
};

/// What a policy is attached to. `tenant` is the default for the whole organization.
const policyScopes = {
  'tenant': 'Whole organization',
  'extension': 'Extension',
  'queue': 'Queue',
  'did': 'Phone number',
};

/// Which calls a policy covers. `any` is every direction.
const policyDirections = {
  'any': 'Every call',
  'inbound': 'Incoming calls',
  'outbound': 'Outgoing calls',
  'internal': 'Calls between extensions',
};

const policyActions = {'record': 'Record', 'no_record': 'Do not record'};

/// What the recordings list is narrowed to. Empty means no narrowing.
class RecordingFilter {
  const RecordingFilter({
    this.from,
    this.to,
    this.direction,
    this.extensionId,
    this.queueId,
  });

  /// First and last day to include (local dates, whole days).
  final DateTime? from;
  final DateTime? to;
  final String? direction;
  final String? extensionId;
  final String? queueId;

  bool get isEmpty =>
      from == null &&
      to == null &&
      direction == null &&
      extensionId == null &&
      queueId == null;

  /// The query the service takes. Day bounds become instants: the start of
  /// [from]'s day and the start of the day after [to], in the viewer's zone.
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
        to!.day + 1,
      ).toUtc().toIso8601String(),
    'direction': ?direction,
    'extensionId': ?extensionId,
    'queueId': ?queueId,
    'cursor': ?cursor,
    // Query strings are text to the service, which reads the number itself.
    if (limit != null) 'limit': '$limit',
  };
}

/// One page of recordings and where the next one starts (null at the end).
class RecordingsResult {
  const RecordingsResult(this.rows, this.nextCursor);

  final List<Json> rows;
  final String? nextCursor;
}

/// One recording policy as the form edits it (`POST`/`PUT .../recording-policies`).
class PolicyForm {
  const PolicyForm({
    this.scopeType = 'tenant',
    this.scopeId,
    this.direction = 'any',
    this.action = 'record',
    this.announce = false,
    this.consentAssetId,
    this.allowOnDemand = false,
  });

  factory PolicyForm.fromPolicy(Json policy) => PolicyForm(
    scopeType: '${policy['scopeType']}',
    scopeId: policy['scopeType'] == 'tenant'
        ? null
        : policy['scopeId'] as String?,
    direction: '${policy['direction']}',
    action: '${policy['action']}',
    announce: policy['announce'] == true,
    consentAssetId: policy['consentAssetId'] as String?,
    allowOnDemand: policy['allowOnDemand'] == true,
  );

  final String scopeType;
  final String? scopeId;
  final String direction;
  final String action;
  final bool announce;
  final String? consentAssetId;

  /// People on the calls it decides may use the in-call feature codes: `*1`
  /// starts or stops a recording (when the rule does not record), `*2`
  /// pauses or resumes one (when it does). Every use is audited.
  final bool allowOnDemand;

  Json toJson() => {
    'scopeType': scopeType,
    'scopeId': ?scopeId,
    'direction': direction,
    'action': action,
    'announce': announce,
    'consentAssetId': announce ? consentAssetId : null,
    'allowOnDemand': allowOnDemand,
  };
}

/// The recordings, policy and retention routes of one tenant. Recordings are
/// private-class data (07 §3.2): a reseller is refused by the service and the
/// section is hidden from one.
class RecordingsApi {
  RecordingsApi(this._dio, this.tenantId, this._token);

  final Dio _dio;
  final String tenantId;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});
  String _path(String tail) => '/v1/tenants/$tenantId/$tail';

  Future<RecordingsResult> list(
    RecordingFilter filter, {
    String? cursor,
    int limit = recordingsPageSize,
  }) async {
    final response = await _dio.get<Object?>(
      _path('recordings'),
      queryParameters: filter.toQuery(cursor: cursor, limit: limit),
      options: _options,
    );
    final body = response.data as Map;
    return RecordingsResult([
      for (final r in body['rows'] as List) (r as Map).cast<String, dynamic>(),
    ], body['nextCursor'] as String?);
  }

  /// A short-lived address the audio can be played from. Each one is audited.
  Future<String> playUrl(String id) async {
    final response = await _dio.get<Object?>(
      _path('recordings/$id/play-url'),
      options: _options,
    );
    return '${(response.data as Map)['url']}';
  }

  /// A short-lived address that saves the file instead of playing it. Audited.
  Future<String> downloadUrl(String id) async {
    final response = await _dio.get<Object?>(
      _path('recordings/$id/download-url'),
      options: _options,
    );
    return '${(response.data as Map)['url']}';
  }

  Future<void> delete(String id) async {
    await _dio.delete<Object?>(_path('recordings/$id'), options: _options);
  }

  Future<List<Json>> policies() async {
    final response = await _dio.get<Object?>(
      _path('recording-policies'),
      options: _options,
    );
    return [
      for (final r in (response.data as Map)['rows'] as List)
        (r as Map).cast<String, dynamic>(),
    ];
  }

  Future<Json> createPolicy(PolicyForm form) async {
    final response = await _dio.post<Object?>(
      _path('recording-policies'),
      data: form.toJson(),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<Json> savePolicy(String id, PolicyForm form) async {
    final response = await _dio.put<Object?>(
      _path('recording-policies/$id'),
      data: form.toJson(),
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<void> deletePolicy(String id) async {
    await _dio.delete<Object?>(
      _path('recording-policies/$id'),
      options: _options,
    );
  }

  /// How long recordings are kept, and whether recording is required.
  Future<RecordingSettings> settings() async {
    final response = await _dio.get<Object?>(
      _path('recording-settings'),
      options: _options,
    );
    return RecordingSettings.fromJson(response.data as Map);
  }

  /// How many days recordings are kept (0: until deleted).
  Future<int> retentionDays() async => (await settings()).retentionDays;

  Future<int> saveRetentionDays(int days) async {
    final response = await _dio.put<Object?>(
      _path('recording-settings'),
      data: {'retentionDays': days},
      options: _options,
    );
    return ((response.data as Map)['retentionDays'] as num).toInt();
  }

  /// Turns "recording required" on or off. Changes nothing else.
  Future<bool> saveRecordingRequired(bool required) async {
    final response = await _dio.put<Object?>(
      _path('recording-settings'),
      data: {'failClosed': required},
      options: _options,
    );
    return (response.data as Map)['failClosed'] == true;
  }
}

/// A tenant's recording settings (`GET .../recording-settings`).
class RecordingSettings {
  const RecordingSettings({
    required this.retentionDays,
    required this.recordingRequired,
  });

  factory RecordingSettings.fromJson(Map<dynamic, dynamic> json) =>
      RecordingSettings(
        retentionDays: (json['retentionDays'] as num).toInt(),
        recordingRequired: json['failClosed'] == true,
      );

  /// 0 keeps recordings until someone deletes them.
  final int retentionDays;

  /// Calls whose recording cannot be set up are refused (the service's
  /// `failClosed`).
  final bool recordingRequired;
}

final recordingsApiProvider = Provider<RecordingsApi?>((ref) {
  final tenant = ref.watch(tenantIdProvider);
  final session = ref.watch(sessionProvider);
  if (tenant == null || session == null) return null;
  return RecordingsApi(ref.watch(apiProvider).dio, tenant, session.accessToken);
});

class RecordingFilterNotifier extends Notifier<RecordingFilter> {
  @override
  RecordingFilter build() => const RecordingFilter();

  void set(RecordingFilter next) => state = next;
}

/// The filter the list is showing. Changing it reloads from the first page.
final recordingFilterProvider =
    NotifierProvider<RecordingFilterNotifier, RecordingFilter>(
      RecordingFilterNotifier.new,
    );

/// The recordings loaded so far for the current filter, newest first;
/// [loadMore] adds the next page.
class RecordingListController extends AsyncNotifier<RecordingsResult> {
  @override
  Future<RecordingsResult> build() async {
    final api = ref.watch(recordingsApiProvider);
    final filter = ref.watch(recordingFilterProvider);
    if (api == null) return const RecordingsResult([], null);
    return api.list(filter);
  }

  Future<void> loadMore() async {
    final current = state.value;
    final api = ref.read(recordingsApiProvider);
    final cursor = current?.nextCursor;
    if (current == null || api == null || cursor == null) return;
    final next = await AsyncValue.guard(
      () => api.list(ref.read(recordingFilterProvider), cursor: cursor),
    );
    // Keep what is on screen if the next page fails; the caller shows why.
    if (next.hasError) {
      state = AsyncData(current);
      throw next.error!;
    }
    final page = next.requireValue;
    state = AsyncData(
      RecordingsResult([...current.rows, ...page.rows], page.nextCursor),
    );
  }
}

final recordingListProvider =
    AsyncNotifierProvider<RecordingListController, RecordingsResult>(
      RecordingListController.new,
    );

final recordingPoliciesProvider = FutureProvider<List<Json>>((ref) async {
  final api = ref.watch(recordingsApiProvider);
  return api == null ? const [] : api.policies();
});

final recordingSettingsProvider = FutureProvider<RecordingSettings>((
  ref,
) async {
  final api = ref.watch(recordingsApiProvider);
  return api == null
      ? const RecordingSettings(retentionDays: 90, recordingRequired: false)
      : api.settings();
});

final recordingRetentionProvider = FutureProvider<int>(
  (ref) async =>
      (await ref.watch(recordingSettingsProvider.future)).retentionDays,
);
