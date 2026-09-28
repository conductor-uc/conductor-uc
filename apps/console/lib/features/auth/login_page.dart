import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../../core/session.dart';
import 'auth_errors.dart';
import '../../l10n/l10n.dart';
import 'auth_scaffold.dart';

/// Password sign-in, the first step of S3-04. The organization comes from the
/// console hostname (G-56), so nothing about it is asked for. The Organization
/// ID field appears only when the service needs it: this hostname does not say
/// (a local address, say), or the same email and password belong to more than
/// one organization. A link from an invitation can fill it in with `?org=`.
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key, this.orgId, this.notice});

  final String? orgId;

  /// A message to show above the form, such as "Password changed".
  final String? notice;

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  late final _org = TextEditingController(text: widget.orgId ?? '');
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _error;
  bool _busy = false;
  late bool _askOrg = widget.orgId != null;

  @override
  void dispose() {
    _org.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await ref
          .read(apiProvider)
          .getAuthApi()
          .login(
            loginRequest: LoginRequest(
              orgId: _org.text.trim().isEmpty ? null : _org.text.trim(),
              email: _email.text.trim(),
              password: _password.text,
            ),
          );
      final data = response.data;
      switch (data?.status) {
        case LoginResponseStatusEnum.ok:
          ref
              .read(sessionProvider.notifier)
              .signIn(
                Tokens(
                  accessToken: data!.accessToken!,
                  refreshToken: data.refreshToken,
                  expiresIn: data.expiresIn!,
                ),
              );
        case LoginResponseStatusEnum.mfaEnrollmentRequired:
          ref
              .read(authStepProvider.notifier)
              .set(
                MfaEnrollStep(
                  ticket: data!.enrollmentTicket!,
                  secret: data.totp!.secret,
                  otpauthUri: data.totp!.otpauthUri,
                ),
              );
          if (mounted) context.go('/login/mfa');
        case LoginResponseStatusEnum.mfaVerificationRequired:
          ref
              .read(authStepProvider.notifier)
              .set(MfaVerifyStep(ticket: data!.verificationTicket!));
          if (mounted) context.go('/login/mfa');
        default:
          setState(() => _error = context.l10n.authCouldNotSignIn);
      }
    } catch (e) {
      if (problemCode(e) == 'org_required') {
        setState(() {
          _askOrg = true;
          _error = problemDetail(e) ?? context.l10n.authEnterOrganizationId;
        });
      } else {
        setState(
          () => _error = isOffline(e)
              ? context.l10n.commonCouldNotReachServer
              : context.l10n.authNotRecognized,
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      title: context.l10n.authSignInTitle,
      children: [
        if (widget.notice != null) FormMessage(widget.notice!),
        if (_askOrg)
          TextField(
            controller: _org,
            decoration: InputDecoration(
              labelText: context.l10n.authOrganizationId,
            ),
          ),
        TextField(
          controller: _email,
          autofillHints: const [AutofillHints.username],
          decoration: InputDecoration(labelText: context.l10n.authEmail),
        ),
        TextField(
          controller: _password,
          obscureText: true,
          autofillHints: const [AutofillHints.password],
          decoration: InputDecoration(labelText: context.l10n.authPassword),
          onSubmitted: (_) => _busy ? null : _submit(),
        ),
        if (_error != null) FormMessage(_error!, isError: true),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: Text(context.l10n.authSignInButton),
        ),
        TextButton(
          onPressed: () => context.go('/reset'),
          child: Text(context.l10n.authForgotPassword),
        ),
      ],
    );
  }
}
