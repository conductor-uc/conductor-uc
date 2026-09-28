import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../myphone/my_phone_api.dart';
import '../pbx/resource.dart';
import 'voicemail_api.dart';
import '../../core/format.dart';

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
    final l10n = context.l10n;
    final boxes = ref.watch(mailboxesProvider);
    return PageFrame(
      children: [
        PageHeader(title: l10n.vmTitle, subtitle: l10n.vmSubtitle),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: boxes,
            emptyText: l10n.vmNoMailboxes,
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columnSpacing: 24,
                  horizontalMargin: 16,
                  columns: [
                    DataColumn(label: Text(l10n.vmMailbox)),
                    DataColumn(label: Text(l10n.vmNewMessages), numeric: true),
                    DataColumn(label: Text(l10n.vmGreeting)),
                    DataColumn(label: Text(l10n.vmEmailTo)),
                    const DataColumn(label: Text('')),
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
    final l10n = context.l10n;
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
        DataCell(
          Text(
            m['greetingStatus'] == 'ready'
                ? l10n.vmGreetingCustom
                : l10n.vmGreetingDefault,
          ),
        ),
        DataCell(Text(address ?? l10n.vmEmailOff)),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: l10n.vmMessages,
                icon: const Icon(Icons.inbox_outlined),
                onPressed: () => onOpen(m),
              ),
              IconButton(
                tooltip: l10n.vmEmailSettings,
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
                tooltip: l10n.vmResetPin,
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
///
/// With [mine] it is the signed-in person's own mailbox (`/me/voicemail`):
/// there is no mailbox to choose, so no back button, and everything goes
/// through their own routes, which take no mailbox id.
class MessagesView extends ConsumerWidget {
  const MessagesView({
    super.key,
    required this.mailbox,
    this.onBack,
    this.mine = false,
  });

  final Json mailbox;
  final VoidCallback? onBack;
  final bool mine;

  String get _id => '${mailbox['id']}';

  MailboxOps? _ops(WidgetRef ref) =>
      mine ? ref.read(myVoicemailApiProvider) : ref.read(voicemailApiProvider);

  void _refresh(WidgetRef ref) => mine
      ? ref.invalidate(myMessagesProvider)
      : ref.invalidate(messagesProvider(_id));

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final messages = mine
        ? ref.watch(myMessagesProvider)
        : ref.watch(messagesProvider(_id));
    return PageFrame(
      children: [
        PageHeader(
          title: mine
              ? l10n.vmMyTitle
              : l10n.vmMailboxTitle(mailboxTitle(ref, mailbox)),
          subtitle: mine
              ? l10n.vmMySubtitle(
                  (mailbox['unreadCount'] as num?)?.toInt() ?? 0,
                  mailbox['greetingStatus'] == 'ready'
                      ? l10n.vmMyGreetingCustom
                      : l10n.vmMyGreetingDefault,
                  '${mailbox['notifyEmail'] ?? l10n.vmMyEmailNobody}',
                )
              : null,
          leading: onBack == null
              ? null
              : IconButton(
                  tooltip: l10n.vmBack,
                  icon: const Icon(Icons.arrow_back),
                  onPressed: onBack,
                ),
          actions: [
            if (mine) ...[
              OutlinedButton.icon(
                onPressed: () async {
                  final saved = await showDialog<bool>(
                    context: context,
                    builder: (_) =>
                        EmailSettingsDialog(mailbox: mailbox, mine: true),
                  );
                  if (saved == true) ref.invalidate(myMailboxProvider);
                },
                icon: const Icon(Icons.forward_to_inbox_outlined),
                label: Text(l10n.vmEmailSettings),
              ),
              OutlinedButton.icon(
                onPressed: () => showDialog<bool>(
                  context: context,
                  builder: (_) => ResetPinDialog(mailbox: mailbox, mine: true),
                ),
                icon: const Icon(Icons.password_outlined),
                label: Text(l10n.vmChangePin),
              ),
            ],
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: messages,
            emptyText: l10n.vmNoMessages,
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columnSpacing: 24,
                  horizontalMargin: 16,
                  columns: [
                    DataColumn(label: Text(l10n.vmFrom)),
                    DataColumn(label: Text(l10n.vmReceived)),
                    DataColumn(label: Text(l10n.vmLength), numeric: true),
                    const DataColumn(label: Text('')),
                    const DataColumn(label: Text('')),
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
    final l10n = context.l10n;
    final name = m['callerIdName'] as String?;
    final number = m['callerIdNumber'] as String?;
    final from = [?name, ?number].join(' · ');
    final when = DateTime.tryParse('${m['createdAt']}');
    final read = m['isRead'] == true;
    return DataRow(
      cells: [
        DataCell(
          Text(
            from.isEmpty ? l10n.vmUnknownCaller : from,
            style: read ? null : const TextStyle(fontWeight: FontWeight.bold),
          ),
        ),
        DataCell(Text(formatDateTime(when))),
        DataCell(Text(formatClockMs(m['durationMs'] as num?))),
        DataCell(Chip(label: Text(read ? l10n.vmRead : l10n.vmNew))),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: l10n.vmPlay,
                icon: const Icon(Icons.play_arrow),
                onPressed: () => _play(context, ref, m),
              ),
              IconButton(
                tooltip: l10n.commonDelete,
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
    final api = _ops(ref);
    final open = ref.read(openRecordingProvider);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = context.l10n;
    if (api == null) return;
    try {
      await open(await api.playUrl(_id, '${m['id']}'));
      // Hearing your own message marks it read.
      if (mine && m['isRead'] != true && api is MyPhoneApi) {
        await api.markRead('${m['id']}');
        _refresh(ref);
        ref.invalidate(myMailboxProvider);
      }
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.vmCouldNotPlay(problemMessage(e)))),
      );
    }
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Json m) async {
    final api = _ops(ref);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.vmDeleteTitle),
        content: Text(l10n.vmDeleteBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.commonDelete),
          ),
        ],
      ),
    );
    if (confirmed != true || api == null) return;
    try {
      await api.deleteMessage(_id, '${m['id']}');
      _refresh(ref);
      if (mine) ref.invalidate(myMailboxProvider);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.vmCouldNotDelete(problemMessage(e)))),
      );
    }
  }
}

/// Where new messages are emailed, whether the recording goes with them, and
/// what happens to the message afterwards.
class EmailSettingsDialog extends ConsumerStatefulWidget {
  const EmailSettingsDialog({
    super.key,
    required this.mailbox,
    this.mine = false,
  });

  final Json mailbox;

  /// The signed-in person's own mailbox, through their own route.
  final bool mine;

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
    final api = widget.mine
        ? ref.read(myVoicemailApiProvider)
        : ref.read(voicemailApiProvider);
    final address = _address.text.trim();
    if (_enabled &&
        !RegExp(r'^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$').hasMatch(address)) {
      setState(() => _error = context.l10n.vmEnterOneEmail);
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
    final l10n = context.l10n;
    final onlyKeepOrRead = !_attach;
    return AlertDialog(
      title: Text(l10n.vmEmailSettings),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.vmEmailNew),
              value: _enabled,
              onChanged: _busy ? null : (v) => setState(() => _enabled = v),
            ),
            TextField(
              controller: _address,
              enabled: _enabled && !_busy,
              keyboardType: TextInputType.emailAddress,
              decoration: InputDecoration(labelText: l10n.vmEmailAddress),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.vmAttach),
              subtitle: Text(l10n.vmAttachHelp),
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
              decoration: InputDecoration(labelText: l10n.vmAfterEmail),
              items: [
                for (final e in emailAfterChoicesOf(l10n).entries)
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
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(l10n.vmDeleteNeedsAttach),
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
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: Text(l10n.commonSave),
        ),
      ],
    );
  }
}

/// Sets a new PIN for phone access to a mailbox.
class ResetPinDialog extends ConsumerStatefulWidget {
  const ResetPinDialog({super.key, required this.mailbox, this.mine = false});

  final Json mailbox;

  /// The signed-in person's own mailbox, through their own route.
  final bool mine;

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
      setState(() => _error = context.l10n.vmPinInvalid);
      return;
    }
    final api = widget.mine
        ? ref.read(myVoicemailApiProvider)
        : ref.read(voicemailApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final pinChanged = context.l10n.vmPinChanged;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await api.resetPin('${widget.mailbox['id']}', pin);
      if (!mounted) return;
      Navigator.of(context).pop(true);
      messenger.showSnackBar(SnackBar(content: Text(pinChanged)));
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
    title: Text(context.l10n.vmResetPin),
    content: SizedBox(
      width: 360,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.mine ? context.l10n.vmPinMine : context.l10n.vmPinOwner),
          const SizedBox(height: 8),
          TextField(
            controller: _pin,
            enabled: !_busy,
            obscureText: true,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(labelText: context.l10n.vmNewPin),
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
        child: Text(context.l10n.commonCancel),
      ),
      FilledButton(
        onPressed: _busy ? null : _save,
        child: Text(context.l10n.commonSave),
      ),
    ],
  );
}
