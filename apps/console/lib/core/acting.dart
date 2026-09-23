import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'session.dart';

/// The tenant a master or reseller user has entered ("act as", 08 §3). Every
/// tenant request carries this tenant in its path, so no token swap is needed;
/// the server still decides what the signed-in user may do there.
class ActingTenant {
  const ActingTenant({required this.id, required this.name});

  final String id;
  final String name;
}

class ActingController extends Notifier<ActingTenant?> {
  @override
  ActingTenant? build() {
    // Signing out (or being signed out) ends the visit.
    ref.listen(sessionProvider, (_, session) {
      if (session == null) state = null;
    });
    return null;
  }

  void enter(ActingTenant tenant) => state = tenant;

  void exit() => state = null;
}

final actingProvider = NotifierProvider<ActingController, ActingTenant?>(
  ActingController.new,
);
