#!/bin/sh
# herdr plugin actions call this; it runs plugin/ctl.js with node, or with
# opencode's embedded Bun if node isn't on PATH.
root="${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}"
if command -v node >/dev/null 2>&1; then
  exec node "$root/plugin/ctl.js" "$@"
fi
exec env BUN_BE_BUN=1 "${OPENCODE_BIN:-opencode}" "$root/plugin/ctl.js" "$@"
