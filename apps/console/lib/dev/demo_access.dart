/// Demo answers for what a signed-in user can do, and for the audit and
/// platform health screens. In step with the built-in roles in `@cuc/authz`
/// closely enough to exercise the console; the real values come from the
/// service.
library;

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
  'cdr.read',
  'cdr.export',
  'voicemail.access',
  'monitor.presence',
  'analytics.view',
  'audit.read',
  'apikey.manage',
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
  'user.manage',
  'analytics.view',
  'audit.read',
  'cdr.read',
  ..._tenantAdmin,
];

/// The permissions the demo gives a user, or null to make the lookup fail
/// (the console then falls back to the org type's sections).
///
/// - `limited@...` is a tenant who can change extensions and see presence only.
/// - `editor@...` is a tenant who can edit call flows but not publish them.
/// - `noperm@...` is a tenant whose permission lookup fails.
List<String>? demoPermissions(String orgType, String email) {
  if (email.startsWith('noperm')) return null;
  if (email.startsWith('limited')) {
    return const ['org.view', 'extension.manage', 'monitor.presence'];
  }
  if (email.startsWith('editor')) return const ['org.view', 'callflow.edit'];
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
