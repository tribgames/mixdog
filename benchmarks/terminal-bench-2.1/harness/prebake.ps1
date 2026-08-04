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
  root/.local/bin
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
