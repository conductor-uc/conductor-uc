import 'package:test/test.dart';
import 'package:console_api/console_api.dart';


/// tests for PublicApi
void main() {
  final instance = ConsoleApi().getPublicApi();

  group(PublicApi, () {
    //Future<PublicBrand> getPublicBrand(String host) async
    test('test getPublicBrand', () async {
      // TODO
    });

  });
}
