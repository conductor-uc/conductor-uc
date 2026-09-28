import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// S9-02: the console translates problems by code. Every code it has words
/// for must be one the services send (api/problem-codes.json, dumped by
/// tool/dump-problem-codes.mjs), so a renamed code is caught here rather than
/// silently falling back to English.
void main() {
  test('every translated problem code is one the services send', () {
    final known = (jsonDecode(
      File('api/problem-codes.json').readAsStringSync(),
    ) as List).cast<String>().toSet();
    final translated = RegExp(r"'([a-z][a-z0-9_]*)'(?= =>| \|\|)")
        .allMatches(
          // problemText only: fieldRuleText's cases are schema keywords.
          File('lib/l10n/problems.dart')
              .readAsStringSync()
              .split('String? fieldRuleText')
              .first,
        )
        .map((m) => m[1]!)
        .toSet();

    expect(translated, isNotEmpty);
    expect(translated.difference(known), isEmpty);
  });
}
