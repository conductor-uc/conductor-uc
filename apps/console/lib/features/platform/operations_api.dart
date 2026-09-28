import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/authed_get.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart' show Json;

double? _number(Object? value) => value is num ? value.toDouble() : null;
int? _int(Object? value) => value is num ? value.round() : null;
String? _string(Object? value) => value is String ? value : null;
List<Json> _rows(Object? value) => [
  if (value is List)
    for (final row in value)
      if (row is Map) row.cast<String, dynamic>(),
];

/// One service as the gateway found it (`GET /v1/platform/overview`, 11 §2.2).
class ServiceStatus {
  ServiceStatus.fromJson(Json json)
    : name = '${json['name']}',
      status = _string(json['status']) ?? 'down',
      latencyMs = _number(json['latencyMs']),
      version = _string(json['version']),
      uptimeSeconds = _number(json['uptimeSeconds']),
      checks = _rows(json['checks']),
      rssBytes = _number((json['memory'] as Map?)?['rssBytes']),
      heapUsedBytes = _number((json['memory'] as Map?)?['heapUsedBytes']),
      outboxPending = _int((json['outbox'] as Map?)?['pending']),
      outboxOldestSeconds = _number(
        (json['outbox'] as Map?)?['oldestPendingSeconds'],
      ),
      outboxFailed = _int((json['outbox'] as Map?)?['failed']),
      facts = [for (final f in _rows(json['facts'])) StoreFact.fromJson(f)];

  final String name;

  /// `up`, `degraded` or `down`.
  final String status;
  final double? latencyMs;
  final String? version;
  final double? uptimeSeconds;
  final List<Json> checks;
  final double? rssBytes;
  final double? heapUsedBytes;
  final int? outboxPending;
  final double? outboxOldestSeconds;
  final int? outboxFailed;

  /// Figures the service reports about itself beyond the common ones, such as
  /// a recording uploader's spool; usually none.
  final List<StoreFact> facts;

  List<String> get failingChecks => [
    for (final c in checks)
      if (c['status'] != 'pass') '${c['name']}',
  ];
}

/// One FreeSWITCH node: call-control's view plus OpenSIPs' dispatcher row.
class MediaNode {
  MediaNode.fromJson(Json json)
    : nodeId = '${json['nodeId']}',
      status = _string(json['status']) ?? 'down',
      draining = json['draining'] == true,
      calls = _int(json['calls']) ?? 0,
      leases = _int(json['leases']) ?? 0,
      weight = _int(json['weight']),
      dispatcher = _string(json['dispatcher']),
      uri = _string(json['uri']),
      sessions = _int(json['sessions']),
      maxSessions = _int(json['maxSessions']),
      cpuIdlePercent = _number(json['cpuIdlePercent']),
      sessionsPerSecond = _number(json['sessionsPerSecond']),
      uptimeSeconds = _number(json['uptimeSeconds']),
      heartbeatAt = _string(json['heartbeatAt']);

  final String nodeId;

  /// `up`, `draining` or `down`.
  final String status;
  final bool draining;
  final int calls;
  final int leases;
  final int? weight;

  /// `active`, `inactive`, `probing` or `absent`; null while unknown.
  final String? dispatcher;
  final String? uri;
  final int? sessions;
  final int? maxSessions;
  final double? cpuIdlePercent;
  final double? sessionsPerSecond;
  final double? uptimeSeconds;
  final String? heartbeatAt;

  /// Busy CPU, 0 to 100, when the node has reported it.
  double? get cpuBusyPercent =>
      cpuIdlePercent == null ? null : (100 - cpuIdlePercent!).clamp(0, 100);

  /// Taking new calls: up, not drained, and in rotation at the edge.
  bool get inService =>
      status == 'up' &&
      !draining &&
      (dispatcher == null || dispatcher == 'active');
}

/// The SIP edge (OpenSIPs), from telephony-config.
class Signalling {
  Signalling.fromJson(Json json)
    : status = _string(json['status']) ?? 'down',
      uptimeSeconds = _number(json['uptimeSeconds']),
      registrations = _int(json['registrations']),
      activeDialogs = _int(json['activeDialogs']),
      earlyDialogs = _int(json['earlyDialogs']),
      transactions = _int(json['transactions']),
      shmUsedBytes = _number(json['shmUsedBytes']),
      shmTotalBytes = _number(json['shmTotalBytes']);

  final String status;
  final double? uptimeSeconds;
  final int? registrations;
  final int? activeDialogs;
  final int? earlyDialogs;
  final int? transactions;
  final double? shmUsedBytes;
  final double? shmTotalBytes;
}

class EventStream {
  EventStream.fromJson(Json json)
    : name = '${json['name']}',
      messages = _int(json['messages']) ?? 0,
      bytes = _number(json['bytes']) ?? 0,
      consumers = _int(json['consumers']) ?? 0;

  final String name;
  final int messages;
  final double bytes;
  final int consumers;
}

class EventConsumer {
  EventConsumer.fromJson(Json json)
    : stream = '${json['stream']}',
      name = '${json['name']}',
      pending = _int(json['pending']) ?? 0,
      ackPending = _int(json['ackPending']) ?? 0,
      redelivered = _int(json['redelivered']) ?? 0;

  final String stream;
  final String name;
  final int pending;
  final int ackPending;
  final int redelivered;

  /// Everything not yet done with: waiting to be delivered, or delivered and
  /// not yet acknowledged.
  int get backlog => pending + ackPending;
}

class EventBus {
  EventBus.fromJson(Json json)
    : streams = [
        for (final s in _rows(json['streams'])) EventStream.fromJson(s),
      ],
      consumers = [
        for (final c in _rows(json['consumers'])) EventConsumer.fromJson(c),
      ];

  final List<EventStream> streams;
  final List<EventConsumer> consumers;

  int get backlog => consumers.fold(0, (sum, c) => sum + c.backlog);
}

/// One labelled figure a data store or a service reports about itself.
class StoreFact {
  StoreFact.fromJson(Json json)
    : label = '${json['label']}',
      value = _number(json['value']),
      unit = _string(json['unit']) ?? 'count';

  final String label;
  final double? value;

  /// `bytes`, `count`, `perSecond`, `seconds` or `percent`.
  final String unit;
}

class DataStore {
  DataStore.fromJson(Json json)
    : name = '${json['name']}',
      status = _string(json['status']) ?? 'down',
      version = _string(json['version']),
      uptimeSeconds = _number(json['uptimeSeconds']),
      facts = [for (final f in _rows(json['facts'])) StoreFact.fromJson(f)];

  final String name;
  final String status;
  final String? version;
  final double? uptimeSeconds;
  final List<StoreFact> facts;
}

/// Everything the Operations page shows, from one `GET /v1/platform/overview`.
class Overview {
  Overview.fromJson(Json json)
    : checkedAt = DateTime.tryParse('${json['checkedAt']}')?.toUtc(),
      services = [
        for (final s in _rows(json['services'])) ServiceStatus.fromJson(s),
      ],
      nodes = [for (final n in _rows(json['nodes'])) MediaNode.fromJson(n)],
      signalling = json['signalling'] is Map
          ? Signalling.fromJson(
              (json['signalling'] as Map).cast<String, dynamic>(),
            )
          : null,
      events = json['events'] is Map
          ? EventBus.fromJson((json['events'] as Map).cast<String, dynamic>())
          : null,
      dataStores = [
        for (final d in _rows(json['dataStores'])) DataStore.fromJson(d),
      ];

  final DateTime? checkedAt;
  final List<ServiceStatus> services;
  final List<MediaNode> nodes;
  final Signalling? signalling;
  final EventBus? events;
  final List<DataStore> dataStores;

  int get servicesReady => services.where((s) => s.status == 'up').length;
  int get nodesInService => nodes.where((n) => n.inService).length;
  int get liveCalls => nodes.fold(0, (sum, n) => sum + n.calls);
}

final operationsOverviewProvider = FutureProvider.autoDispose<Overview>((
  ref,
) async {
  final body = await authedGet(ref, '/v1/platform/overview');
  return Overview.fromJson((body as Map).cast<String, dynamic>());
});

/// One point of the page's own rolling history: what the overview said at
/// [at]. Kept only while the page is open, until history comes from the
/// platform's metrics (S4-13).
class OperationsSample {
  const OperationsSample(this.at, this.calls, this.backlog);

  final DateTime at;
  final int calls;
  final int? backlog;
}

/// The last ten minutes of readings this page has taken, at most.
class OperationsHistory extends Notifier<List<OperationsSample>> {
  static const window = Duration(minutes: 10);

  @override
  List<OperationsSample> build() => const [];

  void add(Overview overview) {
    final at = overview.checkedAt ?? DateTime.now().toUtc();
    if (state.isNotEmpty && !at.isAfter(state.last.at)) return;
    final cutoff = at.subtract(window);
    state = [
      for (final s in state)
        if (s.at.isAfter(cutoff)) s,
      OperationsSample(at, overview.liveCalls, overview.events?.backlog),
    ];
  }
}

final operationsHistoryProvider =
    NotifierProvider.autoDispose<OperationsHistory, List<OperationsSample>>(
      OperationsHistory.new,
    );

/// The media node actions (`platform.operate`), through call-control.
class OperationsApi {
  OperationsApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  String _node(String nodeId) =>
      '/v1/platform/nodes/${Uri.encodeComponent(nodeId)}';

  Future<void> drain(String nodeId) =>
      _dio.post<Object?>('${_node(nodeId)}/drain', options: _options);

  Future<void> undrain(String nodeId) =>
      _dio.post<Object?>('${_node(nodeId)}/undrain', options: _options);

  Future<void> setWeight(String nodeId, int weight) => _dio.put<Object?>(
    '${_node(nodeId)}/weight',
    data: {'weight': weight},
    options: _options,
  );

  /// S4-13: one chart of the fixed catalog over [range] (`1h`, `6h`, `24h`,
  /// `7d`), from Prometheus through the gateway. 503 `history_unavailable`
  /// when the platform keeps no history.
  Future<HistoryChart> history(String chart, String range) async {
    final response = await _dio.get<Object?>(
      '/v1/platform/metrics/$chart',
      queryParameters: {'range': range},
      options: _options,
    );
    return HistoryChart.fromJson(
      (response.data as Map).cast<String, dynamic>(),
    );
  }
}

/// One chart's lines over a range (11 §3).
class HistoryChart {
  const HistoryChart({required this.unit, required this.series});

  /// `count`, `percent`, `perSecond` or `seconds`.
  final String unit;
  final List<HistorySeries> series;

  factory HistoryChart.fromJson(Map<String, dynamic> json) => HistoryChart(
    unit: '${json['unit']}',
    series: [
      for (final s in (json['series'] as List? ?? const []))
        HistorySeries(
          label: '${(s as Map)['label'] ?? ''}',
          points: [
            for (final p in (s['points'] as List? ?? const []))
              (
                DateTime.fromMillisecondsSinceEpoch(
                  ((p as List)[0] as num).toInt() * 1000,
                ),
                (p[1] as num).toDouble(),
              ),
          ],
        ),
    ],
  );
}

class HistorySeries {
  const HistorySeries({required this.label, required this.points});

  /// The node, service or consumer; empty for a chart with one line.
  final String label;
  final List<(DateTime, double)> points;
}

/// The charts of the catalog, in the order the History tab shows them.
const historyCharts = [
  'calls-by-node',
  'sessions-by-node',
  'node-cpu',
  'registrations',
  'dialogs',
  'request-rate',
  'error-rate',
  'latency-p95',
  'outbox-pending',
  'consumer-backlog',
];

/// One chart over one range, asked for when shown.
final historyChartProvider = FutureProvider.autoDispose
    .family<HistoryChart, (String, String)>(
      (ref, key) => ref.read(operationsApiProvider).history(key.$1, key.$2),
    );

final operationsApiProvider = Provider.autoDispose<OperationsApi>((ref) {
  final session = ref.watch(sessionProvider);
  return OperationsApi(ref.watch(apiProvider).dio, session?.accessToken ?? '');
});

/// The weights a node may be given (`OPENSIPS_FS_DESTINATION`, G-123).
const minWeight = 1;
const maxWeight = 999;

/// Why [text] is not a weight, or null when it is one.
String? weightError(String text) {
  final value = int.tryParse(text.trim());
  if (value == null) return 'Enter a whole number.';
  if (value < minWeight || value > maxWeight) {
    return 'Enter a weight from $minWeight to $maxWeight.';
  }
  return null;
}
