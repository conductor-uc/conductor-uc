import 'package:test/test.dart';
import 'package:console_api/console_api.dart';


/// tests for AuthApi
void main() {
  final instance = ConsoleApi().getAuthApi();

  group(AuthApi, () {
    //Future<InvitationAccepted> acceptInvitation(InvitationAcceptRequest invitationAcceptRequest) async
    test('test acceptInvitation', () async {
      // TODO
    });

    //Future<Tokens> confirmMfaEnrollment(MfaEnrollConfirmRequest mfaEnrollConfirmRequest) async
    test('test confirmMfaEnrollment', () async {
      // TODO
    });

    //Future confirmPasswordReset(PasswordResetConfirmRequest passwordResetConfirmRequest) async
    test('test confirmPasswordReset', () async {
      // TODO
    });

    //Future<LoginResponse> login(LoginRequest loginRequest) async
    test('test login', () async {
      // TODO
    });

    //Future logout(RefreshRequest refreshRequest) async
    test('test logout', () async {
      // TODO
    });

    //Future<InvitationSummary> lookupInvitation(InvitationTokenRequest invitationTokenRequest) async
    test('test lookupInvitation', () async {
      // TODO
    });

    //Future<Tokens> refreshTokens(RefreshRequest refreshRequest) async
    test('test refreshTokens', () async {
      // TODO
    });

    //Future requestPasswordReset(PasswordResetRequest passwordResetRequest) async
    test('test requestPasswordReset', () async {
      // TODO
    });

    //Future<Tokens> verifyMfa(MfaVerifyRequest mfaVerifyRequest) async
    test('test verifyMfa', () async {
      // TODO
    });

  });
}
