# console_api.api.AuthApi

## Load the API package
```dart
import 'package:console_api/api.dart';
```

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**acceptInvitation**](AuthApi.md#acceptinvitation) | **POST** /v1/auth/invitations/accept | 
[**confirmMfaEnrollment**](AuthApi.md#confirmmfaenrollment) | **POST** /v1/auth/mfa/enroll/confirm | 
[**confirmPasswordReset**](AuthApi.md#confirmpasswordreset) | **POST** /v1/auth/password-reset/confirm | 
[**login**](AuthApi.md#login) | **POST** /v1/auth/login | 
[**logout**](AuthApi.md#logout) | **POST** /v1/auth/logout | 
[**lookupInvitation**](AuthApi.md#lookupinvitation) | **POST** /v1/auth/invitations/lookup | 
[**refreshTokens**](AuthApi.md#refreshtokens) | **POST** /v1/auth/refresh | 
[**requestPasswordReset**](AuthApi.md#requestpasswordreset) | **POST** /v1/auth/password-reset | 
[**verifyMfa**](AuthApi.md#verifymfa) | **POST** /v1/auth/mfa/verify | 


# **acceptInvitation**
> InvitationAccepted acceptInvitation(invitationAcceptRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final InvitationAcceptRequest invitationAcceptRequest = ; // InvitationAcceptRequest | 

try {
    final response = api.acceptInvitation(invitationAcceptRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->acceptInvitation: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **invitationAcceptRequest** | [**InvitationAcceptRequest**](InvitationAcceptRequest.md)|  | 

### Return type

[**InvitationAccepted**](InvitationAccepted.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **confirmMfaEnrollment**
> Tokens confirmMfaEnrollment(mfaEnrollConfirmRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final MfaEnrollConfirmRequest mfaEnrollConfirmRequest = ; // MfaEnrollConfirmRequest | 

try {
    final response = api.confirmMfaEnrollment(mfaEnrollConfirmRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->confirmMfaEnrollment: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **mfaEnrollConfirmRequest** | [**MfaEnrollConfirmRequest**](MfaEnrollConfirmRequest.md)|  | 

### Return type

[**Tokens**](Tokens.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **confirmPasswordReset**
> confirmPasswordReset(passwordResetConfirmRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final PasswordResetConfirmRequest passwordResetConfirmRequest = ; // PasswordResetConfirmRequest | 

try {
    api.confirmPasswordReset(passwordResetConfirmRequest);
} catch on DioException (e) {
    print('Exception when calling AuthApi->confirmPasswordReset: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **passwordResetConfirmRequest** | [**PasswordResetConfirmRequest**](PasswordResetConfirmRequest.md)|  | 

### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **login**
> LoginResponse login(loginRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final LoginRequest loginRequest = ; // LoginRequest | 

try {
    final response = api.login(loginRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->login: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **loginRequest** | [**LoginRequest**](LoginRequest.md)|  | 

### Return type

[**LoginResponse**](LoginResponse.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **logout**
> logout(refreshRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final RefreshRequest refreshRequest = ; // RefreshRequest | 

try {
    api.logout(refreshRequest);
} catch on DioException (e) {
    print('Exception when calling AuthApi->logout: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **refreshRequest** | [**RefreshRequest**](RefreshRequest.md)|  | 

### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **lookupInvitation**
> InvitationSummary lookupInvitation(invitationTokenRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final InvitationTokenRequest invitationTokenRequest = ; // InvitationTokenRequest | 

try {
    final response = api.lookupInvitation(invitationTokenRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->lookupInvitation: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **invitationTokenRequest** | [**InvitationTokenRequest**](InvitationTokenRequest.md)|  | 

### Return type

[**InvitationSummary**](InvitationSummary.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **refreshTokens**
> Tokens refreshTokens(refreshRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final RefreshRequest refreshRequest = ; // RefreshRequest | 

try {
    final response = api.refreshTokens(refreshRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->refreshTokens: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **refreshRequest** | [**RefreshRequest**](RefreshRequest.md)|  | 

### Return type

[**Tokens**](Tokens.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **requestPasswordReset**
> requestPasswordReset(passwordResetRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final PasswordResetRequest passwordResetRequest = ; // PasswordResetRequest | 

try {
    api.requestPasswordReset(passwordResetRequest);
} catch on DioException (e) {
    print('Exception when calling AuthApi->requestPasswordReset: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **passwordResetRequest** | [**PasswordResetRequest**](PasswordResetRequest.md)|  | 

### Return type

void (empty response body)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: Not defined

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **verifyMfa**
> Tokens verifyMfa(mfaVerifyRequest)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getAuthApi();
final MfaVerifyRequest mfaVerifyRequest = ; // MfaVerifyRequest | 

try {
    final response = api.verifyMfa(mfaVerifyRequest);
    print(response);
} catch on DioException (e) {
    print('Exception when calling AuthApi->verifyMfa: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **mfaVerifyRequest** | [**MfaVerifyRequest**](MfaVerifyRequest.md)|  | 

### Return type

[**Tokens**](Tokens.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

