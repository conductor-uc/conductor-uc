//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'password_reset_confirm_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class PasswordResetConfirmRequest {
  /// Returns a new [PasswordResetConfirmRequest] instance.
  PasswordResetConfirmRequest({

    required  this.token,

    required  this.newPassword,
  });

  @JsonKey(
    
    name: r'token',
    required: true,
    includeIfNull: false,
  )


  final String token;



  @JsonKey(
    
    name: r'newPassword',
    required: true,
    includeIfNull: false,
  )


  final String newPassword;





    @override
    bool operator ==(Object other) => identical(this, other) || other is PasswordResetConfirmRequest &&
      other.token == token &&
      other.newPassword == newPassword;

    @override
    int get hashCode =>
        token.hashCode +
        newPassword.hashCode;

  factory PasswordResetConfirmRequest.fromJson(Map<String, dynamic> json) => _$PasswordResetConfirmRequestFromJson(json);

  Map<String, dynamic> toJson() => _$PasswordResetConfirmRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

