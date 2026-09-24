import 'package:flutter/widgets.dart';
import 'package:flutter/material.dart' show Scaffold;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/acting.dart';
import '../core/permissions.dart';
import '../core/session.dart';
import '../features/auth/invite_page.dart';
import '../features/auth/login_page.dart';
import '../features/auth/mfa_page.dart';
import '../features/auth/reset_pages.dart';
import '../features/callflow/builder/flow_builder_page.dart';
import '../features/callflow/flows_page.dart';
import '../features/media/media_page.dart';
import '../features/orgs/domains_panel.dart';
import '../features/orgs/reseller_page.dart';
import '../features/trunks/trunks_page.dart';
import '../features/orgs/brand_page.dart';
import '../features/orgs/orgs_page.dart';
import '../features/pbx/resource.dart';
import '../features/pbx/resource_page.dart';
import '../features/dashboard/dashboard_page.dart';
import '../features/audit/audit_page.dart';
import '../features/platform/platform_health_page.dart';
import '../features/shell/notice_pages.dart';
import '../features/shell/sections.dart';
import '../features/certificates/certificates_page.dart';
import '../features/users/users_page.dart';
import '../features/voicemail/voicemail_page.dart';
import '../features/shell/shell_page.dart';

/// Each top-level section is its own route (08 §1), so deep links work and a
/// reload restores the page from the URL. Sections are shown by org type.
final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(sessionProvider, (_, _) => refresh.value++);
  ref.listen(actingProvider, (_, _) => refresh.value++);
  // What the user may see arrives after sign-in; recheck the page they are on.
  ref.listen(permissionsProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  final everySection = {
    for (final list in sectionsByOrgType.values)
      for (final s in list) s.path: s,
  }.values;

  return GoRouter(
    refreshListenable: refresh,
    errorBuilder: (context, state) => const Scaffold(body: NotFoundPage()),
    redirect: (context, state) {
      final session = ref.read(sessionProvider);
      final path = state.uri.path;
      if (session == null) {
        // The second sign-in step only makes sense mid sign-in; a reload lands
        // here with no pending step and goes back to the first.
        if (path == '/login/mfa') {
          return ref.read(authStepProvider) == null ? '/login' : null;
        }
        return _signedOutPaths.contains(path) ? null : '/login';
      }
      final sections = visibleSections(
        session,
        ref.read(actingProvider),
        ref.read(knownPermissionsProvider),
      );
      if (_signedOutPaths.contains(path) || path == '/') {
        return sections.first.path;
      }
      // A section the role does not have is not reachable by URL either: it
      // gets the forbidden page. An address that is no section at all is a
      // 404 page.
      if (path == '/forbidden') return null;
      if (!sections.any((s) => path.startsWith(s.path))) {
        return everySection.any((s) => path.startsWith(s.path))
            ? '/forbidden'
            : null;
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => LoginPage(
          orgId: state.uri.queryParameters['org'],
          notice: _notices[state.uri.queryParameters['notice']],
        ),
      ),
      GoRoute(path: '/login/mfa', builder: (context, state) => const MfaPage()),
      GoRoute(
        path: '/reset',
        builder: (context, state) => const ResetRequestPage(),
      ),
      GoRoute(
        path: '/reset/confirm',
        builder: (context, state) =>
            ResetConfirmPage(token: state.uri.queryParameters['token']),
      ),
      GoRoute(
        path: '/invite',
        builder: (context, state) =>
            InvitePage(token: state.uri.queryParameters['token']),
      ),
      ShellRoute(
        builder: (context, state, child) => ShellPage(child: child),
        routes: [
          GoRoute(
            path: '/resellers/:id',
            builder: (context, state) =>
                ResellerPage(resellerId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: '/call-flows/:id',
            builder: (context, state) =>
                FlowBuilderPage(flowId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: '/forbidden',
            builder: (context, state) => const ForbiddenPage(),
          ),
          for (final s in everySection)
            GoRoute(path: s.path, builder: (context, state) => _pageFor(s)),
        ],
      ),
    ],
  );
});

/// The screen behind a section: a PBX resource page where one exists, and a
/// placeholder for the sections whose backend or screens are still to come.
Widget _pageFor(Section section) {
  final defs = _pbxPages[section.path];
  if (defs != null) return ResourcePage(defs: defs);
  if (section.path == '/call-flows') return const FlowsPage();
  if (section.path == '/brand') return const BrandPage();
  if (section.path == '/users') return const UsersPage();
  if (section.path == '/certificates') return const CertificatesPage();
  if (section.path == '/media') return const MediaPage();
  if (section.path == '/voicemail') return const VoicemailPage();
  if (section.path == '/dashboard') return const DashboardPage();
  if (section.path == '/audit') return const AuditPage();
  if (section.path == '/platform-health') return const PlatformHealthPage();
  if (section.path == '/trunks') return const TrunksPage();
  if (section.path == '/domains') return const DomainsPage();
  if (section.path == '/resellers' || section.path == '/tenants') {
    return const OrgsPage();
  }
  return SectionPage(section: section);
}

const _pbxPages = <String, List<ResourceDef>>{
  '/extensions': [extensionsDef],
  '/phones': [devicesDef],
  '/phone-numbers': [didsDef],
  '/ring-groups': [ringGroupsDef],
  '/queues': [queuesDef, agentsDef],
  '/conference-rooms': [conferenceRoomsDef],
  '/parking-lots': [parkingLotsDef],
  '/schedules': [schedulesDef],
  '/settings': [emergencyLocationsDef],
};

/// Pages a signed-out visitor may open.
const _signedOutPaths = {
  '/login',
  '/login/mfa',
  '/reset',
  '/reset/confirm',
  '/invite',
};

/// What a `?notice=` on the sign-in page says.
const _notices = {
  'password-changed': 'Password changed. Sign in with your new password.',
  'account-created': 'Account created. Sign in to continue.',
};
