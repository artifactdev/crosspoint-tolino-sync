#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
# An explicit allow-list keeps imported credentials out of release archives.
cd plugins
zip -q - tolino-sync/manifest.json tolino-sync/device.json tolino-sync/plugin.js tolino-sync/README.md \
  > ../dist/tolino-sync-0.1.0.zip
