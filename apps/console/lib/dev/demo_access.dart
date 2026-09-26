/// Demo answers for what a signed-in user can do, and for the audit and
/// platform health screens. In step with the built-in roles in `@cuc/authz`
/// closely enough to exercise the console; the real values come from the
/// service.
library;

/// What the built-in `tenant_user` role holds (`@cuc/authz`).
const demoSelfService = [
  'org.view',
  'monitor.presence',
  'self.settings',
  'self.voicemail',
  'self.history',
  'self.recording',
];

/// The id the demo gives the signed-in person, by email: the one an extension
/// can be linked to. Everyone else is the anonymous `demo-user`.
String demoUserId(String email) {
  if (email.startsWith('user') || email.startsWith('linked')) return 'user-4';
  if (email.startsWith('nophone')) return 'user-nophone';
  return 'demo-user';
}

const _tenantAdmin = [
  'org.view',
  'user.manage',
  'role.manage',
  'grant.manage',
  'extension.manage',
  'did.manage',
  'emergency_location.manage',
  'emergency_route.manage',
  'group.manage',
  'queue.manage',
  'parking_lot.manage',
  'conference_room.manage',
  'schedule.manage',
  'media.manage',
  'trunk.manage',
  'callflow.edit',
  'callflow.publish',
  'secret.reveal',
  'recording.policy.manage',
  'recording.listen',
  'recording.download',
  'recording.delete',
  'recording.control',
  'cdr.read',
  'cdr.export',
  'voicemail.access',
  'monitor.presence',
  'monitor.calls',
  'analytics.view',
  'audit.read',
  'apikey.manage',
  ...demoSelfService,
];

const _resellerAdmin = [
  'org.view',
  'tenant.create',
  'tenant.manage',
  'tenant.suspend',
  'domain.manage',
  'brand.manage',
  'user.manage',
  'role.manage',
  'grant.manage',
  'extension.manage',
  'did.manage',
  'emergency_location.manage',
  'emergency_route.manage',
  'group.manage',
  'queue.manage',
  'parking_lot.manage',
  'conference_room.manage',
  'schedule.manage',
  'media.manage',
  'trunk.manage',
  'audit.read',
  'apikey.manage',
  'billing.read',
];

const _masterAdmin = [
  'org.view',
  'reseller.create',
  'reseller.manage',
  'tenant.create',
  'tenant.manage',
  'tenant.suspend',
  'brand.manage',
  // master_admin holds every permission; this is the one the certificate
  // settings use.
  'domain.manage',
  'user.manage',
  'analytics.view',
  'audit.read',
  'cdr.read',
  ..._tenantAdmin,
];

/// Configuration reads (G-10) a tenant's own configuration screens need.
const _tenantReads = [
  'user.read',
  'role.read',
  'grant.read',
  'extension.read',
  'did.read',
  'emergency_location.read',
  'emergency_route.read',
  'group.read',
  'queue.read',
  'parking_lot.read',
  'conference_room.read',
  'schedule.read',
  'media.read',
  'trunk.read',
  'callflow.read',
  'recording.policy.read',
];

/// Read-only support roles (`master_support`, `reseller_support`), and a
/// tenant person who can read the configuration and change none of it.
List<String> _support(String orgType) => switch (orgType) {
  'master' => const [
    'org.view',
    'cdr.read',
    'analytics.view',
    'audit.read',
    'monitor.presence',
    'monitor.calls',
    'billing.read',
    'reseller.read',
    'tenant.read',
    'domain.read',
    'brand.read',
    ..._tenantReads,
  ],
  'reseller' => const [
    'org.view',
    'audit.read',
    'tenant.read',
    'domain.read',
    'brand.read',
    ..._tenantReads,
  ],
  _ => const ['org.view', 'monitor.presence', ..._tenantReads],
};

/// The permissions the demo gives a user, or null to make the lookup fail
/// (the console then falls back to the org type's sections).
///
/// - `limited@...` is a tenant who can change extensions and see presence only.
/// - `editor@...` is a tenant who can edit call flows but not publish them.
/// - `reader@...` is a tenant who can read call records but not export them.
/// - `routes@...` is a tenant who can change outbound routes but not the
///   emergency route.
/// - `listener@...` is a tenant who can play recordings but not download or delete
///   them, or change what is recorded.
/// - `noperm@...` is a tenant whose permission lookup fails.
/// - `support@...`, `reseller-support@...` and `master-support@...` hold the
///   configuration reads and no writes: the support role of their org type,
///   or, in a tenant, someone who only looks (G-10).
/// - `user@...` is an ordinary person of a tenant (the `tenant_user` role):
///   only their own phone. They own extension 101.
/// - `nophone@...` is the same, but nobody has linked an extension to them.
/// - `linked@...` is a tenant administrator who is also linked to extension
///   101, so is offered My phone as well.
List<String>? demoPermissions(String orgType, String email) {
  if (email.startsWith('noperm')) return null;
  if (email.startsWith('user') || email.startsWith('nophone')) {
    return const [...demoSelfService];
  }
  if (email.startsWith('limited')) {
    return const ['org.view', 'extension.manage', 'monitor.presence'];
  }
  if (email.startsWith('reader')) return const ['org.view', 'cdr.read'];
  if (email.startsWith('listener')) {
    return const ['org.view', 'recording.listen'];
  }
  if (email.startsWith('routes')) return const ['org.view', 'trunk.manage'];
  if (email.startsWith('editor')) return const ['org.view', 'callflow.edit'];
  if (email.split('@').first.endsWith('support')) return _support(orgType);
  return switch (orgType) {
    'master' => [
      ...{..._masterAdmin},
    ],
    'reseller' => _resellerAdmin,
    _ => _tenantAdmin,
  };
}

/// A few audit rows for the organization the demo user is in.
List<Map<String, Object?>> demoAuditEvents(String orgId, String orgType) => [
  {
    'id': 'ev-3',
    'at': '2026-09-24T09:41:07.000Z',
    'actorType': 'user',
    'actorId': 'a1b2c3d4-0000-0000-0000-000000000001',
    'actorOrgId': orgId,
    'targetOrgId': null,
    'action': orgType == 'tenant' ? 'flow.publish' : 'tenant.suspend',
    'resource': orgType == 'tenant' ? 'flow:flow-1' : 'tenant:t-3',
    'dataClass': 'config',
    'reason': null,
    'ip': '203.0.113.7',
    'requestId': 'req-3',
  },
  {
    'id': 'ev-2',
    'at': '2026-09-23T16:02:44.000Z',
    'actorType': 'user',
    'actorId': 'a1b2c3d4-0000-0000-0000-000000000002',
    'actorOrgId': orgId,
    'targetOrgId': orgId,
    'action': 'user.invite',
    'resource': 'user:new.person@example.test',
    'dataClass': 'config',
    'reason': null,
    'ip': '203.0.113.9',
    'requestId': 'req-2',
  },
  if (orgType == 'tenant')
    {
      'id': 'ev-1',
      'at': '2026-09-22T11:15:00.000Z',
      'actorType': 'user',
      'actorId': 'ffff0000-0000-0000-0000-00000000000f',
      'actorOrgId': 'master-org',
      'targetOrgId': orgId,
      'action': 'cdr.read',
      'resource': 'cdr:abc123',
      'dataClass': 'private',
      'reason': 'Support ticket 4411',
      'ip': null,
      'requestId': null,
    },
];

/// One reading of the services' readiness: everything up but one service that
/// answers and says one of its checks is failing.
Map<String, Object?> demoPlatformHealth() => {
  'checkedAt': DateTime.now().toUtc().toIso8601String(),
  'services': [
    for (final (name, ms) in const [
      ('identity-service', 12),
      ('org-service', 9),
      ('pbx-config-service', 15),
      ('callflow-service', 11),
      ('voicemail-service', 41),
      ('cdr-service', 14),
      ('trunk-service', 10),
    ])
      {
        'name': name,
        'status': name == 'voicemail-service' ? 'degraded' : 'up',
        'latencyMs': ms,
        'version': '0.1.0',
        'failing': name == 'voicemail-service' ? ['storage'] : <String>[],
      },
  ],
};
