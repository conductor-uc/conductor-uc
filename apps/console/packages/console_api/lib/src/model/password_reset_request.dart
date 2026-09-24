//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'password_reset_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class PasswordResetRequest {
  /// Returns a new [PasswordResetRequest] instance.
  PasswordResetRequest({

     this.orgId,

    required  this.email,
  });

  @JsonKey(
    
    name: r'orgId',
    required: false,
    includeIfNull: false,
  )


  final String? orgId;



  @JsonKey(
    
    name: r'email',
    required: true,
    includeIfNull: false,
  )


  final String email;





    @override
    bool operator ==(Object other) => identical(this, other) || other is PasswordResetRequest &&
      other.orgId == orgId &&
      other.email == email;

    @override
    int get hashCode =>
        orgId.hashCode +
        email.hashCode;

  factory PasswordResetRequest.fromJson(Map<String, dynamic> json) => _$PasswordResetRequestFromJson(json);

  Map<String, dynamic> toJson() => _$PasswordResetRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

