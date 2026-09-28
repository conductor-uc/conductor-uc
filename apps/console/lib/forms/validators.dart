import '../l10n/l10n.dart';

/// Checks and normalizes what people type into forms (S9-04): phone numbers
/// written the way people write them, MAC addresses with or without
/// separators, email addresses. Each returns the value to send, or explains
/// what is wrong in the viewer's language.

/// Countries that dial within the North American Numbering Plan (+1), where a
/// ten-digit number is written without its country code.
const _nanp = {'US', 'CA', 'PR', 'GU', 'VI', 'AS', 'MP'};

/// The outcome of reading a typed value: the value to send, or the problem.
class Parsed<T> {
  const Parsed.ok(T this.value) : error = null;
  const Parsed.error(String this.error) : value = null;

  final T? value;
  final String? error;
  bool get ok => error == null;
}

/// Reads a phone number as a person writes it and returns it in E.164
/// (`+14155550100`), the form every service stores. "(415) 555-0100",
/// "415.555.0100" and "1 415 555 0100" all work in a [country] that dials
/// +1; elsewhere, or for a number abroad, the country code is needed:
/// "+44 20 7946 0958".
Parsed<String> parsePhone(String input, {String country = 'US'}) {
  final l = currentL10n;
  final text = input.trim();
  if (text.isEmpty) return Parsed.error(l.fieldRequired);
  if (!RegExp(r'^[+\d\s().\-/]+$').hasMatch(text)) {
    return Parsed.error(l.formPhoneInvalid);
  }
  final digits = text.replaceAll(RegExp(r'\D'), '');
  String e164;
  if (text.startsWith('+')) {
    e164 = '+$digits';
  } else if (text.startsWith('00')) {
    e164 = '+${digits.substring(2)}';
  } else if (_nanp.contains(country.toUpperCase()) && digits.length == 10) {
    e164 = '+1$digits';
  } else if (_nanp.contains(country.toUpperCase()) &&
      digits.length == 11 &&
      digits.startsWith('1')) {
    e164 = '+$digits';
  } else {
    return Parsed.error(l.formPhoneNeedsCountry);
  }
  if (!RegExp(r'^\+[1-9]\d{6,14}$').hasMatch(e164)) {
    return Parsed.error(l.formPhoneInvalid);
  }
  // A +1 number has ten digits after the country code, and its area code
  // and exchange never start with 0 or 1.
  if (e164.startsWith('+1') &&
      !RegExp(r'^\+1[2-9]\d{2}[2-9]\d{6}$').hasMatch(e164)) {
    return Parsed.error(l.formPhoneInvalid);
  }
  return Parsed.ok(e164);
}

/// How a stored E.164 number reads to someone in [country]: "(415) 555-0100"
/// for a +1 number in a +1 country, otherwise the number as stored.
String formatPhone(String? e164, {String country = 'US'}) {
  if (e164 == null || e164.isEmpty) return '';
  final m = RegExp(r'^\+1(\d{3})(\d{3})(\d{4})$').firstMatch(e164);
  if (m != null && _nanp.contains(country.toUpperCase())) {
    return '(${m[1]}) ${m[2]}-${m[3]}';
  }
  return e164;
}

/// A MAC address as printed on a phone's label: 12 hex digits, with or
/// without `:`, `-` or `.` between them. Returned as typed (the service
/// normalizes it), once it is known to be one.
Parsed<String> parseMac(String input) {
  final stripped = input.trim().replaceAll(RegExp(r'[:.\-\s]'), '');
  return RegExp(r'^[0-9a-fA-F]{12}$').hasMatch(stripped)
      ? Parsed.ok(input.trim())
      : Parsed.error(currentL10n.formMacInvalid);
}

/// One email address.
Parsed<String> parseEmail(String input) {
  final text = input.trim();
  return RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(text)
      ? Parsed.ok(text)
      : Parsed.error(currentL10n.fieldFormatEmail);
}

/// Digits only (a PIN, an extension number), [min] to [max] of them.
Parsed<String> parseDigits(String input, {int min = 1, int max = 32}) {
  final text = input.trim();
  if (!RegExp(r'^\d+$').hasMatch(text)) {
    return Parsed.error(currentL10n.formDigitsOnly);
  }
  if (text.length < min || text.length > max) {
    return Parsed.error(currentL10n.formDigitsLength(min, max));
  }
  return Parsed.ok(text);
}
