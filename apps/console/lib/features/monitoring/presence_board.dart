import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../pbx/pbx_api.dart';
import 'presence.dart';

/// How a presence state reads on the board: a word, an icon and a color, so no
/// state is told apart by color alone.
class PresenceLook {
  const PresenceLook(this.label, this.icon, this.color);

  final String label;
  final IconData icon;

  /// Null for a state the console does not know: the theme's neutral outline.
  final Color? color;
}

/// The look of each state the topic sends. An unknown one is shown as it
/// comes, in neutral. Colors are the shade that reads on the theme's
/// background: darker on light, lighter on dark (S9-17).
PresenceLook presenceLook(
  AppLocalizations l,
  String state, {
  Brightness brightness = Brightness.light,
}) {
  final dark = brightness == Brightness.dark;
  Color shade(MaterialColor c, int light, int onDark) =>
      c[dark ? onDark : light]!;
  return switch (state) {
    'idle' => PresenceLook(
      l.presenceAvailable,
      Icons.check_circle_outline,
      shade(Colors.green, 800, 300),
    ),
    'ringing' => PresenceLook(
      l.presenceRinging,
      Icons.ring_volume_outlined,
      shade(Colors.orange, 900, 300),
    ),
    'on_call' => PresenceLook(
      l.presenceOnACall,
      Icons.call,
      shade(Colors.red, 700, 300),
    ),
    'dnd' => PresenceLook(
      l.presenceDoNotDisturb,
      Icons.do_not_disturb_on_outlined,
      shade(Colors.purple, 700, 200),
    ),
    'offline' => PresenceLook(
      l.presenceOffline,
      Icons.phone_disabled_outlined,
      shade(Colors.grey, 700, 400),
    ),
    _ => PresenceLook(_unknownLabel(l, state), Icons.help_outline, null),
  };
}

/// `on_break` reads as "On break"; nothing at all as "Unknown".
String _unknownLabel(AppLocalizations l, String state) {
  final words = state.replaceAll('_', ' ').trim();
  if (words.isEmpty) return l.presenceUnknown;
  return '${words[0].toUpperCase()}${words.substring(1)}';
}

/// The tenant's extensions and what each is doing, updated as it changes.
/// Presence is `config` data every tenant user holds (`monitor.presence`), so
/// unlike live calls it is also shown to a reseller inside a tenant, if its
/// role holds it. Names are shown to a holder of `extension.read`; anyone else
/// sees numbers only.
class PresencePanel extends ConsumerWidget {
  const PresencePanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    if (ref.watch(tenantIdProvider) == null) {
      return Text(l10n.monChooseTenantPresence);
    }
    if (!ref.watch(canProvider('monitor.presence'))) {
      return Text(l10n.monNoPresenceRole);
    }
    final view = ref.watch(presenceProvider).value;
    final stopped = view?.stopped;
    if (view == null || (!view.loaded && stopped == null)) {
      return Text(l10n.monConnecting);
    }
    if (stopped != null) return Text(_stoppedText(l10n, stopped));
    if (view.extensions.isEmpty) return Text(l10n.monNoExtensions);
    final names = ref.watch(canProvider('extension.read'))
        ? {
            for (final e
                in ref.watch(rowsProvider('extensions')).asData?.value ??
                    const <Json>[])
              '${e['number']}': e['displayName'] as String?,
          }
        : const <String, String?>{};
    return SingleChildScrollView(
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final p in view.extensions)
            PresenceTile(
              key: ValueKey('presence-${p.extension}'),
              presence: p,
              name: names[p.extension],
            ),
        ],
      ),
    );
  }
}

String _stoppedText(AppLocalizations l, String code) => switch (code) {
  'offline' || 'unavailable' => l.monUpdatesUnavailable,
  'forbidden' ||
  'permission_denied' ||
  'reseller_private_data_denied' => l.monNoPresenceRole,
  _ => l.monUpdatesStopped,
};

/// One extension on the board: its number, its name when known, and its state
/// as a word beside an icon in the state's color.
class PresenceTile extends StatelessWidget {
  const PresenceTile({super.key, required this.presence, this.name});

  final Presence presence;
  final String? name;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final look = presenceLook(
      context.l10n,
      presence.state,
      brightness: Theme.of(context).brightness,
    );
    final color = look.color ?? theme.colorScheme.outline;
    final name = this.name;
    return MergeSemantics(
      child: Container(
        width: 176,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          border: Border.all(color: color.withValues(alpha: 0.6)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            Icon(look.icon, color: color, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(presence.extension, style: theme.textTheme.titleSmall),
                  if (name != null && name.isNotEmpty)
                    Text(
                      name,
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  Text(look.label, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
