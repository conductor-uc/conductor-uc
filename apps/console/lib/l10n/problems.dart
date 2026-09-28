import 'app_localizations.dart';

/// The console's words for a problem [code] a service sent (S9-02, D-018), or
/// null when it has none yet and the service's English `detail` is shown.
///
/// Every code here must exist in `api/problem-codes.json`, which is dumped
/// from the services (`test/problem_codes_test.dart` checks it). Screens add
/// the codes they meet as they move onto the ARB.
String? problemText(
  AppLocalizations l,
  String code,
  Map<String, Object?> params,
) => switch (code) {
  'validation_failed' => l.problemValidationFailed,
  'route_not_found' => l.problemRouteNotFound,
  'internal_error' => l.problemInternalError,
  'sign_in_required' => l.problemSignInRequired,
  'permission_check_unavailable' => l.problemPermissionCheckUnavailable,
  'step_up_required' => l.problemStepUpRequired,
  'step_up_invalid' => l.problemStepUpInvalid,
  'step_up_locked' => l.problemStepUpLocked,
  'step_up_not_enrolled' => l.problemStepUpNotEnrolled,
  'org_required' => l.problemOrgRequired,
  'cannot_reset_self' => l.problemCannotResetSelf,
  'mfa_not_enrolled' => l.problemMfaNotEnrolled,
  'authentication_required' => l.problemAuthenticationRequired,
  'access_token_invalid' => l.problemAccessTokenInvalid,
  'upstream_unavailable' => l.problemUpstreamUnavailable,
  'insufficient_permission' => l.problemInsufficientPermission,
  'platform_operator_only' ||
  'platform_master_only' => l.problemPlatformOperatorOnly,
  'extension_number_taken' => l.problemExtensionNumberTaken(
    '${params['number'] ?? ''}',
  ),
  'extension_user_taken' => l.problemExtensionUserTaken,
  'did_number_taken' => l.problemDidNumberTaken,
  'device_mac_taken' => l.problemDeviceMacTaken,
  'conference_room_number_taken' => l.problemConferenceRoomNumberTaken(
    '${params['number'] ?? ''}',
  ),
  'parking_lot_slots_overlap' => l.problemParkingLotSlotsOverlap,
  'extension_already_agent' => l.problemExtensionAlreadyAgent,
  'agent_already_tiered' => l.problemAgentAlreadyTiered,
  'role_name_taken' => l.problemRoleNameTaken('${params['name'] ?? ''}'),
  'email_taken' => l.problemEmailTaken,
  'flow_in_use' => l.problemFlowInUse(
    [...?(params['usedBy'] as List?)].join(', '),
  ),
  _ => null,
};

/// The console's words for a JSON Schema rule a field broke ([keyword] with
/// its [params], as `@cuc/http` passes on from the validator), or null.
String? fieldRuleText(
  AppLocalizations l,
  String keyword,
  Map<String, Object?> params,
) {
  String limit() => '${params['limit'] ?? ''}';
  int count() => (params['limit'] as num?)?.toInt() ?? 0;
  return switch (keyword) {
    'required' => l.fieldRequired,
    'minLength' => count() <= 1 ? l.fieldRequired : l.fieldMinLength(count()),
    'maxLength' => l.fieldMaxLength(count()),
    'minimum' => l.fieldMinimum(limit()),
    'maximum' => l.fieldMaximum(limit()),
    'exclusiveMinimum' => l.fieldExclusiveMinimum(limit()),
    'exclusiveMaximum' => l.fieldExclusiveMaximum(limit()),
    'multipleOf' => l.fieldMultipleOf('${params['multipleOf'] ?? ''}'),
    'pattern' => l.fieldPattern,
    'format' => switch (params['format']) {
      'email' => l.fieldFormatEmail,
      'uri' || 'url' => l.fieldFormatUrl,
      'hostname' => l.fieldFormatHostname,
      'ipv4' => l.fieldFormatIpv4,
      'ipv6' => l.fieldFormatIpv6,
      'date' => l.fieldFormatDate,
      'time' => l.fieldFormatTime,
      'date-time' => l.fieldFormatDateTime,
      _ => l.fieldPattern,
    },
    'enum' || 'const' || 'anyOf' || 'oneOf' => l.fieldOneOf,
    'type' => l.fieldType('${params['type'] ?? ''}'),
    'minItems' => l.fieldMinItems(count()),
    'maxItems' => l.fieldMaxItems(count()),
    'uniqueItems' => l.fieldUniqueItems,
    'additionalProperties' => l.fieldUnknown,
    _ => null,
  };
}
