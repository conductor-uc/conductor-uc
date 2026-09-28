import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';

import 'app_localizations.dart';

export 'app_localizations.dart';

/// `context.l10n.navUsers`: the strings of the locale the app is showing
/// (S9-01, D-018). Every user-facing string comes from here; none are
/// written into widgets.
extension L10nContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
}

Locale _current = const Locale('en');

/// The strings of the locale the app is showing, for code that has no
/// [BuildContext]: formatters, and messages built from a failed request.
/// Widgets use `context.l10n`.
AppLocalizations get currentL10n => lookupAppLocalizations(_current);

/// Called by the app when its locale is resolved, so [currentL10n] and
/// `intl`'s formatters follow it.
void setCurrentLocale(Locale locale) {
  _current = locale;
  Intl.defaultLocale = locale.toLanguageTag();
}
