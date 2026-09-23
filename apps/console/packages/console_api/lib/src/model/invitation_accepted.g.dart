// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_accepted.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvitationAccepted _$InvitationAcceptedFromJson(Map<String, dynamic> json) =>
    $checkedCreate('InvitationAccepted', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['email', 'orgId']);
      final val = InvitationAccepted(
        email: $checkedConvert('email', (v) => v as String),
        orgId: $checkedConvert('orgId', (v) => v as String),
      );
      return val;
    });

Map<String, dynamic> _$InvitationAcceptedToJson(InvitationAccepted instance) =>
    <String, dynamic>{'email': instance.email, 'orgId': instance.orgId};
