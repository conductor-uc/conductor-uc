// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'totp.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Totp _$TotpFromJson(Map<String, dynamic> json) =>
    $checkedCreate('Totp', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['secret', 'otpauthUri']);
      final val = Totp(
        secret: $checkedConvert('secret', (v) => v as String),
        otpauthUri: $checkedConvert('otpauthUri', (v) => v as String),
      );
      return val;
    });

Map<String, dynamic> _$TotpToJson(Totp instance) => <String, dynamic>{
  'secret': instance.secret,
  'otpauthUri': instance.otpauthUri,
};
