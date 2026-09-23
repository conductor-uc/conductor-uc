//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'mfa_verify_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class MfaVerifyRequest {
  /// Returns a new [MfaVerifyRequest] instance.
  MfaVerifyRequest({

    required  this.verificationTicket,

    required  this.code,
  });

  @JsonKey(
    
    name: r'verificationTicket',
    required: true,
    includeIfNull: false,
  )


  final String verificationTicket;



  @JsonKey(
    
    name: r'code',
    required: true,
    includeIfNull: false,
  )


  final String code;





    @override
    bool operator ==(Object other) => identical(this, other) || other is MfaVerifyRequest &&
      other.verificationTicket == verificationTicket &&
      other.code == code;

    @override
    int get hashCode =>
        verificationTicket.hashCode +
        code.hashCode;

  factory MfaVerifyRequest.fromJson(Map<String, dynamic> json) => _$MfaVerifyRequestFromJson(json);

  Map<String, dynamic> toJson() => _$MfaVerifyRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

