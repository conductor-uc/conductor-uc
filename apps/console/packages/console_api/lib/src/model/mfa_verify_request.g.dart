// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'mfa_verify_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

MfaVerifyRequest _$MfaVerifyRequestFromJson(Map<String, dynamic> json) =>
    $checkedCreate('MfaVerifyRequest', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['verificationTicket', 'code']);
      final val = MfaVerifyRequest(
        verificationTicket: $checkedConvert(
          'verificationTicket',
          (v) => v as String,
        ),
        code: $checkedConvert('code', (v) => v as String),
      );
      return val;
    });

Map<String, dynamic> _$MfaVerifyRequestToJson(MfaVerifyRequest instance) =>
    <String, dynamic>{
      'verificationTicket': instance.verificationTicket,
      'code': instance.code,
    };
