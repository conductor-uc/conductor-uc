import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import 'auth_errors.dart';
import 'auth_scaffold.dart';

/// The shortest password identity-service accepts (a length floor, G-56).
const minPasswordLength = 12;

/// Checks a new password and its confirmation before anything is sent.
String? newPasswordProblem(String password, String confirmation) {
  if (password.length < minPasswordLength) {
    return 'Use at least $minPasswordLength characters.';
  }
  if (password != confirmation) return 'The two passwords do not match.';
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
  String? _error;

  @override
  void dispose() {
    _org.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_org.text.trim().isEmpty || _email.text.trim().isEmpty) {
      setState(() => _error = 'Enter your organization ID and email.');
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
              orgId: _org.text.trim(),
              email: _email.text.trim(),
            ),
          );
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = isOffline(e)
              ? 'Could not reach the server.'
              : 'Something went wrong. Try again in a moment.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return AuthScaffold(
        title: 'Check your email',
        children: [
          const Text(
            'If there is an account for that email, we have sent a link to '
            'choose a new password. It works for a limited time.',
          ),
          const SizedBox(height: 16),
          TextButton(
            onPressed: () => context.go('/login'),
            child: const Text('Back to sign in'),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: 'Reset your password',
      children: [
        TextField(
          controller: _org,
          decoration: const InputDecoration(labelText: 'Organization ID'),
        ),
        TextField(
          controller: _email,
          autofillHints: const [AutofillHints.email],
          decoration: const InputDecoration(labelText: 'Email'),
          onSubmitted: (_) => _busy ? null : _submit(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: const Text('Send reset link'),
        ),
        TextButton(
          onPressed: () => context.go('/login'),
          child: const Text('Back to sign in'),
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
    final problem = newPasswordProblem(_password.text, _confirm.text);
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
          'invalid_reset_token' =>
            'This link is invalid or has expired. Request a new one.',
          'weak_password' => problemDetail(e) ?? 'Choose a stronger password.',
          _ =>
            isOffline(e)
                ? 'Could not reach the server.'
                : 'Something went wrong. Try again.',
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
        title: 'Reset your password',
        children: [
          const Text('This link is incomplete. Request a new one.'),
          TextButton(
            onPressed: () => context.go('/reset'),
            child: const Text('Request a new link'),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: 'Choose a new password',
      children: [
        TextField(
          controller: _password,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: 'New password',
            helperText: 'At least $minPasswordLength characters.',
          ),
        ),
        TextField(
          controller: _confirm,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: const InputDecoration(labelText: 'Confirm new password'),
          onSubmitted: (_) => _busy ? null : _submit(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: const Text('Change password'),
        ),
        const FormMessage(
          'You will be signed out everywhere, and asked to sign in again.',
        ),
      ],
    );
  }
}
