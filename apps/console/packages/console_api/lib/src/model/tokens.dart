//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'tokens.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class Tokens {
  /// Returns a new [Tokens] instance.
  Tokens({

    required  this.accessToken,

     this.refreshToken,

    required  this.expiresIn,
  });

  @JsonKey(
    
    name: r'accessToken',
    required: true,
    includeIfNull: false,
  )


  final String accessToken;



  @JsonKey(
    
    name: r'refreshToken',
    required: false,
    includeIfNull: false,
  )


  final String? refreshToken;



  @JsonKey(
    
    name: r'expiresIn',
    required: true,
    includeIfNull: false,
  )


  final int expiresIn;





    @override
    bool operator ==(Object other) => identical(this, other) || other is Tokens &&
      other.accessToken == accessToken &&
      other.refreshToken == refreshToken &&
      other.expiresIn == expiresIn;

    @override
    int get hashCode =>
        accessToken.hashCode +
        refreshToken.hashCode +
        expiresIn.hashCode;

  factory Tokens.fromJson(Map<String, dynamic> json) => _$TokensFromJson(json);

  Map<String, dynamic> toJson() => _$TokensToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

