// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'tokens.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Tokens _$TokensFromJson(Map<String, dynamic> json) =>
    $checkedCreate('Tokens', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['accessToken', 'expiresIn']);
      final val = Tokens(
        accessToken: $checkedConvert('accessToken', (v) => v as String),
        refreshToken: $checkedConvert('refreshToken', (v) => v as String?),
        expiresIn: $checkedConvert('expiresIn', (v) => (v as num).toInt()),
      );
      return val;
    });

Map<String, dynamic> _$TokensToJson(Tokens instance) => <String, dynamic>{
  'accessToken': instance.accessToken,
  'refreshToken': ?instance.refreshToken,
  'expiresIn': instance.expiresIn,
};
