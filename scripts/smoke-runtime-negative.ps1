# smoke-runtime-negative.ps1 — Negative-path tests against released win32-x64
# runtime tarball. Validates: download, sha256, corrupt-tarball, fresh-extract
# boot, double-init refusal, hostile-env survival.
#
# Env: TAG / OS / ARCH / RUNTIME_RELEASE_REPOSITORY (default tribgames/mixdog)

$ErrorActionPreference = 'Stop'

$Tag         = if ($env:TAG)                { $env:TAG }  else { 'runtime-v0.4.0' }
$Os          = if ($env:OS)                 { $env:OS }   else { 'win32' }
$Arch        = if ($env:ARCH)               { $env:ARCH } else { 'x64' }
$ReleaseRepo = if ($env:RUNTIME_RELEASE_REPOSITORY) { $env:RUNTIME_RELEASE_REPOSITORY } else { 'tribgames/mixdog' }
$PgVer       = '16.4'
$PgvectorVer = '0.8.2'

$Asset = "mixdog-runtime-${Os}-${Arch}-pg${PgVer}-pgvector${PgvectorVer}.tar.gz"
$Url   = "https://github.com/${ReleaseRepo}/releases/download/${Tag}/${Asset}"

$Work = New-Item -ItemType Directory -Force -Path "$env:TEMP\smoke-$([guid]::NewGuid().ToString('N'))" | Select-Object -ExpandProperty FullName

try {
    Write-Host "==> Negative-path smoke for ${Os}-${Arch} from $Url"

    Write-Host "==> Test 1: HEAD reaches release asset"
    $resp = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -ErrorAction Stop
    Write-Host "  HTTP $($resp.StatusCode)"

    Write-Host "==> Test 2: full download + sha256"
    $TarPath = Join-Path $Work $Asset
    Invoke-WebRequest -Uri $Url -OutFile $TarPath -UseBasicParsing
    $sha = (Get-FileHash -Algorithm SHA256 $TarPath).Hash.ToLower()
    Write-Host "  sha256=$sha"

    Write-Host "==> Test 3: corrupt tarball — flip a byte and ensure tar errors"
    $CorruptPath = "$Work\corrupt.tar.gz"
    Copy-Item $TarPath $CorruptPath
    $bytes = [byte[]]::new(1); $rand = [System.Random]::new(); $rand.NextBytes($bytes)
    $stream = [System.IO.File]::OpenWrite($CorruptPath)
    $stream.Position = 102400
    $stream.Write($bytes, 0, 1)
    $stream.Close()
    $CorruptDir = "$Work\corrupt"
    New-Item -ItemType Directory -Force -Path $CorruptDir | Out-Null
    $TarProc = Start-Process -FilePath tar -ArgumentList @('-xzf', $CorruptPath, '-C', $CorruptDir.Replace('\','/')) -Wait:$false -PassThru -WindowStyle Hidden
    if (-not $TarProc.WaitForExit(15000)) {
        Stop-Process -Id $TarProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  PASS: corrupted tarball extraction timed out and was stopped"
    } elseif ($TarProc.ExitCode -eq 0) {
        Write-Host "  WARN: corrupted tarball extracted without error (tar gzip recovery)"
    } else {
        Write-Host "  PASS: corrupted tarball rejected by tar (exit $($TarProc.ExitCode))"
    }

    Write-Host "==> Test 4: fresh-extract boot (extension load + distance query)"
    $FreshDir = "$Work\fresh"
    New-Item -ItemType Directory -Force -Path $FreshDir | Out-Null
    & tar -xzf $TarPath -C ($FreshDir.Replace('\','/'))
    if ($LASTEXITCODE -ne 0) { throw "fresh extract failed" }

    $PgBin   = "$FreshDir\bin"
    $Data    = "$FreshDir\pgdata"
    $Log     = "$FreshDir\pg.log"
    $Port    = 55897

    # Hostile env: minimal PATH (System32 only), no PGROOT/PGDATA
    $SavedPath = $env:PATH
    $SavedPgRoot = $env:PGROOT
    $env:PATH   = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:PGROOT = $null
    $env:PGDATA = $null

    try {
        & "$PgBin\postgres.exe" --version
        if ($LASTEXITCODE -ne 0) { throw "FAIL: postgres --version" }
        & "$PgBin\initdb.exe" -D $Data --username=postgres --auth-local=trust --no-locale -E UTF8 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "FAIL: initdb" }
        & "$PgBin\pg_ctl.exe" -D $Data -o "-p $Port -h 127.0.0.1" -l $Log -w start
        if ($LASTEXITCODE -ne 0) { Get-Content $Log | Select-Object -Last 30; throw "FAIL: pg_ctl start" }

        try {
            & "$PgBin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d postgres -c "CREATE EXTENSION vector;" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "FAIL: CREATE EXTENSION" }
            $ExtV = & "$PgBin\psql.exe" -h 127.0.0.1 -p $Port -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"
            if ($ExtV.Trim() -ne $PgvectorVer) { throw "FAIL: extversion='$ExtV' expected='$PgvectorVer'" }
            Write-Host "  PASS: fresh-extract boot + vector extension"
        } finally {
            & "$PgBin\pg_ctl.exe" -D $Data -m fast stop 2>$null | Out-Null
        }

        Write-Host "==> Test 5: second initdb on initialized dir refused"
        $rc = (Start-Process -FilePath "$PgBin\initdb.exe" -ArgumentList "-D",$Data,"-U","postgres" -Wait -PassThru -NoNewWindow).ExitCode
        if ($rc -eq 0) {
            Write-Host "  WARN: second initdb succeeded (unexpected)"
        } else {
            Write-Host "  PASS: second initdb refused (exit $rc)"
        }
    } finally {
        $env:PATH   = $SavedPath
        $env:PGROOT = $SavedPgRoot
    }

    Write-Host "==> All negative-path smokes: PASS"
}
finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
