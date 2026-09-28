import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n.dart';
import 'local_store.dart';

const _key = 'console.locale';

/// The language the person chose from the account menu (S9-05), remembered
/// in this browser; null follows the browser's own. Only languages the
/// console has strings for are offered (English until translations arrive).
class LocaleController extends Notifier<Locale?> {
  @override
  Locale? build() {
    final saved = readLocal(_key);
    if (saved == null) return null;
    final match = AppLocalizations.supportedLocales.where(
      (l) => l.toLanguageTag() == saved,
    );
    return match.isEmpty ? null : match.first;
  }

  void choose(Locale? locale) {
    state = locale;
    writeLocal(_key, locale?.toLanguageTag());
  }
}

final localeProvider = NotifierProvider<LocaleController, Locale?>(
  LocaleController.new,
);
