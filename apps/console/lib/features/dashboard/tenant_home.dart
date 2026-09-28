import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/acting.dart';
import '../../core/format.dart';
import '../../core/permissions.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../cdr/call_records_page.dart' show dispositionLabels, partyLabel;
import '../cdr/cdr_api.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart' show tenantCountryProvider;

/// The last few calls, newest first, for the home page (S9-06).
final recentCallsProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  final api = ref.watch(cdrApiProvider);
  if (api == null) return const [];
  return (await api.list(const CdrFilter(), limit: 5)).rows;
});

/// One step of getting a new phone system going.
class _Step {
  const _Step({
    required this.title,
    required this.why,
    required this.action,
    required this.path,
    required this.done,
  });

  final String title;
  final String why;
  final String action;
  final String path;

  /// True once done, null while it cannot be told yet.
  final bool? done;
}

/// A tenant's home (S9-06): what is left to set up, what needs attention, and
/// the latest calls, for the sections this person can open. Every figure
/// comes from the same lists the screens show.
class TenantHome extends ConsumerWidget {
  const TenantHome({super.key, required this.visible, required this.glance});

  /// The paths of the sections this person can open.
  final Set<String> visible;

  /// The at-a-glance figures, below everything else.
  final Widget glance;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final acting = ref.watch(actingProvider);
    final me = ref.watch(meProvider).asData?.value;
    final name = acting?.name.isNotEmpty == true
        ? acting!.name
        : me?.orgName ?? l10n.homeTitle;

    List<Json>? rows(String key) => ref.watch(rowsProvider(key)).asData?.value;
    bool? has(String key) => rows(key)?.isNotEmpty;

    final numbers = visible.contains('/phone-numbers') ? rows('dids') : null;
    final unrouted = [
      for (final d in numbers ?? const <Json>[])
        if (d['destinationId'] == null || d['destinationType'] == null) d,
    ];

    final steps = <_Step>[
      if (visible.contains('/settings'))
        _Step(
          title: l10n.homeStepLocationTitle,
          why: l10n.homeStepLocationWhy,
          action: l10n.homeStepLocationAction,
          path: '/settings',
          done: has('emergency-locations'),
        ),
      if (visible.contains('/extensions'))
        _Step(
          title: l10n.homeStepExtensionsTitle,
          why: l10n.homeStepExtensionsWhy,
          action: l10n.homeStepExtensionsAction,
          path: '/extensions',
          done: has('extensions'),
        ),
      if (visible.contains('/phones'))
        _Step(
          title: l10n.homeStepPhoneTitle,
          why: l10n.homeStepPhoneWhy,
          action: l10n.homeStepPhoneAction,
          path: '/phones',
          done: has('devices'),
        ),
      if (visible.contains('/phone-numbers')) ...[
        _Step(
          title: l10n.homeStepNumberTitle,
          why: l10n.homeStepNumberWhy,
          action: l10n.homeStepNumberAction,
          path: '/phone-numbers',
          done: has('dids'),
        ),
        _Step(
          title: l10n.homeStepAnsweredTitle,
          why: l10n.homeStepAnsweredWhy,
          action: l10n.homeStepAnsweredAction,
          path: '/phone-numbers',
          done: numbers == null ? null : numbers.isNotEmpty && unrouted.isEmpty,
        ),
      ],
    ];

    final flows = visible.contains('/call-flows') ? rows('flows') : null;
    final unpublished = [
      for (final f in flows ?? const <Json>[])
        if (f['currentPublishedVersionId'] == null) f,
    ];
    final media = visible.contains('/media') ? rows('media-assets') : null;
    final failed = [
      for (final m in media ?? const <Json>[])
        if (m['status'] == 'failed') m,
    ];
    final attention = <(IconData, String, String)>[
      if (unrouted.isNotEmpty)
        (
          Icons.phone_disabled_outlined,
          l10n.homeAttentionUnrouted(unrouted.length),
          '/phone-numbers',
        ),
      if (unpublished.isNotEmpty)
        (
          Icons.account_tree_outlined,
          l10n.homeAttentionUnpublished(unpublished.length),
          '/call-flows',
        ),
      if (failed.isNotEmpty)
        (
          Icons.error_outline,
          l10n.homeAttentionFailedMedia(failed.length),
          '/media',
        ),
    ];

    final setupDone = steps.every((s) => s.done == true);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(name, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 4),
          Text(l10n.homeSubtitle),
          const SizedBox(height: 16),
          if (steps.isNotEmpty && !setupDone) ...[
            _Checklist(steps: steps),
            const SizedBox(height: 16),
          ],
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              _Panel(
                title: l10n.homeAttentionTitle,
                icon: Icons.notifications_outlined,
                child: attention.isEmpty
                    ? Text(l10n.homeAttentionNone)
                    : Column(
                        children: [
                          for (final (icon, text, path) in attention)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              leading: Icon(
                                icon,
                                color: Theme.of(context).colorScheme.error,
                              ),
                              title: Text(text),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () => context.go(path),
                            ),
                        ],
                      ),
              ),
              if (visible.contains('/call-records') &&
                  ref.watch(canProvider('cdr.read')))
                _Panel(
                  title: l10n.homeRecentCallsTitle,
                  icon: Icons.history,
                  trailing: TextButton(
                    onPressed: () => context.go('/call-records'),
                    child: Text(l10n.homeSeeAll),
                  ),
                  child: ref
                      .watch(recentCallsProvider)
                      .when(
                        loading: () => Text(l10n.shellLoading),
                        error: (e, _) => Text(problemMessage(e)),
                        data: (calls) => calls.isEmpty
                            ? Text(l10n.homeRecentCallsNone)
                            : Column(
                                children: [
                                  for (final c in calls) _CallLine(call: c),
                                ],
                              ),
                      ),
                ),
            ],
          ),
          const SizedBox(height: 24),
          Text(
            l10n.homeGlanceTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          glance,
        ],
      ),
    );
  }
}

/// What is left to set up, in order, with the step that does each.
class _Checklist extends StatelessWidget {
  const _Checklist({required this.steps});

  final List<_Step> steps;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final done = steps.where((s) => s.done == true).length;
    final next = steps.indexWhere((s) => s.done == false);
    return Card(
      key: const ValueKey('setup-checklist'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.homeSetupTitle, style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(l10n.homeSetupProgress(done, steps.length)),
            const SizedBox(height: 8),
            LinearProgressIndicator(value: done / steps.length),
            const SizedBox(height: 8),
            for (final (i, s) in steps.indexed)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: switch (s.done) {
                  true => Icon(
                    Icons.check_circle,
                    color: theme.colorScheme.primary,
                  ),
                  false => const Icon(Icons.radio_button_unchecked),
                  // Still being counted: a still mark, not a spinner, so a
                  // slow list doesn't make the page busy.
                  null => const Icon(Icons.more_horiz),
                },
                title: Text(
                  s.title,
                  style: s.done == true
                      ? TextStyle(color: theme.colorScheme.onSurfaceVariant)
                      : null,
                ),
                subtitle: s.done == true ? null : Text(s.why),
                trailing: s.done == true
                    ? null
                    : i == next
                    ? FilledButton(
                        onPressed: () => context.go(s.path),
                        child: Text(s.action),
                      )
                    : OutlinedButton(
                        onPressed: () => context.go(s.path),
                        child: Text(s.action),
                      ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A titled card on the home page.
class _Panel extends StatelessWidget {
  const _Panel({
    required this.title,
    required this.icon,
    required this.child,
    this.trailing,
  });

  final String title;
  final IconData icon;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 460,
    child: Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 8),
            child,
          ],
        ),
      ),
    ),
  );
}

/// One recent call: which way, who, how it ended, and when.
class _CallLine extends ConsumerWidget {
  const _CallLine({required this.call});

  final Json call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final country = ref.watch(tenantCountryProvider);
    // An outside number reads as people write it; an extension as it is.
    String number(Object? n) =>
        '$n'.startsWith('+') ? formatPhone('$n', country: country) : '$n';
    final icon = switch (call['direction']) {
      'inbound' => Icons.call_received,
      'outbound' => Icons.call_made,
      _ => Icons.swap_horiz,
    };
    final disposition = dispositionLabels[call['disposition']];
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon),
      title: Text(
        context.l10n.homeCallParties(
          partyLabel(number(call['fromNumber']), call['fromName']),
          partyLabel(number(call['toNumber']), call['toName']),
        ),
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        [?disposition, formatDateTime(call['startAt'])].join(' · '),
      ),
    );
  }
}
