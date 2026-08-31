# Build the host-side mixdog prebake cache (CC-prebaked parity), gzip-packed.
#
# The stock MixdogAgent.install() spends ~110s/trial installing NodeSource
# node + `npm install -g mixdog` inside EVERY container (registry + apt on
# the uplink, n-way concurrent). This script does that install ONCE in a
# throwaway debian container and tars the resulting artifacts
# (node binary + global node_modules + bin links) into
#   mixdog-prebake/mixdog-node-prebake.tar.gz
# which install() then `docker cp`s and extracts in seconds. Task images stay
# untouched — this caches OUR agent's own dependency shell only, exactly like
# the claude-code prebaked binary (cc-bin/).
#
# Re-run whenever the pinned package.json version changes. The src snapshot
# overlay still replaces the whole source tree per run, so the cache only pins
# the dependency shell, not mixdog code.
param(
    [string]$Image = "debian:bookworm-slim",
    [string]$MixdogVersion = "",
    # Optional local `npm pack` artifact for versions not published yet.
    # Registry installation remains the default release-reproduction path.
    [string]$PackageTar = ""
)
$ErrorActionPreference = "Stop"
$packageMount = ""
$packageSpec = ""
if (-not [string]::IsNullOrWhiteSpace($PackageTar)) {
    $resolvedPackageTar = (Resolve-Path -LiteralPath $PackageTar -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolvedPackageTar -PathType Leaf)) {
        throw "PackageTar must be a package archive file: $resolvedPackageTar"
    }
    $packageMount = ($resolvedPackageTar -replace '\\', '/')
    $packageSpec = "/input/mixdog-package.tgz"
}
if ([string]::IsNullOrWhiteSpace($MixdogVersion)) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
    $MixdogVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version)
}
if ([string]::IsNullOrWhiteSpace($MixdogVersion) -or $MixdogVersion -eq "latest") {
    throw "MixdogVersion must be a pinned package version, not latest"
}
if (-not $packageMount) {
    $packageSpec = "mixdog@$MixdogVersion"
}
$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) "mixdog-prebake"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$hostOut = $outDir -replace '\\', '/'
$script = @'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates ripgrep zstd
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Lifecycle scripts are skipped here for one reason only: the embedding prune
# aborts the whole install on linux-x64 when the published tarball ships no
# ONNX payload, and this cache deletes the entire embedding stack a few lines
# below anyway. The OTHER half of that postinstall is not optional — it stages
# the release native assets, including the search server behind the runtime's
# grep/glob tools — so it runs explicitly right after.
npm install -g __PACKAGE_SPEC__ --ignore-scripts
MIXDOG_PKG="$(npm root -g)/mixdog"
INSTALLED_VERSION="$(node -p "require('$MIXDOG_PKG/package.json').version")"
test "$INSTALLED_VERSION" = "__VERSION__"
(cd "$MIXDOG_PKG" && node scripts/prepare-native-assets.mjs)
test -d "$MIXDOG_PKG/native-tools"
# Native spawn is supplied by the local runtime bundle, never by this
# dependency cache. Removing it makes a missing bundle fail closed.
rm -f "$MIXDOG_PKG/native-tools/mixdog-spawn"
node --version
mixdog --help >/dev/null 2>&1 && echo "mixdog ok"
# Bench containers never run local embeddings (memory features are disabled
# by the pristine contract), and the ONNX/transformers stack is ~344MB of the
# ~502MB dependency tree. Prune it from the bench-only shell, then prove the
# session runtime still imports without it (all references are lazy).
rm -rf "$MIXDOG_PKG/node_modules/onnxruntime-node" \
  "$MIXDOG_PKG/node_modules/onnxruntime-web" \
  "$MIXDOG_PKG/node_modules/@huggingface" \
  "$MIXDOG_PKG/node_modules/@img/sharp-wasm32"
# The benchmark runtime executes JavaScript only and never enables Node source
# maps. Type declarations and source-map payloads are 53MB raw and cannot
# affect runtime module resolution; keep licenses and executable JS intact.
find "$MIXDOG_PKG/node_modules" -type f \
  \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) \
  -delete
# Warm the V8 compile cache for the whole import graph while proving the
# runtime still imports. Published deps are immutable across runs, so their
# cache entries stay valid per trial; only overlaid src files recompile.
mkdir -p /opt/mixdog-v8-cache
NODE_COMPILE_CACHE=/opt/mixdog-v8-cache node --input-type=module -e "await import('$MIXDOG_PKG/src/mixdog-session-runtime.mjs'); console.log('runtime import ok after prune')"
(cd "$MIXDOG_PKG" && node --input-type=module -e "await Promise.all([import('@anthropic-ai/sdk'),import('openai'),import('sharp')]); console.log('provider/native imports ok after prune')")
chmod -R a+rwX /opt/mixdog-v8-cache
# Package managers are needed only while building this archive. Runtime source
# overlay locates the installed package through the mixdog executable itself.
rm -rf /usr/lib/node_modules/npm /usr/lib/node_modules/corepack
rm -f /usr/bin/npm /usr/bin/npx /usr/bin/corepack
# Static curl + CA bundle ride the tar so trials never pay the apt leg (the
# apt-get update on curl-less task images was the 18-20s setup critical
# path). Verified executable here before packing; install() only uses it
# when the task image lacks curl/certs.
mkdir -p /opt/static-curl
curl -fsSL -o /opt/static-curl/curl https://github.com/moparisthebest/static-curl/releases/latest/download/curl-amd64
chmod 0755 /opt/static-curl/curl
/opt/static-curl/curl --version | head -n 1
cp /etc/ssl/certs/ca-certificates.crt /opt/static-curl/ca-certificates.crt
# uv 0.9.5 rides the tar too: install() validates it in the extraction command
# and only runs the network-capable provision fallback when either binary is
# missing or has the wrong version.
mkdir -p /root/.local/bin
curl -fsSL https://astral.sh/uv/0.9.5/install.sh -o /tmp/uv-install.sh
UV_INSTALL_DIR=/root/.local/bin sh /tmp/uv-install.sh
rm -f /tmp/uv-install.sh
/root/.local/bin/uv --version | grep -q '0.9.5'
/root/.local/bin/uvx --version | grep -q '0.9.5'
# Bin links are absolute symlinks into /usr/lib/node_modules — tar keeps them.
# gzip: the raw tree is ~670MB; under 8-way concurrent trial setup the
# docker-cp of that tar dominated (75s avg). ~3x smaller upload wins even
# with the in-container gunzip cost.
tar -C / -czf /out/mixdog-node-prebake.tar.gz \
  usr/bin/node usr/bin/mixdog usr/bin/rg usr/lib/node_modules \
  root/.local/bin opt/mixdog-v8-cache opt/static-curl
echo "prebake tar written"
# zstd variant: ~same upload size at -19 but decompresses multi-threaded in
# ~1s where gunzip takes 5-10s under 8-way concurrent trial setup. The zstd
# BINARY ships alongside (apt/glibc task images all carry libzstd via dpkg,
# but not necessarily the CLI); install() prefers this pair and falls back
# to the .tar.gz when either file is missing or the binary refuses to run.
tar -C / -I 'zstd -T0 -19' -cf /out/mixdog-node-prebake.tar.zst \
  usr/bin/node usr/bin/mixdog usr/bin/rg usr/lib/node_modules \
  root/.local/bin opt/mixdog-v8-cache opt/static-curl
cp /usr/bin/zstd /out/zstd-amd64
echo "prebake zst written"
'@ -replace '__VERSION__', $MixdogVersion -replace '__PACKAGE_SPEC__', $packageSpec
# The here-string inherits this file's CRLF endings; bash -lc treats a
# trailing \r as part of the command (exit 127), so normalize to LF.
$script = $script -replace "`r", ""
$dockerArgs = @("run", "--rm", "-v", "${hostOut}:/out")
if ($packageMount) {
    $dockerArgs += @("-v", "${packageMount}:/input/mixdog-package.tgz:ro")
}
$dockerArgs += @($Image, "bash", "-lc", $script)
docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw "prebake build failed (exit $LASTEXITCODE)" }
$tar = Join-Path $outDir "mixdog-node-prebake.tar.gz"
# Version stamp for the pre-run guard in run.ps1. install() verifies the same
# version INSIDE the container, but that costs a full trial wave to discover;
# the stamp lets a run fail in seconds when the cache is stale.
$stamp = [ordered]@{
    schemaVersion = 1
    mixdogVersion = $MixdogVersion
    image = $Image
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
}
$stampPath = Join-Path $outDir "prebake.json"
$stamp | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stampPath -Encoding utf8
"prebake ready: $tar ($([math]::Round((Get-Item $tar).Length/1MB)) MB) version=$MixdogVersion"
