//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'invitation_token_request.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class InvitationTokenRequest {
  /// Returns a new [InvitationTokenRequest] instance.
  InvitationTokenRequest({

    required  this.token,
  });

  @JsonKey(
    
    name: r'token',
    required: true,
    includeIfNull: false,
  )


  final String token;





    @override
    bool operator ==(Object other) => identical(this, other) || other is InvitationTokenRequest &&
      other.token == token;

    @override
    int get hashCode =>
        token.hashCode;

  factory InvitationTokenRequest.fromJson(Map<String, dynamic> json) => _$InvitationTokenRequestFromJson(json);

  Map<String, dynamic> toJson() => _$InvitationTokenRequestToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

