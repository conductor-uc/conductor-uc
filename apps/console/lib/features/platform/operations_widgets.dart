import 'package:flutter/material.dart';

/// "—" for a figure nobody reported.
const noValue = '—';

/// 1536 → "1.5 KB"; binary units, as memory is counted.
String formatBytes(double? bytes) {
  if (bytes == null) return noValue;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var value = bytes;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  final digits = unit == 0 || value >= 100 ? 0 : 1;
  return '${value.toStringAsFixed(digits)} ${units[unit]}';
}

/// 273_600 → "3 d 4 h"; the two largest units, as an operator reads uptime.
String formatDuration(double? seconds) {
  if (seconds == null) return noValue;
  final s = seconds.round();
  if (s < 60) return '$s s';
  final minutes = s ~/ 60;
  if (minutes < 60) return '$minutes min';
  final hours = minutes ~/ 60;
  if (hours < 24) {
    final m = minutes % 60;
    return m == 0 ? '$hours h' : '$hours h $m min';
  }
  final days = hours ~/ 24;
  final h = hours % 24;
  return h == 0 ? '$days d' : '$days d $h h';
}

String formatPercent(double? value) =>
    value == null ? noValue : '${value.toStringAsFixed(value < 10 ? 1 : 0)}%';

String formatCount(num? value) {
  if (value == null) return noValue;
  final digits = value.round().toString();
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0 && digits[i - 1] != '-') {
      out.write(',');
    }
    out.write(digits[i]);
  }
  return out.toString();
}

String formatMs(double? ms) =>
    ms == null ? noValue : '${ms.toStringAsFixed(ms < 10 ? 1 : 0)} ms';

/// A data store's fact in its own unit.
String formatFact(double? value, String unit) => switch (unit) {
  'bytes' => formatBytes(value),
  'seconds' => formatDuration(value),
  'percent' => formatPercent(value),
  'perSecond' =>
    value == null ? noValue : '${value.toStringAsFixed(value < 10 ? 1 : 0)}/s',
  _ => formatCount(value),
};

/// How a state reads to an operator: good, needs attention, or broken. Every
/// state is shown with an icon and a word, never colour alone.
enum Health { good, attention, bad, neutral }

Color healthColor(ColorScheme scheme, Health health) => switch (health) {
  Health.good => scheme.primary,
  Health.attention => scheme.tertiary,
  Health.bad => scheme.error,
  Health.neutral => scheme.outline,
};

IconData healthIcon(Health health) => switch (health) {
  Health.good => Icons.check_circle_outline,
  Health.attention => Icons.warning_amber_outlined,
  Health.bad => Icons.error_outline,
  Health.neutral => Icons.remove_circle_outline,
};

/// A service's or store's `up | degraded | down`.
(Health, String) serviceHealth(String status) => switch (status) {
  'up' => (Health.good, 'Ready'),
  'degraded' => (Health.attention, 'Not ready'),
  _ => (Health.bad, 'Unreachable'),
};

/// A media node's `up | draining | down`.
(Health, String) nodeHealth(String status) => switch (status) {
  'up' => (Health.good, 'Up'),
  'draining' => (Health.attention, 'Draining'),
  _ => (Health.bad, 'Down'),
};

/// Where OpenSIPs has the node: in rotation or not.
(Health, String) dispatcherHealth(String? state) => switch (state) {
  'active' => (Health.good, 'In rotation'),
  'inactive' => (Health.attention, 'Out of rotation'),
  'probing' => (Health.bad, 'Failing probes'),
  'absent' => (Health.neutral, 'Not in the edge list'),
  _ => (Health.neutral, 'Edge state unknown'),
};

/// An icon and a word in the state's colour; the word carries the meaning.
class HealthLabel extends StatelessWidget {
  const HealthLabel(this.health, this.label, {super.key, this.dense = false});

  final Health health;
  final String label;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = healthColor(scheme, health);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(healthIcon(health), size: dense ? 16 : 18, color: color),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: color, fontWeight: FontWeight.w500),
          ),
        ),
      ],
    );
  }
}

/// The same as a chip, for the top of a card.
class HealthChip extends StatelessWidget {
  const HealthChip(this.health, this.label, {super.key});

  final Health health;
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = healthColor(scheme, health);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: HealthLabel(health, label, dense: true),
    );
  }
}

/// A panel: a titled card with an optional line of explanation.
class Panel extends StatelessWidget {
  const Panel({
    super.key,
    required this.title,
    required this.child,
    this.subtitle,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(title, style: theme.textTheme.titleMedium),
                ),
                ?trailing,
              ],
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 2),
              Text(
                subtitle!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 16),
            child,
          ],
        ),
      ),
    );
  }
}

/// A headline figure: what it counts, the figure, and a line of context.
class StatTile extends StatelessWidget {
  const StatTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.detail,
    this.health,
  });

  final String label;
  final String value;
  final IconData icon;
  final String? detail;

  /// Colours the icon when the figure is a state; the words still say it.
  final Health? health;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final accent = health == null
        ? scheme.primary
        : healthColor(scheme, health!);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: accent.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: accent, size: 22),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (detail != null)
                    Text(
                      detail!,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Lays [children] out in as many equal columns as fit, each at least
/// [minWidth] wide: one column on a phone, several on a desktop.
class ResponsiveGrid extends StatelessWidget {
  const ResponsiveGrid({
    super.key,
    required this.children,
    this.minWidth = 220,
    this.maxColumns = 6,
    this.spacing = 16,
  });

  final List<Widget> children;
  final double minWidth;
  final int maxColumns;
  final double spacing;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final columns = ((constraints.maxWidth + spacing) / (minWidth + spacing))
          .floor()
          .clamp(1, maxColumns);
      final width = (constraints.maxWidth - spacing * (columns - 1)) / columns;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: [
          for (final child in children) SizedBox(width: width, child: child),
        ],
      );
    },
  );
}

/// A label over a figure, for the facts on a card.
class Fact extends StatelessWidget {
  const Fact(this.label, this.value, {super.key});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 2),
        Text(value, style: theme.textTheme.titleSmall),
      ],
    );
  }
}

/// Shown in place of a section whose source did not answer.
class Unavailable extends StatelessWidget {
  const Unavailable(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 24),
    child: Center(child: HealthLabel(Health.bad, message)),
  );
}
