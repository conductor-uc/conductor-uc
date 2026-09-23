import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/brand.dart';
import '../../core/api_client.dart';
import '../../core/session.dart';
import '../../widgets/brand_header.dart';

/// Password sign-in. MFA, reset, and invitations are S3-04; until the gateway
/// resolves the organization from the hostname, the organization id is typed.
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  final _org = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _error;
  bool _busy = false;

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
              orgId: _org.text.trim(),
              email: _email.text.trim(),
              password: _password.text,
            ),
          );
      final data = response.data;
      if (data?.status == LoginResponseStatusEnum.ok) {
        ref
            .read(sessionProvider.notifier)
            .signIn(
              Session.fromTokens(
                accessToken: data!.accessToken!,
                refreshToken: data.refreshToken!,
              ),
            );
        return;
      }
      setState(() => _error = 'Multi-factor sign-in is not available yet.');
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      setState(
        () => _error = status == 401 || status == 400
            ? 'Those details were not recognized.'
            : 'Could not reach the server.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final brand = ref.watch(brandProvider);
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: AutofillGroup(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  BrandHeader(brand: brand, large: true),
                  Text(
                    'Sign in',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _org,
                    decoration: const InputDecoration(
                      labelText: 'Organization ID',
                    ),
                  ),
                  TextField(
                    controller: _email,
                    autofillHints: const [AutofillHints.username],
                    decoration: const InputDecoration(labelText: 'Email'),
                  ),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    autofillHints: const [AutofillHints.password],
                    decoration: const InputDecoration(labelText: 'Password'),
                    onSubmitted: (_) => _busy ? null : _submit(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: const Text('Sign in'),
                  ),
                  if (brand.legalFooter != null) ...[
                    const SizedBox(height: 24),
                    Text(
                      brand.legalFooter!,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
