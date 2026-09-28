import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import 'auth_errors.dart';
import '../../l10n/l10n.dart';
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
            ? context.l10n.commonCouldNotReachServer
            : context.l10n.authMfaCodeRejected,
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
          ? context.l10n.authMfaSetUpTitle
          : context.l10n.authMfaTitle,
      children: [
        if (step is MfaEnrollStep) ...[
          Text(context.l10n.authMfaScanInstructions),
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
          Text(context.l10n.authMfaEnterCode),
        const SizedBox(height: 16),
        TextField(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          autofillHints: const [AutofillHints.oneTimeCode],
          decoration: InputDecoration(labelText: context.l10n.authMfaCode),
          onSubmitted: (_) => _busy ? null : _submit(step),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : () => _submit(step),
          child: Text(
            enrolling
                ? context.l10n.authMfaConfirm
                : context.l10n.authMfaVerify,
          ),
        ),
        TextButton(
          onPressed: _back,
          child: Text(context.l10n.commonBackToSignIn),
        ),
      ],
    );
  }
}
