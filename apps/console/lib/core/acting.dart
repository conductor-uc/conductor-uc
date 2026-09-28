import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'session.dart';

/// The tenant a master or reseller user has entered ("act as", 08 §3). Every
/// tenant request carries this tenant in its path, so no token swap is needed;
/// the server still decides what the signed-in user may do there.
class ActingTenant {
  const ActingTenant({required this.id, required this.name, this.resellerId});

  final String id;

  /// Empty while it is being looked up after a reload ([ActingController.restore]).
  final String name;

  /// The reseller it belongs to, for switching to a sibling (S9-05); null
  /// until known.
  final String? resellerId;
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

  /// The last `?as=` the address had, as the router saw or wrote it: the
  /// address only decides the visit when it changes from outside the app (a
  /// reload, a pasted link), never over a change made in the app.
  String? _seen;

  /// Called with the address's `?as=` on every navigation (S9-05).
  void followAddress(String? tenantId) {
    if (tenantId == _seen) return;
    _seen = tenantId;
    // An address without one is a page inside the visit: it stays.
    if (tenantId != null && tenantId != state?.id) restore(tenantId);
  }

  /// The router put [tenantId] (or nothing) in the address.
  void addressWritten(String? tenantId) => _seen = tenantId;

  /// Picks the visit back up from the address (`?as=<tenant id>`, S9-05)
  /// after a reload: the tenant's id at once, so the right pages are allowed,
  /// and its name once org-service answers. A tenant the user may not visit
  /// is refused there, and the visit ends.
  void restore(String tenantId) {
    if (state?.id == tenantId) return;
    state = ActingTenant(id: tenantId, name: '');
    final session = ref.read(sessionProvider);
    if (session == null) return;
    ref
        .read(apiProvider)
        .dio
        .get<Object?>(
          '/v1/tenants/$tenantId',
          options: Options(
            headers: {'Authorization': 'Bearer ${session.accessToken}'},
          ),
        )
        .then(
          (response) {
            final body = response.data as Map?;
            final name = body?['name'];
            final reseller = body?['resellerId'];
            if (state?.id == tenantId && name is String) {
              state = ActingTenant(
                id: tenantId,
                name: name,
                resellerId: reseller is String ? reseller : null,
              );
            }
          },
          onError: (Object _) {
            if (state?.id == tenantId) state = null;
          },
        );
  }
}

final actingProvider = NotifierProvider<ActingController, ActingTenant?>(
  ActingController.new,
);
