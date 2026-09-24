import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import 'voicemail_api.dart';

/// "24 Sep 2026, 19:20" in the viewer's own time.
String formatWhen(DateTime when) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  final t = when.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${t.day} ${months[t.month - 1]} ${t.year}, ${two(t.hour)}:${two(t.minute)}';
}

/// "0:42", "12:05".
String formatLength(num? durationMs) {
  if (durationMs == null) return '—';
  final total = (durationMs / 1000).round();
  return '${total ~/ 60}:${(total % 60).toString().padLeft(2, '0')}';
}

/// The tenant's voicemail: its mailboxes, and one mailbox's messages. Private
/// data (rule H1), so it is not shown to a reseller acting as the tenant.
class VoicemailPage extends ConsumerStatefulWidget {
  const VoicemailPage({super.key});

  @override
  ConsumerState<VoicemailPage> createState() => _VoicemailPageState();
}

class _VoicemailPageState extends ConsumerState<VoicemailPage> {
  Json? _open;

  @override
  Widget build(BuildContext context) {
    final open = _open;
    if (open != null) {
      return MessagesView(
        mailbox: open,
        onBack: () {
          ref.invalidate(mailboxesProvider);
          setState(() => _open = null);
        },
      );
    }
    return MailboxesView(onOpen: (m) => setState(() => _open = m));
  }
}

/// The title of the extension a mailbox belongs to.
String mailboxTitle(WidgetRef ref, Json mailbox) {
  final extensions = ref.watch(rowsProvider('extensions')).asData?.value;
  final match = extensions?.where((e) => e['id'] == mailbox['extensionId']);
  if (match == null || match.isEmpty) return '${mailbox['extensionId']}';
  return resourceByKey('extensions').titleOf(match.first);
}

class MailboxesView extends ConsumerWidget {
  const MailboxesView({super.key, required this.onOpen});

  final void Function(Json mailbox) onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final boxes = ref.watch(mailboxesProvider);
    return PageFrame(
      children: [
        const PageHeader(
          title: 'Voicemail',
          subtitle:
              'Each extension with voicemail has a mailbox. Open one to hear its '
              'messages, or set where new messages are emailed.',
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: boxes,
            emptyText: 'No mailboxes yet.',
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columnSpacing: 24,
                  horizontalMargin: 16,
                  columns: const [
                    DataColumn(label: Text('Mailbox')),
                    DataColumn(label: Text('New messages'), numeric: true),
                    DataColumn(label: Text('Greeting')),
                    DataColumn(label: Text('Email to')),
                    DataColumn(label: Text('')),
                  ],
                  rows: [for (final m in data) _row(context, ref, m)],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  DataRow _row(BuildContext context, WidgetRef ref, Json m) {
    final address = m['notifyEmail'] as String?;
    final unread = (m['unreadCount'] as num?)?.toInt() ?? 0;
    return DataRow(
      cells: [
        DataCell(Text(mailboxTitle(ref, m))),
        DataCell(
          Text(
            '$unread',
            style: unread > 0
                ? const TextStyle(fontWeight: FontWeight.bold)
                : null,
          ),
        ),
        DataCell(Text(m['greetingStatus'] == 'ready' ? 'Custom' : 'Default')),
        DataCell(Text(address ?? 'Off')),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: 'Messages',
                icon: const Icon(Icons.inbox_outlined),
                onPressed: () => onOpen(m),
              ),
              IconButton(
                tooltip: 'Email settings',
                icon: const Icon(Icons.forward_to_inbox_outlined),
                onPressed: () async {
                  final saved = await showDialog<bool>(
                    context: context,
                    builder: (_) => EmailSettingsDialog(mailbox: m),
                  );
                  if (saved == true) ref.invalidate(mailboxesProvider);
                },
              ),
              IconButton(
                tooltip: 'Reset PIN',
                icon: const Icon(Icons.password_outlined),
                onPressed: () => showDialog<bool>(
                  context: context,
                  builder: (_) => ResetPinDialog(mailbox: m),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// One mailbox's messages: who called, when, how long, and whether they have
/// been heard. Playing opens a short-lived address for the recording.
class MessagesView extends ConsumerWidget {
  const MessagesView({super.key, required this.mailbox, required this.onBack});

  final Json mailbox;
  final VoidCallback onBack;

  String get _id => '${mailbox['id']}';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = ref.watch(messagesProvider(_id));
    return PageFrame(
      children: [
        PageHeader(
          title: 'Voicemail: ${mailboxTitle(ref, mailbox)}',
          leading: IconButton(
            tooltip: 'Back to mailboxes',
            icon: const Icon(Icons.arrow_back),
            onPressed: onBack,
          ),
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: messages,
            emptyText: 'No messages.',
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columnSpacing: 24,
                  horizontalMargin: 16,
                  columns: const [
                    DataColumn(label: Text('From')),
                    DataColumn(label: Text('Received')),
                    DataColumn(label: Text('Length'), numeric: true),
                    DataColumn(label: Text('')),
                    DataColumn(label: Text('')),
                  ],
                  rows: [for (final m in data) _row(context, ref, m)],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  DataRow _row(BuildContext context, WidgetRef ref, Json m) {
    final name = m['callerIdName'] as String?;
    final number = m['callerIdNumber'] as String?;
    final from = [?name, ?number].join(' · ');
    final when = DateTime.tryParse('${m['createdAt']}');
    final read = m['isRead'] == true;
    return DataRow(
      cells: [
        DataCell(
          Text(
            from.isEmpty ? 'Unknown caller' : from,
            style: read ? null : const TextStyle(fontWeight: FontWeight.bold),
          ),
        ),
        DataCell(Text(when == null ? '—' : formatWhen(when))),
        DataCell(Text(formatLength(m['durationMs'] as num?))),
        DataCell(Chip(label: Text(read ? 'Read' : 'New'))),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: 'Play',
                icon: const Icon(Icons.play_arrow),
                onPressed: () => _play(context, ref, m),
              ),
              IconButton(
                tooltip: 'Delete',
                icon: const Icon(Icons.delete_outline),
                onPressed: () => _delete(context, ref, m),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _play(BuildContext context, WidgetRef ref, Json m) async {
    final api = ref.read(voicemailApiProvider);
    final open = ref.read(openRecordingProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (api == null) return;
    try {
      await open(await api.playUrl(_id, '${m['id']}'));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not play it: ${problemMessage(e)}')),
      );
    }
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Json m) async {
    final api = ref.read(voicemailApiProvider);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete message?'),
        content: const Text(
          'The recording is removed and cannot be recovered.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.deleteMessage(_id, '${m['id']}');
      ref.invalidate(messagesProvider(_id));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not delete it: ${problemMessage(e)}')),
      );
    }
  }
}

/// Where new messages are emailed, whether the recording goes with them, and
/// what happens to the message afterwards.
class EmailSettingsDialog extends ConsumerStatefulWidget {
  const EmailSettingsDialog({super.key, required this.mailbox});

  final Json mailbox;

  @override
  ConsumerState<EmailSettingsDialog> createState() =>
      _EmailSettingsDialogState();
}

class _EmailSettingsDialogState extends ConsumerState<EmailSettingsDialog> {
  late final TextEditingController _address;
  late bool _enabled;
  late bool _attach;
  late String _after;
  String? _error;
  var _busy = false;

  @override
  void initState() {
    super.initState();
    final current = EmailSettings.fromMailbox(widget.mailbox);
    _address = TextEditingController(text: current.notifyEmail ?? '');
    _enabled = current.notifyEmail != null;
    _attach = current.attachAudio;
    _after = current.afterEmail;
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final api = ref.read(voicemailApiProvider);
    final address = _address.text.trim();
    if (_enabled &&
        !RegExp(r'^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$').hasMatch(address)) {
      setState(() => _error = 'Enter one email address.');
      return;
    }
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.saveEmailSettings(
        '${widget.mailbox['id']}',
        EmailSettings(
          notifyEmail: _enabled ? address : null,
          attachAudio: _enabled && _attach,
          afterEmail: _enabled ? _after : 'keep',
        ),
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final onlyKeepOrRead = !_attach;
    return AlertDialog(
      title: const Text('Email settings'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Email new messages'),
              value: _enabled,
              onChanged: _busy ? null : (v) => setState(() => _enabled = v),
            ),
            TextField(
              controller: _address,
              enabled: _enabled && !_busy,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Email address'),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Attach the recording'),
              subtitle: const Text(
                'A very long message is sent without it, and says so.',
              ),
              value: _attach,
              onChanged: _enabled && !_busy
                  ? (v) => setState(() {
                      _attach = v;
                      if (!v && _after == 'delete') _after = 'keep';
                    })
                  : null,
            ),
            DropdownButtonFormField<String>(
              initialValue: _after,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'After it is emailed',
              ),
              items: [
                for (final e in emailAfterChoices.entries)
                  DropdownMenuItem(
                    value: e.key,
                    enabled: !(e.key == 'delete' && onlyKeepOrRead),
                    child: Text(e.value),
                  ),
              ],
              onChanged: _enabled && !_busy
                  ? (v) => setState(() => _after = v!)
                  : null,
            ),
            if (_enabled && onlyKeepOrRead)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('Deleting needs the recording attached.'),
              ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              ErrorText(_error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: const Text('Save'),
        ),
      ],
    );
  }
}

/// Sets a new PIN for phone access to a mailbox.
class ResetPinDialog extends ConsumerStatefulWidget {
  const ResetPinDialog({super.key, required this.mailbox});

  final Json mailbox;

  @override
  ConsumerState<ResetPinDialog> createState() => _ResetPinDialogState();
}

class _ResetPinDialogState extends ConsumerState<ResetPinDialog> {
  final _pin = TextEditingController();
  String? _error;
  var _busy = false;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final pin = _pin.text.trim();
    if (!RegExp(r'^\d{4,8}$').hasMatch(pin)) {
      setState(() => _error = 'The PIN must be 4 to 8 digits.');
      return;
    }
    final api = ref.read(voicemailApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.resetPin('${widget.mailbox['id']}', pin);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      messenger.showSnackBar(const SnackBar(content: Text('PIN changed.')));
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = problemMessage(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Reset PIN'),
    content: SizedBox(
      width: 360,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('The PIN the mailbox owner enters on a phone.'),
          const SizedBox(height: 8),
          TextField(
            controller: _pin,
            enabled: !_busy,
            obscureText: true,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'New PIN'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorText(_error!),
          ],
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: _busy ? null : () => Navigator.of(context).pop(false),
        child: const Text('Cancel'),
      ),
      FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')),
    ],
  );
}
