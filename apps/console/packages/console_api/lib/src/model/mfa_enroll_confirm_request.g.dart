// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'mfa_enroll_confirm_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

MfaEnrollConfirmRequest _$MfaEnrollConfirmRequestFromJson(
  Map<String, dynamic> json,
) => $checkedCreate('MfaEnrollConfirmRequest', json, ($checkedConvert) {
  $checkKeys(json, requiredKeys: const ['enrollmentTicket', 'code']);
  final val = MfaEnrollConfirmRequest(
    enrollmentTicket: $checkedConvert('enrollmentTicket', (v) => v as String),
    code: $checkedConvert('code', (v) => v as String),
  );
  return val;
});

Map<String, dynamic> _$MfaEnrollConfirmRequestToJson(
  MfaEnrollConfirmRequest instance,
) => <String, dynamic>{
  'enrollmentTicket': instance.enrollmentTicket,
  'code': instance.code,
};
