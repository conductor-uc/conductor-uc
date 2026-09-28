final _memory = <String, String>{};

/// The saved value for [key], or null (tests and non-web builds keep it in
/// memory).
String? readLocal(String key) => _memory[key];

/// Saves [value] under [key]; null forgets it.
void writeLocal(String key, String? value) =>
    value == null ? _memory.remove(key) : _memory[key] = value;
