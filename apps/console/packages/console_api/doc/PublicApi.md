# console_api.api.PublicApi

## Load the API package
```dart
import 'package:console_api/api.dart';
```

All URIs are relative to *http://localhost*

Method | HTTP request | Description
------------- | ------------- | -------------
[**getPublicBrand**](PublicApi.md#getpublicbrand) | **GET** /v1/public/brand | 


# **getPublicBrand**
> PublicBrand getPublicBrand(host)



### Example
```dart
import 'package:console_api/api.dart';

final api = ConsoleApi().getPublicApi();
final String host = host_example; // String | 

try {
    final response = api.getPublicBrand(host);
    print(response);
} catch on DioException (e) {
    print('Exception when calling PublicApi->getPublicBrand: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **host** | **String**|  | 

### Return type

[**PublicBrand**](PublicBrand.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

