# Windows counterpart of ctl.sh: herdr plugin actions call this; it runs
# plugin/ctl.js with node, or with opencode's embedded Bun if node isn't on PATH.
$root = if ($env:HERDR_PLUGIN_ROOT) { $env:HERDR_PLUGIN_ROOT } else { Join-Path $PSScriptRoot '..' }
$ctl = Join-Path $root 'plugin\ctl.js'
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node $ctl @args
} else {
  $opencode = if ($env:OPENCODE_BIN) { $env:OPENCODE_BIN } else { 'opencode' }
  $env:BUN_BE_BUN = '1'
  & $opencode $ctl @args
}
exit $LASTEXITCODE
