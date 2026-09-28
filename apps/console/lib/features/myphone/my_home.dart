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
import 'my_live_calls.dart';
import 'my_phone_api.dart';
import 'my_phone_pages.dart' show MyPhoneTabs;

/// Makes a microphone recorder for a greeting; null where there is no
/// microphone to record from. Tests replace it.
final greetingRecorderProvider = Provider<Recorder Function()?>(
  (ref) => AudioRecorder.supported ? AudioRecorder.new : null,
);

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
              const Wrap(
                spacing: 16,
                runSpacing: 16,
                children: [
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
                  Icon(Icons.fiber_manual_record, color: Colors.red.shade700),
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
