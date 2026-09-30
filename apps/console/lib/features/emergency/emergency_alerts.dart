import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../core/realtime.dart';
import '../../l10n/l10n.dart';
import '../pbx/pbx_api.dart';

/// The topic name for a tenant's emergency alerts (S2-06, G-1).
String emergencyTopic(String tenantId) => 'tenant:$tenantId:emergencies';

/// Someone in the tenant dialled an emergency number: who, the number, when,
/// and the location on file for their extension, as the realtime hub sends it
/// (`emergency.initiated`).
class EmergencyAlert {
  const EmergencyAlert({
    required this.id,
    required this.at,
    required this.dialedNumber,
    this.callingNumber,
    this.callingName,
    this.locationLabel,
    this.address = const [],
  });

  final String id;
  final DateTime at;
  final String dialedNumber;
  final String? callingNumber;
  final String? callingName;
  final String? locationLabel;

  /// The address lines of the location on file; empty when none was found.
  final List<String> address;

  /// Reads one event, or null when it is not an alert this console shows.
  static EmergencyAlert? fromEvent(Map<String, dynamic> event) {
    if (event['type'] != 'emergency.initiated') return null;
    final id = event['id'];
    final dialed = event['dialedNumber'];
    if (id is! String || dialed is! String) return null;
    String? text(Object? value) =>
        value is String && value.trim().isNotEmpty ? value.trim() : null;
    final location = event['location'];
    final lines = <String>[];
    String? label;
    if (location is Map) {
      label = text(location['label']);
      final city = [
        text(location['city']),
        [
          text(location['state']),
          text(location['postalCode']),
        ].whereType<String>().join(' '),
      ].whereType<String>().where((s) => s.isNotEmpty).join(', ');
      lines.addAll(
        [
          text(location['addressLine1']),
          text(location['addressLine2']),
          city.isEmpty ? null : city,
          text(location['country']),
        ].whereType<String>(),
      );
    }
    return EmergencyAlert(
      id: id,
      at: DateTime.tryParse('${event['at']}') ?? DateTime.now(),
      dialedNumber: dialed,
      callingNumber: text(event['callingNumber']),
      callingName: text(event['callingName']),
      locationLabel: label,
      address: lines,
    );
  }
}

/// The emergency alerts not yet dismissed, newest first, for the tenant being
/// looked at. Watched for as long as someone who holds `emergency.alert` is
/// signed in, whatever screen they are on. The hub keeps no history: an alert
/// reaches only those connected when it happens (the email does not depend on
/// that).
class EmergencyAlerts extends Notifier<List<EmergencyAlert>> {
  StreamSubscription<TopicMessage>? _subscription;
  final _dismissed = <String>{};

  @override
  List<EmergencyAlert> build() {
    final tenant = ref.watch(tenantIdProvider);
    final client = ref.watch(realtimeClientProvider);
    final held = ref.watch(knownPermissionsProvider);
    ref.onDispose(() => _subscription?.cancel());
    // Only once the permission is known to be held: a refused subscription
    // would only add noise.
    if (tenant == null ||
        client == null ||
        held == null ||
        !holds(held, 'emergency.alert')) {
      return const [];
    }
    _subscription = client.watch(emergencyTopic(tenant)).listen((message) {
      if (message is! TopicEvent) return;
      final alert = EmergencyAlert.fromEvent(message.event);
      if (alert == null ||
          _dismissed.contains(alert.id) ||
          state.any((a) => a.id == alert.id)) {
        return;
      }
      state = [alert, ...state];
    });
    return const [];
  }

  void dismiss(String id) {
    _dismissed.add(id);
    state = [
      for (final alert in state)
        if (alert.id != id) alert,
    ];
  }
}

final emergencyAlertsProvider =
    NotifierProvider<EmergencyAlerts, List<EmergencyAlert>>(
      EmergencyAlerts.new,
    );

/// Every emergency alert not yet dismissed, at the top of every screen.
class EmergencyAlertBanners extends ConsumerWidget {
  const EmergencyAlertBanners({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final alerts = ref.watch(emergencyAlertsProvider);
    if (alerts.isEmpty) return const SizedBox.shrink();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final alert in alerts)
          EmergencyAlertBanner(
            key: ValueKey('emergency-${alert.id}'),
            alert: alert,
            onDismiss: () =>
                ref.read(emergencyAlertsProvider.notifier).dismiss(alert.id),
          ),
      ],
    );
  }
}

class EmergencyAlertBanner extends StatelessWidget {
  const EmergencyAlertBanner({
    super.key,
    required this.alert,
    required this.onDismiss,
  });

  final EmergencyAlert alert;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final scheme = Theme.of(context).colorScheme;
    final time = MaterialLocalizations.of(context)
        .formatTimeOfDay(TimeOfDay.fromDateTime(alert.at.toLocal()));
    final number = alert.callingNumber;
    final caller = number == null
        ? l.emergencyAlertUnknownCaller
        : alert.callingName == null
        ? number
        : l.emergencyAlertCaller(number, alert.callingName!);
    final where = alert.address.isEmpty
        ? l.emergencyAlertNoLocation
        : [
            if (alert.locationLabel != null) alert.locationLabel!,
            ...alert.address,
          ].join(', ');
    return Semantics(
      liveRegion: true,
      container: true,
      child: Material(
        color: scheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
          child: Row(
            children: [
              Icon(Icons.emergency, color: scheme.onErrorContainer),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l.emergencyAlertTitle(alert.dialedNumber, caller, time),
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: scheme.onErrorContainer,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      where,
                      style: TextStyle(color: scheme.onErrorContainer),
                    ),
                  ],
                ),
              ),
              TextButton(
                key: ValueKey('emergency-dismiss-${alert.id}'),
                onPressed: onDismiss,
                style: TextButton.styleFrom(
                  foregroundColor: scheme.onErrorContainer,
                ),
                child: Text(l.emergencyAlertDismiss),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
