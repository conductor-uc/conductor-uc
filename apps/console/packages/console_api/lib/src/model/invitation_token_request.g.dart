// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_token_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvitationTokenRequest _$InvitationTokenRequestFromJson(
  Map<String, dynamic> json,
) => $checkedCreate('InvitationTokenRequest', json, ($checkedConvert) {
  $checkKeys(json, requiredKeys: const ['token']);
  final val = InvitationTokenRequest(
    token: $checkedConvert('token', (v) => v as String),
  );
  return val;
});

Map<String, dynamic> _$InvitationTokenRequestToJson(
  InvitationTokenRequest instance,
) => <String, dynamic>{'token': instance.token};
