import 'package:console/core/problem.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

DioException failure(Object? data, [int status = 400]) => DioException(
  requestOptions: RequestOptions(path: '/x'),
  response: Response(
    requestOptions: RequestOptions(path: '/x'),
    statusCode: status,
    data: data,
  ),
);

void main() {
  test("a validation failure names the field and the rule", () {
    expect(
      problemMessage(
        failure({
          'detail': 'The body failed validation.',
          'errors': [
            {
              'field': '/adminPassword',
              'message': 'must NOT have fewer than 12 characters',
            },
          ],
        }),
      ),
      'The body failed validation. admin password must NOT have fewer than 12 characters.',
    );
  });

  test('a problem with no field errors is just its detail', () {
    expect(
      problemMessage(failure({'detail': 'Slug taken.'}, 409)),
      'Slug taken.',
    );
  });

  test('no response means the server could not be reached', () {
    expect(
      problemMessage(DioException(requestOptions: RequestOptions(path: '/x'))),
      'Could not reach the server.',
    );
  });
}
