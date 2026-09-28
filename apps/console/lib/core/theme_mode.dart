import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'local_store.dart';

const _key = 'console.theme';

/// Light, dark, or as the device is set (S9-17), chosen from the account menu
/// and remembered in this browser, like the language.
class ThemeModeController extends Notifier<ThemeMode> {
  @override
  ThemeMode build() => switch (readLocal(_key)) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };

  void choose(ThemeMode mode) {
    state = mode;
    writeLocal(_key, mode == ThemeMode.system ? null : mode.name);
  }
}

final themeModeProvider = NotifierProvider<ThemeModeController, ThemeMode>(
  ThemeModeController.new,
);
