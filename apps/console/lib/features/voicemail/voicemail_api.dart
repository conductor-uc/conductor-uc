import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config.dart';
import '../pbx/pbx_api.dart';

/// What happens to a message once it has been emailed.
const emailAfterChoices = {
  'keep': 'Keep it as a new message',
  'mark_read': 'Mark it as read',
  'delete': 'Delete it (the email holds the only copy)',
};

/// A mailbox's voicemail-to-email settings (`PUT .../email-settings`).
class EmailSettings {
  const EmailSettings({
    this.notifyEmail,
    this.attachAudio = false,
    this.afterEmail = 'keep',
  });

  factory EmailSettings.fromMailbox(Json mailbox) => EmailSettings(
    notifyEmail: mailbox['notifyEmail'] as String?,
    attachAudio: mailbox['emailAttachAudio'] == true,
    afterEmail: (mailbox['emailAfter'] as String?) ?? 'keep',
  );

  /// Null means no email.
  final String? notifyEmail;
  final bool attachAudio;
  final String afterEmail;

  Json toJson() => {
    'notifyEmail': notifyEmail,
    'attachAudio': attachAudio,
    'afterEmail': afterEmail,
  };
}

/// The voicemail routes under `/v1/tenants/{tenantId}/voicemail/mailboxes`.
/// Everything here is private-class data (07 §3.3): a reseller is refused by
/// the service, and the section is hidden from one in the navigation.
class VoicemailApi {
  VoicemailApi(this._api);

  final PbxApi _api;

  static const _mailboxes = 'voicemail/mailboxes';

  Future<List<Json>> mailboxes() => _api.list(_mailboxes);

  Future<List<Json>> messages(String mailboxId) async {
    final data = await _api.call('GET', _mailboxes, mailboxId, 'messages');
    final rows = (data as Map)['rows'] as List;
    return [for (final r in rows) (r as Map).cast<String, dynamic>()];
  }

  /// A short-lived address the recording can be played from.
  Future<String> playUrl(String mailboxId, String messageId) async {
    final data = await _api.call(
      'GET',
      _mailboxes,
      mailboxId,
      'messages/$messageId/play-url',
    );
    return '${(data as Map)['url']}';
  }

  Future<void> deleteMessage(String mailboxId, String messageId) =>
      _api.call('DELETE', _mailboxes, mailboxId, 'messages/$messageId');

  Future<Json> saveEmailSettings(String mailboxId, EmailSettings settings) =>
      _api
          .call(
            'PUT',
            _mailboxes,
            mailboxId,
            'email-settings',
            body: settings.toJson(),
          )
          .then((data) => (data as Map).cast<String, dynamic>());

  Future<void> resetPin(String mailboxId, String pin) =>
      _api.call('POST', _mailboxes, mailboxId, 'reset-pin', body: {'pin': pin});
}

final voicemailApiProvider = Provider<VoicemailApi?>((ref) {
  final api = ref.watch(pbxApiProvider);
  return api == null ? null : VoicemailApi(api);
});

final mailboxesProvider = FutureProvider<List<Json>>((ref) async {
  final api = ref.watch(voicemailApiProvider);
  return api == null ? const [] : api.mailboxes();
});

final messagesProvider = FutureProvider.family<List<Json>, String>((
  ref,
  mailboxId,
) async {
  final api = ref.watch(voicemailApiProvider);
  return api == null ? const [] : api.messages(mailboxId);
});

/// How a recording is opened for listening; tests replace it. On the web this
/// opens the presigned address in a new tab, where the browser plays it.
final openRecordingProvider = Provider<Future<void> Function(String url)>((
  ref,
) {
  // Demo mode has nothing to open.
  if (demoMode) return (_) async {};
  return (url) async {
    await launchUrl(Uri.parse(url), webOnlyWindowName: '_blank');
  };
});
