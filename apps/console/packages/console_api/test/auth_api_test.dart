import 'package:test/test.dart';
import 'package:console_api/console_api.dart';


/// tests for AuthApi
void main() {
  final instance = ConsoleApi().getAuthApi();

  group(AuthApi, () {
    //Future<LoginResponse> login(LoginRequest loginRequest) async
    test('test login', () async {
      // TODO
    });

  });
}
