#!/usr/bin/env bash
#
# Says whether a built macOS app will open without a Gatekeeper warning.
#
#   npm run verify:mac-signature
#
# Three separate things have to be true, and they fail differently:
#   - the app is signed with a Developer ID (not ad-hoc, not unsigned)
#   - the signature carries the hardened runtime
#   - Apple has notarised it and the ticket is stapled to the bundle
#
# An ad-hoc build passes the first check in a way that looks fine until you
# read the authority line, which is why that is printed rather than summarised.
set -uo pipefail

APP="${1:-release/mac-arm64/Groundplan.app}"
[ -d "$APP" ] || APP="release/mac/Groundplan.app"

if [ ! -d "$APP" ]; then
  echo "No built app found. Run a dist:mac build first." >&2
  exit 1
fi

echo "Checking $APP"
echo

echo "── Signature ──"
codesign --display --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|flags|Signature" || true
echo

echo "── Hardened runtime ──"
if codesign --display --verbose=2 "$APP" 2>&1 | grep -q "flags=.*runtime"; then
  echo "present"
else
  echo "MISSING — Apple will refuse to notarise this build"
fi
echo

echo "── Notarisation ticket ──"
if xcrun stapler validate "$APP" 2>&1 | grep -q "The validate action worked"; then
  echo "stapled"
else
  echo "NOT stapled — users will see the Gatekeeper warning"
fi
echo

echo "── Gatekeeper verdict ──"
spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true
