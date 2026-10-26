#!/bin/sh
# Builds "Shellhive Preview", a side-by-side copy for testing unreleased work,
# and installs it in /Applications next to the regular app.
set -e
cd "$(dirname "$0")/.."
pnpm tauri build --config src-tauri/tauri.preview.conf.json --features preview --bundles app
APP="src-tauri/target/release/bundle/macos/Shellhive Preview.app"
rm -rf "/Applications/Shellhive Preview.app"
cp -R "$APP" /Applications/
echo "Installed /Applications/Shellhive Preview.app"
