import 'dart:convert';

import 'package:dio/dio.dart';

import '../features/pbx/resource.dart';

/// In-memory stand-in for pbx-config-service and callflow-service, seeded with
/// a small tenant so every PBX screen has something to show. Development only
/// (see `demo_backend.dart`); state lives until the page is reloaded.
class DemoPbx {
  DemoPbx() {
    _rows.addAll({
      'emergency-locations': [
        {
          'id': 'loc-1',
          'label': 'Head office',
          'addressLine1': '1 Main Street',
          'addressLine2': null,
          'city': 'Springfield',
          'state': 'IL',
          'postalCode': '62701',
          'country': 'US',
        },
      ],
      'extensions': [
        _ext('ext-1', '101', 'Alice Kim'),
        _ext('ext-2', '102', 'Bob Osei'),
        _ext('ext-3', '103', 'Carol Diaz'),
      ],
      'ring-groups': [
        {
          'id': 'rg-1',
          'label': 'Sales',
          'strategy': 'simultaneous',
          'memberExtensionIds': ['ext-1', 'ext-2'],
          'ringTimeoutSeconds': 20,
          'noAnswerDestinationType': 'voicemail',
          'noAnswerDestinationId': 'ext-1',
        },
      ],
      'queues': [
        {
          'id': 'q-1',
          'label': 'Support',
          'strategy': 'longest-idle-agent',
          'mohMediaAssetId': 'media-2',
          'maxWaitSeconds': 300,
          'announcePosition': true,
          'announceFrequencySeconds': 60,
          'noAgentDestinationType': null,
          'noAgentDestinationId': null,
        },
      ],
      'agents': [
        {
          'id': 'ag-1',
          'extensionId': 'ext-3',
          'maxNoAnswer': 3,
          'wrapUpSeconds': 10,
          'rejectDelaySeconds': 10,
        },
      ],
      'trunks': [
        {'id': 'trunk-1', 'name': 'Primary trunk'},
      ],
      'dids': [
        {
          'id': 'did-1',
          'e164': '+14155550100',
          'trunkId': 'trunk-1',
          'destinationType': 'flow',
          'destinationId': 'flow-1',
        },
      ],
      'conference-rooms': [
        {
          'id': 'conf-1',
          'label': 'All hands',
          'number': '800',
          'pinRequired': true,
          'video': true,
          'layout': null,
          'maxMembers': 50,
        },
      ],
      'parking-lots': [
        {
          'id': 'park-1',
          'label': 'Main lot',
          'slotStart': 701,
          'slotEnd': 720,
          'timeoutSeconds': 120,
          'returnDestinationType': null,
          'returnDestinationId': null,
        },
      ],
      'media-assets': [
        _media('media-1', 'prompt', 'Welcome greeting'),
        _media('media-2', 'moh', 'Hold music'),
      ],
      'flows': [
        {
          'id': 'flow-1',
          'name': 'Main menu',
          'currentPublishedVersionId': 'ver-1',
          'draftGraph': _mainMenu,
          'draftUpdatedAt': '2026-09-01T09:00:00Z',
        },
      ],
    });
    _versions['flow-1'] = [
      {
        'id': 'ver-1',
        'versionNumber': 1,
        'publishedAt': '2026-09-01T09:00:00Z',
      },
    ];
  }

  static const _mainMenu = {
    'entryPoints': {'default': 'greet'},
    'nodes': [
      {
        'id': 'greet',
        'type': 'menu',
        'config': {'prompt': 'media-1'},
      },
      {
        'id': 'sales',
        'type': 'ring_group',
        'config': {'ringGroupId': 'rg-1'},
      },
    ],
    'edges': [
      {'from': 'greet', 'port': '1', 'to': 'sales'},
    ],
  };

  static Map<String, dynamic> _ext(String id, String number, String name) => {
    'id': id,
    'number': number,
    'userId': null,
    'displayName': name,
    'callerIdName': null,
    'callerIdNumber': null,
    'voicemailEnabled': true,
    'emergencyLocationId': 'loc-1',
  };

  static Map<String, dynamic> _media(String id, String kind, String label) => {
    'id': id,
    'kind': kind,
    'label': label,
    'status': 'ready',
    'contentType': 'audio/wav',
    'durationMs': 4200,
    'sha256': null,
    'sizeBytes': 90000,
    'errorMessage': null,
  };

  final _rows = <String, List<Map<String, dynamic>>>{};
  final _versions = <String, List<Map<String, dynamic>>>{};
  var _next = 100;

  static final _route = RegExp(
    r'^/v1/tenants/[^/]+/([^/]+)(?:/([^/]+))?(?:/([^/]+))?$',
  );

  /// Null when [options] is not a tenant route.
  ResponseBody? handle(RequestOptions options) {
    final match = _route.firstMatch(options.path);
    if (match == null) return null;
    final resource = match.group(1)!;
    final id = match.group(2);
    final action = match.group(3);
    final rows = _rows[resource];
    if (rows == null) return _problem(404, 'No such resource.');
    final method = options.method.toUpperCase();

    if (resource == 'flows' && id != null && action != null) {
      return _flowAction(method, id, action, options.data);
    }
    if (id == null) {
      if (method == 'GET') return _json({'rows': rows});
      if (method == 'POST') return _create(resource, rows, _body(options));
    } else {
      final index = rows.indexWhere((r) => r['id'] == id);
      if (index < 0) return _problem(404, 'Not found.');
      if (method == 'GET') return _json(rows[index]);
      if (method == 'PATCH') {
        return _update(resource, rows, index, _body(options));
      }
      if (method == 'DELETE') {
        rows.removeAt(index);
        return ResponseBody.fromString('', 204);
      }
    }
    return _problem(405, 'Not supported.');
  }

  Map<String, dynamic> _body(RequestOptions options) {
    final data = options.data;
    final map = data is Map ? data : jsonDecode('$data') as Map;
    return map.cast<String, dynamic>();
  }

  ResponseBody _create(
    String resource,
    List<Map<String, dynamic>> rows,
    Map<String, dynamic> body,
  ) {
    if (resource == 'flows') {
      final flow = {
        'id': 'flow-${_next++}',
        'name': body['name'],
        'currentPublishedVersionId': null,
        'draftGraph': {
          'entryPoints': <String, String>{},
          'nodes': <Object>[],
          'edges': <Object>[],
        },
        'draftUpdatedAt': DateTime.now().toUtc().toIso8601String(),
      };
      rows.add(flow);
      return _json(flow, 201);
    }
    final def = resourceByKey(resource);
    for (final f in def.fields) {
      final v = body[f.key];
      if (f.required && (v == null || (v is List && v.isEmpty))) {
        return _problem(400, '${f.label} is required.');
      }
    }
    final clash = _clash(resource, rows, body, null);
    if (clash != null) return clash;
    final row = <String, dynamic>{'id': '${_prefix(resource)}-${_next++}'};
    _apply(def, row, body);
    rows.add(row);
    return _json(row, 201);
  }

  ResponseBody _update(
    String resource,
    List<Map<String, dynamic>> rows,
    int index,
    Map<String, dynamic> body,
  ) {
    final clash = _clash(resource, rows, body, rows[index]['id'] as String);
    if (clash != null) return clash;
    _apply(resourceByKey(resource), rows[index], body);
    return _json(rows[index]);
  }

  void _apply(
    ResourceDef def,
    Map<String, dynamic> row,
    Map<String, dynamic> body,
  ) {
    for (final f in def.fields) {
      if (f.key == 'pin') {
        if (body.containsKey('pin')) row['pinRequired'] = body['pin'] != null;
        continue;
      }
      if (body.containsKey(f.key)) {
        row[f.key] = body[f.key];
      } else {
        row.putIfAbsent(f.key, () => f.kind == FieldKind.toggle ? false : null);
      }
    }
    if (def.key == 'conference-rooms') {
      row.putIfAbsent('pinRequired', () => false);
    }
  }

  ResponseBody? _clash(
    String resource,
    List<Map<String, dynamic>> rows,
    Map<String, dynamic> body,
    String? selfId,
  ) {
    final unique = {
      'extensions': 'number',
      'dids': 'e164',
      'conference-rooms': 'number',
    }[resource];
    if (unique == null || body[unique] == null) return null;
    final taken = rows.any(
      (r) => r['id'] != selfId && r[unique] == body[unique],
    );
    return taken ? _problem(409, '${body[unique]} is already in use.') : null;
  }

  ResponseBody _flowAction(
    String method,
    String id,
    String action,
    Object? data,
  ) {
    final flow = _rows['flows']!.firstWhere((f) => f['id'] == id);
    final versions = _versions.putIfAbsent(id, () => []);
    switch ((method, action)) {
      case ('GET', 'versions'):
        return _json({'rows': versions});
      case ('PUT', 'draft'):
        flow['draftGraph'] = data is Map ? data : jsonDecode('$data');
        flow['draftUpdatedAt'] = DateTime.now().toUtc().toIso8601String();
        return _json(flow);
      case ('POST', 'validate'):
        final nodes = ((flow['draftGraph'] as Map)['nodes'] as List);
        return _json({
          'valid': nodes.isNotEmpty,
          'issues': nodes.isEmpty
              ? [
                  {
                    'kind': 'empty_graph',
                    'message': 'The flow has no nodes yet.',
                  },
                ]
              : <Object>[],
        });
      case ('POST', 'publish'):
        final version = {
          'id': 'ver-${_next++}',
          'versionNumber': versions.length + 1,
          'publishedAt': DateTime.now().toUtc().toIso8601String(),
        };
        versions.add(version);
        flow['currentPublishedVersionId'] = version['id'];
        return _json(version, 201);
      case ('POST', 'rollback'):
        final n = (data is Map ? data : jsonDecode('$data'))['versionNumber'];
        final found = versions.where((v) => v['versionNumber'] == n);
        if (found.isEmpty) return _problem(404, 'No such version.');
        flow['currentPublishedVersionId'] = found.first['id'];
        return _json(found.first);
    }
    return _problem(405, 'Not supported.');
  }

  String _prefix(String resource) =>
      resource.split('-').map((w) => w[0]).join();

  ResponseBody _json(Object body, [int status = 200]) =>
      ResponseBody.fromString(
        jsonEncode(body),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  ResponseBody _problem(int status, String detail) => ResponseBody.fromString(
    jsonEncode({'title': 'Error', 'status': status, 'detail': detail}),
    status,
    headers: {
      Headers.contentTypeHeader: ['application/problem+json'],
    },
  );
}
