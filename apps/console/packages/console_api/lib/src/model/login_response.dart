//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:console_api/src/model/totp.dart';
import 'package:json_annotation/json_annotation.dart';

part 'login_response.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class LoginResponse {
  /// Returns a new [LoginResponse] instance.
  LoginResponse({

    required  this.status,

     this.accessToken,

     this.refreshToken,

     this.expiresIn,

     this.enrollmentTicket,

     this.verificationTicket,

     this.totp,
  });

  @JsonKey(
    
    name: r'status',
    required: true,
    includeIfNull: false,
  )


  final LoginResponseStatusEnum status;



  @JsonKey(
    
    name: r'accessToken',
    required: false,
    includeIfNull: false,
  )


  final String? accessToken;



  @JsonKey(
    
    name: r'refreshToken',
    required: false,
    includeIfNull: false,
  )


  final String? refreshToken;



  @JsonKey(
    
    name: r'expiresIn',
    required: false,
    includeIfNull: false,
  )


  final int? expiresIn;



  @JsonKey(
    
    name: r'enrollmentTicket',
    required: false,
    includeIfNull: false,
  )


  final String? enrollmentTicket;



  @JsonKey(
    
    name: r'verificationTicket',
    required: false,
    includeIfNull: false,
  )


  final String? verificationTicket;



  @JsonKey(
    
    name: r'totp',
    required: false,
    includeIfNull: false,
  )


  final Totp? totp;





    @override
    bool operator ==(Object other) => identical(this, other) || other is LoginResponse &&
      other.status == status &&
      other.accessToken == accessToken &&
      other.refreshToken == refreshToken &&
      other.expiresIn == expiresIn &&
      other.enrollmentTicket == enrollmentTicket &&
      other.verificationTicket == verificationTicket &&
      other.totp == totp;

    @override
    int get hashCode =>
        status.hashCode +
        accessToken.hashCode +
        refreshToken.hashCode +
        expiresIn.hashCode +
        enrollmentTicket.hashCode +
        verificationTicket.hashCode +
        totp.hashCode;

  factory LoginResponse.fromJson(Map<String, dynamic> json) => _$LoginResponseFromJson(json);

  Map<String, dynamic> toJson() => _$LoginResponseToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}


enum LoginResponseStatusEnum {
@JsonValue(r'ok')
ok(r'ok'),
@JsonValue(r'mfa_enrollment_required')
mfaEnrollmentRequired(r'mfa_enrollment_required'),
@JsonValue(r'mfa_verification_required')
mfaVerificationRequired(r'mfa_verification_required');

const LoginResponseStatusEnum(this.value);

final String value;

@override
String toString() => value;
}


