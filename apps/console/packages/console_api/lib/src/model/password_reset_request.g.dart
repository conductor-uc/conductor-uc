// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'password_reset_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PasswordResetRequest _$PasswordResetRequestFromJson(
  Map<String, dynamic> json,
) => $checkedCreate('PasswordResetRequest', json, ($checkedConvert) {
  $checkKeys(json, requiredKeys: const ['email']);
  final val = PasswordResetRequest(
    orgId: $checkedConvert('orgId', (v) => v as String?),
    email: $checkedConvert('email', (v) => v as String),
  );
  return val;
});

Map<String, dynamic> _$PasswordResetRequestToJson(
  PasswordResetRequest instance,
) => <String, dynamic>{'orgId': ?instance.orgId, 'email': instance.email};
