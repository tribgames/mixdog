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
# Re-run whenever you want to refresh mixdog@latest in the cache. The src
# snapshot overlay still replaces the whole source tree per run, so the cache
# only pins the dependency shell, not mixdog code.
param(
    [string]$Image = "debian:bookworm-slim",
    [string]$MixdogVersion = "latest"
)
$ErrorActionPreference = "Stop"
$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) "mixdog-prebake"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$script = @'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates ripgrep
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g --ignore-scripts mixdog@__VERSION__
node --version
mixdog --help >/dev/null 2>&1 && echo "mixdog ok"
# Bench containers never run local embeddings (memory features are disabled
# by the pristine contract), and the ONNX/transformers stack is ~344MB of the
# ~502MB dependency tree. Prune it from the bench-only shell, then prove the
# session runtime still imports without it (all references are lazy).
MIXDOG_PKG="$(npm root -g)/mixdog"
rm -rf "$MIXDOG_PKG/node_modules/onnxruntime-node" \
  "$MIXDOG_PKG/node_modules/onnxruntime-web" \
  "$MIXDOG_PKG/node_modules/@huggingface"
# Warm the V8 compile cache for the whole import graph while proving the
# runtime still imports. Published deps are immutable across runs, so their
# cache entries stay valid per trial; only overlaid src files recompile.
mkdir -p /opt/mixdog-v8-cache
NODE_COMPILE_CACHE=/opt/mixdog-v8-cache node --input-type=module -e "await import('$MIXDOG_PKG/src/mixdog-session-runtime.mjs'); console.log('runtime import ok after prune')"
chmod -R a+rwX /opt/mixdog-v8-cache
# Static curl + CA bundle ride the tar so trials never pay the apt leg (the
# apt-get update on curl-less task images was the 18-20s setup critical
# path). Verified executable here before packing; install() only uses it
# when the task image lacks curl/certs.
mkdir -p /opt/static-curl
curl -fsSL -o /opt/static-curl/curl https://github.com/moparisthebest/static-curl/releases/latest/download/curl-amd64
chmod 0755 /opt/static-curl/curl
/opt/static-curl/curl --version | head -n 1
cp /etc/ssl/certs/ca-certificates.crt /opt/static-curl/ca-certificates.crt
# uv 0.9.5 rides the tar too: install() re-runs the uv provision command in
# every trial, and its "already available" fast path turns the per-trial
# network bootstrap (astral.sh download, 5-15s + flake risk) into a ~1s no-op.
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
  usr/bin/node usr/bin/npm usr/bin/npx usr/bin/mixdog usr/bin/rg usr/lib/node_modules \
  root/.local/bin opt/mixdog-v8-cache opt/static-curl
echo "prebake tar written"
'@ -replace '__VERSION__', $MixdogVersion
# The here-string inherits this file's CRLF endings; bash -lc treats a
# trailing \r as part of the command (exit 127), so normalize to LF.
$script = $script -replace "`r", ""
$hostOut = $outDir -replace '\\', '/'
docker run --rm -v "${hostOut}:/out" $Image bash -lc $script
if ($LASTEXITCODE -ne 0) { throw "prebake build failed (exit $LASTEXITCODE)" }
$tar = Join-Path $outDir "mixdog-node-prebake.tar.gz"
"prebake ready: $tar ($([math]::Round((Get-Item $tar).Length/1MB)) MB)"
