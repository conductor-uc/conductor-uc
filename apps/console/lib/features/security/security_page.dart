import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../auth/auth_errors.dart';
import '../auth/auth_scaffold.dart' show FormMessage;
import '../pbx/pbx_api.dart';
import 'security_api.dart';

/// The platform operator's sign-in policy. A new platform starts without
/// requiring two-step verification for its own administrators, so it can be
/// set up first; this is where it is turned on once it is (D-012 as amended).
class SecurityPage extends ConsumerWidget {
  const SecurityPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PageFrame(
      children: [
        const PageHeader(
          title: 'Sign-in security',
          subtitle: 'How administrators of this platform sign in.',
        ),
        const SizedBox(height: 16),
        Expanded(
          child: SingleChildScrollView(
            child: AsyncBody<Json>(
              value: ref.watch(securitySettingsProvider),
              emptyText: '',
              isEmpty: (_) => false,
              builder: (s) => TwoStepCard(settings: s),
            ),
          ),
        ),
      ],
    );
  }
}

/// Whether the platform's administrators must use two-step verification.
/// Turning it on takes effect at each administrator's next sign-in; turning
/// it off asks for the current code from the operator's own authenticator app.
class TwoStepCard extends ConsumerStatefulWidget {
  const TwoStepCard({super.key, required this.settings});

  final Json settings;

  @override
  ConsumerState<TwoStepCard> createState() => _TwoStepCardState();
}

class _TwoStepCardState extends ConsumerState<TwoStepCard> {
  bool _saving = false;
  String? _error;

  Future<void> _set(bool on) async {
    final api = ref.read(securityApiProvider);
    if (api == null) return;
    if (!on) {
      final done = await showDialog<bool>(
        context: context,
        builder: (_) => TurnOffTwoStepDialog(
          turnOff: (code) =>
              api.save(requireMasterMfa: false, stepUpCode: code),
        ),
      );
      if (done == true) ref.invalidate(securitySettingsProvider);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await api.save(requireMasterMfa: true);
      ref.invalidate(securitySettingsProvider);
    } catch (e) {
      if (mounted) setState(() => _error = problemMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final on = widget.settings['requireMasterMfa'] == true;
    final canChange = ref.watch(canProvider('platform.operate'));
    final scheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              key: const ValueKey('require-two-step'),
              contentPadding: EdgeInsets.zero,
              value: on,
              onChanged: canChange && !_saving ? _set : null,
              title: const Text(
                'Require two-step verification for platform administrators',
              ),
              subtitle: const Text(
                'Administrators sign in with a password and a code from an '
                'authenticator app. Reseller administrators always need both.',
              ),
            ),
            const SizedBox(height: 8),
            Container(
              key: const ValueKey('two-step-status'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: on
                    ? scheme.secondaryContainer
                    : scheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                on
                    ? 'On. Administrators who have not set up an authenticator '
                          'app are asked to at their next sign-in.'
                    : 'Off. Turn this on once the platform is set up. Anyone '
                          'who has already set up an authenticator app is '
                          'still asked for a code.',
              ),
            ),
            if (_error != null) FormMessage(_error!, isError: true),
          ],
        ),
      ),
    );
  }
}

/// Confirms turning the requirement off with a current code from the
/// administrator's own authenticator app (step-up, G-100), so a signed-in
/// session alone cannot weaken every administrator's sign-in. Stays open on a
/// wrong code; closes with `true` once it is off.
class TurnOffTwoStepDialog extends StatefulWidget {
  const TurnOffTwoStepDialog({super.key, required this.turnOff});

  /// Turns the requirement off with the administrator's code; throws on refusal.
  final Future<Object?> Function(String code) turnOff;

  @override
  State<TurnOffTwoStepDialog> createState() => _TurnOffTwoStepDialogState();
}

class _TurnOffTwoStepDialogState extends State<TurnOffTwoStepDialog> {
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  /// Nothing to enter a code with: the account has no authenticator of its own.
  bool _cannot = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final code = _code.text.replaceAll(RegExp(r'\s'), '');
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      setState(
        () => _error = 'Enter the 6-digit code from your authenticator app.',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.turnOff(code);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _cannot = problemCode(e) == 'step_up_not_enrolled';
        _error = switch (problemCode(e)) {
          'step_up_required' =>
            'Enter the 6-digit code from your authenticator app.',
          'step_up_invalid' =>
            'That code did not work, or it was already used. Wait for the '
                'next code in your authenticator app and try again.',
          'step_up_locked' =>
            'Too many wrong codes. Wait 15 minutes, then try again.',
          'step_up_not_enrolled' =>
            'You have not set up an authenticator app yet, so you cannot '
                'confirm this. Sign out and back in to set one up.',
          _ => problemMessage(e),
        };
      });
      if (!_cannot) _code.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Stop requiring two-step verification?'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Administrators who have not set up an authenticator app will '
              'sign in with a password alone. Anyone who has set one up is '
              'still asked for a code.',
            ),
            const SizedBox(height: 16),
            const Text(
              'To confirm, enter the current code from your own authenticator '
              'app.',
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('step-up-code'),
              controller: _code,
              autofocus: true,
              enabled: !_busy && !_cannot,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              decoration: const InputDecoration(labelText: 'Your code'),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            if (_error != null) FormMessage(_error!, isError: true),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy || _cannot ? null : _submit,
          child: const Text('Turn off'),
        ),
      ],
    );
  }
}
