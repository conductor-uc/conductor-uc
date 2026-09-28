import 'dart:math' as math;

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../l10n/l10n.dart';

/// Rounds [max] up to a tidy axis top (1, 2, 5, 10, 20, 50, ...), never below
/// [floor], so a quiet platform still draws a sensible axis.
double niceCeiling(double max, {double floor = 4}) {
  final target = math.max(max, floor);
  final magnitude = math.pow(10, (math.log(target) / math.ln10).floor());
  for (final step in const [1, 2, 5, 10]) {
    final top = step * magnitude;
    if (top >= target) return top.toDouble();
  }
  return (10 * magnitude).toDouble();
}

TextStyle? _axisStyle(ThemeData theme) => theme.textTheme.labelSmall?.copyWith(
  color: theme.colorScheme.onSurfaceVariant,
);

/// One bar per item, all one measure: calls per node, response time per
/// service, backlog per consumer. One hue (the theme's primary), since colour
/// carries no identity here; the item's name is on the axis, its value in the
/// tooltip and, for a few bars, above each bar.
class ValueBarChart extends StatelessWidget {
  const ValueBarChart({
    super.key,
    required this.items,
    required this.format,
    this.height = 220,
    this.floor = 4,
    this.emptyText,
  });

  final List<(String, double)> items;
  final String Function(double value) format;
  final double height;
  final double floor;

  /// Said when there are no items; "Nothing to show yet." when not given.
  final String? emptyText;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (items.isEmpty) {
      return SizedBox(
        height: height,
        child: Center(
          child: Text(
            emptyText ?? context.l10n.opsNothingToShowYet,
            style: _axisStyle(theme),
          ),
        ),
      );
    }
    final top = niceCeiling(
      items.map((i) => i.$2).fold(0.0, math.max),
      floor: floor,
    );
    final showValues = items.length <= 8;
    return SizedBox(
      height: height,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final slot = constraints.maxWidth / math.max(items.length, 1);
          final barWidth = (slot * 0.5).clamp(6.0, 36.0);
          // Tilt long names when the bars are narrow, so they never collide.
          final tilt = slot < 72;
          return BarChart(
            BarChartData(
              maxY: top,
              minY: 0,
              alignment: BarChartAlignment.spaceAround,
              gridData: FlGridData(
                drawVerticalLine: false,
                horizontalInterval: top / 4,
                getDrawingHorizontalLine: (_) => FlLine(
                  color: scheme.outlineVariant.withValues(alpha: 0.6),
                  strokeWidth: 1,
                ),
              ),
              borderData: FlBorderData(show: false),
              titlesData: FlTitlesData(
                topTitles: const AxisTitles(),
                rightTitles: const AxisTitles(),
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 48,
                    interval: top / 4,
                    getTitlesWidget: (value, meta) => SideTitleWidget(
                      meta: meta,
                      child: Text(format(value), style: _axisStyle(theme)),
                    ),
                  ),
                ),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: tilt ? 56 : 28,
                    getTitlesWidget: (value, meta) {
                      final index = value.toInt();
                      if (index < 0 || index >= items.length) {
                        return const SizedBox.shrink();
                      }
                      return SideTitleWidget(
                        meta: meta,
                        angle: tilt ? -math.pi / 5 : 0,
                        child: SizedBox(
                          width: tilt ? 72 : slot,
                          child: Text(
                            items[index].$1,
                            textAlign: tilt ? TextAlign.end : TextAlign.center,
                            overflow: TextOverflow.ellipsis,
                            style: _axisStyle(theme),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ),
              barTouchData: BarTouchData(
                enabled: true,
                handleBuiltInTouches: !showValues,
                touchTooltipData: BarTouchTooltipData(
                  // Always-on value labels sit on the surface; a hover tooltip
                  // (many bars) is a dark box.
                  getTooltipColor: (_) =>
                      showValues ? Colors.transparent : scheme.inverseSurface,
                  tooltipPadding: showValues
                      ? EdgeInsets.zero
                      : const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  tooltipMargin: 4,
                  getTooltipItem: (group, _, rod, _) => BarTooltipItem(
                    showValues
                        ? format(rod.toY)
                        : '${items[group.x].$1}\n${format(rod.toY)}',
                    TextStyle(
                      color: showValues
                          ? scheme.onSurface
                          : scheme.onInverseSurface,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              barGroups: [
                for (final (index, item) in items.indexed)
                  BarChartGroupData(
                    x: index,
                    showingTooltipIndicators: showValues ? [0] : const [],
                    barRods: [
                      BarChartRodData(
                        toY: item.$2,
                        width: barWidth,
                        color: scheme.primary,
                        borderRadius: const BorderRadius.vertical(
                          top: Radius.circular(4),
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// A ring showing how busy a node's CPU is, the figure in the middle and the
/// node's name below. The ring turns the attention colour above 70% and the
/// error colour above 90%; the figure itself always says it.
class CpuGauge extends StatelessWidget {
  const CpuGauge({super.key, required this.label, required this.busyPercent});

  final String label;
  final double? busyPercent;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final busy = busyPercent;
    final color = busy == null
        ? scheme.outline
        : busy >= 90
        ? scheme.error
        : busy >= 70
        ? scheme.tertiary
        : scheme.primary;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 112,
          height: 112,
          child: Stack(
            alignment: Alignment.center,
            children: [
              PieChart(
                PieChartData(
                  startDegreeOffset: -90,
                  sectionsSpace: 0,
                  centerSpaceRadius: 40,
                  pieTouchData: PieTouchData(enabled: false),
                  sections: [
                    PieChartSectionData(
                      value: busy ?? 0,
                      color: color,
                      radius: 12,
                      showTitle: false,
                    ),
                    PieChartSectionData(
                      value: 100 - (busy ?? 0),
                      color: scheme.surfaceContainerHighest,
                      radius: 12,
                      showTitle: false,
                    ),
                  ],
                ),
              ),
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    formatPercent(busy),
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    context.l10n.opsCpu,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Text(
          label,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.labelLarge,
        ),
      ],
    );
  }
}

/// One measure over the minutes this page has been open: a 2px line with a
/// faint fill, time along the bottom, and a crosshair tooltip.
class TrendChart extends StatelessWidget {
  const TrendChart({
    super.key,
    required this.points,
    required this.format,
    this.height = 180,
    this.floor = 4,
  });

  final List<(DateTime, double)> points;
  final String Function(double value) format;
  final double height;
  final double floor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (points.length < 2) {
      return SizedBox(
        height: height,
        child: Center(
          child: Text(
            context.l10n.opsLineStartsLater,
            style: _axisStyle(theme),
          ),
        ),
      );
    }
    final origin = points.first.$1;
    double x(DateTime at) => at.difference(origin).inMilliseconds / 1000;
    final spots = [for (final (at, v) in points) FlSpot(x(at), v)];
    final top = niceCeiling(
      points.map((p) => p.$2).fold(0.0, math.max),
      floor: floor,
    );
    final span = math.max(spots.last.x, 1.0);
    String clock(double seconds) {
      final at = origin.add(Duration(milliseconds: (seconds * 1000).round()));
      return formatTime(at);
    }

    return SizedBox(
      height: height,
      child: LineChart(
        LineChartData(
          minX: 0,
          maxX: span,
          minY: 0,
          maxY: top,
          gridData: FlGridData(
            drawVerticalLine: false,
            horizontalInterval: top / 4,
            getDrawingHorizontalLine: (_) => FlLine(
              color: scheme.outlineVariant.withValues(alpha: 0.6),
              strokeWidth: 1,
            ),
          ),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 44,
                interval: top / 4,
                getTitlesWidget: (value, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(format(value), style: _axisStyle(theme)),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 24,
                interval: math.max(span / 3, 1),
                getTitlesWidget: (value, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(clock(value), style: _axisStyle(theme)),
                ),
              ),
            ),
          ),
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipColor: (_) => scheme.inverseSurface,
              tooltipPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 4,
              ),
              getTooltipItems: (touched) => [
                for (final spot in touched)
                  LineTooltipItem(
                    '${clock(spot.x)}  ${format(spot.y)}',
                    TextStyle(
                      color: scheme.onInverseSurface,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
            getTouchedSpotIndicator: (bar, indexes) => [
              for (final _ in indexes)
                TouchedSpotIndicatorData(
                  FlLine(color: scheme.outline, strokeWidth: 1),
                  FlDotData(
                    getDotPainter: (_, _, _, _) => FlDotCirclePainter(
                      radius: 4,
                      color: scheme.primary,
                      strokeWidth: 2,
                      strokeColor: scheme.surface,
                    ),
                  ),
                ),
            ],
          ),
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              isCurved: true,
              preventCurveOverShooting: true,
              color: scheme.primary,
              barWidth: 2,
              dotData: const FlDotData(show: false),
              belowBarData: BarAreaData(
                show: true,
                color: scheme.primary.withValues(alpha: 0.12),
              ),
            ),
          ],
        ),
        duration: Duration.zero,
      ),
    );
  }
}
