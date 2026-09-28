import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/audio_recorder.dart';
import '../../core/format.dart';
import '../../core/permissions.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../media/media_page.dart'
    show filePickerProvider, uploadToStorageProvider;
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart' show tenantCountryProvider;
import '../monitoring/live_calls.dart' show clockProvider;
import '../monitoring/presence.dart' show presenceProvider;
import 'my_live_calls.dart';
import 'my_phone_api.dart';
import 'my_phone_pages.dart' show MyPhoneTabs;

/// Makes a microphone recorder for a greeting; null where there is no
/// microphone to record from. Tests replace it.
final greetingRecorderProvider = Provider<Recorder Function()?>(
  (ref) => AudioRecorder.supported ? AudioRecorder.new : null,
);

/// S9-18: the calls ringing within my pickup groups. Refreshed whenever an
/// extension's presence changes (a colleague's phone starting or stopping
/// ringing), so no polling.
final myPickupProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null || !ref.watch(canProvider('self.calls'))) return const [];
  ref.listen(presenceProvider, (_, _) => ref.invalidateSelf());
  try {
    return await api.pickupable();
  } catch (_) {
    // Not offered, rather than an error on the home page.
    return const [];
  }
});

/// S9-20: the queues I answer as an agent, and who waits in them. Read again
/// every few seconds while my home is open: callers join and leave a queue
/// without anyone's presence changing.
final myQueuesProvider = FutureProvider.autoDispose<List<Json>>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null || !ref.watch(canProvider('self.settings'))) return const [];
  final timer = Timer(const Duration(seconds: 5), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  try {
    return await api.myQueues();
  } catch (_) {
    // Not shown, rather than an error on the home page.
    return const [];
  }
});

/// My own status as an agent: `available`, `on_break`, `logged_out`, or null
/// while unknown.
final myAgentStatusProvider = FutureProvider.autoDispose<String?>((ref) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null) return null;
  try {
    return (await api.agentStatus())['status'] as String?;
  } catch (_) {
    return null;
  }
});

/// My last few calls, for the home page.
final myRecentCallsProvider = FutureProvider.autoDispose<List<Json>>((
  ref,
) async {
  final api = ref.watch(myPhoneApiProvider);
  if (api == null) return const [];
  return (await api.calls(limit: 5)).rows;
});

/// A person's own home (S9-11): their number, one switch to forward calls to
/// their mobile, their voicemail and greeting, their last calls, and how to
/// connect a phone or app, without knowing anything about phone systems.
class MyHomePage extends ConsumerWidget {
  const MyHomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final extension = ref.watch(myExtensionProvider);
    final me = ref.watch(meProvider).asData?.value;
    return extension.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text(problemMessage(e))),
      data: (ext) {
        if (ext == null) {
          return Center(child: Text(l10n.myPhoneNothingLinked));
        }
        final name = me?.displayName ?? '${ext['displayName']}';
        return SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                l10n.myHomeHello(name),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 4),
              Text(l10n.myHomeYourNumber('${ext['number']}')),
              const MyPhoneTabs(current: '/my-phone/home'),
              const SizedBox(height: 16),
              const MyLiveCalls(),
              const _PickupCard(),
              const Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
                  _QueuesCard(),
                  _ForwardCard(),
                  _VoicemailCard(),
                  _RecentCallsCard(),
                  _ConnectCard(),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.icon, required this.title, required this.child});

  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 440,
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

/// S9-18: the calls ringing a colleague in my pickup groups, each with a way
/// to take it on my own phone. Not shown when there are none.
class _PickupCard extends ConsumerWidget {
  const _PickupCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final calls = ref.watch(myPickupProvider).value ?? const [];
    if (calls.isEmpty) return const SizedBox.shrink();
    final country = ref.watch(tenantCountryProvider);
    String number(Object? n) =>
        '$n'.startsWith('+') ? formatPhone('$n', country: country) : '$n';
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Card(
        key: const ValueKey('my-pickup'),
        color: Theme.of(context).colorScheme.tertiaryContainer,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                l10n.myPickupTitle,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              Text(l10n.myPickupHelp),
              for (final call in calls)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.ring_volume_outlined),
                  title: Text(
                    l10n.myPickupRinging(
                      '${call['extension']}',
                      number(call['from']),
                    ),
                  ),
                  trailing: FilledButton(
                    key: ValueKey('pick-up-${call['callUuid']}'),
                    onPressed: () async {
                      final messenger = ScaffoldMessenger.of(context);
                      showToast(messenger, currentL10n.attRingingYourPhone);
                      try {
                        await ref
                            .read(myPhoneApiProvider)
                            ?.pickup('${call['callUuid']}');
                        showToast(messenger, currentL10n.attPickedUp);
                      } catch (e) {
                        showToast(messenger, problemMessage(e));
                      }
                      ref.invalidate(myPickupProvider);
                    },
                    child: Text(l10n.myPickupButton),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// S9-20: the queues I take calls for, how many callers wait in each and for
/// how long, and whether I am taking calls, on a break, or not taking calls
/// (the same as the `*45`/`*46` codes). Not shown to someone who answers no
/// queue.
class _QueuesCard extends ConsumerWidget {
  const _QueuesCard();

  static const _statuses = ['available', 'on_break', 'logged_out'];

  Future<void> _choose(
    BuildContext context,
    WidgetRef ref,
    String status,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(myPhoneApiProvider)?.setAgentStatus(status);
      showToast(messenger, currentL10n.myAgentStatusSaved);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
    ref.invalidate(myAgentStatusProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final queues = ref.watch(myQueuesProvider).value ?? const [];
    if (queues.isEmpty) return const SizedBox.shrink();
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final current = ref.watch(myAgentStatusProvider).value;
    String waiting(Json queue) {
      final count = (queue['waiting'] as num?)?.toInt() ?? 0;
      final since = DateTime.tryParse('${queue['longestWaitingSince']}');
      if (since == null) return l10n.attQueueWaiting(count);
      return l10n.attQueueWaitingLongest(
        count,
        formatClock(now.difference(since).inSeconds.clamp(0, 1 << 30)),
      );
    }

    return KeyedSubtree(
      key: const ValueKey('my-queues'),
      child: _Card(
        icon: Icons.support_agent_outlined,
        title: l10n.myQueuesTitle,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.myQueuesHelp),
            for (final queue in queues)
              ListTile(
                key: ValueKey('my-queue-${queue['queueId']}'),
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.groups_outlined),
                title: Text(
                  '${queue['label'] ?? ''}'.isEmpty
                      ? l10n.myQueueUnnamed
                      : '${queue['label']}',
                ),
                subtitle: Text(waiting(queue)),
              ),
            const SizedBox(height: 8),
            Text(
              l10n.myAgentStatusLabel,
              style: Theme.of(context).textTheme.labelLarge,
            ),
            const SizedBox(height: 4),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final status in _statuses)
                  ChoiceChip(
                    key: ValueKey('my-agent-$status'),
                    label: Text(switch (status) {
                      'available' => l10n.myAgentAvailable,
                      'on_break' => l10n.myAgentOnBreak,
                      _ => l10n.myAgentSignedOut,
                    }),
                    selected: current == status,
                    onSelected: (_) => _choose(context, ref, status),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One switch: send every call to my mobile. The rest of the call handling
/// (do not disturb, the other forwards) stays as it is.
class _ForwardCard extends ConsumerStatefulWidget {
  const _ForwardCard();

  @override
  ConsumerState<_ForwardCard> createState() => _ForwardCardState();
}

class _ForwardCardState extends ConsumerState<_ForwardCard> {
  final _mobile = TextEditingController();
  bool _loaded = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _mobile.dispose();
    super.dispose();
  }

  Future<void> _set(Json current, bool on) async {
    final l10n = context.l10n;
    final api = ref.read(myPhoneApiProvider);
    if (api == null) return;
    String? e164;
    if (on) {
      final parsed = parsePhone(
        _mobile.text,
        country: ref.read(tenantCountryProvider),
      );
      if (!parsed.ok) {
        setState(() => _error = parsed.error);
        return;
      }
      e164 = parsed.value;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await api.saveCallHandling({
        for (final k in const [
          'dnd',
          'dndAction',
          'forwardBusy',
          'forwardNoAnswer',
          'noAnswerSeconds',
          'forwardUnreachable',
          'simultaneousRing',
        ])
          if (current.containsKey(k)) k: current[k],
        'forwardAlways': on ? {'type': 'external', 'e164': e164} : null,
      });
      ref.invalidate(myCallHandlingProvider);
      if (mounted) {
        showToast(
          ScaffoldMessenger.of(context),
          on ? l10n.myHomeForwardOn : l10n.myHomeForwardOff,
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final handling = ref.watch(myCallHandlingProvider);
    return _Card(
      icon: Icons.phone_forwarded_outlined,
      title: l10n.myHomeForwardTitle,
      child: handling.when(
        loading: () => Text(l10n.shellLoading),
        error: (e, _) => Text(problemMessage(e)),
        data: (current) {
          final always = current['forwardAlways'];
          final on = always is Map && always['type'] == 'external';
          if (!_loaded) {
            _loaded = true;
            if (on) {
              _mobile.text = formatPhone(
                '${always['e164']}',
                country: ref.read(tenantCountryProvider),
              );
            }
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                key: const ValueKey('my-mobile'),
                controller: _mobile,
                enabled: !on && !_saving,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: l10n.myHomeMobile,
                  helperText: l10n.myHomeMobileHelp,
                  errorText: _error,
                ),
              ),
              SwitchListTile(
                key: const ValueKey('forward-to-mobile'),
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.myHomeForwardSwitch),
                subtitle: Text(
                  on ? l10n.myHomeForwardOnHelp : l10n.myHomeForwardOffHelp,
                ),
                value: on,
                onChanged: _saving ? null : (v) => _set(current, v),
              ),
              TextButton(
                onPressed: () => context.go('/my-phone/call-handling'),
                child: Text(l10n.myHomeMoreForwarding),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// New messages, and my greeting: record one, or upload a WAV.
class _VoicemailCard extends ConsumerWidget {
  const _VoicemailCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    if (!ref.watch(canProvider('self.voicemail'))) {
      return const SizedBox.shrink();
    }
    final mailbox = ref.watch(myMailboxProvider);
    return _Card(
      icon: Icons.voicemail_outlined,
      title: l10n.navVoicemail,
      child: mailbox.when(
        loading: () => Text(l10n.shellLoading),
        error: (e, _) => Text(problemMessage(e)),
        data: (box) {
          final unread = (box['unreadCount'] as num?)?.toInt() ?? 0;
          final greeting = box['greetingStatus'];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(l10n.myHomeNewMessages(unread)),
              const SizedBox(height: 4),
              Text(switch (greeting) {
                'ready' => l10n.myHomeGreetingYours,
                'pending' => l10n.myHomeGreetingProcessing,
                _ => l10n.myHomeGreetingStandard,
              }, style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.tonal(
                    onPressed: () => context.go('/my-phone/voicemail'),
                    child: Text(l10n.myHomeListen),
                  ),
                  if (ref.watch(greetingRecorderProvider) != null)
                    OutlinedButton.icon(
                      onPressed: () => showDialog<void>(
                        context: context,
                        builder: (_) => const RecordGreetingDialog(),
                      ),
                      icon: const Icon(Icons.mic_none),
                      label: Text(l10n.myHomeRecordGreeting),
                    ),
                  OutlinedButton.icon(
                    onPressed: () => _upload(context, ref),
                    icon: const Icon(Icons.upload_file),
                    label: Text(l10n.myHomeUploadGreeting),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _upload(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final picked = await ref.read(filePickerProvider)();
    if (picked == null) return;
    if (!picked.name.toLowerCase().endsWith('.wav')) {
      showToast(messenger, l10n.myHomeGreetingWavOnly);
      return;
    }
    await saveGreeting(ref, messenger, picked.bytes);
  }
}

/// Puts [wav] up as my greeting: an upload address, the bytes, then done.
Future<void> saveGreeting(
  WidgetRef ref,
  ScaffoldMessengerState messenger,
  Uint8List wav,
) async {
  final api = ref.read(myPhoneApiProvider);
  if (api == null) return;
  try {
    final target = await api.presignGreeting();
    await ref.read(uploadToStorageProvider)(
      '${target['uploadUrl']}',
      wav,
      'audio/wav',
    );
    await api.completeGreeting();
    ref.invalidate(myMailboxProvider);
    showToast(messenger, currentL10n.myHomeGreetingSaved);
  } catch (e) {
    showToast(messenger, problemMessage(e));
  }
}

/// The longest greeting recorded before the recording stops by itself.
const maxGreetingSeconds = 120;

/// Records a greeting from the microphone, then saves it.
class RecordGreetingDialog extends ConsumerStatefulWidget {
  const RecordGreetingDialog({super.key});

  @override
  ConsumerState<RecordGreetingDialog> createState() =>
      _RecordGreetingDialogState();
}

class _RecordGreetingDialogState extends ConsumerState<RecordGreetingDialog> {
  late final Recorder _recorder = ref.read(greetingRecorderProvider)!();
  bool _recording = false;
  bool _saving = false;
  int _seconds = 0;
  Timer? _timer;
  String? _error;

  @override
  void dispose() {
    _timer?.cancel();
    if (_recording) _recorder.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    try {
      await _recorder.start();
      setState(() {
        _recording = true;
        _seconds = 0;
        _error = null;
      });
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        setState(() => _seconds++);
        // A greeting is short; a forgotten recording stops itself.
        if (_seconds >= maxGreetingSeconds) _stopAndSave();
      });
    } catch (_) {
      setState(() => _error = context.l10n.myHomeMicrophoneRefused);
    }
  }

  Future<void> _stopAndSave() async {
    _timer?.cancel();
    setState(() {
      _recording = false;
      _saving = true;
    });
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      final wav = await _recorder.stop();
      await saveGreeting(ref, messenger, wav);
      navigator.pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      title: Text(l10n.myHomeRecordGreeting),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.myHomeRecordHelp),
            const SizedBox(height: 16),
            if (_recording)
              Row(
                children: [
                  Icon(
                    Icons.fiber_manual_record,
                    color: Theme.of(context).colorScheme.error,
                  ),
                  const SizedBox(width: 8),
                  Text(formatClock(_seconds)),
                ],
              ),
            if (_error != null)
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
        if (_recording)
          FilledButton(
            onPressed: _stopAndSave,
            child: Text(l10n.myHomeStopAndSave),
          )
        else
          FilledButton.icon(
            onPressed: _saving ? null : _start,
            icon: const Icon(Icons.mic),
            label: Text(l10n.myHomeStartRecording),
          ),
      ],
    );
  }
}

/// My last few calls.
class _RecentCallsCard extends ConsumerWidget {
  const _RecentCallsCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    if (!ref.watch(canProvider('self.history'))) return const SizedBox.shrink();
    final country = ref.watch(tenantCountryProvider);
    String number(Object? n) =>
        '$n'.startsWith('+') ? formatPhone('$n', country: country) : '$n';
    return _Card(
      icon: Icons.history,
      title: l10n.homeRecentCallsTitle,
      child: ref
          .watch(myRecentCallsProvider)
          .when(
            loading: () => Text(l10n.shellLoading),
            error: (e, _) => Text(problemMessage(e)),
            data: (calls) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (calls.isEmpty) Text(l10n.homeRecentCallsNone),
                for (final c in calls)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      c['direction'] == 'inbound'
                          ? Icons.call_received
                          : Icons.call_made,
                    ),
                    title: Text(
                      c['direction'] == 'inbound'
                          ? number(c['fromNumber'])
                          : number(c['toNumber']),
                    ),
                    subtitle: Text(formatDateTime(c['startAt'])),
                  ),
                TextButton(
                  onPressed: () => context.go('/my-phone/history'),
                  child: Text(l10n.homeSeeAll),
                ),
              ],
            ),
          ),
    );
  }
}

/// How to connect a desk phone or a phone app: where it signs in, and, on
/// request, the username and password.
class _ConnectCard extends ConsumerWidget {
  const _ConnectCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return _Card(
      icon: Icons.phone_iphone_outlined,
      title: l10n.myHomeConnectTitle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.myHomeConnectHelp),
          const SizedBox(height: 8),
          OutlinedButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => const ConnectMyPhoneDialog(),
            ),
            child: Text(l10n.myHomeConnectShow),
          ),
        ],
      ),
    );
  }
}

/// The details a phone app asks for: server, username, password.
class ConnectMyPhoneDialog extends ConsumerStatefulWidget {
  const ConnectMyPhoneDialog({super.key});

  @override
  ConsumerState<ConnectMyPhoneDialog> createState() =>
      _ConnectMyPhoneDialogState();
}

class _ConnectMyPhoneDialogState extends ConsumerState<ConnectMyPhoneDialog> {
  Json? _endpoint;
  Json? _signIn;
  String? _error;

  @override
  void initState() {
    super.initState();
    ref
        .read(myPhoneApiProvider)
        ?.sipEndpoint()
        .then(
          (e) => mounted ? setState(() => _endpoint = e) : null,
          onError: (Object e) =>
              mounted ? setState(() => _error = problemMessage(e)) : null,
        );
  }

  Future<void> _reveal() async {
    try {
      final signIn = await ref.read(myPhoneApiProvider)!.revealMySignIn();
      if (mounted) setState(() => _signIn = signIn);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final endpoint = _endpoint;
    Widget line(String label, String value) => ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      title: Text(label),
      subtitle: SelectableText(value),
    );
    return AlertDialog(
      title: Text(l10n.myHomeConnectTitle),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.myHomeConnectDialogHelp),
            const SizedBox(height: 8),
            if (endpoint == null && _error == null) Text(l10n.shellLoading),
            if (endpoint != null) ...[
              line(l10n.myHomeServer, '${endpoint['server']}'),
              line(l10n.myHomePort, '${endpoint['port']}'),
            ],
            if (_signIn != null) ...[
              line(l10n.myHomeUsername, '${_signIn!['username']}'),
              line(l10n.authPassword, '${_signIn!['password']}'),
            ] else if (endpoint != null)
              TextButton.icon(
                key: const ValueKey('reveal-my-sign-in'),
                onPressed: _reveal,
                icon: const Icon(Icons.visibility_outlined),
                label: Text(l10n.myHomeShowSignIn),
              ),
            if (_error != null)
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.commonClose),
        ),
      ],
    );
  }
}
