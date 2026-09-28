import 'package:dio/dio.dart';

import '../l10n/l10n.dart';
import '../l10n/problems.dart';

/// A failed request's RFC 9457 problem, as the services send it (09 §2,
/// S9-02): a stable [code] to translate and branch on, the values the message
/// is built from ([params]), and field-level [errors]. [detail] is English,
/// the fallback for a code the console has no words for yet.
class Problem {
  const Problem({
    required this.status,
    this.code,
    this.detail,
    this.params = const {},
    this.errors = const [],
  });

  final int status;
  final String? code;
  final String? detail;
  final Map<String, Object?> params;
  final List<FieldProblem> errors;
}

/// One field that was refused: its [field] path (`/number`), and either the
/// schema rule it broke ([keyword] with [params], e.g. `minLength` and
/// `{limit: 12}`) or the service's own [code].
class FieldProblem {
  const FieldProblem({
    required this.field,
    required this.message,
    this.keyword,
    this.code,
    this.params = const {},
  });

  final String field;

  /// English, from the service: used only when neither [code] nor [keyword]
  /// has words in the console.
  final String message;
  final String? keyword;
  final String? code;
  final Map<String, Object?> params;

  /// The top-level key of the body this is about: `number` for `/number`,
  /// `rules` for `/rules/0/start`, empty for the body as a whole.
  String get key => field.replaceAll(RegExp(r'^/+'), '').split('/').first;
}

Map<String, Object?> _map(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const {};

/// The problem a failed request answered with, or null when there is none
/// (it never reached the server, or the body is not a problem document).
Problem? problemOf(Object error) {
  if (error is! DioException) return null;
  final response = error.response;
  if (response == null) return null;
  final data = response.data;
  if (data is! Map) return Problem(status: response.statusCode ?? 0);
  final errors = data['errors'];
  return Problem(
    status: response.statusCode ?? (data['status'] as int? ?? 0),
    code: data['code'] is String ? data['code'] as String : null,
    detail: switch (data['detail'] ?? data['title'] ?? data['message']) {
      final String s when s.isNotEmpty => s,
      _ => null,
    },
    params: _map(data['params']),
    errors: [
      if (errors is List)
        for (final e in errors)
          if (e is Map)
            FieldProblem(
              field: '${e['field'] ?? ''}',
              message: e['message'] is String ? e['message'] as String : '',
              keyword: e['keyword'] is String ? e['keyword'] as String : null,
              code: e['code'] is String ? e['code'] as String : null,
              params: _map(e['params']),
            ),
    ],
  );
}

/// What to tell a person about one refused field, in their language.
String fieldProblemMessage(FieldProblem f, [AppLocalizations? l10n]) {
  final l = l10n ?? currentL10n;
  return (f.code == null ? null : problemText(l, f.code!, f.params)) ??
      (f.keyword == null ? null : fieldRuleText(l, f.keyword!, f.params)) ??
      f.message;
}

/// The refused fields a form can show under themselves, by body key; the
/// first problem for a field wins.
Map<String, String> problemFieldMessages(
  Object error, [
  AppLocalizations? l10n,
]) {
  final out = <String, String>{};
  for (final f in problemOf(error)?.errors ?? const <FieldProblem>[]) {
    if (f.key.isEmpty) continue;
    out.putIfAbsent(f.key, () => fieldProblemMessage(f, l10n));
  }
  return out;
}

/// The message to show for a failed call, in the viewer's language: the
/// console's own words for the problem's code where it has them, else the
/// service's `detail` (09 §2). Field problems not shown elsewhere follow as
/// "name: what is wrong"; a form that shows fields itself passes their keys
/// as [shownFields] so they are not repeated here.
String problemMessage(
  Object error, {
  Set<String> shownFields = const {},
  AppLocalizations? l10n,
}) {
  final l = l10n ?? currentL10n;
  if (error is DioException && error.response == null) {
    return l.commonCouldNotReachServer;
  }
  final problem = problemOf(error);
  if (problem == null) return l.commonSomethingWentWrong;
  final text =
      (problem.code == null
          ? null
          : problemText(l, problem.code!, problem.params)) ??
      problem.detail ??
      l.commonServerRejected(problem.status);
  final fields = [
    for (final f in problem.errors)
      if (!shownFields.contains(f.key))
        f.key.isEmpty
            ? fieldProblemMessage(f, l)
            : l.problemFieldLine(_fieldName(f.key), fieldProblemMessage(f, l)),
  ];
  return fields.isEmpty ? text : '$text ${fields.join(' ')}';
}

/// `adminPassword` → "admin password": how a body key reads in a sentence
/// when the screen has no label for it.
String _fieldName(String key) => key
    .replaceAllMapped(RegExp(r'[A-Z]'), (m) => ' ${m[0]!.toLowerCase()}')
    .replaceAll('_', ' ')
    .trim();
