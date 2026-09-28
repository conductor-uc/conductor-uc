import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/problem.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';

/// The ways a supervisor can join a live call (S5-09), each from their own
/// phone (O-14), each with its own permission.
enum MonitorMode {
  listen('listen', 'monitor.listen', Icons.headphones_outlined),
  whisper('whisper', 'monitor.whisper', Icons.record_voice_over_outlined),
  barge('barge', 'monitor.barge', Icons.call_merge);

  const MonitorMode(this.wire, this.permission, this.icon);

  final String wire;
  final String permission;
  final IconData icon;

  /// The button's label.
  String label(AppLocalizations l) => switch (this) {
    MonitorMode.listen => l.mcListen,
    MonitorMode.whisper => l.mcWhisper,
    MonitorMode.barge => l.mcBarge,
  };

  /// What the snackbar says once the phone has answered and joined.
  String doneLabel(AppLocalizations l) => switch (this) {
    MonitorMode.listen => l.mcListening,
    MonitorMode.whisper => l.mcWhispering,
    MonitorMode.barge => l.mcBarged,
  };
}

/// Whether a call can be joined: the service refuses one that is still
/// ringing (`call_not_answered`), so only answered and held calls offer it.
bool monitorable(String state) => state == 'answered' || state == 'held';

/// `POST .../calls/{callUuid}/listen|whisper|barge` (call-control). No body:
/// the phone rung is always the signed-in person's own linked extension, and
/// the service joins it to the tenant's own party on the call, whichever leg is
/// named. The request returns only once that phone has answered.
class MonitorApi {
  MonitorApi(this._dio, this._token);

  final Dio _dio;
  final String _token;

  /// How long to wait for the answer: the service rings the phone for up to
  /// 30 s (its `MONITOR_RING_TIMEOUT_SECONDS`) before it says no one answered,
  /// longer than the client's usual wait.
  static const patience = Duration(seconds: 60);

  Future<void> monitor({
    required String tenantId,
    required String callUuid,
    required MonitorMode mode,
  }) async {
    await _dio.post<Object?>(
      '/v1/tenants/$tenantId/calls/$callUuid/${mode.wire}',
      options: Options(
        headers: {'Authorization': 'Bearer $_token'},
        receiveTimeout: patience,
      ),
    );
  }
}

final monitorApiProvider = Provider<MonitorApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  return MonitorApi(ref.watch(apiProvider).dio, session.accessToken);
});

/// The requests waiting for the supervisor's phone to answer, by call: while
/// one waits, the call's monitor buttons are replaced by what it is doing.
class PendingMonitors extends Notifier<Map<String, MonitorMode>> {
  @override
  Map<String, MonitorMode> build() => const {};

  void start(String callId, MonitorMode mode) =>
      state = {...state, callId: mode};

  void clear(String callId) {
    if (!state.containsKey(callId)) return;
    state = {...state}..remove(callId);
  }
}

final pendingMonitorsProvider =
    NotifierProvider<PendingMonitors, Map<String, MonitorMode>>(
      PendingMonitors.new,
    );

/// The listen, whisper and barge buttons for one live call: those of [modes]
/// (the ones the viewer holds the permission for), or, while a press rings the
/// viewer's phone, "Ringing your phone…". The outcome is said in a snackbar:
/// what the phone is now doing, or the service's own (neutral) words.
class MonitorControls extends ConsumerWidget {
  const MonitorControls({
    super.key,
    required this.tenantId,
    required this.callId,
    required this.actOn,
    required this.modes,
  });

  final String tenantId;

  /// The call, as the screen keys it (the pending press is kept under it).
  final String callId;

  /// The leg to name in the request (either leg of the call will do).
  final String actOn;

  final List<MonitorMode> modes;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pending = ref.watch(pendingMonitorsProvider)[callId];
    if (pending != null) {
      return Row(
        key: ValueKey('monitor-pending-$callId'),
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
          Text(context.l10n.mcRingingYourPhone),
        ],
      );
    }
    if (modes.isEmpty) return const SizedBox.shrink();
    // One line: a table cell is one row high.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final mode in modes)
          TextButton.icon(
            key: ValueKey('monitor-${mode.wire}-$callId'),
            onPressed: () => _press(context, ref, mode),
            icon: Icon(mode.icon, size: 18),
            label: Text(mode.label(context.l10n)),
          ),
      ],
    );
  }

  Future<void> _press(
    BuildContext context,
    WidgetRef ref,
    MonitorMode mode,
  ) async {
    final api = ref.read(monitorApiProvider);
    if (api == null) return;
    final pending = ref.read(pendingMonitorsProvider.notifier);
    final messenger = ScaffoldMessenger.of(context);
    final l = context.l10n;
    pending.start(callId, mode);
    try {
      await api.monitor(tenantId: tenantId, callUuid: actOn, mode: mode);
      messenger.showSnackBar(SnackBar(content: Text(mode.doneLabel(l))));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    } finally {
      pending.clear(callId);
    }
  }
}
