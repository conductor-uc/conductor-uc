// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'password_reset_confirm_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PasswordResetConfirmRequest _$PasswordResetConfirmRequestFromJson(
  Map<String, dynamic> json,
) => $checkedCreate('PasswordResetConfirmRequest', json, ($checkedConvert) {
  $checkKeys(json, requiredKeys: const ['token', 'newPassword']);
  final val = PasswordResetConfirmRequest(
    token: $checkedConvert('token', (v) => v as String),
    newPassword: $checkedConvert('newPassword', (v) => v as String),
  );
  return val;
});

Map<String, dynamic> _$PasswordResetConfirmRequestToJson(
  PasswordResetConfirmRequest instance,
) => <String, dynamic>{
  'token': instance.token,
  'newPassword': instance.newPassword,
};
