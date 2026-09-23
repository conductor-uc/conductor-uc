import 'package:flutter/material.dart';

import '../../core/session.dart';

class Section {
  const Section(this.path, this.label, this.icon);

  final String path;
  final String label;
  final IconData icon;
}

const _audit = Section('/audit', 'Audit', Icons.fact_check_outlined);
const _users = Section('/users', 'Users', Icons.people_outline);

/// Top-level sections by org type (08 §3). Each is a placeholder page until
/// its owning task (S3-06 to S3-08) builds the screens.
const sectionsByOrgType = <OrgType, List<Section>>{
  OrgType.master: [
    Section('/resellers', 'Resellers', Icons.storefront_outlined),
    Section(
      '/platform-health',
      'Platform health',
      Icons.monitor_heart_outlined,
    ),
    _audit,
    _users,
  ],
  OrgType.reseller: [
    Section('/tenants', 'Tenants', Icons.apartment_outlined),
    Section('/trunks', 'Trunks', Icons.cable_outlined),
    Section('/domains', 'Domains', Icons.dns_outlined),
    Section('/brand', 'Brand', Icons.palette_outlined),
    _users,
    _audit,
  ],
  OrgType.tenant: [
    Section('/dashboard', 'Dashboard', Icons.dashboard_outlined),
    _users,
    Section('/extensions', 'Extensions', Icons.dialpad_outlined),
    Section('/phone-numbers', 'Phone numbers', Icons.phone_outlined),
    Section('/call-flows', 'Call flows', Icons.account_tree_outlined),
    Section('/ring-groups', 'Ring groups', Icons.groups_outlined),
    Section('/queues', 'Queues', Icons.queue_outlined),
    Section('/schedules', 'Schedules', Icons.schedule_outlined),
    Section('/media', 'Media', Icons.library_music_outlined),
    Section('/monitoring', 'Monitoring', Icons.visibility_outlined),
    Section('/recordings', 'Recordings', Icons.mic_none_outlined),
    Section('/voicemail', 'Voicemail', Icons.voicemail_outlined),
    Section('/reports', 'Reports', Icons.bar_chart_outlined),
    Section('/settings', 'Settings', Icons.settings_outlined),
  ],
};
