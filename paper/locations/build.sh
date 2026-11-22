#!/usr/bin/env bash
# Build against the API shipped with the installed Paper server.
set -euo pipefail
server=${1:?Supply the Paper server directory}
output=${2:?Supply an output jar path}
here=$(cd "$(dirname "$0")" && pwd)
classes=$(mktemp -d)
trap 'rm -rf -- "$classes"' EXIT
classpath=$(find "$server/libraries" -type f -name '*.jar' -print | paste -sd : -)
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" -proc:none -classpath "$classpath" -d "$classes" "$here/JevcraftLocations.java"
cp "$here/plugin.yml" "$classes/"
"${JAVA_HOME:+$JAVA_HOME/bin/}jar" --create --file "$output" -C "$classes" .
