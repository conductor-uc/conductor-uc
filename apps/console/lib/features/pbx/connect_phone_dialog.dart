import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
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
        ? Future.error(currentL10n.chSignInAgain)
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
    final l = context.l10n;
    try {
      final got = await api.resetSipPassword('${widget.extension['id']}', why);
      if (!mounted) return;
      setState(() {
        _revealed = got;
        _error = null;
      });
      messenger.showSnackBar(SnackBar(content: Text(l.phonePasswordReset)));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(problemMessage(e))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final canReveal = ref.watch(canProvider('secret.reveal'));
    final number = '${widget.extension['number']}';
    return AlertDialog(
      title: Text(l.phoneTitle(number)),
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
                  Text(l.phoneIntro),
                  const SizedBox(height: 16),
                  if (e['outboundProxy'] != null) ...[
                    // Phones connect to the proxy, which has a certificate they
                    // can verify, and still register to and log in as the domain.
                    _Line(l.phoneOutboundProxy, '${e['outboundProxy']}'),
                    _Line(l.phoneServerRegistrar, '${e['server']}'),
                  ] else
                    _Line(l.myHomeServer, '${e['server']}'),
                  _Line(l.myHomePort, '${e['port']}'),
                  if (e['tlsPort'] != null)
                    _Line(l.phoneTlsPort, '${e['tlsPort']}'),
                  _Line(
                    l.phoneTransport,
                    transports.join(l.phoneOrSeparator),
                    copyValue: transports.first,
                  ),
                  _Line(
                    l.myHomeUsername,
                    '${_revealed?['username'] ?? number}',
                  ),
                  _Line(l.phoneDomainRealm, '${e['realm']}'),
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
          child: Text(l.commonClose),
        ),
      ],
    );
  }

  Widget _password(bool canReveal) {
    final l = context.l10n;
    final revealed = _revealed;
    if (revealed != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Line(l.phonePassword, '${revealed['password']}', secret: true),
          TextButton.icon(
            onPressed: _confirmReset,
            icon: const Icon(Icons.autorenew),
            label: Text(l.phoneResetPassword),
          ),
        ],
      );
    }
    if (!canReveal) {
      return Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(l.phonePasswordHidden),
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
                label: Text(l.phoneRevealPassword),
              ),
              TextButton.icon(
                onPressed: _confirmReset,
                icon: const Icon(Icons.autorenew),
                label: Text(l.phoneResetPassword),
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
            decoration: InputDecoration(
              labelText: l.phoneWhyReveal,
              helperText: l.phoneAuditNote,
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
            child: Text(l.phoneReveal),
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
            tooltip: context.l10n.phoneCopy(label),
            icon: const Icon(Icons.copy_outlined, size: 18),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: copyValue ?? value));
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(
                    secret
                        ? context.l10n.phonePasswordCopied
                        : context.l10n.phoneCopied(label),
                  ),
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
    final l = context.l10n;
    return AlertDialog(
      title: Text(l.phoneResetTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l.phoneResetBody),
          const SizedBox(height: 12),
          TextField(
            controller: _reason,
            autofocus: true,
            decoration: InputDecoration(
              labelText: l.phoneWhyReset,
              helperText: l.phoneAuditNote,
            ),
            onChanged: (_) => setState(() {}),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l.commonCancel),
        ),
        FilledButton(
          onPressed: _reason.text.trim().isEmpty
              ? null
              : () => Navigator.of(context).pop(_reason.text.trim()),
          child: Text(l.phoneReset),
        ),
      ],
    );
  }
}
