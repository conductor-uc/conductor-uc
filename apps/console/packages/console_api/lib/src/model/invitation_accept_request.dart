//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'invitation_accept_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class InvitationAcceptRequest {
  /// Returns a new [InvitationAcceptRequest] instance.
  InvitationAcceptRequest({

    required  this.token,

    required  this.password,
  });

  @JsonKey(
    
    name: r'token',
    required: true,
    includeIfNull: false,
  )


  final String token;



  @JsonKey(
    
    name: r'password',
    required: true,
    includeIfNull: false,
  )


  final String password;





    @override
    bool operator ==(Object other) => identical(this, other) || other is InvitationAcceptRequest &&
      other.token == token &&
      other.password == password;

    @override
    int get hashCode =>
        token.hashCode +
        password.hashCode;

  factory InvitationAcceptRequest.fromJson(Map<String, dynamic> json) => _$InvitationAcceptRequestFromJson(json);

  Map<String, dynamic> toJson() => _$InvitationAcceptRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

