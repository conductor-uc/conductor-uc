import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import 'pbx_api.dart';

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

  String _lastFetched() {
    final at = widget.device['lastProvisionedAt'];
    if (at == null) {
      return widget.device['provisioningIssued'] == true
          ? 'Set up, but the phone has not fetched its settings yet.'
          : 'No setup details have been created yet.';
    }
    final when = DateTime.tryParse('$at')?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final text = when == null
        ? '$at'
        : '${when.year}-${two(when.month)}-${two(when.day)} ${two(when.hour)}:${two(when.minute)}';
    final ip = widget.device['lastSeenIp'];
    final agent = widget.device['lastUserAgent'];
    return 'Last fetched its settings $text'
        '${ip == null ? '' : ' from $ip'}'
        '${agent == null ? '' : ' ($agent)'}.';
  }

  @override
  Widget build(BuildContext context) {
    final canIssue = ref.watch(canProvider('secret.reveal'));
    final issued = _issued;
    return AlertDialog(
      title: const Text('Set up this phone'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_lastFetched()),
              const SizedBox(height: 16),
              if (issued != null) ..._details(issued) else _ask(canIssue),
            ],
          ),
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

  Widget _ask(bool canIssue) {
    if (!canIssue) {
      return const Text(
        'Setup details are created only by people allowed to reveal passwords.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Create the address, user name and password to give this phone. '
          'The password is shown once. Creating new details replaces any '
          'earlier ones, and a phone still using them stops fetching its settings.',
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _reason,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Why do you need them?',
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
          onPressed: _busy || _reason.text.trim().isEmpty ? null : _issue,
          child: const Text('Create setup details'),
        ),
      ],
    );
  }

  List<Widget> _details(Json issued) {
    final url = issued['url'] as String?;
    return [
      const Text(
        'On the phone, open its web page and find Auto Provision (the menu '
        'name varies by model). Enter these, then start auto provision. '
        'Or give the phone the address by DHCP option 66.',
      ),
      const SizedBox(height: 12),
      if (url == null)
        const Text(
          "This platform's public address is not set, so the address is not "
          'shown. Use your API address followed by /v1/public/provision/yealink/',
        )
      else
        _CopyLine('Server URL', url),
      _CopyLine('User name', '${issued['username']}'),
      _CopyLine('Password', '${issued['password']}', secret: true),
      if (issued['urlWithCredentials'] != null) ...[
        const SizedBox(height: 8),
        _CopyLine(
          'DHCP option 66',
          '${issued['urlWithCredentials']}',
          secret: true,
        ),
      ],
      const SizedBox(height: 8),
      const Text('This password is not shown again.'),
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
            tooltip: 'Copy $label',
            icon: const Icon(Icons.copy_outlined, size: 18),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: value));
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(
                  content: Text(secret ? '$label copied.' : '$label copied.'),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}
