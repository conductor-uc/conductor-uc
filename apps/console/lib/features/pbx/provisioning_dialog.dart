import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import 'pbx_api.dart';
import '../../core/format.dart';

/// What to tell a Yealink desk phone so it sets itself up.
///
/// The phone is given an address and a user name and password of its own. The
/// password unlocks the extension's SIP password, so it is issued only to people
/// with `secret.reveal`, for a reason, and shown once: issuing again replaces it
/// and the old one stops working.
class ProvisioningDialog extends ConsumerStatefulWidget {
  const ProvisioningDialog({super.key, required this.device});

  final Json device;

  @override
  ConsumerState<ProvisioningDialog> createState() => _ProvisioningDialogState();
}

class _ProvisioningDialogState extends ConsumerState<ProvisioningDialog> {
  final _reason = TextEditingController();
  Json? _issued;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _issue() async {
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final got = await api.issueProvisioning(
        '${widget.device['id']}',
        _reason.text.trim(),
      );
      if (mounted) setState(() => _issued = got);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _lastFetched(AppLocalizations l) {
    final at = widget.device['lastProvisionedAt'];
    if (at == null) {
      return widget.device['provisioningIssued'] == true
          ? l.provNotFetched
          : l.provNotIssued;
    }
    final text = formatDateTime(at);
    final ip = widget.device['lastSeenIp'];
    final agent = widget.device['lastUserAgent'];
    return l.provLastFetched(
      text,
      ip == null ? '' : l.provFromIp('$ip'),
      agent == null ? '' : l.provUserAgent('$agent'),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final canIssue = ref.watch(canProvider('secret.reveal'));
    final issued = _issued;
    return AlertDialog(
      title: Text(l.provTitle),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_lastFetched(l)),
              const SizedBox(height: 16),
              if (issued != null) ..._details(l, issued) else _ask(l, canIssue),
            ],
          ),
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

  Widget _ask(AppLocalizations l, bool canIssue) {
    if (!canIssue) {
      return Text(l.provNotAllowed);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l.provIntro),
        const SizedBox(height: 12),
        TextField(
          controller: _reason,
          autofocus: true,
          decoration: InputDecoration(
            labelText: l.provWhy,
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
          onPressed: _busy || _reason.text.trim().isEmpty ? null : _issue,
          child: Text(l.provCreate),
        ),
      ],
    );
  }

  List<Widget> _details(AppLocalizations l, Json issued) {
    final url = issued['url'] as String?;
    return [
      Text(l.provHowTo),
      const SizedBox(height: 12),
      if (url == null)
        Text(l.provNoPublicAddress)
      else
        _CopyLine(l.provServerUrl, url),
      _CopyLine(l.provUserName, '${issued['username']}'),
      _CopyLine(l.phonePassword, '${issued['password']}', secret: true),
      if (issued['urlWithCredentials'] != null) ...[
        const SizedBox(height: 8),
        _CopyLine(
          l.provDhcpOption66,
          '${issued['urlWithCredentials']}',
          secret: true,
        ),
      ],
      const SizedBox(height: 8),
      Text(l.provShownOnce),
    ];
  }
}

class _CopyLine extends StatelessWidget {
  const _CopyLine(this.label, this.value, {this.secret = false});

  final String label;
  final String value;
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
              await Clipboard.setData(ClipboardData(text: value));
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(context.l10n.phoneCopied(label))),
              );
            },
          ),
        ],
      ),
    );
  }
}
