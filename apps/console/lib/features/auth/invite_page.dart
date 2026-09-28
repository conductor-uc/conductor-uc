import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import 'auth_errors.dart';
import '../../l10n/l10n.dart';
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
          _error = isOffline(e) ? context.l10n.commonCouldNotReachServer : null;
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _accept() async {
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
          'invalid_invitation' => context.l10n.authInviteInvalidShort,
          'email_taken' => context.l10n.authEmailTaken,
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
    if (_loading) {
      return AuthScaffold(
        title: context.l10n.authInviteTitle,
        children: const [Center(child: CircularProgressIndicator())],
      );
    }
    final invitation = _invitation;
    if (invitation == null) {
      return AuthScaffold(
        title: context.l10n.authInviteTitle,
        children: [
          FormMessage(
            _invalid
                ? context.l10n.authInviteInvalid
                : (_error ?? context.l10n.authInviteCouldNotLoad),
            isError: true,
          ),
          TextButton(
            onPressed: () => context.go('/login'),
            child: Text(context.l10n.authGoToSignIn),
          ),
        ],
      );
    }
    return AuthScaffold(
      title: context.l10n.authInviteWelcome(invitation.displayName),
      children: [
        Text(context.l10n.authInviteChoosePassword(invitation.email)),
        const SizedBox(height: 8),
        TextField(
          controller: _password,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: context.l10n.authPassword,
            helperText: context.l10n.authPasswordHelper(minPasswordLength),
          ),
        ),
        TextField(
          controller: _confirm,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: InputDecoration(
            labelText: context.l10n.authConfirmPassword,
          ),
          onSubmitted: (_) => _busy ? null : _accept(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _accept,
          child: Text(context.l10n.authCreateAccount),
        ),
      ],
    );
  }
}
