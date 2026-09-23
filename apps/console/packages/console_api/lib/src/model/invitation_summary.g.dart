// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invitation_summary.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvitationSummary _$InvitationSummaryFromJson(Map<String, dynamic> json) =>
    $checkedCreate('InvitationSummary', json, ($checkedConvert) {
      $checkKeys(json, requiredKeys: const ['email', 'displayName']);
      final val = InvitationSummary(
        email: $checkedConvert('email', (v) => v as String),
        displayName: $checkedConvert('displayName', (v) => v as String),
      );
      return val;
    });

Map<String, dynamic> _$InvitationSummaryToJson(InvitationSummary instance) =>
    <String, dynamic>{
      'email': instance.email,
      'displayName': instance.displayName,
    };
