import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import 'auth_errors.dart';
import 'auth_scaffold.dart';

/// The second sign-in step (07 §1): confirm a new authenticator on first use,
/// or enter the current code. Master and reseller users always pass through
/// here; the server issues no token until they do.
class MfaPage extends ConsumerStatefulWidget {
  const MfaPage({super.key});

  @override
  ConsumerState<MfaPage> createState() => _MfaPageState();
}

class _MfaPageState extends ConsumerState<MfaPage> {
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit(AuthStep step) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final auth = ref.read(apiProvider).getAuthApi();
    final code = _code.text.trim();
    try {
      final response = switch (step) {
        MfaEnrollStep() => await auth.confirmMfaEnrollment(
          mfaEnrollConfirmRequest: MfaEnrollConfirmRequest(
            enrollmentTicket: step.ticket,
            code: code,
          ),
        ),
        MfaVerifyStep() => await auth.verifyMfa(
          mfaVerifyRequest: MfaVerifyRequest(
            verificationTicket: step.ticket,
            code: code,
          ),
        ),
      };
      final tokens = response.data;
      if (tokens == null) throw StateError('empty response');
      ref.read(authStepProvider.notifier).set(null);
      ref.read(sessionProvider.notifier).signIn(tokens);
    } catch (e) {
      setState(
        () => _error = isOffline(e)
            ? 'Could not reach the server.'
            : 'That code was not accepted. If it keeps failing, sign in again.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _back() {
    ref.read(authStepProvider.notifier).set(null);
    context.go('/login');
  }

  @override
  Widget build(BuildContext context) {
    final step = ref.watch(authStepProvider);
    if (step == null) return const SizedBox.shrink();
    final enrolling = step is MfaEnrollStep;

    return AuthScaffold(
      title: enrolling
          ? 'Set up two-step verification'
          : 'Two-step verification',
      children: [
        if (step is MfaEnrollStep) ...[
          const Text(
            'Scan this code with an authenticator app, or enter the key by hand, '
            'then type the 6-digit code it shows.',
          ),
          const SizedBox(height: 16),
          Center(
            child: QrImageView(
              data: step.otpauthUri,
              size: 176,
              backgroundColor: Colors.white,
            ),
          ),
          const SizedBox(height: 8),
          SelectableText(step.secret, textAlign: TextAlign.center),
        ] else
          const Text('Enter the 6-digit code from your authenticator app.'),
        const SizedBox(height: 16),
        TextField(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          decoration: const InputDecoration(labelText: 'Code'),
          onSubmitted: (_) => _busy ? null : _submit(step),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : () => _submit(step),
          child: Text(enrolling ? 'Confirm' : 'Verify'),
        ),
        TextButton(onPressed: _back, child: const Text('Back to sign in')),
      ],
    );
  }
}
