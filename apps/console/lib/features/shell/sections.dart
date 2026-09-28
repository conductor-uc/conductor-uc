import 'package:flutter/material.dart';

import '../../core/acting.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';

/// The navigation's names, translated through lib/l10n (S9-01).
enum NavLabel {
  dashboard,
  audit,
  users,
  myCallHandling,
  myVoicemail,
  myCallHistory,
  myPhone,
  resellers,
  operations,
  certificates,
  security,
  tenants,
  trunks,
  domains,
  brand,
  extensions,
  phones,
  phoneNumbers,
  callFlows,
  ringGroups,
  outboundRoutes,
  queues,
  conferenceRooms,
  parkingLots,
  schedules,
  media,
  monitoring,
  recordings,
  voicemail,
  callRecords,
  emergencyLocations,
}

extension NavLabelText on NavLabel {
  String of(AppLocalizations l10n) => switch (this) {
    NavLabel.dashboard => l10n.navDashboard,
    NavLabel.audit => l10n.navAudit,
    NavLabel.users => l10n.navUsers,
    NavLabel.myCallHandling => l10n.navMyCallHandling,
    NavLabel.myVoicemail => l10n.navMyVoicemail,
    NavLabel.myCallHistory => l10n.navMyCallHistory,
    NavLabel.myPhone => l10n.navMyPhone,
    NavLabel.resellers => l10n.navResellers,
    NavLabel.operations => l10n.navOperations,
    NavLabel.certificates => l10n.navCertificates,
    NavLabel.security => l10n.navSecurity,
    NavLabel.tenants => l10n.navTenants,
    NavLabel.trunks => l10n.navTrunks,
    NavLabel.domains => l10n.navDomains,
    NavLabel.brand => l10n.navBrand,
    NavLabel.extensions => l10n.navExtensions,
    NavLabel.phones => l10n.navPhones,
    NavLabel.phoneNumbers => l10n.navPhoneNumbers,
    NavLabel.callFlows => l10n.navCallFlows,
    NavLabel.ringGroups => l10n.navRingGroups,
    NavLabel.outboundRoutes => l10n.navOutboundRoutes,
    NavLabel.queues => l10n.navQueues,
    NavLabel.conferenceRooms => l10n.navConferenceRooms,
    NavLabel.parkingLots => l10n.navParkingLots,
    NavLabel.schedules => l10n.navSchedules,
    NavLabel.media => l10n.navMedia,
    NavLabel.monitoring => l10n.navMonitoring,
    NavLabel.recordings => l10n.navRecordings,
    NavLabel.voicemail => l10n.navVoicemail,
    NavLabel.callRecords => l10n.navCallRecords,
    NavLabel.emergencyLocations => l10n.navEmergencyLocations,
  };
}

/// The headings the navigation is grouped under (S9-05), so a tenant's twenty
/// screens read as a few areas rather than one long list.
enum NavGroup {
  platform,
  customers,
  service,
  people,
  calls,
  activity,
  settings,
  you,
  admin,
}

extension NavGroupText on NavGroup {
  String of(AppLocalizations l10n) => switch (this) {
    NavGroup.platform => l10n.navGroupPlatform,
    NavGroup.customers => l10n.navGroupCustomers,
    NavGroup.service => l10n.navGroupService,
    NavGroup.people => l10n.navGroupPeople,
    NavGroup.calls => l10n.navGroupCalls,
    NavGroup.activity => l10n.navGroupActivity,
    NavGroup.settings => l10n.navGroupSettings,
    NavGroup.you => l10n.navGroupYou,
    NavGroup.admin => l10n.navGroupAdmin,
  };
}

class Section {
  const Section(
    this.path,
    this.label,
    this.icon, {
    this.privateData = false,
    this.requires = const [],
    this.group,
  });

  /// The heading it sits under; null sits at the top, ungrouped.
  final NavGroup? group;

  final String path;

  /// What the menu calls it: `label.of(context.l10n)`.
  final NavLabel label;
  final IconData icon;

  /// Shows tenant `private` data, which a reseller can never read (rule H1).
  final bool privateData;

  /// The permissions that make this section worth showing: holding any one is
  /// enough. Empty means everyone. A configuration screen asks for its `.read`
  /// permission (G-10), which the `.manage` one implies ([holds]); the screen
  /// itself hides its changes from someone without the `.manage` one. Hiding
  /// is a convenience; the services still decide what a request may do.
  final List<String> requires;

  bool shownTo(Set<String>? permissions) =>
      permissions == null ||
      requires.isEmpty ||
      requires.any((p) => holds(permissions, p));
}

const _dashboard = Section(
  '/dashboard',
  NavLabel.dashboard,
  Icons.dashboard_outlined,
);
const _audit = Section(
  '/audit',
  NavLabel.audit,
  Icons.fact_check_outlined,
  requires: ['audit.read'],
  group: NavGroup.admin,
);
const _users = Section(
  '/users',
  NavLabel.users,
  Icons.people_outline,
  requires: ['user.read'],
  group: NavGroup.admin,
);

/// A tenant's people are the first thing it manages, not an afterthought.
const _tenantUsers = Section(
  '/users',
  NavLabel.users,
  Icons.people_outline,
  requires: ['user.read'],
  group: NavGroup.people,
);

/// The three screens of a person's own phone (end-user self-service). They are
/// everything a person who holds only self-service permissions sees, in place
/// of the administrator's navigation.
const myPhoneSections = [
  Section(
    '/my-phone/call-handling',
    NavLabel.myCallHandling,
    Icons.call_split_outlined,
    requires: ['self.settings'],
  ),
  Section(
    '/my-phone/voicemail',
    NavLabel.myVoicemail,
    Icons.voicemail_outlined,
    privateData: true,
    requires: ['self.voicemail'],
  ),
  Section(
    '/my-phone/history',
    NavLabel.myCallHistory,
    Icons.history_outlined,
    privateData: true,
    requires: ['self.history'],
  ),
];

/// What an administrator who is also linked to an extension is offered: one
/// entry for the same three screens.
const myPhoneEntry = Section(
  '/my-phone',
  NavLabel.myPhone,
  Icons.phone_in_talk_outlined,
  privateData: true,
  requires: ['self.settings', 'self.voicemail', 'self.history'],
  group: NavGroup.you,
);

/// Top-level sections by org type (08 §3).
const sectionsByOrgType = <OrgType, List<Section>>{
  OrgType.master: [
    _dashboard,
    Section(
      '/resellers',
      NavLabel.resellers,
      Icons.storefront_outlined,
      requires: ['reseller.read'],
      group: NavGroup.platform,
    ),
    // S4-12: the services, media nodes, SIP edge, event bus and data stores.
    Section(
      '/operations',
      NavLabel.operations,
      Icons.monitor_heart_outlined,
      requires: ['platform.observe'],
      group: NavGroup.platform,
    ),
    Section(
      '/certificates',
      NavLabel.certificates,
      Icons.verified_user_outlined,
      requires: ['domain.read'],
      group: NavGroup.platform,
    ),
    // Whether the platform's administrators must use two-step verification.
    Section(
      '/security',
      NavLabel.security,
      Icons.lock_outline,
      requires: ['platform.observe'],
      group: NavGroup.platform,
    ),
    _audit,
    _users,
  ],
  OrgType.reseller: [
    _dashboard,
    Section(
      '/tenants',
      NavLabel.tenants,
      Icons.apartment_outlined,
      requires: ['tenant.read', 'tenant.create'],
      group: NavGroup.customers,
    ),
    Section(
      '/trunks',
      NavLabel.trunks,
      Icons.cable_outlined,
      requires: ['trunk.read'],
      group: NavGroup.service,
    ),
    Section(
      '/domains',
      NavLabel.domains,
      Icons.dns_outlined,
      requires: ['domain.read'],
      group: NavGroup.service,
    ),
    Section(
      '/brand',
      NavLabel.brand,
      Icons.palette_outlined,
      requires: ['brand.read'],
      group: NavGroup.service,
    ),
    _users,
    _audit,
  ],
  OrgType.tenant: [
    _dashboard,
    _tenantUsers,
    Section(
      '/extensions',
      NavLabel.extensions,
      Icons.dialpad_outlined,
      requires: ['extension.read'],
      group: NavGroup.people,
    ),
    Section(
      '/phones',
      NavLabel.phones,
      Icons.phone_android_outlined,
      requires: ['extension.read'],
      group: NavGroup.people,
    ),
    Section(
      '/phone-numbers',
      NavLabel.phoneNumbers,
      Icons.phone_outlined,
      requires: ['did.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/call-flows',
      NavLabel.callFlows,
      Icons.account_tree_outlined,
      requires: ['callflow.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/ring-groups',
      NavLabel.ringGroups,
      Icons.groups_outlined,
      requires: ['group.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/outbound-routes',
      NavLabel.outboundRoutes,
      Icons.call_made_outlined,
      requires: ['trunk.read', 'emergency_route.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/queues',
      NavLabel.queues,
      Icons.queue_outlined,
      requires: ['queue.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/conference-rooms',
      NavLabel.conferenceRooms,
      Icons.video_call_outlined,
      requires: ['conference_room.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/parking-lots',
      NavLabel.parkingLots,
      Icons.local_parking_outlined,
      requires: ['parking_lot.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/schedules',
      NavLabel.schedules,
      Icons.schedule_outlined,
      requires: ['schedule.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/media',
      NavLabel.media,
      Icons.library_music_outlined,
      requires: ['media.read'],
      group: NavGroup.calls,
    ),
    Section(
      '/monitoring',
      NavLabel.monitoring,
      Icons.visibility_outlined,
      requires: ['monitor.presence'],
      group: NavGroup.activity,
    ),
    Section(
      '/recordings',
      NavLabel.recordings,
      Icons.mic_none_outlined,
      privateData: true,
      requires: [
        'recording.listen',
        'recording.download',
        'recording.delete',
        'recording.policy.read',
      ],
      group: NavGroup.activity,
    ),
    Section(
      '/voicemail',
      NavLabel.voicemail,
      Icons.voicemail_outlined,
      privateData: true,
      requires: ['voicemail.access'],
      group: NavGroup.activity,
    ),
    Section(
      '/call-records',
      NavLabel.callRecords,
      Icons.history_outlined,
      privateData: true,
      requires: ['cdr.read'],
      group: NavGroup.activity,
    ),
    Section(
      '/settings',
      NavLabel.emergencyLocations,
      Icons.settings_outlined,
      requires: ['emergency_location.read'],
      group: NavGroup.settings,
    ),
  ],
};

/// The sections the signed-in user sees. While acting as a tenant that is the
/// tenant's own navigation, without the private-data sections when the user is
/// a reseller (rule H1; the server enforces it independently). When
/// [permissions] is known, sections the user holds none of the permissions for
/// are left out too; the Dashboard is always there.
///
/// A person of a tenant who holds only self-service permissions
/// ([isSelfOnly]) is shown [myPhoneSections] and nothing else. An
/// administrator of a tenant who is linked to an extension ([hasPhone]) also
/// gets [myPhoneEntry]. Neither applies while acting as a tenant: a reseller or
/// the master has no extension of their own there.
List<Section> visibleSections(
  Session session,
  ActingTenant? acting, [
  Set<String>? permissions,
  bool hasPhone = false,
]) {
  final ownTenant = session.orgType == OrgType.tenant && acting == null;
  if (ownTenant && isSelfOnly(permissions)) {
    return [
      for (final s in myPhoneSections)
        if (s.shownTo(permissions)) s,
    ];
  }
  final List<Section> byOrg;
  if (acting == null || session.orgType == OrgType.tenant) {
    byOrg = sectionsByOrgType[session.orgType]!;
  } else {
    final tenant = sectionsByOrgType[OrgType.tenant]!;
    byOrg = session.orgType == OrgType.reseller
        ? [
            for (final s in tenant)
              if (!s.privateData) s,
          ]
        : tenant;
  }
  return [
    for (final s in byOrg)
      if (s.shownTo(permissions)) s,
    if (ownTenant && hasPhone && myPhoneEntry.shownTo(permissions))
      myPhoneEntry,
  ];
}
