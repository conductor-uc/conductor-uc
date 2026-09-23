//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'invitation_accepted.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class InvitationAccepted {
  /// Returns a new [InvitationAccepted] instance.
  InvitationAccepted({

    required  this.email,

    required  this.orgId,
  });

  @JsonKey(
    
    name: r'email',
    required: true,
    includeIfNull: false,
  )


  final String email;



  @JsonKey(
    
    name: r'orgId',
    required: true,
    includeIfNull: false,
  )


  final String orgId;





    @override
    bool operator ==(Object other) => identical(this, other) || other is InvitationAccepted &&
      other.email == email &&
      other.orgId == orgId;

    @override
    int get hashCode =>
        email.hashCode +
        orgId.hashCode;

  factory InvitationAccepted.fromJson(Map<String, dynamic> json) => _$InvitationAcceptedFromJson(json);

  Map<String, dynamic> toJson() => _$InvitationAcceptedToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

