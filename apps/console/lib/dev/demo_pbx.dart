import 'dart:convert';
import 'dart:math' as math;

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
        {
          'id': 'trunk-1',
          'name': 'Primary trunk',
          'authMode': 'register',
          'host': 'sip.carrier.example',
          'port': 5060,
          'transport': 'udp',
          'username': 'acme',
          'fromDomain': null,
          'codecs': ['PCMU', 'PCMA'],
          'maxChannels': 20,
          'callerIdPolicy': null,
          'status': 'active',
        },
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
      'schedules': [
        {
          'id': 'sch-1',
          'label': 'Office hours',
          'timezone': 'America/Chicago',
          'rules': [
            {
              'days': [1, 2, 3, 4, 5],
              'start': '09:00',
              'end': '17:00',
            },
            {
              'days': [6],
              'start': '10:00',
              'end': '14:00',
            },
          ],
          'holidays': [
            {'date': '2026-12-25', 'label': 'Christmas Day'},
            {'date': '2027-01-01'},
          ],
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
        'graph': _mainMenu,
      },
    ];
  }

  static const _mainMenu = {
    'entryPoints': {'main': 'greet'},
    'nodes': [
      {
        'id': 'greet',
        'type': 'menu',
        'config': {
          'promptMediaAssetId': 'media-1',
          'timeoutSeconds': 5,
          'maxInvalidAttempts': 3,
        },
      },
      {
        'id': 'sales',
        'type': 'ring_group',
        'config': {'ringGroupId': 'rg-1'},
      },
      {
        'id': 'mail',
        'type': 'voicemail',
        'config': {'mailboxId': 'mb-1'},
      },
      {
        'id': 'hours',
        'type': 'time_condition',
        'config': {'scheduleId': 'sch-1'},
      },
      {'id': 'bye', 'type': 'hangup', 'config': {}},
    ],
    'edges': [
      {'from': 'greet', 'port': '1', 'to': 'sales'},
      {'from': 'greet', 'port': '2', 'to': 'hours'},
      {'from': 'hours', 'port': 'match', 'to': 'sales'},
      {'from': 'hours', 'port': 'noMatch', 'to': 'mail'},
      {'from': 'greet', 'port': 'timeout', 'to': 'bye'},
      {'from': 'greet', 'port': 'invalid', 'to': 'bye'},
      {'from': 'sales', 'port': 'noAnswer', 'to': 'mail'},
      {'from': 'mail', 'port': 'next', 'to': 'bye'},
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
    r'^/v1/tenants/[^/]+/([^/]+)(?:/([^/]+))?(?:/([^/]+))?(?:/([^/]+))?$',
  );

  final _resellers = <Map<String, dynamic>>[
    _org('rs-1', 'Northwind Telecom', 'northwind'),
    _org('rs-2', 'Harbor Voice', 'harbor'),
  ];

  final _tenants = <String, List<Map<String, dynamic>>>{
    'rs-1': [
      _org('t-1', 'Acme Dental', 'acme-dental'),
      _org('t-2', 'Blue Bottle Cafe', 'blue-bottle'),
      _org('t-3', 'Old Company', 'old-co', status: 'suspended'),
    ],
    'rs-2': [_org('t-4', 'Lakeside Realty', 'lakeside')],
  };

  final _baseDomains = <String, List<Map<String, dynamic>>>{
    'rs-1': [
      {
        'id': 'bd-1',
        'resellerId': 'rs-1',
        'fqdn': 'voice.northwind.example',
        'status': 'active',
        'verificationRecordName': '_verify.voice.northwind.example',
        'verifiedAt': '2026-09-01T09:00:00Z',
      },
      {
        'id': 'bd-2',
        'resellerId': 'rs-1',
        'fqdn': 'talk.northwind.example',
        'status': 'pending',
        'verificationRecordName': '_verify.talk.northwind.example',
        'verificationToken': 'demo-token-2',
        'verifiedAt': null,
      },
    ],
  };

  ResponseBody? _domainsAndAssets(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    // A presigned upload goes to storage, not the API.
    if (path.startsWith('https://uploads.demo.invalid/')) {
      return ResponseBody.fromString('', 200);
    }
    final domains = RegExp(
      r'^/v1/resellers/([^/]+)/base-domains(?:/([^/]+)/verify)?$',
    ).firstMatch(path);
    if (domains != null) {
      final id = domains.group(1)!;
      // Any other reseller (the demo sign-in is one) starts with Northwind's.
      final list = _baseDomains.putIfAbsent(
        id,
        () => [
          for (final d in _baseDomains['rs-1']!) {...d, 'resellerId': id},
        ],
      );
      final verifyId = domains.group(2);
      if (verifyId != null) {
        final row = list.where((d) => d['id'] == verifyId);
        if (row.isEmpty) return _problem(404, 'No base domain with that id.');
        final d = row.first;
        if ('${d['fqdn']}'.contains('unverified')) {
          return _problem(409, 'The TXT record was not found yet.');
        }
        d['status'] = 'active';
        d.remove('verificationToken');
        d['verifiedAt'] = DateTime.now().toUtc().toIso8601String();
        return _json(d);
      }
      if (method == 'GET') return _json({'rows': list});
      final fqdn = '${_body(options)['fqdn']}';
      if (!fqdn.contains('.')) {
        return _problem(400, "'$fqdn' is not a valid domain name.");
      }
      if (_baseDomains.values.any((l) => l.any((d) => d['fqdn'] == fqdn))) {
        return _problem(409, '$fqdn is already registered.');
      }
      final n = _next++;
      final row = <String, dynamic>{
        'id': 'bd-$n',
        'resellerId': id,
        'fqdn': fqdn,
        'status': 'pending',
        'verificationRecordName': '_verify.$fqdn',
        'verificationToken': 'demo-token-$n',
        'verifiedAt': null,
      };
      list.add(row);
      return _json(row, 201);
    }
    final tenantDomain = RegExp(r'^/v1/tenants/([^/]+)/domain$')
        .firstMatch(path);
    if (tenantDomain != null) {
      final id = tenantDomain.group(1)!;
      final tenant = [for (final l in _tenants.values) ...l]
          .where((t) => t['id'] == id);
      if (tenant.isEmpty) {
        return _problem(404, 'No primary domain for that tenant.');
      }
      return _json({
        'id': 'td-$id',
        'fqdn': '${tenant.first['slug']}.voice.northwind.example',
        'isPrimary': true,
      });
    }
    final assets = RegExp(r'^/v1/resellers/([^/]+)/brand/assets$')
        .firstMatch(path);
    if (assets != null) {
      final kind = '${_body(options)['kind']}';
      return _json({
        'uploadUrl': 'https://uploads.demo.invalid/brand/$kind?signature=demo',
        'key': 'brand/${assets.group(1)}/$kind-${_next++}',
      }, 201);
    }
    return null;
  }

  final _brands = <String, Map<String, dynamic>>{};
  final _hostnames = <String, List<Map<String, dynamic>>>{};

  static Map<String, dynamic> _org(
    String id,
    String name,
    String slug, {
    String status = 'active',
  }) => {
    'id': id,
    'name': name,
    'slug': slug,
    'status': status,
    'timezone': 'UTC',
    'country': 'US',
  };

  Map<String, dynamic>? _findOrg(String id) {
    for (final r in _resellers) {
      if (r['id'] == id) return r;
    }
    for (final list in _tenants.values) {
      for (final t in list) {
        if (t['id'] == id) return t;
      }
    }
    return null;
  }

  /// The signed-in org's users, invitations, and role assignments. `user-1`
  /// is the person signed in.
  final _users = <Map<String, dynamic>>[
    _user('user-1', 'admin@example.test', 'Alex Admin', ['tenant_admin']),
    _user('user-2', 'sam@example.test', 'Sam Support', ['tenant_user']),
    _user('user-3', 'dana@example.test', 'Dana Diaz', []),
  ];

  static Map<String, dynamic> _user(
    String id,
    String email,
    String name,
    List<String> roles,
  ) => {
    'id': id,
    'email': email,
    'displayName': name,
    'status': 'active',
    'mfaEnrolled': id == 'user-1',
    'lastLoginAt': id == 'user-3' ? null : '2026-09-20T15:04:00.000Z',
    'roleIds': roles,
  };

  /// Another organization's people, made up the first time they are asked for.
  final _otherPeople = <String, List<Map<String, dynamic>>>{};

  /// The people of [orgId]: the signed-in user's own (`demo-org`), or a tenant
  /// entered through "act as".
  List<Map<String, dynamic>> _peopleOf(String orgId) {
    if (orgId == 'demo-org') return _users;
    return _otherPeople.putIfAbsent(
      orgId,
      () => [
        _user('$orgId-user-1', 'owner@tenant.example.test', 'Riley Owner', [
          'tenant_admin',
        ]),
        _user('$orgId-user-2', 'desk@tenant.example.test', 'Jo Front Desk', [
          'tenant_user',
        ]),
      ],
    );
  }

  ResponseBody? _people(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    final users = RegExp(r'^/v1/orgs/([^/]+)/users(?:/([^/]+))?$')
        .firstMatch(path);
    if (users != null) {
      final id = users.group(2);
      final people = _peopleOf(users.group(1)!);
      if (id == null) return _json({'rows': people});
      final index = people.indexWhere((u) => u['id'] == id);
      if (index < 0) return _problem(404, 'No such user in this organization.');
      final body = _body(options);
      if (body['status'] == 'disabled' && id == 'user-1') {
        return _problem(409, 'You cannot disable your own account.');
      }
      people[index] = {
        ...people[index],
        for (final k in const ['displayName', 'status'])
          if (body.containsKey(k)) k: body[k],
      };
      return _json(people[index]);
    }
    final invite = RegExp(r'^/v1/orgs/([^/]+)/invitations$').firstMatch(path);
    if (invite != null && method == 'POST') {
      final body = _body(options);
      final email = '${body['email']}'.toLowerCase();
      if (_peopleOf(invite.group(1)!).any((u) => u['email'] == email)) {
        return _problem(409, 'That email already has an account.');
      }
      return _json({
        'id': 'inv-${_next++}',
        'email': email,
        'expiresAt': '2026-10-01T00:00:00.000Z',
      }, 201);
    }
    final assign = RegExp(r'^/v1/orgs/([^/]+)/roles/([^/]+)/assignments$')
        .firstMatch(path);
    if (assign != null) {
      final body = _body(options);
      final people = _peopleOf(
        RegExp(r'^/v1/orgs/([^/]+)/').firstMatch(path)!.group(1)!,
      );
      final index = people.indexWhere((u) => u['id'] == body['userId']);
      if (index < 0) return _problem(404, 'No such user in this organization.');
      final roles = [...(people[index]['roleIds'] as List).cast<String>()];
      final role = assign.group(2)!;
      if (method == 'DELETE') {
        roles.remove(role);
      } else if (!roles.contains(role)) {
        roles.add(role);
      }
      people[index] = {...people[index], 'roleIds': roles};
      return ResponseBody.fromString('', 204);
    }
    return null;
  }

  /// The org tree and a reseller's brand and hostnames. A reseller signed in
  /// through the demo has an id of its own, so an id not listed is treated as
  /// the first reseller's.
  ResponseBody? _orgs(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    if (path == '/v1/resellers') {
      if (method == 'GET') {
        return _json({'rows': _resellers});
      }
      return _createOrg(_resellers, _body(options));
    }
    final tenants = RegExp(r'^/v1/resellers/([^/]+)/tenants$').firstMatch(path);
    if (tenants != null) {
      final list = _tenants.putIfAbsent(
        tenants.group(1)!,
        () => [...?_tenants['rs-1']],
      );
      return method == 'GET'
          ? _json({'rows': list})
          : _createOrg(list, _body(options));
    }
    final org = RegExp(
      r'^/v1/(?:resellers|tenants)/([^/]+)(?:/(suspend|resume))?$',
    ).firstMatch(path);
    if (org != null) {
      final row = _findOrg(org.group(1)!);
      if (row == null) return _problem(404, 'Not found.');
      if (org.group(2) != null) {
        row['status'] = org.group(2) == 'suspend' ? 'suspended' : 'active';
        return _json(row);
      }
      if (method == 'PATCH') {
        final body = _body(options);
        for (final k in const ['name', 'timezone', 'country']) {
          if (body[k] != null) row[k] = body[k];
        }
      }
      return _json(row);
    }
    final brand = RegExp(r'^/v1/resellers/([^/]+)/brand$').firstMatch(path);
    if (brand != null) {
      final id = brand.group(1)!;
      if (method == 'PUT') {
        final body = _body(options);
        for (final k in const ['primaryColor', 'accentColor']) {
          final v = body[k];
          if (v != null && !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch('$v')) {
            return _problem(400, '$k must be a #rrggbb color.');
          }
        }
        final primary = body['primaryColor'];
        final accent = body['accentColor'];
        if (primary != null && accent != null) {
          // The service checks the two colors against each other (02 §5.3).
          final ratio = _contrast('$primary', '$accent');
          if (ratio < 4.5) {
            return _problem(
              400,
              'primaryColor/accentColor contrast is ${ratio.toStringAsFixed(2)}:1; '
              'WCAG AA requires at least 4.5:1.',
            );
          }
        }
        return _json(_brands[id] = {'resellerId': id, ...body});
      }
      final saved = _brands[id];
      return saved == null ? _problem(404, 'No brand yet.') : _json(saved);
    }
    final hosts = RegExp(r'^/v1/resellers/([^/]+)/console-hostnames$')
        .firstMatch(path);
    if (hosts != null) {
      final id = hosts.group(1)!;
      final list = _hostnames.putIfAbsent(id, () => []);
      if (method == 'GET') return _json({'rows': list});
      final fqdn = _body(options)['fqdn'];
      if (list.any((h) => h['fqdn'] == fqdn)) {
        return _problem(409, '$fqdn is already a console hostname.');
      }
      final row = {'fqdn': fqdn, 'resellerId': id, 'tlsStatus': 'pending'};
      list.add(row);
      return _json(row, 201);
    }
    return null;
  }

  static double _luminance(String hex) {
    double channel(int i) {
      final c = int.parse(hex.substring(i, i + 2), radix: 16) / 255;
      return c <= 0.03928
          ? c / 12.92
          : math.pow((c + 0.055) / 1.055, 2.4).toDouble();
    }

    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }

  static double _contrast(String a, String b) {
    final la = _luminance(a);
    final lb = _luminance(b);
    return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
  }

  ResponseBody _createOrg(
    List<Map<String, dynamic>> into,
    Map<String, dynamic> body,
  ) {
    for (final k in const [
      'slug',
      'name',
      'adminEmail',
      'adminDisplayName',
      'adminPassword',
    ]) {
      if ('${body[k] ?? ''}'.trim().isEmpty) {
        return _problem(400, '$k is required.');
      }
    }
    if (into.any((o) => o['slug'] == body['slug'])) {
      return _problem(409, 'The short name ${body['slug']} is taken.');
    }
    final created = _org(
      'org-${_next++}',
      '${body['name']}',
      '${body['slug']}',
    );
    into.add(created);
    return _json({
      ...created,
      'adminUser': {'id': 'user-${_next++}', 'email': body['adminEmail']},
    }, 201);
  }

  /// Null when [options] is not a tenant route.
  ResponseBody? handle(RequestOptions options) {
    final orgs = _orgs(options);
    if (orgs != null) return orgs;
    final infra = _domainsAndAssets(options);
    if (infra != null) return infra;
    final people = _people(options);
    if (people != null) return people;
    if (options.path.endsWith('/voicemail/mailboxes')) {
      return _json({
        'rows': [
          {
            'id': 'mb-1',
            'extensionId': _rows['extensions']!.first['id'],
            'greetingStatus': 'none',
            'unreadCount': 0,
          },
        ],
      });
    }
    final match = _route.firstMatch(options.path);
    if (match == null) return null;
    final resource = match.group(1)!;
    final id = match.group(2);
    final action = match.group(3);
    final rows = _rows[resource];
    if (rows == null) return _problem(404, 'No such resource.');
    final method = options.method.toUpperCase();

    if (resource == 'trunks' && id != null && action != null) {
      return _trunkAction(method, id, action, match.group(4), options.data);
    }
    if (resource == 'flows' && id != null && action != null) {
      return _flowAction(method, id, action, options.data, match.group(4));
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
      // Never stored or returned, like a real secret.
      if (f.writeOnly) continue;
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

  final _trunkIps = <String, List<Map<String, dynamic>>>{
    'trunk-1': [
      {'id': 'ip-1', 'cidr': '203.0.113.0/24'},
    ],
  };

  ResponseBody _trunkAction(
    String method,
    String id,
    String action,
    String? ipId,
    Object? data,
  ) {
    final trunk = _rows['trunks']!.where((t) => t['id'] == id);
    if (trunk.isEmpty) return _problem(404, 'No such trunk.');
    final ips = _trunkIps.putIfAbsent(id, () => []);
    switch ((method, action)) {
      case ('GET', 'ips'):
        return _json({'rows': ips});
      case ('POST', 'ips'):
        final cidr = '${(data is Map ? data : jsonDecode('$data'))['cidr']}';
        if (!RegExp(r'^[0-9a-fA-F:.]+(/\d{1,3})?$').hasMatch(cidr)) {
          return _problem(400, "'$cidr' is not a valid address or range.");
        }
        final row = {'id': 'ip-${_next++}', 'cidr': cidr};
        ips.add(row);
        return _json(row, 201);
      case ('DELETE', 'ips'):
        ips.removeWhere((r) => r['id'] == ipId);
        return ResponseBody.fromString('', 204);
      case ('GET', 'status'):
        return _json({
          'registrationStatus': trunk.first['authMode'] == 'ip'
              ? 'not_applicable'
              : 'registered',
        });
    }
    return _problem(405, 'Not supported.');
  }

  ResponseBody _flowAction(
    String method,
    String id,
    String action,
    Object? data,
    String? number,
  ) {
    final flow = _rows['flows']!.firstWhere((f) => f['id'] == id);
    final versions = _versions.putIfAbsent(id, () => []);
    Map<String, dynamic> summary(Map<String, dynamic> v) => {
      for (final k in const ['id', 'versionNumber', 'publishedAt']) k: v[k],
    };
    switch ((method, action)) {
      case ('GET', 'versions') when number != null:
        final found = versions.where((v) => '${v['versionNumber']}' == number);
        return found.isEmpty
            ? _problem(404, 'No such version.')
            : _json(found.first);
      case ('GET', 'versions'):
        return _json({'rows': versions.map(summary).toList()});
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
          'graph': jsonDecode(jsonEncode(flow['draftGraph'])),
        };
        versions.add(version);
        flow['currentPublishedVersionId'] = version['id'];
        return _json(summary(version), 201);
      case ('POST', 'rollback'):
        final n = (data is Map ? data : jsonDecode('$data'))['versionNumber'];
        final found = versions.where((v) => v['versionNumber'] == n);
        if (found.isEmpty) return _problem(404, 'No such version.');
        flow['currentPublishedVersionId'] = found.first['id'];
        return _json(summary(found.first));
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
