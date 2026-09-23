#!/usr/bin/env bash
# Regenerates packages/console_api from api/openapi.yaml (08 §1).
# Needs Java 17+ and the openapi-generator CLI jar (OPENAPI_GENERATOR_JAR,
# default ~/openapi-generator-cli.jar; CI downloads a pinned one).
set -euo pipefail
cd "$(dirname "$0")/.."

jar="${OPENAPI_GENERATOR_JAR:-$HOME/openapi-generator-cli.jar}"
rm -rf packages/console_api
java -jar "$jar" generate \
  -i api/openapi.yaml \
  -g dart-dio \
  -o packages/console_api \
  --additional-properties=pubName=console_api,pubVersion=0.1.0,pubDescription="Generated API client",serializationLibrary=json_serializable \
  --skip-validate-spec
# The template's SDK floor predates the null-aware elements it emits.
sed -i "s|json_annotation: '^4.9.0'|json_annotation: '^4.12.0'|" packages/console_api/pubspec.yaml
sed -i "s|sdk: '>=3.5.0 <4.0.0'|sdk: '>=3.8.0 <4.0.0'|" packages/console_api/pubspec.yaml
(cd packages/console_api && dart pub get && dart run build_runner build --delete-conflicting-outputs)
