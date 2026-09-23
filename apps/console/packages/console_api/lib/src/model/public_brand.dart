//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'public_brand.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class PublicBrand {
  /// Returns a new [PublicBrand] instance.
  PublicBrand({

    required  this.neutral,

     this.displayName,

     this.primaryColor,

     this.accentColor,

     this.logoLightUrl,

     this.logoDarkUrl,

     this.faviconUrl,

     this.supportEmail,

     this.supportUrl,

     this.supportPhone,

     this.legalFooter,
  });

  @JsonKey(
    
    name: r'neutral',
    required: true,
    includeIfNull: false,
  )


  final bool neutral;



  @JsonKey(
    
    name: r'displayName',
    required: false,
    includeIfNull: false,
  )


  final String? displayName;



  @JsonKey(
    
    name: r'primaryColor',
    required: false,
    includeIfNull: false,
  )


  final String? primaryColor;



  @JsonKey(
    
    name: r'accentColor',
    required: false,
    includeIfNull: false,
  )


  final String? accentColor;



  @JsonKey(
    
    name: r'logoLightUrl',
    required: false,
    includeIfNull: false,
  )


  final String? logoLightUrl;



  @JsonKey(
    
    name: r'logoDarkUrl',
    required: false,
    includeIfNull: false,
  )


  final String? logoDarkUrl;



  @JsonKey(
    
    name: r'faviconUrl',
    required: false,
    includeIfNull: false,
  )


  final String? faviconUrl;



  @JsonKey(
    
    name: r'supportEmail',
    required: false,
    includeIfNull: false,
  )


  final String? supportEmail;



  @JsonKey(
    
    name: r'supportUrl',
    required: false,
    includeIfNull: false,
  )


  final String? supportUrl;



  @JsonKey(
    
    name: r'supportPhone',
    required: false,
    includeIfNull: false,
  )


  final String? supportPhone;



  @JsonKey(
    
    name: r'legalFooter',
    required: false,
    includeIfNull: false,
  )


  final String? legalFooter;





    @override
    bool operator ==(Object other) => identical(this, other) || other is PublicBrand &&
      other.neutral == neutral &&
      other.displayName == displayName &&
      other.primaryColor == primaryColor &&
      other.accentColor == accentColor &&
      other.logoLightUrl == logoLightUrl &&
      other.logoDarkUrl == logoDarkUrl &&
      other.faviconUrl == faviconUrl &&
      other.supportEmail == supportEmail &&
      other.supportUrl == supportUrl &&
      other.supportPhone == supportPhone &&
      other.legalFooter == legalFooter;

    @override
    int get hashCode =>
        neutral.hashCode +
        (displayName == null ? 0 : displayName.hashCode) +
        (primaryColor == null ? 0 : primaryColor.hashCode) +
        (accentColor == null ? 0 : accentColor.hashCode) +
        (logoLightUrl == null ? 0 : logoLightUrl.hashCode) +
        (logoDarkUrl == null ? 0 : logoDarkUrl.hashCode) +
        (faviconUrl == null ? 0 : faviconUrl.hashCode) +
        (supportEmail == null ? 0 : supportEmail.hashCode) +
        (supportUrl == null ? 0 : supportUrl.hashCode) +
        (supportPhone == null ? 0 : supportPhone.hashCode) +
        (legalFooter == null ? 0 : legalFooter.hashCode);

  factory PublicBrand.fromJson(Map<String, dynamic> json) => _$PublicBrandFromJson(json);

  Map<String, dynamic> toJson() => _$PublicBrandToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

