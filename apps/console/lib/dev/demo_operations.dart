import 'dart:math' as math;

/// The Operations console's stand-in (`GET /v1/platform/overview` and the media
/// node actions, 11 §2.2), for the demo backend: two media nodes, the second
/// drained; a dozen services, one not ready; the event bus with a consumer a
/// little behind; and the three data stores. Figures drift with the clock so
/// the charts move.
class DemoOperations {
  final _nodes = <String, _DemoNode>{
    'fs1': _DemoNode('fs1', 'sip:10.10.0.21:5060', weight: 2, base: 14),
    'fs2': _DemoNode(
      'fs2',
      'sip:10.10.0.22:5060',
      weight: 1,
      base: 3,
      draining: true,
    ),
  };

  final _started = DateTime.now().toUtc().subtract(
    const Duration(days: 3, hours: 4, minutes: 12),
  );

  /// Null when [nodeId] is not a node.
  Map<String, Object?>? drain(String nodeId, {required bool draining}) {
    final node = _nodes[nodeId];
    if (node == null) return null;
    node.draining = draining;
    return _node(node, DateTime.now().toUtc());
  }

  /// Null when [nodeId] is not a node.
  Map<String, Object?>? setWeight(String nodeId, int weight) {
    final node = _nodes[nodeId];
    if (node == null) return null;
    node.weight = weight;
    return _node(node, DateTime.now().toUtc());
  }

  /// A smooth wobble in [-1, 1] for the given period, so readings drift.
  static double _wave(DateTime now, int periodSeconds, [double phase = 0]) =>
      math.sin(
        now.millisecondsSinceEpoch / 1000 / periodSeconds * 2 * math.pi + phase,
      );

  int _calls(_DemoNode node, DateTime now) {
    if (node.draining) {
      // A drained node's calls end one by one.
      return math.max(0, (node.base * (1 + _wave(now, 90))).round() ~/ 2);
    }
    return math.max(
      0,
      (node.base + node.base * 0.4 * _wave(now, 120, node.base.toDouble()))
          .round(),
    );
  }

  Map<String, Object?> _node(_DemoNode node, DateTime now) {
    final calls = _calls(node, now);
    final cpuBusy = (8 + calls * 2.6 + 3 * _wave(now, 17)).clamp(1, 99);
    return {
      'nodeId': node.id,
      'status': node.draining ? 'draining' : 'up',
      'draining': node.draining,
      'calls': calls,
      'leases': node.draining ? 0 : 3,
      'weight': node.weight,
      'dispatcher': node.draining ? 'inactive' : 'active',
      'uri': node.uri,
      'sessions': calls * 2,
      'maxSessions': 1000,
      'cpuIdlePercent': 100 - cpuBusy,
      'sessionsPerSecond': node.draining ? 0 : (calls / 12).clamp(0, 5),
      'uptimeSeconds': now.difference(_started).inSeconds - node.base * 40,
      'heartbeatAt': now.subtract(const Duration(seconds: 2)).toIso8601String(),
    };
  }

  Map<String, Object?> overview() {
    final now = DateTime.now().toUtc();
    final uptime = now.difference(_started).inSeconds;
    final backlog = math.max(0, (6 + 6 * _wave(now, 45)).round());
    return {
      'checkedAt': now.toIso8601String(),
      'services': [
        for (final (name, ms, rss) in const [
          ('identity-service', 11.0, 96.0),
          ('org-service', 9.0, 88.0),
          ('pbx-config-service', 14.0, 112.0),
          ('callflow-service', 10.0, 84.0),
          ('voicemail-service', 38.0, 91.0),
          ('cdr-service', 16.0, 104.0),
          ('trunk-service', 8.0, 79.0),
          ('recording-service', 12.0, 99.0),
          ('call-control', 6.0, 121.0),
          ('telephony-config', 7.0, 134.0),
          ('media-worker', 13.0, 142.0),
          ('notification-service', 9.0, 74.0),
          ('recording-uploader-fs1', 4.0, 52.0),
          ('recording-uploader-fs2', 5.0, 49.0),
        ])
          {
            'name': name,
            'status': name == 'voicemail-service' ? 'degraded' : 'up',
            'latencyMs': ms + 3 * (1 + _wave(now, 23, ms)),
            'version': '0.1.0',
            'uptimeSeconds': uptime - ms.round() * 7,
            'checks': [
              {'name': 'db', 'status': 'pass'},
              if (name == 'voicemail-service')
                {'name': 'storage', 'status': 'fail'},
            ],
            'memory': {
              'rssBytes': rss * 1024 * 1024,
              'heapUsedBytes': rss * 0.45 * 1024 * 1024,
            },
            'outbox': name.startsWith('recording-uploader')
                ? null
                : {
                    'pending': name == 'call-control' ? backlog ~/ 3 : 0,
                    'oldestPendingSeconds':
                        name == 'call-control' && backlog > 2 ? 1.2 : null,
                    'failed': 0,
                  },
            // The uploaders report their spool (11 §2.2's `facts`).
            'facts': name.startsWith('recording-uploader')
                ? [
                    {
                      'label': 'Spool files',
                      'value': name.endsWith('fs1') ? 2 : 0,
                      'unit': 'count',
                    },
                    {
                      'label': 'Spool size',
                      'value': name.endsWith('fs1') ? 3.1 * 1024 * 1024 : 0,
                      'unit': 'bytes',
                    },
                    {'label': 'Stuck files', 'value': 0, 'unit': 'count'},
                    {
                      'label': 'Oldest file',
                      'value': name.endsWith('fs1') ? 4 : null,
                      'unit': 'seconds',
                    },
                    {
                      'label': 'Uploaded',
                      'value': name.endsWith('fs1') ? 1842 : 377,
                      'unit': 'count',
                    },
                  ]
                : const <Object>[],
          },
      ],
      'nodes': [for (final node in _nodes.values) _node(node, now)],
      'signalling': {
        'status': 'up',
        'uptimeSeconds': uptime + 600,
        'registrations': 148 + (2 * _wave(now, 300)).round(),
        'activeDialogs': _nodes.values.fold<int>(
          0,
          (sum, n) => sum + _calls(n, now),
        ),
        'earlyDialogs': math.max(0, (2 + 2 * _wave(now, 11)).round()),
        'transactions': math.max(0, (9 + 5 * _wave(now, 13)).round()),
        'shmUsedBytes': 41.5 * 1024 * 1024,
        'shmTotalBytes': 256 * 1024 * 1024,
      },
      'events': {
        'streams': [
          for (final (name, messages, consumers) in const [
            ('CALL', 18240, 1),
            ('PBX', 3120, 1),
            ('ORG', 412, 2),
            ('TRUNK', 96, 1),
            ('RECORDING', 1780, 1),
            ('VOICEMAIL', 640, 1),
          ])
            {
              'name': name,
              'messages': messages,
              'bytes': messages * 610,
              'consumers': consumers,
            },
        ],
        'consumers': [
          {
            'stream': 'CALL',
            'name': 'telephony-config-nodes',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 0,
          },
          {
            'stream': 'PBX',
            'name': 'telephony-config-pbx',
            'pending': backlog,
            'ackPending': backlog > 0 ? 1 : 0,
            'redelivered': 0,
          },
          {
            'stream': 'ORG',
            'name': 'telephony-config-org',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 0,
          },
          {
            'stream': 'ORG',
            'name': 'notification-service-org',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 2,
          },
          {
            'stream': 'TRUNK',
            'name': 'telephony-config-trunk',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 0,
          },
          {
            'stream': 'RECORDING',
            'name': 'telephony-config-recording',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 0,
          },
          {
            'stream': 'VOICEMAIL',
            'name': 'notification-service-voicemail',
            'pending': 0,
            'ackPending': 0,
            'redelivered': 0,
          },
        ],
      },
      'dataStores': [
        {
          'name': 'redis',
          'status': 'up',
          'version': '7.4.1',
          'uptimeSeconds': uptime + 3600,
          'facts': [
            {
              'label': 'Memory used',
              'value': 3.4 * 1024 * 1024,
              'unit': 'bytes',
            },
            {'label': 'Clients', 'value': 19, 'unit': 'count'},
            {
              'label': 'Operations per second',
              'value': 42 + 10 * _wave(now, 29),
              'unit': 'perSecond',
            },
            {'label': 'Keys', 'value': 1284, 'unit': 'count'},
          ],
        },
        {
          'name': 'mariadb',
          'status': 'up',
          'version': '11.4.3',
          'uptimeSeconds': uptime + 7200,
          'facts': [
            {'label': 'Connections', 'value': 64, 'unit': 'count'},
            {
              'label': 'Queries per second',
              'value': 118 + 25 * _wave(now, 31),
              'unit': 'perSecond',
            },
            {'label': 'Slow queries', 'value': 0, 'unit': 'count'},
          ],
        },
        {
          'name': 'nats',
          'status': 'up',
          'version': '2.10.22',
          'uptimeSeconds': uptime + 7100,
          'facts': [
            {'label': 'Connections', 'value': 15, 'unit': 'count'},
            {'label': 'Stored', 'value': 14.8 * 1024 * 1024, 'unit': 'bytes'},
            {
              'label': 'Memory used',
              'value': 22 * 1024 * 1024,
              'unit': 'bytes',
            },
          ],
        },
      ],
    };
  }
}

class _DemoNode {
  _DemoNode(
    this.id,
    this.uri, {
    required this.weight,
    required this.base,
    this.draining = false,
  });

  final String id;
  final String uri;
  int weight;
  final int base;
  bool draining;
}
