import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import 'auth_errors.dart';
import '../../l10n/l10n.dart';
import 'auth_scaffold.dart';

/// The shortest password identity-service accepts (a length floor, G-56).
const minPasswordLength = 12;

/// Checks a new password and its confirmation before anything is sent.
String? newPasswordProblem(
  AppLocalizations l10n,
  String password,
  String confirmation,
) {
  if (password.length < minPasswordLength) {
    return l10n.authPasswordTooShort(minPasswordLength);
  }
  if (password != confirmation) return l10n.authPasswordsDoNotMatch;
  return null;
}

/// Asks for a reset link. Always answers the same way, whether or not the
/// account exists, so it cannot be used to find out who has one.
class ResetRequestPage extends ConsumerStatefulWidget {
  const ResetRequestPage({super.key});

  @override
  ConsumerState<ResetRequestPage> createState() => _ResetRequestPageState();
}

class _ResetRequestPageState extends ConsumerState<ResetRequestPage> {
  final _org = TextEditingController();
  final _email = TextEditingController();
  bool _busy = false;
  bool _sent = false;
  bool _askOrg = false;
  String? _error;

  @override
  void dispose() {
    _org.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || (_askOrg && _org.text.trim().isEmpty)) {
      setState(
        () => _error = _askOrg
            ? context.l10n.authResetEnterOrgAndEmail
            : context.l10n.authResetEnterEmail,
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(apiProvider)
          .getAuthApi()
          .requestPasswordReset(
            passwordResetRequest: PasswordResetRequest(
              orgId: _org.text.trim().isEmpty ? null : _org.text.trim(),
              email: _email.text.trim(),
            ),
          );
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) {
        if (problemCode(e) == 'org_required') {
          // This hostname does not say which organization; it depends on the
          // address the page is served from, not on the account.
          setState(() {
            _askOrg = true;
            _error = context.l10n.authEnterOrganizationId;
          });
        } else {
          setState(
            () => _error = isOffline(e)
                ? context.l10n.commonCouldNotReachServer
                : context.l10n.authResetTryAgainLater,
          );
        }
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return AuthScaffold(
        title: context.l10n.authResetCheckEmailTitle,
        children: [
          Text(context.l10n.authResetCheckEmailBody),
          const SizedBox(height: 16),
          TextButton(
            onPressed: () => context.go('/login'),
            child: Text(context.l10n.commonBackToSignIn),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: context.l10n.authResetTitle,
      children: [
        if (_askOrg)
          TextField(
            controller: _org,
            decoration: InputDecoration(
              labelText: context.l10n.authOrganizationId,
            ),
          ),
        TextField(
          controller: _email,
          autofillHints: const [AutofillHints.email],
          decoration: InputDecoration(labelText: context.l10n.authEmail),
          onSubmitted: (_) => _busy ? null : _submit(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(context.l10n.authResetSend),
        ),
        TextButton(
          onPressed: () => context.go('/login'),
          child: Text(context.l10n.commonBackToSignIn),
        ),
      ],
    );
  }
}

/// Sets a new password from the emailed link's `token`.
class ResetConfirmPage extends ConsumerStatefulWidget {
  const ResetConfirmPage({super.key, required this.token});

  final String? token;

  @override
  ConsumerState<ResetConfirmPage> createState() => _ResetConfirmPageState();
}

class _ResetConfirmPageState extends ConsumerState<ResetConfirmPage> {
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final problem = newPasswordProblem(
      context.l10n,
      _password.text,
      _confirm.text,
    );
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(apiProvider)
          .getAuthApi()
          .confirmPasswordReset(
            passwordResetConfirmRequest: PasswordResetConfirmRequest(
              token: widget.token!,
              newPassword: _password.text,
            ),
          );
      if (mounted) context.go('/login?notice=password-changed');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = switch (problemCode(e)) {
          'invalid_reset_token' => context.l10n.authResetLinkInvalid,
          'weak_password' =>
            problemDetail(e) ?? context.l10n.authChooseStrongerPassword,
          'password_in_use' =>
            problemDetail(e) ?? context.l10n.authPasswordInUse,
          _ =>
            isOffline(e)
                ? context.l10n.commonCouldNotReachServer
                : context.l10n.commonSomethingWentWrongTryAgain,
        };
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.token == null || widget.token!.isEmpty) {
      return AuthScaffold(
        title: context.l10n.authResetTitle,
        children: [
          Text(context.l10n.authResetLinkIncomplete),
          TextButton(
            onPressed: () => context.go('/reset'),
            child: Text(context.l10n.authResetRequestNewLink),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: context.l10n.authResetChooseTitle,
      children: [
        TextField(
          controller: _password,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: context.l10n.authNewPassword,
            helperText: context.l10n.authPasswordHelper(minPasswordLength),
          ),
        ),
        TextField(
          controller: _confirm,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: context.l10n.authConfirmNewPassword,
          ),
          onSubmitted: (_) => _busy ? null : _submit(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(context.l10n.authChangePassword),
        ),
        FormMessage(context.l10n.authSignedOutEverywhere),
      ],
    );
  }
}
