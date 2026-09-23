// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'public_brand.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PublicBrand _$PublicBrandFromJson(Map<String, dynamic> json) =>
    $checkedCreate('PublicBrand', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['neutral']);
      final val = PublicBrand(
        neutral: $checkedConvert('neutral', (v) => v as bool),
        displayName: $checkedConvert('displayName', (v) => v as String?),
        primaryColor: $checkedConvert('primaryColor', (v) => v as String?),
        accentColor: $checkedConvert('accentColor', (v) => v as String?),
        logoLightUrl: $checkedConvert('logoLightUrl', (v) => v as String?),
        logoDarkUrl: $checkedConvert('logoDarkUrl', (v) => v as String?),
        faviconUrl: $checkedConvert('faviconUrl', (v) => v as String?),
        supportEmail: $checkedConvert('supportEmail', (v) => v as String?),
        supportUrl: $checkedConvert('supportUrl', (v) => v as String?),
        supportPhone: $checkedConvert('supportPhone', (v) => v as String?),
        legalFooter: $checkedConvert('legalFooter', (v) => v as String?),
      );
      return val;
    });

Map<String, dynamic> _$PublicBrandToJson(PublicBrand instance) =>
    <String, dynamic>{
      'neutral': instance.neutral,
      'displayName': ?instance.displayName,
      'primaryColor': ?instance.primaryColor,
      'accentColor': ?instance.accentColor,
      'logoLightUrl': ?instance.logoLightUrl,
      'logoDarkUrl': ?instance.logoDarkUrl,
      'faviconUrl': ?instance.faviconUrl,
      'supportEmail': ?instance.supportEmail,
      'supportUrl': ?instance.supportUrl,
      'supportPhone': ?instance.supportPhone,
      'legalFooter': ?instance.legalFooter,
    };
