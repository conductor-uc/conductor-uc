import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import 'auth_errors.dart';
import 'auth_scaffold.dart';
import 'reset_pages.dart';

/// Accepts an invitation from the emailed link's `token`: shows who it is
/// for, then takes the password the new user chooses.
class InvitePage extends ConsumerStatefulWidget {
  const InvitePage({super.key, required this.token});

  final String? token;

  @override
  ConsumerState<InvitePage> createState() => _InvitePageState();
}

class _InvitePageState extends ConsumerState<InvitePage> {
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  InvitationSummary? _invitation;
  bool _loading = true;
  bool _invalid = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _lookup();
  }

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    final token = widget.token;
    if (token == null || token.isEmpty) {
      setState(() {
        _loading = false;
        _invalid = true;
      });
      return;
    }
    try {
      final response = await ref
          .read(apiProvider)
          .getAuthApi()
          .lookupInvitation(
            invitationTokenRequest: InvitationTokenRequest(token: token),
          );
      if (mounted) setState(() => _invitation = response.data);
    } catch (e) {
      if (mounted) {
        setState(() {
          _invalid = !isOffline(e);
          _error = isOffline(e) ? 'Could not reach the server.' : null;
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _accept() async {
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
      final response = await ref
          .read(apiProvider)
          .getAuthApi()
          .acceptInvitation(
            invitationAcceptRequest: InvitationAcceptRequest(
              token: widget.token!,
              password: _password.text,
            ),
          );
      final org = Uri.encodeQueryComponent(response.data?.orgId ?? '');
      if (mounted) context.go('/login?org=$org&notice=account-created');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = switch (problemCode(e)) {
          'invalid_invitation' => 'This invitation is invalid or has expired.',
          'email_taken' =>
            'That email already has an account. Sign in instead.',
          'weak_password' => problemDetail(e) ?? 'Choose a stronger password.',
          'password_in_use' => problemDetail(e) ?? 'That password is already used for another account with this email. Choose a different one.',
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
    if (_loading) {
      return const AuthScaffold(
        title: 'Accept invitation',
        children: [Center(child: CircularProgressIndicator())],
      );
    }
    final invitation = _invitation;
    if (invitation == null) {
      return AuthScaffold(
        title: 'Accept invitation',
        children: [
          FormMessage(
            _invalid
                ? 'This invitation is invalid or has expired. Ask whoever '
                      'invited you to send a new one.'
                : (_error ?? 'Could not load this invitation.'),
            isError: true,
          ),
          TextButton(
            onPressed: () => context.go('/login'),
            child: const Text('Go to sign in'),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: 'Welcome, ${invitation.displayName}',
      children: [
        Text('Choose a password for ${invitation.email}.'),
        const SizedBox(height: 8),
        TextField(
          controller: _password,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: 'Password',
            helperText: 'At least $minPasswordLength characters.',
          ),
        ),
        TextField(
          controller: _confirm,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: const InputDecoration(labelText: 'Confirm password'),
          onSubmitted: (_) => _busy ? null : _accept(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _accept,
          child: const Text('Create account'),
        ),
      ],
    );
  }
}
