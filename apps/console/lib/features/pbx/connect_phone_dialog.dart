import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import 'pbx_api.dart';

/// What a person types into a desk phone or a softphone to make it this
/// extension: the server, port, transport, username, and password.
///
/// The server, port and transport come from the platform (the tenant's own
/// domain and the edge's listening port). The password exists nowhere else, so
/// it is only shown when someone with `secret.reveal` asks for it, gives a
/// reason, and the service records that they did.
class ConnectPhoneDialog extends ConsumerStatefulWidget {
  const ConnectPhoneDialog({super.key, required this.extension});

  final Json extension;

  @override
  ConsumerState<ConnectPhoneDialog> createState() => _ConnectPhoneDialogState();
}

class _ConnectPhoneDialogState extends ConsumerState<ConnectPhoneDialog> {
  late final Future<Json> _endpoint;
  final _reason = TextEditingController();
  Json? _revealed;
  bool _asking = false;
  bool _revealing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final api = ref.read(pbxApiProvider);
    _endpoint = api == null
        ? Future.error('Sign in again to continue.')
        : api.sipEndpoint();
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _reveal() async {
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    setState(() {
      _revealing = true;
      _error = null;
    });
    try {
      final got = await api.revealSip(
        '${widget.extension['id']}',
        _reason.text.trim(),
      );
      if (mounted) setState(() => _revealed = got);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _revealing = false);
    }
  }

  Future<void> _confirmReset() async {
    final why = await showDialog<String>(
      context: context,
      builder: (_) => const _ResetPasswordDialog(),
    );
    if (why == null || !mounted) return;
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final got = await api.resetSipPassword('${widget.extension['id']}', why);
      if (!mounted) return;
      setState(() {
        _revealed = got;
        _error = null;
      });
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Password reset. Enter the new one in the phone.'),
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final canReveal = ref.watch(canProvider('secret.reveal'));
    final number = '${widget.extension['number']}';
    return AlertDialog(
      title: Text('Connect a phone to $number'),
      content: SizedBox(
        width: 480,
        child: FutureBuilder<Json>(
          future: _endpoint,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const SizedBox(
                height: 96,
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (snapshot.hasError) {
              return Text(problemMessage(snapshot.error!));
            }
            final e = snapshot.data!;
            final transports = [
              for (final t in (e['transports'] as List)) '$t'.toUpperCase(),
            ];
            return SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Enter these in the phone or softphone. On a desk phone, '
                    'open its web page and look for the account or SIP settings.',
                  ),
                  const SizedBox(height: 16),
                  _Line('Server', '${e['server']}'),
                  _Line('Port', '${e['port']}'),
                  if (e['tlsPort'] != null)
                    _Line('TLS port', '${e['tlsPort']}'),
                  _Line(
                    'Transport',
                    transports.join(' or '),
                    copyValue: transports.first,
                  ),
                  _Line('Username', '${_revealed?['username'] ?? number}'),
                  _Line('Domain / realm', '${e['realm']}'),
                  _password(canReveal),
                ],
              ),
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }

  Widget _password(bool canReveal) {
    final revealed = _revealed;
    if (revealed != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Line('Password', '${revealed['password']}', secret: true),
          TextButton.icon(
            onPressed: _confirmReset,
            icon: const Icon(Icons.autorenew),
            label: const Text('Reset password'),
          ),
        ],
      );
    }
    if (!canReveal) {
      return const Padding(
        padding: EdgeInsets.only(top: 8),
        child: Text(
          'The password is shown only to people allowed to reveal it.',
        ),
      );
    }
    if (!_asking) {
      return Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Wrap(
            spacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: () => setState(() => _asking = true),
                icon: const Icon(Icons.visibility_outlined),
                label: const Text('Reveal password'),
              ),
              TextButton.icon(
                onPressed: _confirmReset,
                icon: const Icon(Icons.autorenew),
                label: const Text('Reset password'),
              ),
            ],
          ),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _reason,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Why do you need it?',
              helperText: 'Recorded in the audit log along with your name.',
            ),
            onChanged: (_) => setState(() {}),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _revealing || _reason.text.trim().isEmpty
                ? null
                : _reveal,
            child: const Text('Reveal'),
          ),
        ],
      ),
    );
  }
}

/// One label and value with a copy button.
class _Line extends StatelessWidget {
  const _Line(this.label, this.value, {this.copyValue, this.secret = false});

  final String label;
  final String value;

  /// What the copy button copies, when that is not the whole shown value.
  final String? copyValue;
  final bool secret;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          SizedBox(
            width: 120,
            child: Text(label, style: Theme.of(context).textTheme.labelLarge),
          ),
          Expanded(child: SelectableText(value)),
          IconButton(
            tooltip: 'Copy $label',
            icon: const Icon(Icons.copy_outlined, size: 18),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: copyValue ?? value));
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(secret ? 'Password copied.' : '$label copied.'),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

/// Asks why, then pops with the reason (or null when cancelled). It owns its
/// text controller so it outlives the dialog's closing animation.
class _ResetPasswordDialog extends StatefulWidget {
  const _ResetPasswordDialog();

  @override
  State<_ResetPasswordDialog> createState() => _ResetPasswordDialogState();
}

class _ResetPasswordDialogState extends State<_ResetPasswordDialog> {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Reset this password?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'The extension gets a new password. The phone using it stops '
            'working until you enter the new one.',
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _reason,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Why are you resetting it?',
              helperText: 'Recorded in the audit log along with your name.',
            ),
            onChanged: (_) => setState(() {}),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _reason.text.trim().isEmpty
              ? null
              : () => Navigator.of(context).pop(_reason.text.trim()),
          child: const Text('Reset'),
        ),
      ],
    );
  }
}
