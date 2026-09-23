//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'mfa_enroll_confirm_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class MfaEnrollConfirmRequest {
  /// Returns a new [MfaEnrollConfirmRequest] instance.
  MfaEnrollConfirmRequest({

    required  this.enrollmentTicket,

    required  this.code,
  });

  @JsonKey(
    
    name: r'enrollmentTicket',
    required: true,
    includeIfNull: false,
  )


  final String enrollmentTicket;



  @JsonKey(
    
    name: r'code',
    required: true,
    includeIfNull: false,
  )


  final String code;





    @override
    bool operator ==(Object other) => identical(this, other) || other is MfaEnrollConfirmRequest &&
      other.enrollmentTicket == enrollmentTicket &&
      other.code == code;

    @override
    int get hashCode =>
        enrollmentTicket.hashCode +
        code.hashCode;

  factory MfaEnrollConfirmRequest.fromJson(Map<String, dynamic> json) => _$MfaEnrollConfirmRequestFromJson(json);

  Map<String, dynamic> toJson() => _$MfaEnrollConfirmRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

