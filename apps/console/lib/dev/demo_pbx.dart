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
      'devices': [
        {
          'id': 'dev-1',
          'extensionId': 'ext-1',
          'vendor': 'yealink',
          'model': 'T46U',
          'mac': '001565aabbcc',
          'label': 'Front desk',
          'provisioningIssued': false,
          'lastProvisionedAt': null,
          'lastSeenIp': null,
          'lastUserAgent': null,
        },
      ],
      'extensions': [
        _ext('ext-1', '101', 'Alice Kim', userId: 'user-4'),
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
        {
          'id': 'trunk-2',
          'name': 'Overflow trunk',
          'authMode': 'ip',
          'host': 'overflow.carrier.example',
          'port': 5060,
          'transport': 'udp',
          'username': null,
          'fromDomain': null,
          'codecs': ['PCMU'],
          'maxChannels': null,
          'callerIdPolicy': null,
          'status': 'active',
        },
      ],
      'outbound-routes': [
        {
          'id': 'or-1',
          'priority': 10,
          'pattern': '+1',
          'trunkIds': ['trunk-1'],
          'strip': 0,
          'prepend': null,
        },
        {
          'id': 'or-2',
          'priority': 100,
          'pattern': '',
          'trunkIds': ['trunk-1', 'trunk-2'],
          'strip': 0,
          'prepend': null,
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
        _mediaRow('media-1', 'prompt', 'Welcome greeting'),
        _mediaRow('media-2', 'moh', 'Hold music'),
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

  static Map<String, dynamic> _ext(
    String id,
    String number,
    String name, {
    String? userId,
  }) => {
    'id': id,
    'number': number,
    'userId': userId,
    'displayName': name,
    'callerIdName': null,
    'callerIdNumber': null,
    'voicemailEnabled': true,
    'emergencyLocationId': 'loc-1',
  };

  static Map<String, dynamic> _mediaRow(String id, String kind, String label) =>
      {
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

  /// Queue tiers by queue id.
  /// Call handling by extension id; an extension with no entry has none set.
  final _callHandling = <String, Map<String, dynamic>>{};

  static Map<String, dynamic> _noCallHandling() => {
    'dnd': false,
    'dndAction': 'voicemail',
    'forwardAlways': null,
    'forwardBusy': null,
    'forwardNoAnswer': null,
    'noAnswerSeconds': 20,
    'forwardUnreachable': null,
    'simultaneousRing': <Object>[],
  };

  static final _e164 = RegExp(r'^\+[1-9]\d{6,14}$');

  /// `GET`/`PUT .../extensions/{id}/call-handling`, checking what the service
  /// checks: numbers in E.164, destinations that exist, no forwarding to
  /// itself, at most five extra rings.
  ResponseBody? _callHandlingRoute(RequestOptions options) {
    final match = RegExp(
      r'^/v1/tenants/[^/]+/extensions/([^/]+)/call-handling$',
    ).firstMatch(options.path);
    if (match == null) return null;
    return _callHandlingOf(match.group(1)!, options);
  }

  /// The read and the replace, for one extension: what both the
  /// administrator's route and a person's own `/me/call-handling` do.
  ResponseBody _callHandlingOf(String id, RequestOptions options) {
    final extensions = _rows['extensions']!;
    if (!extensions.any((r) => r['id'] == id)) {
      return _problem(404, 'No extension with that id.');
    }
    final method = options.method.toUpperCase();
    if (method == 'GET') {
      return _json(_callHandling[id] ?? _noCallHandling());
    }
    if (method != 'PUT') return _problem(405, 'Not supported.');

    final body = _body(options);
    String? check(Object? d, String field, {bool ring = false}) {
      if (d == null) return null;
      if (d is! Map) return '$field: not a destination.';
      switch (d['type']) {
        case 'extension':
          final target = d['extensionId'];
          if (target == id) {
            return '$field: an extension cannot forward to itself '
                '(a forwarding loop).';
          }
          if (!extensions.any((r) => r['id'] == target)) {
            return "Extension '$target' does not exist in this tenant.";
          }
        case 'voicemail':
          if (ring) return '$field: voicemail cannot be a ring destination.';
          final target = d['extensionId'];
          if (target != null && !extensions.any((r) => r['id'] == target)) {
            return "Extension '$target' does not exist in this tenant.";
          }
        case 'external':
          if (!_e164.hasMatch('${d['e164']}')) {
            return "$field: '${d['e164']}' is not an E.164 number "
                '(a leading +, then 7 to 15 digits).';
          }
        default:
          return '$field: unknown destination type.';
      }
      return null;
    }

    final ring = [...?(body['simultaneousRing'] as List?)];
    final seconds = body['noAnswerSeconds'] ?? 20;
    final problems = [
      check(body['forwardAlways'], 'forwardAlways'),
      check(body['forwardBusy'], 'forwardBusy'),
      check(body['forwardNoAnswer'], 'forwardNoAnswer'),
      check(body['forwardUnreachable'], 'forwardUnreachable'),
      for (var i = 0; i < ring.length; i++)
        check(ring[i], 'simultaneousRing[$i]', ring: true),
      if (ring.length > 5) 'simultaneousRing takes at most 5 destinations.',
      if (seconds is! int || seconds < 5 || seconds > 120)
        'noAnswerSeconds must be a whole number of 5-120 seconds.',
    ].whereType<String>();
    if (problems.isNotEmpty) return _problem(400, problems.first);

    final saved = {
      ..._noCallHandling(),
      for (final k in _noCallHandling().keys)
        if (body.containsKey(k)) k: body[k],
    };
    _callHandling[id] = saved;
    return _json(saved);
  }

  final _queueTiers = <String, List<Map<String, dynamic>>>{
    'q-1': [
      {
        'id': 'tier-1',
        'queueId': 'q-1',
        'agentId': 'ag-1',
        'level': 1,
        'position': 1,
      },
    ],
  };

  /// Recordings still being converted, and how many more lists until each is
  /// done. A name containing "bad" fails, so both outcomes can be seen.
  final _converting = <String, int>{};
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
    _user('user-4', 'alice@example.test', 'Alice Kim', ['tenant_user']),
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
    'mfaEnrolled': id == 'user-1' || id == 'user-2',
    'lastLoginAt': id == 'user-3' ? null : '2026-09-20T15:04:00.000Z',
    'roleIds': roles,
  };

  /// Another organization's people, made up the first time they are asked for.
  final _otherPeople = <String, List<Map<String, dynamic>>>{};

  /// The people of [orgId]: the signed-in user's own (`demo-org`), or a tenant
  /// entered through "act as".
  List<Map<String, dynamic>> _peopleOf(String orgId) {
    if (orgId == 'demo-org') return _users;
    if (orgId.startsWith('rs-')) {
      return _otherPeople.putIfAbsent(
        orgId,
        () => [
          _user(
            '$orgId-user-1',
            'admin@reseller.example.test',
            'Morgan Reseller',
            ['reseller_admin'],
          ),
          _user(
            '$orgId-user-2',
            'help@reseller.example.test',
            'Casey Support',
            ['reseller_support'],
          ),
        ],
      );
    }
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

  /// Passwords set by a reset, by extension id; the rest keep their first one.
  final _sipPasswords = <String, String>{};

  /// The platform's Let's Encrypt settings, as the operator last saved them.
  final _acme = <String, dynamic>{
    'contactEmail': null,
    'directory': 'production',
    'termsUrl': 'https://letsencrypt.org/repository/',
    'termsAgreed': false,
    'termsAgreedAt': null,
    'ready': false,
  };

  /// Where the platform is reached from the internet, as the operator last saved it.
  String? _publicAddress;

  static String _recordType(String address) {
    if (RegExp(r'^\d+\.\d+\.\d+\.\d+$').hasMatch(address)) return 'A';
    return address.contains(':') ? 'AAAA' : 'CNAME';
  }

  /// Certificates: the platform's own, and a reseller's (one working, one failing).
  ResponseBody? _certificates(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    if (path == '/v1/platform/acme-settings') {
      if (method == 'GET') return _json(_acme);
      if (method == 'PUT') {
        final body = _body(options);
        final email = '${body['contactEmail'] ?? ''}'.trim();
        if (email.isNotEmpty &&
            !RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email)) {
          return _problem(
            400,
            'Enter one email address, such as certs@example.com.',
          );
        }
        final agree = body['agreeToTerms'] == true;
        final wasAgreed =
            _acme['termsAgreed'] == true &&
            _acme['directory'] == body['directory'];
        _acme['contactEmail'] = email.isEmpty ? null : email;
        _acme['directory'] = body['directory'];
        _acme['termsAgreed'] = agree;
        _acme['termsAgreedAt'] = !agree
            ? null
            : wasAgreed
            ? _acme['termsAgreedAt']
            : '2026-09-24T12:00:00.000Z';
        _acme['ready'] = email.isNotEmpty && agree;
        return _json(_acme);
      }
    }
    if (path == '/v1/platform/network-settings') {
      if (method == 'PUT') {
        final value = '${_body(options)['publicAddress'] ?? ''}'.trim();
        if (value.contains('://') ||
            value.contains('/') ||
            value.contains(' ')) {
          return _problem(
            400,
            'Enter an IP address or a hostname, such as 203.0.113.10 or '
            'edge.example.com, without http:// or a port.',
          );
        }
        _publicAddress = value.isEmpty ? null : value;
      }
      return _json({'publicAddress': _publicAddress});
    }
    if (method == 'GET' &&
        RegExp(r'^/v1/resellers/[^/]+/dns-records$').hasMatch(path)) {
      final address = _publicAddress;
      return _json({
        'publicAddress': address,
        'rows': [
          for (final (name, purpose) in [
            ('sip.voice.northwind.example', 'sip'),
            ('portal.northwind.example', 'console'),
          ])
            {
              'name': name,
              'type': address == null ? 'A' : _recordType(address),
              'value': address,
              'purpose': purpose,
            },
        ],
      });
    }
    if (method == 'GET' && path == '/v1/platform/certificates') {
      return _json({
        'rows': [
          _cert('console.platform.example', 'console', 'active'),
          _cert('sip.platform.example', 'sip', 'active'),
        ],
      });
    }
    if (method == 'GET' &&
        RegExp(r'^/v1/resellers/[^/]+/certificates$').hasMatch(path)) {
      return _json({
        'rows': [
          _cert(
            'sip.voice.northwind.example',
            'sip',
            'failed',
            lastError:
                'DNS lookup for sip.voice.northwind.example found no address.',
          ),
          _cert('portal.northwind.example', 'console', 'active'),
        ],
      });
    }
    return null;
  }

  static Map<String, dynamic> _cert(
    String fqdn,
    String purpose,
    String status, {
    String? lastError,
  }) => {
    'fqdn': fqdn,
    'purpose': purpose,
    'status': status,
    'notBefore': status == 'active' ? '2026-08-01T00:00:00.000Z' : null,
    'notAfter': status == 'active' ? '2026-10-30T00:00:00.000Z' : null,
    'lastError': lastError,
    'attempts': status == 'failed' ? 3 : 0,
    'nextAttemptAt': '2026-09-25T00:00:00.000Z',
  };

  /// Where a phone registers, and an extension's SIP login. The demo has no
  /// real edge; the values only need to look like what the service returns.
  ResponseBody? _phone(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    final endpoint = RegExp(r'^/v1/tenants/([^/]+)/sip-endpoint$');
    if (method == 'GET' && endpoint.hasMatch(path)) {
      final realm = 'demo.voice.northwind.example';
      return _json({
        'server': realm,
        'port': 5060,
        'tlsPort': 5061,
        'transports': ['udp', 'tcp', 'tls'],
        'realm': realm,
        'outboundProxy': 'sip.voice.northwind.example',
      });
    }
    final issue = RegExp(
      r'^/v1/tenants/([^/]+)/devices/([^/]+)/provisioning-credentials$',
    ).firstMatch(path);
    if (method == 'POST' && issue != null) {
      final id = issue.group(2)!;
      final found = _rows['devices']!.where((r) => r['id'] == id);
      if (found.isEmpty) return _problem(404, 'Not found.');
      found.first['provisioningIssued'] = true;
      const base = 'https://api.demo.example/v1/public/provision/yealink/';
      final password = 'demo-provision-${_next++}';
      return _json({
        'url': base,
        'username': id,
        'password': password,
        'urlWithCredentials':
            'https://$id:$password@api.demo.example/v1/public/provision/yealink/',
      });
    }
    final reveal = RegExp(
      r'^/v1/tenants/([^/]+)/extensions/([^/]+)/(reveal|reset-password)$',
    ).firstMatch(path);
    if (method == 'POST' && reveal != null) {
      final id = reveal.group(2)!;
      final found = _rows['extensions']!.where((r) => r['id'] == id);
      if (found.isEmpty) return _problem(404, 'Not found.');
      final number = '${found.first['number']}';
      if (reveal.group(3) == 'reset-password') {
        _sipPasswords[id] = 'demo-$number-reset-${_next++}';
      }
      return _json({
        'username': number,
        'password': _sipPasswords[id] ?? 'demo-$number-secret',
        'realm': 'demo.voice.northwind.example',
      });
    }
    return null;
  }

  ResponseBody? _people(RequestOptions options) {
    final path = options.path;
    final method = options.method.toUpperCase();
    final users = RegExp(
      r'^/v1/orgs/([^/]+)/users(?:/([^/]+))?(?:/(mfa-reset))?$',
    ).firstMatch(path);
    if (users != null) {
      final id = users.group(2);
      final people = _peopleOf(users.group(1)!);
      if (id == null) return _json({'rows': people});
      final index = people.indexWhere((u) => u['id'] == id);
      if (index < 0) return _problem(404, 'No such user in this organization.');
      if (users.group(3) != null) {
        if (id == 'user-1') {
          return _problem(
            409,
            'You cannot reset your own two-step verification.',
          );
        }
        if (people[index]['mfaEnrolled'] != true) {
          return _problem(
            409,
            'That user has not set up two-step verification.',
          );
        }
        people[index] = {...people[index], 'mfaEnrolled': false};
        return _json(people[index]);
      }
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
  static final _mediaRoute = RegExp(
    r'^/v1/tenants/[^/]+/media-assets(?:/([^/]+)/finalize)?$',
  );

  /// Uploading a recording: an address to send the bytes to, then a finalize
  /// that starts a short "processing" before the recording is ready (or fails).
  ResponseBody? _media(RequestOptions options) {
    final match = _mediaRoute.firstMatch(options.path);
    if (match == null) return null;
    final method = options.method.toUpperCase();
    final rows = _rows['media-assets']!;
    final id = match.group(1);
    if (method == 'POST' && id == null) {
      final body = _body(options);
      final asset = {
        ..._mediaRow('media-${_next++}', '${body['kind']}', '${body['label']}'),
        'status': 'pending',
        'contentType': body['contentType'],
        'durationMs': null,
        'sizeBytes': null,
      };
      rows.add(asset);
      return _json({
        'asset': asset,
        'uploadUrl': 'https://storage.demo.invalid/upload/${asset['id']}',
      }, 201);
    }
    if (method == 'POST' && id != null) {
      final asset = rows.where((r) => r['id'] == id);
      if (asset.isEmpty) return _problem(404, 'Not found.');
      asset.first['status'] = 'processing';
      _converting[id] = 3;
      return _json(asset.first);
    }
    if (method == 'GET' && id == null) {
      // Each look at the list moves conversions along.
      for (final row in rows) {
        final left = _converting[row['id']];
        if (left == null) continue;
        if (left > 1) {
          _converting['${row['id']}'] = left - 1;
          continue;
        }
        _converting.remove(row['id']);
        final bad = '${row['label']}'.toLowerCase().contains('bad');
        row['status'] = bad ? 'failed' : 'ready';
        row['errorMessage'] = bad ? 'The audio could not be read.' : null;
        row['durationMs'] = bad ? null : 3200;
        row['sizeBytes'] = bad ? null : 51200;
      }
    }
    return null;
  }

  /// Outbound routes and the emergency route, with the service's own checks.
  ResponseBody? _routing(RequestOptions options) {
    final method = options.method.toUpperCase();
    final emergency = RegExp(r'^/v1/tenants/[^/]+/emergency-route$')
        .hasMatch(options.path);
    if (emergency) {
      switch (method) {
        case 'GET':
          return _emergencyRoute == null
              ? _problem(404, 'No emergency route for this tenant.')
              : _json(_emergencyRoute!);
        case 'PUT':
          final body = _body(options);
          final numbers = [
            for (final n in (body['numbers'] as List? ?? const [])) '$n'.trim(),
          ];
          if (numbers.isEmpty) {
            return _problem(400, 'At least one emergency number is required.');
          }
          for (final n in numbers) {
            if (!RegExp(r'^\d{2,6}$').hasMatch(n)) {
              return _problem(
                400,
                "'$n' is not a valid emergency number: digits only, no country code or prefix.",
              );
            }
          }
          if (numbers.toSet().length != numbers.length) {
            return _problem(400, 'A number is listed more than once.');
          }
          if (!_rows['trunks']!.any((t) => t['id'] == body['trunkId'])) {
            return _problem(400, 'No such trunk.');
          }
          _emergencyRoute = {
            'id': _emergencyRoute?['id'] ?? 'er-1',
            'trunkId': body['trunkId'],
            'numbers': numbers,
          };
          return _json(_emergencyRoute!);
        case 'DELETE':
          if (_emergencyRoute == null) {
            return _problem(404, 'No emergency route for this tenant.');
          }
          _emergencyRoute = null;
          return ResponseBody.fromString('', 204);
      }
      return _problem(405, 'Not supported.');
    }
    final match = RegExp(r'^/v1/tenants/[^/]+/outbound-routes(?:/([^/]+))?$')
        .firstMatch(options.path);
    if (match == null) return null;
    final rows = _rows['outbound-routes']!;
    final id = match.group(1);
    if (method == 'GET' && id == null) {
      final sorted = [
        ...rows,
      ]..sort((a, b) => (a['priority'] as int).compareTo(b['priority'] as int));
      return _json({'rows': sorted});
    }
    if (method == 'POST' && id == null) {
      final body = _body(options);
      final row = {
        'id': 'or-${_next++}',
        'priority': null,
        'pattern': null,
        'trunkIds': null,
        'strip': 0,
        'prepend': null,
      };
      return _saveRoute(rows, row, body, created: true);
    }
    final index = rows.indexWhere((r) => r['id'] == id);
    if (index < 0) return _problem(404, 'No outbound route with that id.');
    switch (method) {
      case 'GET':
        return _json(rows[index]);
      case 'PATCH':
        return _saveRoute(rows, rows[index], _body(options));
      case 'DELETE':
        rows.removeAt(index);
        return ResponseBody.fromString('', 204);
    }
    return _problem(405, 'Not supported.');
  }

  ResponseBody _saveRoute(
    List<Map<String, dynamic>> rows,
    Map<String, dynamic> row,
    Map<String, dynamic> body, {
    bool created = false,
  }) {
    final next = {...row, for (final k in body.keys) k: body[k]};
    final pattern = '${next['pattern'] ?? ''}'.trim();
    if (!RegExp(r'^(\+\d*)?$').hasMatch(pattern)) {
      return _problem(
        400,
        "'$pattern' is not a valid outbound route pattern: an E.164 prefix (e.g. '+1', '+44') or empty for catch-all.",
      );
    }
    final trunks = [...(next['trunkIds'] as List? ?? const [])];
    if (trunks.isEmpty) return _problem(400, 'At least one trunk is required.');
    if (trunks.toSet().length != trunks.length) {
      return _problem(400, 'A trunk is listed more than once.');
    }
    final priority = next['priority'];
    if (priority is! int || priority < 0) {
      return _problem(400, 'priority must be a non-negative integer.');
    }
    next['pattern'] = pattern;
    if (next['prepend'] == '') next['prepend'] = null;
    row
      ..clear()
      ..addAll(next);
    if (created) rows.add(row);
    return _json(row, created ? 201 : 200);
  }

  Map<String, dynamic>? _emergencyRoute;

  /// Call records (a fixed set, newest first, so paging and filters can be
  /// seen) and their CSV exports.
  ResponseBody? _calls(RequestOptions options) {
    final method = options.method.toUpperCase();
    final path = options.path;
    final one = RegExp(r'^/v1/tenants/[^/]+/cdrs/([^/]+)$').firstMatch(path);
    if (one != null && method == 'GET') {
      final found = _cdrs.where((c) => c['id'] == one.group(1));
      return found.isEmpty
          ? _problem(404, 'No CDR with that id.')
          : _json(found.first);
    }
    if (RegExp(r'^/v1/tenants/[^/]+/cdrs$').hasMatch(path) && method == 'GET') {
      final q = options.queryParameters;
      final from = q['from'] == null ? null : DateTime.parse('${q['from']}');
      final to = q['to'] == null ? null : DateTime.parse('${q['to']}');
      final limit = int.tryParse('${q['limit'] ?? 50}') ?? 50;
      final after = q['cursor'] == null ? -1 : int.parse('${q['cursor']}');
      final matching = [
        for (final (i, c) in _cdrs.indexed)
          if (i > after &&
              (from == null ||
                  !DateTime.parse('${c['startAt']}').isBefore(from)) &&
              (to == null || !DateTime.parse('${c['startAt']}').isAfter(to)) &&
              (q['direction'] == null || c['direction'] == q['direction']) &&
              (q['did'] == null || c['did'] == q['did']) &&
              (q['number'] == null ||
                  c['fromNumber'] == q['number'] ||
                  c['toNumber'] == q['number'] ||
                  c['dialedNumber'] == q['number']))
            (i, c),
      ];
      final page = matching.take(limit).toList();
      final more = matching.length > page.length;
      return _json({
        'rows': [for (final (_, c) in page) c],
        'nextCursor': more ? '${page.last.$1}' : null,
      });
    }
    if (RegExp(r'^/v1/tenants/[^/]+/cdr-exports$').hasMatch(path) &&
        method == 'POST') {
      final body = _body(options);
      final from = DateTime.tryParse('${body['from']}');
      final to = DateTime.tryParse('${body['to']}');
      if (from == null || to == null) {
        return _problem(400, 'from and to must be valid RFC 3339 timestamps.');
      }
      if (!to.isAfter(from)) return _problem(400, 'to must be after from.');
      if (to.difference(from).inDays > 366) {
        return _problem(400, 'from/to cannot span more than 366 days.');
      }
      final export = {
        'id': 'exp-${_next++}',
        'status': 'pending',
        'fromAt': from.toUtc().toIso8601String(),
        'toAt': to.toUtc().toIso8601String(),
        'downloadUrl': null,
        'errorMessage': null,
      };
      _exports['${export['id']}'] = export;
      return _json(export, 201);
    }
    final exp = RegExp(r'^/v1/tenants/[^/]+/cdr-exports/([^/]+)$')
        .firstMatch(path);
    if (exp != null && method == 'GET') {
      final export = _exports[exp.group(1)];
      if (export == null) return _problem(404, 'No CDR export with that id.');
      // Each look moves it along: pending, processing, then ready. A range
      // from before 2020 fails, so that outcome can be seen too.
      if (export['status'] == 'pending') {
        export['status'] = 'processing';
      } else if (export['status'] == 'processing') {
        final old = DateTime.parse('${export['fromAt']}').year < 2020;
        export['status'] = old ? 'failed' : 'ready';
        export['errorMessage'] = old ? 'The file could not be written.' : null;
        export['downloadUrl'] = old
            ? null
            : 'https://storage.demo.invalid/exports/${export['id']}.csv';
      }
      return _json(export);
    }
    return null;
  }

  final _exports = <String, Map<String, dynamic>>{};

  /// 65 calls, one every three hours back from 2026-09-24, so the list spans
  /// two pages.
  late final List<Map<String, dynamic>> _cdrs = [
    for (var i = 0; i < 65; i++) _cdr(i),
  ];

  static Map<String, dynamic> _cdr(int i) {
    final start = DateTime.utc(2026, 9, 24, 9).subtract(Duration(hours: 3 * i));
    final kind = i % 3; // 0 inbound, 1 outbound, 2 internal
    final answered = i % 5 != 4;
    final duration = answered ? 30 + (i * 37) % 600 : 0;
    final ext = 101 + i % 3;
    final direction = ['inbound', 'outbound', 'internal'][kind];
    return {
      'id': 'cdr-${i + 1}',
      'direction': direction,
      'startAt': start.toIso8601String(),
      'answerAt': answered
          ? start.add(const Duration(seconds: 4)).toIso8601String()
          : null,
      'endAt': start.add(Duration(seconds: duration + 6)).toIso8601String(),
      'durationSec': duration + 6,
      'billableSec': duration,
      'fromNumber': switch (kind) {
        0 => '+1415555${(1000 + i).toString()}',
        1 => '$ext',
        _ => '$ext',
      },
      'fromName': kind == 1 || kind == 2 ? 'Ext $ext' : null,
      'toNumber': switch (kind) {
        0 => '$ext',
        1 => '+1212555${(2000 + i).toString()}',
        _ => '${101 + (i + 1) % 3}',
      },
      'dialedNumber': switch (kind) {
        0 => '+14155550100',
        1 => '+1212555${(2000 + i).toString()}',
        _ => '${101 + (i + 1) % 3}',
      },
      'did': kind == 0 ? '+14155550100' : null,
      'trunkId': kind == 2 ? null : 'trunk-1',
      'extensionIds': ['ext-${ext - 100}'],
      'disposition': answered ? 'answered' : (kind == 1 ? 'busy' : 'no_answer'),
      'hangupCause': answered ? 'NORMAL_CLEARING' : 'NO_ANSWER',
      'hangupBy': answered ? 'caller' : 'system',
      'queueId': null,
      'flowId': kind == 0 ? 'flow-1' : null,
      'recordingIds': <String>[],
    };
  }

  static final _tierRoute = RegExp(
    r'^/v1/tenants/[^/]+/queues/([^/]+)/tiers(?:/([^/]+))?$',
  );

  ResponseBody? _tiers(RequestOptions options) {
    final match = _tierRoute.firstMatch(options.path);
    if (match == null) return null;
    final tiers = _queueTiers.putIfAbsent(match.group(1)!, () => []);
    final id = match.group(2);
    final method = options.method.toUpperCase();
    if (method == 'GET') return _json({'rows': tiers});
    if (method == 'POST') {
      final body = _body(options);
      if (tiers.any((t) => t['agentId'] == body['agentId'])) {
        return _problem(409, 'That agent is already in this queue.');
      }
      final tier = {
        'id': 'tier-${_next++}',
        'queueId': match.group(1),
        'agentId': body['agentId'],
        'level': body['level'] ?? 1,
        'position': body['position'] ?? 1,
      };
      tiers.add(tier);
      return _json(tier, 201);
    }
    final index = tiers.indexWhere((t) => t['id'] == id);
    if (index < 0) return _problem(404, 'Not found.');
    if (method == 'PATCH') {
      final body = _body(options);
      for (final k in const ['level', 'position']) {
        if (body[k] != null) tiers[index][k] = body[k];
      }
      return _json(tiers[index]);
    }
    if (method == 'DELETE') {
      tiers.removeAt(index);
      return ResponseBody.fromString('', 204);
    }
    return _problem(405, 'Not supported.');
  }

  /// Mailboxes, keyed by id, and their messages. Seeded lazily so the
  /// extensions they point at exist.
  late final List<Map<String, dynamic>> _mailboxes = [
    {
      'id': 'mb-1',
      'extensionId': 'ext-1',
      'greetingStatus': 'none',
      'notifyEmail': 'alice@acme-dental.example',
      'emailAttachAudio': true,
      'emailAfter': 'mark_read',
    },
    {
      'id': 'mb-2',
      'extensionId': 'ext-2',
      'greetingStatus': 'ready',
      'notifyEmail': null,
      'emailAttachAudio': false,
      'emailAfter': 'keep',
    },
  ];

  late final Map<String, List<Map<String, dynamic>>> _messages = {
    'mb-1': [
      _message('vm-1', 'Pat Caller', '+15005550123', 42000, false, 2),
      _message('vm-2', null, '+15005550188', 8000, false, 26),
      _message('vm-3', 'Dr. Lee', '+15005550199', 95000, true, 50),
    ],
    'mb-2': <Map<String, dynamic>>[],
  };

  static Map<String, dynamic> _message(
    String id,
    String? name,
    String? number,
    int durationMs,
    bool isRead,
    int hoursAgo,
  ) => {
    'id': id,
    'status': 'ready',
    'callerIdName': name,
    'callerIdNumber': number,
    'durationMs': durationMs,
    'isRead': isRead,
    'createdAt': DateTime.utc(
      2026,
      9,
      24,
      19,
      20,
    ).subtract(Duration(hours: hoursAgo)).toIso8601String(),
  };

  static final _voicemailRoute = RegExp(
    r'^/v1/tenants/[^/]+/voicemail/mailboxes(?:/([^/]+))?(?:/([^/]+))?(?:/([^/]+))?(?:/([^/]+))?$',
  );
  static final _emailAddress = RegExp(r'^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$');

  Map<String, dynamic> _mailboxView(Map<String, dynamic> box) => {
    ...box,
    'unreadCount': (_messages[box['id']] ?? const [])
        .where((m) => m['isRead'] != true)
        .length,
  };

  /// The voicemail API (`voicemail-service`): mailboxes, their messages,
  /// presigned play addresses, PIN reset and the email settings.
  ResponseBody? _voicemail(RequestOptions options) {
    final match = _voicemailRoute.firstMatch(options.path);
    if (match == null) return null;
    final method = options.method.toUpperCase();
    final id = match.group(1);
    if (id == null) {
      return method == 'GET'
          ? _json({
              'rows': [for (final b in _mailboxes) _mailboxView(b)],
            })
          : _problem(405, 'Not supported.');
    }
    final index = _mailboxes.indexWhere((b) => b['id'] == id);
    if (index < 0) return _problem(404, 'No mailbox with that id.');
    final box = _mailboxes[index];
    final part = match.group(2);
    if (part == null) {
      return method == 'GET'
          ? _json(_mailboxView(box))
          : _problem(405, 'Not supported.');
    }
    final messages = _messages.putIfAbsent(id, () => []);
    if (part == 'email-settings' && method == 'PUT') {
      final body = _body(options);
      final address = ('${body['notifyEmail'] ?? ''}').trim();
      final attach = body['attachAudio'] == true;
      final after = '${body['afterEmail']}';
      if (address.isNotEmpty && !_emailAddress.hasMatch(address)) {
        return _problem(
          400,
          'notifyEmail must be a single valid email address.',
        );
      }
      if (!const ['keep', 'mark_read', 'delete'].contains(after)) {
        return _problem(
          400,
          "afterEmail must be 'keep', 'mark_read' or 'delete'.",
        );
      }
      if (after == 'delete' && !attach) {
        return _problem(
          400,
          "afterEmail 'delete' requires attachAudio: the email is then the only copy.",
        );
      }
      box['notifyEmail'] = address.isEmpty ? null : address;
      box['emailAttachAudio'] = attach;
      box['emailAfter'] = after;
      return _json(_mailboxView(box));
    }
    if (part == 'reset-pin' && method == 'POST') {
      final pin = '${_body(options)['pin']}';
      if (!RegExp(r'^\d{4,8}$').hasMatch(pin)) {
        return _problem(400, 'PIN must be 4 to 8 digits.');
      }
      return ResponseBody.fromString('', 204);
    }
    if (part == 'messages') {
      final messageId = match.group(3);
      if (messageId == null) {
        return method == 'GET'
            ? _json({'rows': messages})
            : _problem(405, 'Not supported.');
      }
      final at = messages.indexWhere((m) => m['id'] == messageId);
      if (at < 0) {
        return _problem(404, 'No message with that id in that mailbox.');
      }
      if (match.group(4) == 'play-url' && method == 'GET') {
        return _json({
          'url': 'https://storage.demo.invalid/voicemail/$messageId.wav',
        });
      }
      if (match.group(4) == null && method == 'DELETE') {
        messages.removeAt(at);
        return ResponseBody.fromString('', 204);
      }
    }
    return _problem(405, 'Not supported.');
  }

  /// 30 recordings, one every two hours back from 2026-09-24, so the list
  /// spans two pages. Every sixth is on the Support queue; a few are still
  /// uploading, failed, or past their retention.
  late final List<Map<String, dynamic>> _recordings = [
    for (var i = 0; i < 30; i++) _recording(i),
  ];

  static Map<String, dynamic> _recording(int i) {
    final start = DateTime.utc(
      2026,
      9,
      24,
      18,
    ).subtract(Duration(hours: 2 * i));
    final direction = ['inbound', 'outbound', 'internal'][i % 3];
    final status = i == 1
        ? 'pending'
        : i == 2
        ? 'failed'
        : i >= 27
        ? 'expired'
        : 'ready';
    final ready = status == 'ready';
    return {
      'id': 'rec-${i + 1}',
      'callUuid': 'call-${i + 1}',
      'direction': direction,
      'extensionId': 'ext-${1 + i % 3}',
      'peerExtensionId': direction == 'internal'
          ? 'ext-${1 + (i + 1) % 3}'
          : null,
      'queueId': direction == 'inbound' && i % 2 == 0 ? 'q-1' : null,
      'didId': direction == 'inbound' ? 'did-1' : null,
      'announced': direction == 'inbound',
      'status': status,
      'startedAt': start.toIso8601String(),
      'durationMs': ready || status == 'expired'
          ? 20000 + (i * 7919) % 400000
          : null,
      'sizeBytes': ready ? 160000 + (i * 104729) % 4000000 : null,
      'retentionDate': ready
          ? start.add(const Duration(days: 90)).toIso8601String()
          : null,
    };
  }

  static final _recordingRoute = RegExp(
    r'^/v1/tenants/[^/]+/recordings(?:/([^/]+))?(?:/([^/]+))?$',
  );
  static final _policyRoute = RegExp(
    r'^/v1/tenants/[^/]+/recording-policies(?:/([^/]+))?$',
  );

  late final List<Map<String, dynamic>> _policies = [
    {
      'id': 'pol-1',
      'scopeType': 'tenant',
      'scopeId': 'demo-tenant',
      'direction': 'any',
      'action': 'record',
      'announce': true,
      'consentAssetId': 'media-1',
    },
    {
      'id': 'pol-2',
      'scopeType': 'extension',
      'scopeId': 'ext-3',
      'direction': 'any',
      'action': 'no_record',
      'announce': false,
      'consentAssetId': null,
    },
  ];
  var _retentionDays = 90;

  /// The recording API (`recording-service`): search, presigned play and
  /// download addresses, delete, the recording rules, and how long recordings
  /// are kept. Checks what the service checks.
  ResponseBody? _recordingApi(RequestOptions options) {
    final method = options.method.toUpperCase();
    final path = options.path;

    if (RegExp(r'^/v1/tenants/[^/]+/recording-settings$').hasMatch(path)) {
      if (method == 'GET') return _json({'retentionDays': _retentionDays});
      if (method == 'PUT') {
        final days = _body(options)['retentionDays'];
        if (days is! int || days < 0 || days > 3650) {
          return _problem(400, 'Retention must be from 0 to 3650 days.');
        }
        _retentionDays = days;
        return _json({'retentionDays': _retentionDays});
      }
      return _problem(405, 'Not supported.');
    }

    final policy = _policyRoute.firstMatch(path);
    if (policy != null) {
      final id = policy.group(1);
      if (id == null) {
        if (method == 'GET') return _json({'rows': _policies});
        if (method == 'POST') {
          final made = _policyFrom(_body(options), 'pol-${_next++}');
          if (made is ResponseBody) return made;
          _policies.add(made as Map<String, dynamic>);
          return _json(made, 201);
        }
        return _problem(405, 'Not supported.');
      }
      final at = _policies.indexWhere((p) => p['id'] == id);
      if (at < 0) return _problem(404, "No policy with id '$id'.");
      if (method == 'PUT') {
        final made = _policyFrom(_body(options), id, except: id);
        if (made is ResponseBody) return made;
        _policies[at] = made as Map<String, dynamic>;
        return _json(made);
      }
      if (method == 'DELETE') {
        _policies.removeAt(at);
        return ResponseBody.fromString('', 204);
      }
      return _problem(405, 'Not supported.');
    }

    final match = _recordingRoute.firstMatch(path);
    if (match == null) return null;
    final id = match.group(1);
    if (id == null) {
      if (method != 'GET') return _problem(405, 'Not supported.');
      final q = options.queryParameters;
      final from = q['from'] == null ? null : DateTime.parse('${q['from']}');
      final to = q['to'] == null ? null : DateTime.parse('${q['to']}');
      final limit = int.tryParse('${q['limit'] ?? 50}') ?? 50;
      final after = q['cursor'] == null ? -1 : int.parse('${q['cursor']}');
      final matching = [
        for (final (i, r) in _recordings.indexed)
          if (i > after &&
              (from == null ||
                  !DateTime.parse('${r['startedAt']}').isBefore(from)) &&
              (to == null ||
                  DateTime.parse('${r['startedAt']}').isBefore(to)) &&
              (q['direction'] == null || r['direction'] == q['direction']) &&
              (q['queueId'] == null || r['queueId'] == q['queueId']) &&
              (q['extensionId'] == null ||
                  r['extensionId'] == q['extensionId'] ||
                  r['peerExtensionId'] == q['extensionId']))
            (i, r),
      ];
      final page = matching.take(limit).toList();
      return _json({
        'rows': [for (final (_, r) in page) r],
        'nextCursor': matching.length > page.length ? '${page.last.$1}' : null,
      });
    }
    final at = _recordings.indexWhere((r) => r['id'] == id);
    if (at < 0) return _problem(404, 'No recording with that id.');
    final recording = _recordings[at];
    final part = match.group(2);
    if (part == null && method == 'GET') return _json(recording);
    if (part == null && method == 'DELETE') {
      _recordings.removeAt(at);
      return ResponseBody.fromString('', 204);
    }
    if ((part == 'play-url' || part == 'download-url') && method == 'GET') {
      if (recording['status'] != 'ready') {
        return _problem(
          409,
          'That recording is ${recording['status']}, so it has no audio to serve.',
        );
      }
      return _json({
        'url': part == 'play-url'
            ? 'https://storage.demo.invalid/recordings/$id.wav?X-Amz-Expires=300'
            : 'https://storage.demo.invalid/recordings/$id.wav?download=1',
        'expiresAt': DateTime.utc(2026, 9, 24, 19, 25).toIso8601String(),
      });
    }
    return _problem(405, 'Not supported.');
  }

  /// A policy from a request body, or the problem to answer with (the same
  /// checks the service makes).
  Object _policyFrom(Map<String, dynamic> body, String id, {String? except}) {
    final scope = '${body['scopeType']}';
    if (!const ['tenant', 'extension', 'queue', 'did'].contains(scope)) {
      return _problem(
        400,
        'scopeType is not one of tenant, extension, queue, did.',
      );
    }
    final direction = '${body['direction'] ?? 'any'}';
    if (!const ['any', 'inbound', 'outbound', 'internal'].contains(direction)) {
      return _problem(400, 'direction is not valid.');
    }
    final action = '${body['action']}';
    if (!const ['record', 'no_record'].contains(action)) {
      return _problem(400, 'action must be record or no_record.');
    }
    final scopeId = scope == 'tenant'
        ? 'demo-tenant'
        : '${body['scopeId'] ?? ''}';
    if (scopeId.isEmpty) {
      return _problem(400, "A $scope policy needs the $scope's id.");
    }
    final announce = body['announce'] == true;
    if (action == 'no_record' && announce) {
      return _problem(
        400,
        'A policy that does not record has nothing to announce.',
      );
    }
    final consent = body['consentAssetId'] as String?;
    if (consent != null && !announce) {
      return _problem(
        400,
        'A consent announcement asset needs announce to be on.',
      );
    }
    final taken = _policies.any(
      (p) =>
          p['id'] != except &&
          p['scopeType'] == scope &&
          p['scopeId'] == scopeId &&
          p['direction'] == direction,
    );
    if (taken) {
      return _problem(
        409,
        'A policy for that scope and direction already exists; change it instead.',
      );
    }
    return {
      'id': id,
      'scopeType': scope,
      'scopeId': scopeId,
      'direction': direction,
      'action': action,
      'announce': announce,
      'consentAssetId': consent,
    };
  }

  Map<String, dynamic>? _extensionOf(String? userId) {
    for (final e in _rows['extensions']!) {
      if (userId != null && e['userId'] == userId) return e;
    }
    return null;
  }

  ResponseBody _noExtension() => _problem(
    404,
    'No extension is linked to your account yet. Ask an administrator to link one.',
    code: 'no_linked_extension',
  );

  /// The signed-in person's own phone (`/v1/tenants/{id}/me/...`), for the
  /// extension linked to [userId]. It never reads an extension, mailbox or
  /// number from the request: everything is worked out from who signed in.
  ResponseBody? _myPhone(RequestOptions options, String? userId) {
    final match = RegExp(
      r'^/v1/tenants/[^/]+/me/(extension|directory|call-handling|voicemail|calls)(?:/(.*))?$',
    ).firstMatch(options.path);
    if (match == null) return null;
    final method = options.method.toUpperCase();
    final extension = _extensionOf(userId);
    if (extension == null) return _noExtension();
    final tail = match.group(2);
    switch (match.group(1)) {
      case 'extension':
        return _json({
          for (final k in const [
            'id',
            'number',
            'displayName',
            'callerIdName',
            'callerIdNumber',
            'voicemailEnabled',
          ])
            k: extension[k],
        });
      case 'directory':
        return _json({
          'rows': [
            for (final e in _rows['extensions']!)
              {
                'id': e['id'],
                'number': e['number'],
                'displayName': e['displayName'],
              },
          ],
        });
      case 'call-handling':
        return _callHandlingOf('${extension['id']}', options);
      case 'voicemail':
        final box = _mailboxes.where(
          (b) => b['extensionId'] == extension['id'],
        );
        if (box.isEmpty) {
          return _problem(
            404,
            'Your extension has no voicemail box yet. Ask an administrator.',
            code: 'no_mailbox',
          );
        }
        final id = '${box.first['id']}';
        final suffix = switch (tail) {
          null => '',
          'messages' => '/messages',
          'reset-pin' => '/reset-pin',
          'email-settings' => '/email-settings',
          _ when tail.startsWith('messages/') => '/$tail',
          _ => null,
        };
        if (suffix == null) return _problem(404, 'No such route.');
        // A message can be marked read here; the administrator's routes have no
        // such thing.
        final read = RegExp(r'^/messages/([^/]+)/read$').firstMatch(suffix);
        if (read != null && method == 'POST') {
          final messages = _messages[id] ?? const [];
          final at = messages.indexWhere((m) => m['id'] == read.group(1));
          if (at < 0) {
            return _problem(404, 'No message with that id in your mailbox.');
          }
          messages[at]['isRead'] = true;
          return ResponseBody.fromString('', 204);
        }
        // Same behaviour as the administrator's mailbox routes, on my mailbox.
        final inner = RequestOptions(
          path: '/v1/tenants/demo/voicemail/mailboxes/$id$suffix',
          method: options.method,
          data: options.data,
        );
        final result = _voicemail(inner);
        if (result == null) return null;
        // My mailbox has no id of its own to show, and neither has its extension.
        if (result.statusCode < 400 &&
            (tail == null || tail == 'email-settings')) {
          final view = _mailboxView(box.first);
          return _json({
            for (final e in view.entries)
              if (e.key != 'id' && e.key != 'extensionId') e.key: e.value,
          });
        }
        return result;
      case 'calls':
        final number = '${extension['number']}';
        final q = options.queryParameters;
        final from = q['from'] == null ? null : DateTime.parse('${q['from']}');
        final to = q['to'] == null ? null : DateTime.parse('${q['to']}');
        final limit = int.tryParse('${q['limit'] ?? 50}') ?? 50;
        final after = q['cursor'] == null ? -1 : int.parse('${q['cursor']}');
        final matching = [
          for (final (i, c) in _cdrs.indexed)
            if (i > after &&
                (c['fromNumber'] == number ||
                    c['toNumber'] == number ||
                    c['dialedNumber'] == number) &&
                (from == null ||
                    !DateTime.parse('${c['startAt']}').isBefore(from)) &&
                (to == null ||
                    !DateTime.parse('${c['startAt']}').isAfter(to)) &&
                (q['direction'] == null || c['direction'] == q['direction']))
              (i, c),
        ];
        final page = matching.take(limit).toList();
        return _json({
          'rows': [
            for (final (_, c) in page)
              {
                for (final k in const [
                  'id',
                  'direction',
                  'startAt',
                  'answerAt',
                  'endAt',
                  'durationSec',
                  'fromNumber',
                  'fromName',
                  'toNumber',
                  'dialedNumber',
                  'disposition',
                ])
                  k: c[k],
              },
          ],
          'nextCursor': matching.length > page.length
              ? '${page.last.$1}'
              : null,
        });
    }
    return null;
  }

  ResponseBody? handle(RequestOptions options, {String? userId}) {
    final mine = _myPhone(options, userId);
    if (mine != null) return mine;
    final orgs = _orgs(options);
    if (orgs != null) return orgs;
    final infra = _domainsAndAssets(options);
    if (infra != null) return infra;
    final people = _people(options);
    if (people != null) return people;
    final certs = _certificates(options);
    if (certs != null) return certs;
    final phone = _phone(options);
    if (phone != null) return phone;
    final callHandling = _callHandlingRoute(options);
    if (callHandling != null) return callHandling;
    final voicemail = _voicemail(options);
    if (voicemail != null) return voicemail;
    final recordings = _recordingApi(options);
    if (recordings != null) return recordings;
    final media = _media(options);
    if (media != null) return media;
    final routing = _routing(options);
    if (routing != null) return routing;
    final calls = _calls(options);
    if (calls != null) return calls;
    final tiers = _tiers(options);
    if (tiers != null) return tiers;
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

  ResponseBody _problem(int status, String detail, {String? code}) =>
      ResponseBody.fromString(
        jsonEncode({
          'title': 'Error',
          'status': status,
          'detail': detail,
          'code': ?code,
        }),
        status,
        headers: {
          Headers.contentTypeHeader: ['application/problem+json'],
        },
      );
}
