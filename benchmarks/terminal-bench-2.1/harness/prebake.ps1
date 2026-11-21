# Build the host-side mixdog prebake cache (CC-prebaked parity) from the Rust core.
#
# Without it MixdogAgent.install() installs ripgrep and curl, provisions uv and
# unpacks the staged core bundle inside EVERY container. This script does that
# ONCE in a throwaway debian container and tars the result into
#   mixdog-prebake/mixdog-core-prebake.tar.gz (+ .tar.zst and zstd-amd64)
# which install() then `docker cp`s and extracts in seconds. The core is the
# staged server bundle (apps/desktop/scripts/stage-core.mjs:
# <runtime>/server-cores/linux-x64/bundle.tgz: mixdogd and its JS runtime),
# which prebake-rust.ps1 checks against the server manifest's digest and the
# pinned version and leaves as mixdog-prebake/mixdogd-linux-x64.tgz, the
# bundle install() unpacks itself when there is no prebake. Task images stay
# untouched — this caches OUR agent's own core and dependencies only, exactly
# like the claude-code prebaked binary (cc-bin/).
#
# Re-run whenever the staged core or the pinned package.json version changes.
param(
    [Parameter(Mandatory = $true)][string]$ServerCores,
    [string]$Image = "debian:bookworm-slim",
    [string]$MixdogVersion = ""
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($MixdogVersion)) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
    $MixdogVersion = [string]((Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version)
}
if ([string]::IsNullOrWhiteSpace($MixdogVersion) -or $MixdogVersion -eq "latest") {
    throw "MixdogVersion must be a pinned package version, not latest"
}
$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) "mixdog-prebake"
& (Join-Path $PSScriptRoot "prebake-rust.ps1") -ServerCores $ServerCores -MixdogVersion $MixdogVersion -OutDir $outDir
$bundle = Join-Path $outDir "mixdogd-linux-x64.tgz"
$bundleSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant()
$hostOut = $outDir -replace '\\', '/'
$script = @'
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates ripgrep zstd findutils
# The bundle laid out as the server install lays it out (the payload's
# entries beside mixdogd) and as install()'s stock path does
# (mixdog_agent._core_install_shell).
CORE=/opt/mixdog-core
rm -rf "$CORE"; mkdir -p "$CORE"
tar -xzf /out/mixdogd-linux-x64.tgz -C "$CORE"
find "$CORE/payload" -mindepth 1 -maxdepth 1 -exec mv -t "$CORE" {} +
rmdir "$CORE/payload"
chmod 0755 "$CORE/mixdogd" "$CORE/js/node"
ln -sf "$CORE/mixdogd" /usr/local/bin/mixdog
ln -sf "$CORE/js/node" /usr/local/bin/node
test "$(mixdog --version)" = "mixdogd __VERSION__"
node --version
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
# gzip: ~3x smaller upload than the raw tree, which under 8-way concurrent
# trial setup dominated the docker cp.
tar -C / -czf /out/mixdog-core-prebake.tar.gz \
  opt/mixdog-core usr/local/bin/mixdog usr/local/bin/node usr/bin/rg \
  root/.local/bin opt/static-curl
echo "prebake tar written"
# zstd variant: ~same upload size at -19 but decompresses multi-threaded in
# ~1s where gunzip takes 5-10s under 8-way concurrent trial setup. The zstd
# BINARY ships alongside (apt/glibc task images all carry libzstd via dpkg,
# but not necessarily the CLI); install() prefers this pair and falls back
# to the .tar.gz when either file is missing or the binary refuses to run.
tar -C / -I 'zstd -T0 -19' -cf /out/mixdog-core-prebake.tar.zst \
  opt/mixdog-core usr/local/bin/mixdog usr/local/bin/node usr/bin/rg \
  root/.local/bin opt/static-curl
cp /usr/bin/zstd /out/zstd-amd64
echo "prebake zst written"
'@ -replace '__VERSION__', $MixdogVersion
# The here-string inherits this file's CRLF endings; bash -lc treats a
# trailing \r as part of the command (exit 127), so normalize to LF.
$script = $script -replace "`r", ""
docker run --rm -v "${hostOut}:/out" $Image bash -lc $script
if ($LASTEXITCODE -ne 0) { throw "prebake build failed (exit $LASTEXITCODE)" }
$tar = Join-Path $outDir "mixdog-core-prebake.tar.gz"
# Version stamp for the pre-run guard in run.ps1. install() verifies the same
# version INSIDE the container, but that costs a full trial wave to discover;
# the stamp lets a run fail in seconds when the cache is stale.
$stamp = [ordered]@{
    schemaVersion = 2
    mixdogVersion = $MixdogVersion
    image         = $Image
    bundleSha256  = $bundleSha
    builtAt       = (Get-Date).ToUniversalTime().ToString("o")
}
$stampPath = Join-Path $outDir "prebake.json"
$stamp | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $stampPath -Encoding utf8
"prebake ready: $tar ($([math]::Round((Get-Item $tar).Length/1MB)) MB) version=$MixdogVersion core=$($bundleSha.Substring(0, 12))"
