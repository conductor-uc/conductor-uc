import 'package:flutter/material.dart';

import '../../core/acting.dart';
import '../../core/session.dart';

class Section {
  const Section(
    this.path,
    this.label,
    this.icon, {
    this.privateData = false,
    this.requires = const [],
  });

  final String path;
  final String label;
  final IconData icon;

  /// Shows tenant `private` data, which a reseller can never read (rule H1).
  final bool privateData;

  /// The permissions that make this section worth showing: holding any one is
  /// enough. Empty means everyone. Hiding is a convenience; the services still
  /// decide what a request may do.
  final List<String> requires;

  bool shownTo(Set<String>? permissions) =>
      permissions == null ||
      requires.isEmpty ||
      requires.any(permissions.contains);
}

const _dashboard = Section('/dashboard', 'Dashboard', Icons.dashboard_outlined);
const _audit = Section(
  '/audit',
  'Audit',
  Icons.fact_check_outlined,
  requires: ['audit.read'],
);
const _users = Section(
  '/users',
  'Users',
  Icons.people_outline,
  requires: ['user.manage'],
);

/// Top-level sections by org type (08 §3). Each is a placeholder page until
/// its owning task (S3-06 to S3-08) builds the screens.
const sectionsByOrgType = <OrgType, List<Section>>{
  OrgType.master: [
    _dashboard,
    Section(
      '/resellers',
      'Resellers',
      Icons.storefront_outlined,
      requires: ['reseller.manage'],
    ),
    Section(
      '/platform-health',
      'Platform health',
      Icons.monitor_heart_outlined,
      requires: ['analytics.view'],
    ),
    Section(
      '/certificates',
      'Certificates',
      Icons.verified_user_outlined,
      requires: ['domain.manage'],
    ),
    _audit,
    _users,
  ],
  OrgType.reseller: [
    _dashboard,
    Section(
      '/tenants',
      'Tenants',
      Icons.apartment_outlined,
      requires: ['tenant.manage', 'tenant.create'],
    ),
    Section(
      '/trunks',
      'Trunks',
      Icons.cable_outlined,
      requires: ['trunk.manage'],
    ),
    Section(
      '/domains',
      'Domains',
      Icons.dns_outlined,
      requires: ['domain.manage'],
    ),
    Section(
      '/brand',
      'Brand',
      Icons.palette_outlined,
      requires: ['brand.manage'],
    ),
    _users,
    _audit,
  ],
  OrgType.tenant: [
    _dashboard,
    _users,
    Section(
      '/extensions',
      'Extensions',
      Icons.dialpad_outlined,
      requires: ['extension.manage'],
    ),
    Section(
      '/phones',
      'Phones',
      Icons.phone_android_outlined,
      requires: ['extension.manage'],
    ),
    Section(
      '/phone-numbers',
      'Phone numbers',
      Icons.phone_outlined,
      requires: ['did.manage'],
    ),
    Section(
      '/call-flows',
      'Call flows',
      Icons.account_tree_outlined,
      requires: ['callflow.edit', 'callflow.publish'],
    ),
    Section(
      '/ring-groups',
      'Ring groups',
      Icons.groups_outlined,
      requires: ['group.manage'],
    ),
    Section(
      '/outbound-routes',
      'Outbound routes',
      Icons.call_made_outlined,
      requires: ['trunk.manage', 'emergency_route.manage'],
    ),
    Section(
      '/queues',
      'Queues',
      Icons.queue_outlined,
      requires: ['queue.manage'],
    ),
    Section(
      '/conference-rooms',
      'Conference rooms',
      Icons.video_call_outlined,
      requires: ['conference_room.manage'],
    ),
    Section(
      '/parking-lots',
      'Parking lots',
      Icons.local_parking_outlined,
      requires: ['parking_lot.manage'],
    ),
    Section(
      '/schedules',
      'Schedules',
      Icons.schedule_outlined,
      requires: ['schedule.manage'],
    ),
    Section(
      '/media',
      'Media',
      Icons.library_music_outlined,
      requires: ['media.manage'],
    ),
    Section(
      '/monitoring',
      'Monitoring',
      Icons.visibility_outlined,
      requires: ['monitor.presence'],
    ),
    Section(
      '/recordings',
      'Recordings',
      Icons.mic_none_outlined,
      privateData: true,
      requires: ['recording.listen', 'recording.download'],
    ),
    Section(
      '/voicemail',
      'Voicemail',
      Icons.voicemail_outlined,
      privateData: true,
      requires: ['voicemail.access'],
    ),
    Section(
      '/call-records',
      'Call records',
      Icons.history_outlined,
      privateData: true,
      requires: ['cdr.read'],
    ),
    Section(
      '/reports',
      'Reports',
      Icons.bar_chart_outlined,
      requires: ['cdr.read', 'analytics.view', 'billing.read'],
    ),
    Section(
      '/settings',
      'Settings',
      Icons.settings_outlined,
      requires: ['emergency_location.manage'],
    ),
  ],
};

/// The sections the signed-in user sees. While acting as a tenant that is the
/// tenant's own navigation, without the private-data sections when the user is
/// a reseller (rule H1; the server enforces it independently). When
/// [permissions] is known, sections the user holds none of the permissions for
/// are left out too; the Dashboard is always there.
List<Section> visibleSections(
  Session session,
  ActingTenant? acting, [
  Set<String>? permissions,
]) {
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
  ];
}
