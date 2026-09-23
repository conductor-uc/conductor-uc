// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'login_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LoginResponse _$LoginResponseFromJson(Map<String, dynamic> json) =>
    $checkedCreate('LoginResponse', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['status']);
      final val = LoginResponse(
        status: $checkedConvert(
          'status',
          (v) => $enumDecode(_$LoginResponseStatusEnumEnumMap, v),
        ),
        accessToken: $checkedConvert('accessToken', (v) => v as String?),
        refreshToken: $checkedConvert('refreshToken', (v) => v as String?),
        expiresIn: $checkedConvert('expiresIn', (v) => (v as num?)?.toInt()),
        enrollmentTicket: $checkedConvert(
          'enrollmentTicket',
          (v) => v as String?,
        ),
        verificationTicket: $checkedConvert(
          'verificationTicket',
          (v) => v as String?,
        ),
        totp: $checkedConvert(
          'totp',
          (v) => v == null ? null : Totp.fromJson(v as Map<String, dynamic>),
        ),
      );
      return val;
    });

Map<String, dynamic> _$LoginResponseToJson(LoginResponse instance) =>
    <String, dynamic>{
      'status': _$LoginResponseStatusEnumEnumMap[instance.status]!,
      'accessToken': ?instance.accessToken,
      'refreshToken': ?instance.refreshToken,
      'expiresIn': ?instance.expiresIn,
      'enrollmentTicket': ?instance.enrollmentTicket,
      'verificationTicket': ?instance.verificationTicket,
      'totp': ?instance.totp?.toJson(),
    };

const _$LoginResponseStatusEnumEnumMap = {
  LoginResponseStatusEnum.ok: 'ok',
  LoginResponseStatusEnum.mfaEnrollmentRequired: 'mfa_enrollment_required',
  LoginResponseStatusEnum.mfaVerificationRequired: 'mfa_verification_required',
};
