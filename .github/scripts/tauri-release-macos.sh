#!/usr/bin/env bash
set -euo pipefail

# tauri-action calls this wrapper before it publishes any release assets.
if [[ $# -ne 3 || "$1" != build || "$2" != --bundles || "$3" != app,dmg ]]; then
  echo 'This wrapper requires: build --bundles app,dmg' >&2
  exit 1
fi

for required in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH; do
  if [[ -z "${!required:-}" ]]; then
    echo "Missing required macOS signing or notarization setting: ${required}" >&2
    exit 1
  fi
done
if [[ ! -s "$APPLE_API_KEY_PATH" ]]; then
  echo 'The notarization key file is missing or empty.' >&2
  exit 1
fi

# Override the repository's ad-hoc signing only for the release build.
release_config='{"bundle":{"macOS":{"signingIdentity":"Developer ID Application: Kuma Base LLC (DL65SFF95N)"}}}'
npm run tauri -- "$@" --config "$release_config"

app='src-tauri/target/release/bundle/macos/kuf.app'
dmg_dir='src-tauri/target/release/bundle/dmg'
shopt -s nullglob
dmgs=("$dmg_dir"/*.dmg)
if [[ ! -d "$app" || ${#dmgs[@]} -ne 1 ]]; then
  echo 'Expected one macOS app and one DMG.' >&2
  exit 1
fi

verify_identity() {
  local target="$1" details
  codesign --verify --deep --strict --verbose=2 \
    -R='anchor apple generic and certificate leaf[subject.OU] = "DL65SFF95N" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' \
    "$target"
  details=$(codesign -dv --verbose=4 "$target" 2>&1)
  grep -Fx 'Authority=Developer ID Application: Kuma Base LLC (DL65SFF95N)' <<< "$details" >/dev/null
  grep -Fx 'TeamIdentifier=DL65SFF95N' <<< "$details" >/dev/null
  grep -q '^Timestamp=' <<< "$details"
}

verify_app() {
  local target="$1" details
  verify_identity "$target"
  details=$(codesign -dv --verbose=4 "$target" 2>&1)
  grep -Eq '^CodeDirectory .*flags=.*\(runtime\)' <<< "$details"
  xcrun stapler validate "$target"
  spctl --assess --type execute --verbose=2 "$target"
}

verify_app "$app"
verify_identity "${dmgs[0]}"

# Verify the app that will actually ship inside the disk image.
mount_dir=$(mktemp -d "${RUNNER_TEMP:?}/kuf-dmg.XXXXXX")
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach -quiet "$mount_dir" || true
  fi
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -quiet -mountpoint "$mount_dir" "${dmgs[0]}"
mounted=true
verify_app "$mount_dir/kuf.app"
