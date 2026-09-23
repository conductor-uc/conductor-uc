//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:json_annotation/json_annotation.dart';

part 'invitation_summary.g.dart';


@JsonSerializable(
  checked: true,
  createToJson: true,
  disallowUnrecognizedKeys: false,
  explicitToJson: true,
)
class InvitationSummary {
  /// Returns a new [InvitationSummary] instance.
  InvitationSummary({

    required  this.email,

    required  this.displayName,
  });

  @JsonKey(
    
    name: r'email',
    required: true,
    includeIfNull: false,
  )


  final String email;



  @JsonKey(
    
    name: r'displayName',
    required: true,
    includeIfNull: false,
  )


  final String displayName;





    @override
    bool operator ==(Object other) => identical(this, other) || other is InvitationSummary &&
      other.email == email &&
      other.displayName == displayName;

    @override
    int get hashCode =>
        email.hashCode +
        displayName.hashCode;

  factory InvitationSummary.fromJson(Map<String, dynamic> json) => _$InvitationSummaryFromJson(json);

  Map<String, dynamic> toJson() => _$InvitationSummaryToJson(this);

  @override
  String toString() {
    return toJson().toString();
  }

}

