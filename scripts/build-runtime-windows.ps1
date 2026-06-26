# build-runtime-windows.ps1 — Build PostgreSQL 16 + pgvector runtime on Windows.
# Uses windows-2022 GHA runner's preinstalled PostgreSQL 16 (consistent
# pg_config + postgres.exe from same package) — avoids EDB zip's split-version
# packaging bug that linked pgvector against PG 14 ABI.
# Builds pgvector from source via MSVC/nmake, then assembles a self-contained
# runtime tree (bin + lib + share at root). Final smoke: initdb + CREATE
# EXTENSION vector + distance query.
# Produces: dist\mixdog-runtime-win32-x64-pg{pgver}-pgvector{vecver}.tar.gz

$ErrorActionPreference = 'Stop'

$PG_VERSION       = '16.4'
$PGVECTOR_VERSION = '0.8.2'
$TARGET_OS        = $env:TARGET_OS   ?? 'win32'
$TARGET_ARCH      = $env:TARGET_ARCH ?? 'x64'

# Auto-detect highest preinstalled PG ≥ 16 OR install via chocolatey.
$PgInstallRoot = 'C:\Program Files\PostgreSQL'

function Find-PgRoot {
    if (-not (Test-Path $PgInstallRoot)) { return $null }
    $cands = Get-ChildItem $PgInstallRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(\d+)' } |
        Sort-Object { [int]([regex]::Match($_.Name, '^(\d+)').Groups[1].Value) } -Descending
    foreach ($c in $cands) {
        $major = [int]([regex]::Match($c.Name, '^(\d+)').Groups[1].Value)
        if ($major -ge 16 -and (Test-Path "$($c.FullName)\bin\pg_config.exe")) {
            return $c.FullName
        }
    }
    return $null
}

$PgRoot = Find-PgRoot
if (-not $PgRoot) {
    Write-Host "==> No preinstalled PG ≥ 16 found. Installing via chocolatey..."
    if (Test-Path $PgInstallRoot) {
        Write-Host "Existing PG dirs (none usable):"
        Get-ChildItem $PgInstallRoot -Directory -ErrorAction SilentlyContinue | Select-Object Name
    }
    choco install postgresql16 --version=16.4.0 --params '/Password:postgres' -y --no-progress 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Error "choco install postgresql16 failed (exit $LASTEXITCODE)"; exit 1 }
    $PgRoot = Find-PgRoot
    if (-not $PgRoot) {
        Write-Error "ASSERT FAILED: chocolatey install completed but PG ≥ 16 still not found under $PgInstallRoot"
        Get-ChildItem $PgInstallRoot -Directory -ErrorAction SilentlyContinue | Select-Object Name
        exit 1
    }
}

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir    = (Resolve-Path "$ScriptDir\..").Path
$BuildDir   = "$RootDir\build\runtime-win32-$TARGET_ARCH"
$DistDir    = "$RootDir\dist"
$RuntimeDir = "$BuildDir\runtime"

$PgBin    = "$PgRoot\bin"
$PgConfig = "$PgBin\pg_config.exe"

$OutputName = "mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

Write-Host "==> Using preinstalled PG: $PgRoot"
& $PgConfig --version
$RealVersion = (& $PgConfig --version) -replace 'PostgreSQL ', ''
Write-Host "  pg_config reports version: $RealVersion"

if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
New-Item -ItemType Directory -Force -Path $BuildDir, $DistDir,
  "$RuntimeDir\bin", "$RuntimeDir\lib", "$RuntimeDir\share" | Out-Null

Write-Host "==> Cloning pgvector $PGVECTOR_VERSION"
$PgVectorDir = "$BuildDir\pgvector"
$VectorDllBuilt = "$PgVectorDir\vector.dll"

if (Test-Path $VectorDllBuilt) {
    Write-Host "  Cache hit: vector.dll already built at $VectorDllBuilt"
} else {
    if (Test-Path $PgVectorDir) { Remove-Item -Recurse -Force $PgVectorDir }
    git clone --branch "v$PGVECTOR_VERSION" --depth 1 `
        https://github.com/pgvector/pgvector.git $PgVectorDir

    Write-Host "==> Building pgvector (MSVC/nmake against system PG 16)"
    Push-Location $PgVectorDir
    try {
        $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        $VcVarsAll = & $VsWhere -latest -find 'VC\Auxiliary\Build\vcvarsall.bat' 2>$null | Select-Object -First 1
        if (-not $VcVarsAll) {
            Write-Error "vswhere could not locate vcvarsall.bat — Visual Studio Build Tools required."
            exit 1
        }
        # CRITICAL: prepend $PgRoot\bin to PATH so any bare `pg_config` call
        # inside Makefile.win resolves to PG 16 — runner has PG 14/15
        # preinstalled and would otherwise win the PATH lookup, producing
        # PG14-ABI vector.dll that fails to load in our PG 16 postgres.exe.
        # Set in PowerShell so cmd /c inherits; setting inside the cmd batch
        # via %PATH% loses vcvarsall's additions due to parse-time expansion.
        $env:PATH = "$PgRoot\bin;$env:PATH"
        $env:PGROOT = $PgRoot
        $BuildCmd = "`"$VcVarsAll`" amd64 && nmake /F Makefile.win PG_CONFIG=`"$PgConfig`""
        cmd /c $BuildCmd
        if ($LASTEXITCODE -ne 0) {
            Write-Error "pgvector nmake build failed (exit $LASTEXITCODE)"
            exit 1
        }
    } finally {
        Pop-Location
    }
}

Write-Host "==> Assembling runtime layout — copy bin (.exe + .dll), lib, share from $PgRoot"
# Copy ALL .exe + .dll from PG bin so postgres.exe + libpq.dll + libcrypto/libssl/
# libintl/libiconv/icu*/libxml2/libxslt/libwinpthread/libecpg/libpgtypes etc. all
# ship together. PG 16 install layout puts these all in bin\.
Copy-Item "$PgBin\*.exe","$PgBin\*.dll" "$RuntimeDir\bin\" -Force

# lib\: PG extension modules (incl. contrib like pgcrypto.dll). vector.dll
# placed here below — PG looks for $libdir/<ext>.dll which resolves to lib\.
Copy-Item -Recurse -Force "$PgRoot\lib\*"   "$RuntimeDir\lib\"   -ErrorAction SilentlyContinue
# share\: extension SQL/control, locale, timezone data, conf samples.
Copy-Item -Recurse -Force "$PgRoot\share\*" "$RuntimeDir\share\" -ErrorAction SilentlyContinue

Write-Host "==> Manually staging pgvector artifacts (avoid pg_config-derived install paths)"
$RuntimeExtDir = "$RuntimeDir\share\extension"
New-Item -ItemType Directory -Force -Path $RuntimeExtDir | Out-Null
Copy-Item "$PgVectorDir\vector.dll"        "$RuntimeDir\lib\"  -Force
Copy-Item "$PgVectorDir\vector.control"    $RuntimeExtDir      -Force
Copy-Item "$PgVectorDir\sql\vector--*.sql" $RuntimeExtDir      -Force

Write-Host "==> Asserting runtime layout"
$VectorControl = "$RuntimeDir\share\extension\vector.control"
if (-not (Test-Path $VectorControl)) { Write-Error "ASSERT FAILED: $VectorControl not found"; exit 1 }
$VectorSql = "$RuntimeDir\share\extension\vector--$PGVECTOR_VERSION.sql"
if (-not (Test-Path $VectorSql))     { Write-Error "ASSERT FAILED: $VectorSql not found"; exit 1 }
if (-not (Test-Path "$RuntimeDir\lib\vector.dll")) {
    Write-Error "ASSERT FAILED: vector.dll not found in lib\"
    exit 1
}
Write-Host "  PASS runtime layout"

# Licenses
if (Test-Path "$PgRoot\doc\postgresql\COPYRIGHT") {
    Copy-Item "$PgRoot\doc\postgresql\COPYRIGHT" "$RuntimeDir\LICENSE.postgresql" -Force
} elseif (Test-Path "$PgRoot\doc\COPYRIGHT") {
    Copy-Item "$PgRoot\doc\COPYRIGHT" "$RuntimeDir\LICENSE.postgresql" -Force
}
if (Test-Path "$PgVectorDir\LICENSE") {
    Copy-Item "$PgVectorDir\LICENSE" "$RuntimeDir\LICENSE.pgvector" -Force
}

Write-Host "==> Self-contained smoke test (initdb + CREATE EXTENSION vector + distance query)"
& "$RuntimeDir\bin\postgres.exe" --version
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: postgres.exe --version exit $LASTEXITCODE"; exit 1 }

$SmokeData = "$BuildDir\smoke-pgdata"
$SmokeLog  = "$BuildDir\smoke-pg.log"
$SmokePort = 55899
if (Test-Path $SmokeData) { Remove-Item -Recurse -Force $SmokeData }

& "$RuntimeDir\bin\initdb.exe" -D $SmokeData --username=postgres --auth-local=trust --no-locale -E UTF8 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: initdb"; exit 1 }

& "$RuntimeDir\bin\pg_ctl.exe" -D $SmokeData -o "-p $SmokePort -h 127.0.0.1" -l $SmokeLog -w start
if ($LASTEXITCODE -ne 0) { Write-Error "FAIL: pg_ctl start (see $SmokeLog)"; Get-Content $SmokeLog | Select-Object -Last 30; exit 1 }

try {
    & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -c "CREATE EXTENSION vector;" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CREATE EXTENSION vector failed" }
    $ExtV = & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"
    $Dist = & "$RuntimeDir\bin\psql.exe" -h 127.0.0.1 -p $SmokePort -U postgres -d postgres -tAc "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;"
    Write-Host "  vector extension version: $ExtV"
    Write-Host "  distance query result:    $Dist"
    if ($ExtV.Trim() -ne $PGVECTOR_VERSION) {
        Write-Error "FAIL: extversion='$ExtV' expected='$PGVECTOR_VERSION'"
        exit 1
    }
    Write-Host "  PASS smoke (extension load + vector distance)"
}
finally {
    & "$RuntimeDir\bin\pg_ctl.exe" -D $SmokeData -m fast stop 2>$null | Out-Null
    Remove-Item -Recurse -Force $SmokeData -ErrorAction SilentlyContinue
}

Write-Host "==> Creating tarball: $OutputName"
$DistDirFwd    = $DistDir.Replace('\', '/')
$RuntimeDirFwd = $RuntimeDir.Replace('\', '/')
& tar -czf "$DistDirFwd/$OutputName" -C "$RuntimeDirFwd" .
if ($LASTEXITCODE -ne 0) { Write-Error "tar failed (exit $LASTEXITCODE)"; exit 1 }

Write-Host "==> Generating sha256 sidecar"
Push-Location $DistDir
$Hash = (Get-FileHash -Algorithm SHA256 $OutputName).Hash.ToLower()
"$Hash  $OutputName" | Out-File -Encoding ascii "${OutputName}.sha256"
Pop-Location

# ---------------------------------------------------------------------------
# Phase A: Re-smoke from EXTRACTED tarball with hostile env (cleared PATH,
# only system32). Catches false-pass where the build host has VC redist /
# preinstalled DLLs that the tarball might be missing.
# ---------------------------------------------------------------------------
Write-Host "==> Re-smoke from extracted tarball (hostile env)"
$ExtractDir = "$BuildDir\extract-smoke"
if (Test-Path $ExtractDir) { Remove-Item -Recurse -Force $ExtractDir }
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
& tar -xzf "$DistDirFwd/$OutputName" -C ($ExtractDir.Replace('\','/'))
if ($LASTEXITCODE -ne 0) { Write-Error "extract failed"; exit 1 }

$ExtractData = "$ExtractDir\extract-pgdata"
$ExtractLog  = "$ExtractDir\extract-pg.log"
$ExtractPort = 55898

# Snapshot current env, then strip to minimal Windows PATH (no PG14/15/16
# preinstalled bin, no chocolatey, no MSVC tools).
$SavedPath  = $env:PATH
$SavedPgRoot = $env:PGROOT
$env:PATH   = "$env:SystemRoot\System32;$env:SystemRoot"
$env:PGROOT = $null
$env:PGDATA = $null

try {
    & "$ExtractDir\bin\postgres.exe" --version
    if ($LASTEXITCODE -ne 0) { throw "FAIL: postgres --version under hostile env" }
    & "$ExtractDir\bin\initdb.exe" -D $ExtractData --username=postgres --auth-local=trust --no-locale -E UTF8 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "FAIL: initdb under hostile env" }
    & "$ExtractDir\bin\pg_ctl.exe" -D $ExtractData -o "-p $ExtractPort -h 127.0.0.1" -l $ExtractLog -w start
    if ($LASTEXITCODE -ne 0) { Get-Content $ExtractLog | Select-Object -Last 30; throw "FAIL: pg_ctl start under hostile env" }
    try {
        & "$ExtractDir\bin\psql.exe" -h 127.0.0.1 -p $ExtractPort -U postgres -d postgres -c "CREATE EXTENSION vector;" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "FAIL: CREATE EXTENSION vector under hostile env" }
        $ExtV2 = & "$ExtractDir\bin\psql.exe" -h 127.0.0.1 -p $ExtractPort -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"
        if ($ExtV2.Trim() -ne $PGVECTOR_VERSION) { throw "FAIL: extracted-smoke extversion='$ExtV2'" }
        Write-Host "  PASS extracted-tarball smoke (hostile env)"
    } finally {
        & "$ExtractDir\bin\pg_ctl.exe" -D $ExtractData -m fast stop 2>$null | Out-Null
    }
} finally {
    $env:PATH   = $SavedPath
    $env:PGROOT = $SavedPgRoot
    Remove-Item -Recurse -Force $ExtractDir -ErrorAction SilentlyContinue
}

Write-Host "==> Done: $DistDir\$OutputName"
Get-Item "$DistDir\$OutputName" | Select-Object Name, Length
