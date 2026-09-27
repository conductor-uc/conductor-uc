import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
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
/// comes, in neutral.
PresenceLook presenceLook(String state) => switch (state) {
  'idle' => PresenceLook(
    'Available',
    Icons.check_circle_outline,
    Colors.green.shade800,
  ),
  'ringing' => PresenceLook(
    'Ringing',
    Icons.ring_volume_outlined,
    Colors.orange.shade900,
  ),
  'on_call' => PresenceLook('On a call', Icons.call, Colors.red.shade700),
  'dnd' => PresenceLook(
    'Do not disturb',
    Icons.do_not_disturb_on_outlined,
    Colors.purple.shade700,
  ),
  'offline' => PresenceLook(
    'Offline',
    Icons.phone_disabled_outlined,
    Colors.grey.shade700,
  ),
  _ => PresenceLook(_unknownLabel(state), Icons.help_outline, null),
};

/// `on_break` reads as "On break"; nothing at all as "Unknown".
String _unknownLabel(String state) {
  final words = state.replaceAll('_', ' ').trim();
  if (words.isEmpty) return 'Unknown';
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
    if (ref.watch(tenantIdProvider) == null) {
      return const Text('Choose a tenant to see its extensions.');
    }
    if (!ref.watch(canProvider('monitor.presence'))) {
      return const Text("Your role doesn't include presence.");
    }
    final view = ref.watch(presenceProvider).value;
    final stopped = view?.stopped;
    if (view == null || (!view.loaded && stopped == null)) {
      return const Text('Connecting…');
    }
    if (stopped != null) return Text(_stoppedText(stopped));
    if (view.extensions.isEmpty) return const Text('No extensions yet.');
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

String _stoppedText(String code) => switch (code) {
  'offline' || 'unavailable' => 'Live updates are unavailable. Reconnecting…',
  'forbidden' ||
  'permission_denied' ||
  'reseller_private_data_denied' => "Your role doesn't include presence.",
  _ => 'Live updates stopped.',
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
    final look = presenceLook(presence.state);
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
