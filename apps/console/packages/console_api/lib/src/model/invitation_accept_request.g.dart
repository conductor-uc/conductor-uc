// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_accept_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvitationAcceptRequest _$InvitationAcceptRequestFromJson(
  Map<String, dynamic> json,
) => $checkedCreate('InvitationAcceptRequest', json, ($checkedConvert) {
  $checkKeys(json, requiredKeys: const ['token', 'password']);
  final val = InvitationAcceptRequest(
    token: $checkedConvert('token', (v) => v as String),
    password: $checkedConvert('password', (v) => v as String),
  );
  return val;
});

Map<String, dynamic> _$InvitationAcceptRequestToJson(
  InvitationAcceptRequest instance,
) => <String, dynamic>{'token': instance.token, 'password': instance.password};
