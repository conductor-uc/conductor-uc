/// The viewer's own time zone as an IANA name ("America/Chicago"), for
/// defaulting a schedule's time zone to where the person is (S9-09).
library;

export 'time_zone_stub.dart' if (dart.library.js_interop) 'time_zone_web.dart';
