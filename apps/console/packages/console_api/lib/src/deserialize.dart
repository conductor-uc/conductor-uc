import 'package:console_api/src/model/invitation_accept_request.dart';
import 'package:console_api/src/model/invitation_accepted.dart';
import 'package:console_api/src/model/invitation_summary.dart';
import 'package:console_api/src/model/invitation_token_request.dart';
import 'package:console_api/src/model/login_request.dart';
import 'package:console_api/src/model/login_response.dart';
import 'package:console_api/src/model/mfa_enroll_confirm_request.dart';
import 'package:console_api/src/model/mfa_verify_request.dart';
import 'package:console_api/src/model/password_reset_confirm_request.dart';
import 'package:console_api/src/model/password_reset_request.dart';
import 'package:console_api/src/model/public_brand.dart';
import 'package:console_api/src/model/refresh_request.dart';
import 'package:console_api/src/model/tokens.dart';
import 'package:console_api/src/model/totp.dart';

final _regList = RegExp(r'^List<(.*)>$');
final _regSet = RegExp(r'^Set<(.*)>$');
final _regMap = RegExp(r'^Map<String,(.*)>$');

  ReturnType deserialize<ReturnType, BaseType>(dynamic value, String targetType, {bool growable= true}) {
      switch (targetType) {
        case 'String':
          return '$value' as ReturnType;
        case 'int':
          return (value is int ? value : int.parse('$value')) as ReturnType;
        case 'bool':
          if (value is bool) {
            return value as ReturnType;
          }
          final valueString = '$value'.toLowerCase();
          return (valueString == 'true' || valueString == '1') as ReturnType;
        case 'double':
          return (value is double ? value : double.parse('$value')) as ReturnType;
        case 'InvitationAcceptRequest':
          return InvitationAcceptRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'InvitationAccepted':
          return InvitationAccepted.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'InvitationSummary':
          return InvitationSummary.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'InvitationTokenRequest':
          return InvitationTokenRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'LoginRequest':
          return LoginRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'LoginResponse':
          return LoginResponse.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'MfaEnrollConfirmRequest':
          return MfaEnrollConfirmRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'MfaVerifyRequest':
          return MfaVerifyRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'PasswordResetConfirmRequest':
          return PasswordResetConfirmRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'PasswordResetRequest':
          return PasswordResetRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'PublicBrand':
          return PublicBrand.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'RefreshRequest':
          return RefreshRequest.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'Tokens':
          return Tokens.fromJson(value as Map<String, dynamic>) as ReturnType;
        case 'Totp':
          return Totp.fromJson(value as Map<String, dynamic>) as ReturnType;
        default:
          RegExpMatch? match;

          if (value is List && (match = _regList.firstMatch(targetType)) != null) {
            targetType = match![1]!; // ignore: parameter_assignments
            return value
              .map<BaseType>((dynamic v) => deserialize<BaseType, BaseType>(v, targetType, growable: growable))
              .toList(growable: growable) as ReturnType;
          }
          if (value is Set && (match = _regSet.firstMatch(targetType)) != null) {
            targetType = match![1]!; // ignore: parameter_assignments
            return value
              .map<BaseType>((dynamic v) => deserialize<BaseType, BaseType>(v, targetType, growable: growable))
              .toSet() as ReturnType;
          }
          if (value is Map && (match = _regMap.firstMatch(targetType)) != null) {
            targetType = match![1]!.trim(); // ignore: parameter_assignments
            return Map<String, BaseType>.fromIterables(
              value.keys as Iterable<String>,
              value.values.map((dynamic v) => deserialize<BaseType, BaseType>(v, targetType, growable: growable)),
            ) as ReturnType;
          }
          break;
    }
    throw Exception('Cannot deserialize');
  }