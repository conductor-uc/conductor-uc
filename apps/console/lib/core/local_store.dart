/// A few small preferences kept in this browser (the language chosen): read
/// and write, never throwing, so a browser that blocks storage just forgets.
library;

export 'local_store_stub.dart'
    if (dart.library.js_interop) 'local_store_web.dart';
