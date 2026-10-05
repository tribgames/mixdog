# Move/resize a top-level window; omitted fields keep the current bounds. Also
# the agent's remedy when the occlusion guard reports a covered element.
function Do-MoveWindow($req) {
    if ($null -eq $req.x -and $null -eq $req.y -and
        $null -eq $req.width -and $null -eq $req.height) {
        throw 'move_window requires x, y, width, or height'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $x = if ($null -ne $req.x) { [int]$req.x } else { $info.X }
    $y = if ($null -ne $req.y) { [int]$req.y } else { $info.Y }
    $w = if ($null -ne $req.width) { [int]$req.width } else { $info.Width }
    $hh = if ($null -ne $req.height) { [int]$req.height } else { $info.Height }
    if ($w -lt 1 -or $hh -lt 1) { throw 'window width and height must be positive' }
    Assert-ExecutionAuthorization $req $info.Handle
    [void][MixWin32]::ShowWindow($info.Handle, 9)
    if (-not [MixWin32]::MoveWindow($info.Handle, $x, $y, $w, $hh, $true)) {
        throw "could not move window: $($info.Id)"
    }
    $after = [MixWin32]::Info($info.Handle)
    $verified = $after.X -eq $x -and $after.Y -eq $y -and $after.Width -eq $w -and $after.Height -eq $hh
    $message = 'moved {0} to {1},{2} size {3}x{4}' -f $info.Id, $x, $y, $w, $hh
    return New-ActionResult 'move_window' 'win32' (Get-VerifiedEffect $verified) $verified $message $null 'background' $info.Id
}

function Do-WindowState($req) {
    $state = ([string]$req.state).ToLower()
    if ($state -notin @('minimize', 'maximize', 'restore')) {
        throw 'window state must be minimize, maximize, or restore'
    }
    $info = Resolve-WindowInfo $req.window $req.window_id
    $command = switch ($state) {
        'minimize' { 6 }
        'maximize' { 3 }
        'restore' { 9 }
        default { throw 'window_state requires state=minimize, maximize, or restore' }
    }
    Assert-ExecutionAuthorization $req $info.Handle
    [void][MixWin32]::ShowWindow($info.Handle, $command)
    Start-Sleep -Milliseconds 80
    $verified = switch ($state) {
        'minimize' { [MixWin32]::IsMinimized($info.Handle) }
        'maximize' { [MixWin32]::IsMaximized($info.Handle) }
        'restore' {
            -not [MixWin32]::IsMinimized($info.Handle) -and
            -not [MixWin32]::IsMaximized($info.Handle)
        }
    }
    return New-ActionResult 'window_state' 'win32' (Get-VerifiedEffect $verified) $verified "$state window $($info.Id)" $null 'background' $info.Id
}

function Do-CloseWindow($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    Assert-ExecutionAuthorization $req $info.Handle
    if (-not [MixWin32]::CloseWindow($info.Handle)) {
        return New-ActionResult 'close_window' 'win32' 'suspected_noop' $false "could not request close for $($info.Id)" 'window_close_rejected' 'background' $info.Id
    }
    Start-Sleep -Milliseconds 120
    $verified = -not [MixWin32]::IsWindowHandle($info.Handle)
    $message = if ($verified) {
        "closed window $($info.Id)"
    }
    else {
        "close requested for $($info.Id); the app may be showing a save or confirmation dialog"
    }
    return New-ActionResult 'close_window' 'win32' (Get-VerifiedEffect $verified) $verified $message $null 'background' $info.Id
}

# Killing a process is the one window action with nothing to undo: unsaved work
# is gone and no dialog gets to ask. So it is refused unless the caller repeats
# the intent, and refused again while the window still answers messages, because
# a responding window can still be closed the ordinary way.
function Do-TerminateProcess($req) {
    $info = Resolve-WindowInfo $req.window $req.window_id
    if ([string]$req.confirm -ne 'terminate') {
        return New-ActionResult 'terminate_process' 'none' 'suspected_noop' $false "terminating $($info.Id) discards unsaved work; confirm=terminate is required and the user has to agree first" 'confirmation_required' 'background' $info.Id
    }
    if ([MixWin32]::IsWindowResponding($info.Handle)) {
        return New-ActionResult 'terminate_process' 'none' 'suspected_noop' $false "window $($info.Id) still answers messages; close it the ordinary way instead of killing its process" 'window_still_responding' 'background' $info.Id
    }
    Assert-ExecutionAuthorization $req $info.Handle
    $processId = [int]$info.Pid
    try {
        $process = [System.Diagnostics.Process]::GetProcessById($processId)
        $process.Kill()
        [void]$process.WaitForExit(2000)
    }
    catch {
        return New-ActionResult 'terminate_process' 'win32' 'suspected_noop' $false "could not terminate pid $($processId): $($_.Exception.Message)" 'terminate_failed' 'background' $info.Id
    }
    $verified = -not [MixWin32]::IsWindowHandle($info.Handle)
    return New-ActionResult 'terminate_process' 'win32' (Get-VerifiedEffect $verified) $verified "terminated pid $processId behind $($info.Id)" $null 'background' $info.Id
}

function Get-InstalledApps {
    # The Start menu catalogue is the only list that pairs the name a user says with
    # the id Windows can activate; a packaged app has no executable worth launching.
    if ($null -eq $script:InstalledApps) {
        $catalogue = New-Object System.Collections.ArrayList
        try {
            Import-Module StartLayout -ErrorAction Stop
            foreach ($entry in Get-StartApps) {
                $id = [string]$entry.AppID
                if ([string]::IsNullOrWhiteSpace($id)) { continue }
                [void]$catalogue.Add([pscustomobject]@{
                        Name     = [string]$entry.Name
                        AppId    = $id
                        Packaged = $id.Contains('!')
                    })
            }
            $script:InstalledAppsError = ''
        }
        catch {
            $script:InstalledAppsError = [string]$_.Exception.Message
        }
        $script:InstalledApps = $catalogue
    }
    return $script:InstalledApps
}

function Find-InstalledApp($target) {
    # A path, a URL or an executable belongs to the shell; only a bare name can mean
    # a catalogue entry. Several matches stay unlaunched rather than becoming a guess.
    # An executable file name is the shell's too: "control.exe" once matched the
    # catalogue id "...\FanControl\FanControl.exe" and launched the wrong program.
    if ($target -match '[\\/]' -or $target -match '^[A-Za-z][A-Za-z0-9+.-]*:' -or
        $target -match '\.(exe|com|bat|cmd|msc|cpl|lnk)$') { return $null }
    $installed = @(Get-InstalledApps)
    if ($installed.Count -eq 0) { return $null }
    $found = @($installed | Where-Object { $_.Name -eq $target })
    if ($found.Count -eq 0) {
        $found = @($installed | Where-Object { $_.Name -like "*$target*" -or $_.AppId -like "*$target*" })
    }
    if ($found.Count -eq 1) { return $found[0] }
    if ($found.Count -gt 1) {
        # A packaged app is the one Windows itself would open for a bare name like
        # "notepad", so it wins over a partial match on some other product's name.
        $packaged = @($found | Where-Object { $_.Packaged })
        if ($packaged.Count -eq 1) { return $packaged[0] }
        $names = (($found | Select-Object -First 6) | ForEach-Object { $_.Name }) -join ', '
        throw "launch failed [ambiguous_app/0] for '$target': $($found.Count) installed apps match ($names)"
    }
    return $null
}

function Do-Launch($app) {
    $target = [string]$app
    if ([string]::IsNullOrWhiteSpace($target)) { throw 'launch requires app' }
    $launchedPid = 0
    $route = 'windows_shell'
    $appId = ''
    try {
        Assert-ExecutionAuthorization $script:CurrentRequest
        $installed = if ($target.Contains('!')) {
            [pscustomobject]@{ Name = $target; AppId = $target; Packaged = $true }
        }
        else { Find-InstalledApp $target }
        if ($null -ne $installed -and $installed.Packaged) {
            # Windows leaves only a stub at a packaged app's executable path and hands the
            # work to the activation broker, so this is the one route that can report the
            # process that owns the new window.
            $appId = [string]$installed.AppId
            $route = 'app_activation'
            $launchedPid = [MixWin32]::ActivateAppId($appId)
        }
        elseif ($null -ne $installed) {
            # An unpackaged Start entry keeps its install path in the catalogue id, which
            # the shell resolves, so the name a user says works without knowing that path.
            $appId = [string]$installed.AppId
            $route = 'apps_folder'
            $launchedPid = [MixWin32]::LaunchWithoutActivation("shell:AppsFolder\$appId")
        }
        else {
            # The user's foreground window survives a launch: the app is shown without
            # activation, the same promise background input makes.
            $launchedPid = [MixWin32]::LaunchWithoutActivation($target)
        }
    }
    catch {
        # A native call arrives wrapped, so the original Win32 code decides the category.
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        if ($failure.Message -like 'launch failed *') { throw $failure.Message }
        $nativeCode = 0
        if ($failure -is [System.ComponentModel.Win32Exception]) {
            $nativeCode = [int]$failure.NativeErrorCode
        }
        elseif (($failure.HResult -band -65536) -eq -2147024896) {
            # An activation failure arrives as an HRESULT that wraps the same Win32 code.
            $nativeCode = $failure.HResult -band 0xFFFF
        }
        $category = switch ($nativeCode) {
            { $_ -in 2, 3 } { 'target_not_found'; break }
            5 { 'access_denied'; break }
            { $_ -in 31, 1155 } { 'no_file_association'; break }
            1223 { 'launch_cancelled'; break }
            default { if ($route -eq 'app_activation') { 'app_activation_failed' } else { 'shell_launch_failed' } }
        }
        $hint = ''
        if ($category -eq 'target_not_found' -and $target -match '\s[-/]') {
            # The whole string is one shell target, so a trailing switch reads as part of the name.
            $hint = '; launch takes one executable, path, file, or URL and passes no command-line arguments'
        }
        throw "launch failed [$category/$nativeCode] for '$target': $($failure.Message)$hint"
    }
    $result = New-ActionResult 'launch' $route 'unverifiable' $false ('launched ' + $target) $null 'background' $null
    if ($appId) { $result.app_id = $appId }
    if ($launchedPid -gt 0) {
        $result.pid = $launchedPid
        try { $result.app_hint = [string]([System.Diagnostics.Process]::GetProcessById($launchedPid).ProcessName) } catch {}
    }
    return $result
}

function Do-ListInstalledApps($req) {
    $query = [string]$req.query
    $apps = @(Get-InstalledApps)
    if (-not [string]::IsNullOrWhiteSpace($query)) {
        $apps = @($apps | Where-Object { $_.Name -like "*$query*" -or $_.AppId -like "*$query*" })
    }
    $rows = @($apps | ForEach-Object {
            [ordered]@{ name = $_.Name; app_id = $_.AppId; packaged = [bool]$_.Packaged }
        })
    $catalogueTotal = @(Get-InstalledApps).Count
    $payload = [ordered]@{ installed = $rows; matched = $rows.Count; catalogue_total = $catalogueTotal }
    if ($script:InstalledAppsError) { $payload.catalogue_error = [string]$script:InstalledAppsError }
    return @{
        text            = ($payload | ConvertTo-Json -Depth 4 -Compress)
        installed       = $rows
        catalogue_total = $catalogueTotal
    }
}

