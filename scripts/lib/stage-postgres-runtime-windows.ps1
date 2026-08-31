function Get-MixdogDumpBin {
    param(
        [Parameter(Mandatory = $true)]
        [string]$VsWhere
    )

    if (-not (Test-Path -LiteralPath $VsWhere)) {
        throw "vswhere.exe not found: $VsWhere"
    }

    $DumpBin = & $VsWhere -latest -products '*' `
        -find 'VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe' 2>$null |
        Select-Object -First 1
    if (-not $DumpBin) {
        throw 'dumpbin.exe not found — Visual Studio Build Tools required.'
    }
    return $DumpBin
}

function Get-MixdogImportedDllNames {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DumpBin,
        [Parameter(Mandatory = $true)]
        [string]$ImagePath
    )

    $Output = & $DumpBin /DEPENDENTS $ImagePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /DEPENDENTS failed for $ImagePath"
    }

    return @(
        $Output |
            ForEach-Object {
                if ($_ -match '^\s+([^\s]+\.dll)\s*$') {
                    $Matches[1].ToLowerInvariant()
                }
            } |
            Sort-Object -Unique
    )
}

function Stage-MixdogWindowsPgRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PgRoot,
        [Parameter(Mandatory = $true)]
        [string]$RuntimeDir,
        [Parameter(Mandatory = $true)]
        [string]$VectorDll,
        [Parameter(Mandatory = $true)]
        [string]$VsWhere
    )

    $PgBin = Join-Path $PgRoot 'bin'
    $ExecutableNames = @(
        'postgres.exe',
        'pg_ctl.exe',
        'pg_dump.exe',
        'pg_restore.exe',
        'psql.exe',
        'initdb.exe'
    )
    $ModuleSources = [ordered]@{
        'dict_snowball.dll' = Join-Path $PgRoot 'lib\dict_snowball.dll'
        'plpgsql.dll'       = Join-Path $PgRoot 'lib\plpgsql.dll'
        'vector.dll'        = $VectorDll
    }

    $RequiredImages = @()
    foreach ($Name in $ExecutableNames) {
        $Source = Join-Path $PgBin $Name
        if (-not (Test-Path -LiteralPath $Source)) {
            throw "Required PostgreSQL executable not found: $Source"
        }
        Copy-Item -LiteralPath $Source -Destination "$RuntimeDir\bin\" -Force
        $RequiredImages += $Source
    }
    foreach ($Entry in $ModuleSources.GetEnumerator()) {
        if (-not (Test-Path -LiteralPath $Entry.Value)) {
            throw "Required PostgreSQL module not found: $($Entry.Value)"
        }
        Copy-Item -LiteralPath $Entry.Value -Destination "$RuntimeDir\lib\$($Entry.Key)" -Force
        $RequiredImages += $Entry.Value
    }

    $DumpBin = Get-MixdogDumpBin -VsWhere $VsWhere
    $PgDllByName = @{}
    Get-ChildItem -Path "$PgBin\*.dll" -File | ForEach-Object {
        $PgDllByName[$_.Name.ToLowerInvariant()] = $_.FullName
    }

    $Queue = [System.Collections.Generic.Queue[string]]::new()
    foreach ($Image in $RequiredImages) {
        $Queue.Enqueue($Image)
    }
    $VisitedImages = @{}
    $RuntimeDllByName = @{}

    while ($Queue.Count -gt 0) {
        $Image = $Queue.Dequeue()
        $ImageKey = [IO.Path]::GetFullPath($Image).ToLowerInvariant()
        if ($VisitedImages.ContainsKey($ImageKey)) {
            continue
        }
        $VisitedImages[$ImageKey] = $true

        foreach ($Dependency in @(Get-MixdogImportedDllNames -DumpBin $DumpBin -ImagePath $Image)) {
            if (-not $PgDllByName.ContainsKey($Dependency)) {
                continue
            }
            if (-not $RuntimeDllByName.ContainsKey($Dependency)) {
                $DependencyPath = $PgDllByName[$Dependency]
                $RuntimeDllByName[$Dependency] = $DependencyPath
                $Queue.Enqueue($DependencyPath)
            }
        }
    }

    foreach ($Dependency in $RuntimeDllByName.GetEnumerator()) {
        Copy-Item -LiteralPath $Dependency.Value -Destination "$RuntimeDir\bin\$($Dependency.Key)" -Force
    }

    $SourceShare = Join-Path $PgRoot 'share'
    Get-ChildItem -LiteralPath $SourceShare -File |
        Copy-Item -Destination "$RuntimeDir\share\" -Force
    Get-ChildItem -LiteralPath $SourceShare -Directory |
        Where-Object { $_.Name -notin @('locale', 'extension') } |
        Copy-Item -Destination "$RuntimeDir\share\" -Recurse -Force

    $RuntimeExtensionDir = Join-Path $RuntimeDir 'share\extension'
    New-Item -ItemType Directory -Force -Path $RuntimeExtensionDir | Out-Null
    $PlpgsqlAssets = @(Get-ChildItem -Path "$SourceShare\extension\plpgsql*" -File)
    if ($PlpgsqlAssets.Count -eq 0) {
        throw "Required PL/pgSQL extension assets not found under $SourceShare\extension"
    }
    $PlpgsqlAssets | Copy-Item -Destination $RuntimeExtensionDir -Force

    $RuntimeBytes = (
        Get-ChildItem -LiteralPath $RuntimeDir -File -Recurse |
            Measure-Object -Property Length -Sum
    ).Sum
    return [pscustomobject]@{
        ExecutableCount = $ExecutableNames.Count
        DependencyDllCount = $RuntimeDllByName.Count
        RuntimeMiB = [math]::Round($RuntimeBytes / 1MB, 1)
    }
}

function Assert-MixdogWindowsPgRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimeDir,
        [Parameter(Mandatory = $true)]
        [string]$PgVectorVersion
    )

    $ExpectedExecutables = @(
        'initdb.exe',
        'pg_ctl.exe',
        'pg_dump.exe',
        'pg_restore.exe',
        'postgres.exe',
        'psql.exe'
    )
    $ActualExecutables = @(
        Get-ChildItem -LiteralPath "$RuntimeDir\bin" -File -Filter '*.exe' |
            ForEach-Object Name |
            Sort-Object
    )
    $ExecutableDiff = @(Compare-Object $ExpectedExecutables $ActualExecutables)
    if ($ExecutableDiff.Count -gt 0) {
        throw "Unexpected PostgreSQL executable set: $($ActualExecutables -join ', ')"
    }

    $ExpectedModules = @('dict_snowball.dll', 'plpgsql.dll', 'vector.dll')
    $ActualModules = @(
        Get-ChildItem -LiteralPath "$RuntimeDir\lib" -File -Filter '*.dll' |
            ForEach-Object Name |
            Sort-Object
    )
    $ModuleDiff = @(Compare-Object $ExpectedModules $ActualModules)
    if ($ModuleDiff.Count -gt 0) {
        throw "Unexpected PostgreSQL module set: $($ActualModules -join ', ')"
    }

    $ImportLibraries = @(Get-ChildItem -LiteralPath $RuntimeDir -File -Filter '*.lib' -Recurse)
    if ($ImportLibraries.Count -gt 0) {
        throw "Development import libraries leaked into runtime: $($ImportLibraries.Count)"
    }
    if (Test-Path -LiteralPath "$RuntimeDir\share\locale") {
        throw 'PostgreSQL message locale files leaked into runtime.'
    }

    $UnexpectedExtensionAssets = @(
        Get-ChildItem -LiteralPath "$RuntimeDir\share\extension" -Force |
            Where-Object { $_.Name -notlike 'plpgsql*' -and $_.Name -notlike 'vector*' }
    )
    if ($UnexpectedExtensionAssets.Count -gt 0) {
        throw "Unexpected extension assets leaked into runtime: $($UnexpectedExtensionAssets.Count)"
    }

    $RequiredPaths = @(
        "$RuntimeDir\share\extension\vector.control",
        "$RuntimeDir\share\extension\vector--$PgVectorVersion.sql",
        "$RuntimeDir\share\extension\plpgsql.control",
        "$RuntimeDir\share\postgres.bki"
    )
    foreach ($Path in $RequiredPaths) {
        if (-not (Test-Path -LiteralPath $Path)) {
            throw "Required runtime asset not found: $Path"
        }
    }

    $RuntimeBytes = (
        Get-ChildItem -LiteralPath $RuntimeDir -File -Recurse |
            Measure-Object -Property Length -Sum
    ).Sum
    if ($RuntimeBytes -gt 80MB) {
        throw "Windows PostgreSQL runtime exceeds 80 MiB: $([math]::Round($RuntimeBytes / 1MB, 1)) MiB"
    }
    Write-Host "  PASS minimal runtime invariants ($([math]::Round($RuntimeBytes / 1MB, 1)) MiB)"
}
