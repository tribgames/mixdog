# Records the corpus of tests/pswire.rs: what Windows PowerShell 5.1 produces for the values and expressions the Office COM
# hosts depend on (ConvertTo-Json writer, ConvertFrom-Json payloads, casts, number text, Sort-Object, Group-Object, text
# operators, VT_DATE conversion, fingerprints). Runs in Windows PowerShell 5.1 only; Microsoft Office is not needed and no
# COM object is touched.
#
#   powershell.exe -NoProfile -File recorder\pswire-corpus.ps1 [-Out <dir>]
#
# <dir> defaults to tests\fixtures\pswire (beside this recorder). The corpus is written as LF text, one entry per line, so
# its sha256 (kept in MANIFEST.json) does not depend on the checkout's line endings.
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw "pswire-corpus.ps1 records Windows PowerShell 5.1 behaviour; this is $($PSVersionTable.PSVersion)" }
if (-not $Out) { $Out = Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\fixtures\pswire' }
$inv = [System.Globalization.CultureInfo]::InvariantCulture
# The messages of PowerShell and of .NET are recorded in English whatever the Windows display language is; the culture of
# number and text formatting (CurrentCulture, which Sort-Object and -f use) stays the machine's own.
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')

# ---- the host functions the corpus runs verbatim (office-com-host.ps1) ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- the host functions the corpus runs verbatim (office-com-host.ps1) ----"
function Color-Value([string]$hex) {
    $clean = $hex.TrimStart('#')
    if ($clean.Length -ne 6) { throw "Invalid color '$hex'; expected RRGGBB" }
    $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
    return $r + (256 * $g) + (65536 * $b)
}

function Color-Hex([long]$color) {
    $r = $color -band 255
    $g = ($color -shr 8) -band 255
    $b = ($color -shr 16) -band 255
    return ('{0:X2}{1:X2}{2:X2}' -f $r, $g, $b)
}

function Operation-Property($op, [string]$name, $fallback) {
    $direct = $op.PSObject.Properties[$name]
    if ($null -ne $direct -and $null -ne $direct.Value) { return $direct.Value }
    $properties = $op.PSObject.Properties['properties']
    if ($null -ne $properties -and $null -ne $properties.Value) {
        $nested = $properties.Value.PSObject.Properties[$name]
        if ($null -ne $nested -and $null -ne $nested.Value) { return $nested.Value }
    }
    return $fallback
}

function Text-Sha256([string]$text) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Snapshot-Fingerprint($value) {
    return Text-Sha256 ($value | ConvertTo-Json -Depth 30 -Compress)
}

# ---- spec grammar: JSON that both this recorder and tests/pswire.rs turn into a value ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- spec grammar: JSON that both this recorder and tests/pswire.rs turn into a value ----"
# null | {"t":"null"} | {"t":"dbnull"} | {"t":"b","v":true} | {"t":"i","v":1} (Int32) | {"t":"l","v":"1"} (Int64)
# {"t":"d","v":"R text"} (Double) | {"t":"f","v":"R text"} (Single) | {"t":"m","v":"1.50"} (Decimal) | {"t":"s","v":"text"}
# {"t":"e","v":2} (System.DayOfWeek) | {"t":"dt","v":"2026-09-12T03:04:05.0000000","k":"u|l|n"} (DateTime of that Kind)
# {"t":"a","v":[spec...]} (object[]) | {"t":"o","v":[["key",spec]...]} ([ordered]) | {"t":"p","v":[["key",spec]...]} (PSCustomObject)
# {"t":"nest","k":"o|p|a","n":depth,"leaf":spec} (depth wrappers, key "k", around the leaf)
function J([string]$s) { return (ConvertTo-Json -InputObject $s -Compress) }
function SpN { 'null' }
function SpDB { '{"t":"dbnull"}' }
function SpB($v) { '{"t":"b","v":' + $(if ($v) { 'true' } else { 'false' }) + '}' }
function SpI($v) { '{"t":"i","v":' + $v + '}' }
function SpL($v) { '{"t":"l","v":' + (J "$v") + '}' }
function SpD([string]$v) { '{"t":"d","v":' + (J $v) + '}' }
function SpF([string]$v) { '{"t":"f","v":' + (J $v) + '}' }
function SpM([string]$v) { '{"t":"m","v":' + (J $v) + '}' }
function SpS([string]$v) { '{"t":"s","v":' + (J $v) + '}' }
function SpE($v) { '{"t":"e","v":' + $v + '}' }
function SpDT([string]$v, [string]$k) { '{"t":"dt","v":' + (J $v) + ',"k":"' + $k + '"}' }
function SpA([string[]]$items) { '{"t":"a","v":[' + ($items -join ',') + ']}' }
function SpO($pairs) { '{"t":"o","v":[' + (($pairs | ForEach-Object { '[' + (J $_[0]) + ',' + $_[1] + ']' }) -join ',') + ']}' }
function SpP($pairs) { '{"t":"p","v":[' + (($pairs | ForEach-Object { '[' + (J $_[0]) + ',' + $_[1] + ']' }) -join ',') + ']}' }
function SpNest([string]$k, [int]$n, [string]$leaf) { '{"t":"nest","k":"' + $k + '","n":' + $n + ',"leaf":' + $leaf + '}' }

function Build($s) {
    if ($null -eq $s) { return ,$null }
    switch ($s.t) {
        'null' { return ,$null }
        'dbnull' { return ,[System.DBNull]::Value }
        'b' { return ,[bool]$s.v }
        'i' { return ,[int]$s.v }
        'l' { return ,[int64]::Parse([string]$s.v, $inv) }
        'd' { return ,[double]::Parse([string]$s.v, $inv) }
        'f' { return ,[single]::Parse([string]$s.v, $inv) }
        'm' { return ,[decimal]::Parse([string]$s.v, [System.Globalization.NumberStyles]::Float, $inv) }
        's' { return ,[string]$s.v }
        'e' { return ,[System.DayOfWeek][int]$s.v }
        'dt' {
            $kind = switch ($s.k) { 'u' { [DateTimeKind]::Utc } 'l' { [DateTimeKind]::Local } default { [DateTimeKind]::Unspecified } }
            $ticks = [DateTime]::ParseExact([string]$s.v, 'o', $inv, [System.Globalization.DateTimeStyles]::RoundtripKind).Ticks
            return ,(New-Object DateTime -ArgumentList $ticks, $kind)
        }
        'a' {
            $list = New-Object System.Collections.ArrayList
            foreach ($item in @($s.v)) { [void]$list.Add((Build $item)) }
            return ,($list.ToArray())
        }
        'o' {
            $d = [ordered]@{}
            foreach ($pair in @($s.v)) { $d[[string]$pair[0]] = (Build $pair[1]) }
            return ,$d
        }
        'p' {
            $d = [ordered]@{}
            foreach ($pair in @($s.v)) { $d[[string]$pair[0]] = (Build $pair[1]) }
            return ,([pscustomobject]$d)
        }
        'nest' {
            $v = Build $s.leaf
            for ($i = 0; $i -lt [int]$s.n; $i++) {
                switch ($s.k) {
                    'o' { $d = [ordered]@{}; $d['k'] = $v; $v = $d }
                    'p' { $d = [ordered]@{}; $d['k'] = $v; $v = [pscustomobject]$d }
                    default { $v = @(, $v) }
                }
            }
            return ,$v
        }
        default { throw "unknown spec $($s.t)" }
    }
}

# Dump: the typed form of a PowerShell value, in the same grammar.
function Dump($v) {
    if ($null -eq $v) { return 'null' }
    if ($v -is [System.DBNull]) { return '{"t":"dbnull"}' }
    if ($v -is [bool]) { return SpB $v }
    if ($v -is [int]) { return SpI $v }
    if ($v -is [int64]) { return SpL $v }
    if ($v -is [double]) { return SpD $v.ToString('R', $inv) }
    if ($v -is [single]) { return SpF $v.ToString('R', $inv) }
    if ($v -is [decimal]) { return SpM $v.ToString($inv) }
    if ($v -is [string]) { return SpS $v }
    if ($v -is [System.Enum]) { return SpE ([int]$v) }
    if ($v -is [datetime]) { return SpDT $v.ToString('o', $inv).Substring(0, 27) $(switch ($v.Kind) { 'Utc' { 'u' } 'Local' { 'l' } default { 'n' } }) }
    if ($v -is [System.Array]) { return SpA @($v | ForEach-Object { Dump $_ }) }
    if ($v -is [System.Collections.IDictionary]) {
        return SpO @(foreach ($k in $v.Keys) { , @([string]$k, (Dump $v[$k])) })
    }
    if ($v -is [pscustomobject]) {
        return SpP @(foreach ($p in $v.PSObject.Properties) { , @([string]$p.Name, (Dump $p.Value)) })
    }
    return '{"t":"other","v":' + (J ($v.GetType().FullName)) + '}'
}
function Err([string]$message) { '{"error":' + (J $message) + '}' }
function Wrap($__body) { try { & $__body } catch { Err $_.Exception.Message } }

$entries = New-Object System.Collections.ArrayList
function Add-Entry([string]$id, [string]$kind, [string]$fields) {
    [void]$entries.Add('{"id":' + (J $id) + ',"kind":"' + $kind + '",' + $fields + '}')
}
function Rec-Json([string]$id, [string]$spec, [int]$depth) {
    $v = Build ($spec | ConvertFrom-Json)
    $text = ConvertTo-Json -InputObject $v -Depth $depth -Compress
    Add-Entry $id 'json' ('"depth":' + $depth + ',"spec":' + $spec + ',"expected":' + (J $text))
}
function Rec-Pipe([string]$id, [string]$spec) {
    $v = Build ($spec | ConvertFrom-Json)
    $text = ($v | ConvertTo-Json -Depth 20 -Compress)
    if ($null -eq $text) { $text = '' }
    Add-Entry $id 'pipe' ('"spec":' + $spec + ',"expected":' + (J $text))
}
function Rec-Fp([string]$id, [string]$spec) {
    $v = Build ($spec | ConvertFrom-Json)
    $text = ($v | ConvertTo-Json -Depth 30 -Compress)
    if ($null -eq $text) { $text = '' }
    Add-Entry $id 'fp' ('"spec":' + $spec + ',"text":' + (J $text) + ',"expected":' + (J (Snapshot-Fingerprint $v)))
}
function Rec-Sha([string]$id, [string]$text) {
    Add-Entry $id 'sha' ('"text":' + (J $text) + ',"expected":' + (J (Text-Sha256 $text)))
}
function Rec-Payload([string]$id, [string]$text) {
    $expected = Wrap { Dump ($text | ConvertFrom-Json) }
    Add-Entry $id 'payload' ('"text":' + (J $text) + ',"expected":' + $expected)
}
function Rec-Get([string]$id, [string]$text, [string]$name) {
    $payload = $text | ConvertFrom-Json
    $expected = Wrap { Dump $payload.$name }
    Add-Entry $id 'get' ('"text":' + (J $text) + ',"name":' + (J $name) + ',"expected":' + $expected)
}
function Rec-OpProp([string]$id, [string]$text, [string]$name, [string]$fallback) {
    $op = $text | ConvertFrom-Json
    $fb = Build ($fallback | ConvertFrom-Json)
    $expected = Wrap { Dump (Operation-Property $op $name $fb) }
    Add-Entry $id 'opprop' ('"text":' + (J $text) + ',"name":' + (J $name) + ',"fallback":' + $fallback + ',"expected":' + $expected)
}
$casts = @{
    int      = { param($x) [int]$x }
    int64    = { param($x) [int64]$x }
    double   = { param($x) [double]$x }
    single   = { param($x) [single]$x }
    bool     = { param($x) [bool]$x }
    string   = { param($x) [string]$x }
    interp   = { param($x) "$x" }
    asint    = { param($x) $x -as [int] }
    tryparse = { param($x) $n = 0; if ([int]::TryParse([string]$x, [ref]$n)) { $n } else { $null } }
    round0   = { param($x) [Math]::Round([double]$x) }
    round2   = { param($x) [Math]::Round([double]$x, 2) }
    roundint = { param($x) [int][Math]::Round([double]$x) }
    floor    = { param($x) [Math]::Floor($x) }
    max      = { param($x, $y) [Math]::Max($x, $y) }
    min      = { param($x, $y) [Math]::Min($x, $y) }
    hex2     = { param($x) '{0:X2}' -f $x }
    cvalue   = { param($x) Color-Value ([string]$x) }
    chex     = { param($x) Color-Hex $x }
    add      = { param($x, $y) $x + $y }
    sub      = { param($x, $y) $x - $y }
    mul      = { param($x, $y) $x * $y }
    div      = { param($x, $y) $x / $y }
    gt       = { param($x, $y) $x -gt $y }
    eq       = { param($x, $y) $x -eq $y }
    ceq      = { param($x, $y) $x -ceq $y }
}
# An ordinal dictionary: a PowerShell hashtable compares keys by culture, ignoring case, and would merge 'detect' with 'DETECT'.
$specCache = New-Object 'System.Collections.Generic.Dictionary[string,object]'
function Build-Cached([string]$spec) {
    if (-not $specCache.ContainsKey($spec)) { $specCache[$spec] = @{ v = (Build ($spec | ConvertFrom-Json)) } }
    return ,$specCache[$spec].v
}
function Rec-Cast([string]$id, [string]$fn, [string[]]$specs) {
    $args2 = @(foreach ($s in $specs) { , (Build-Cached $s) })
    $block = $casts[$fn]
    $expected = Wrap { Dump (& $block @args2) }
    Add-Entry $id 'cast' ('"fn":"' + $fn + '","args":[' + ($specs -join ',') + '],"expected":' + $expected)
}
function Rec-Sort([string]$id, [string[]]$specs, [bool]$desc, [bool]$unique) {
    $values = @(foreach ($s in $specs) { , (Build ($s | ConvertFrom-Json)) })
    $flat = @(foreach ($v in $values) { $v })
    $sorted = if ($desc -and $unique) { @($flat | Sort-Object -Descending -Unique) }
    elseif ($desc) { @($flat | Sort-Object -Descending) }
    elseif ($unique) { @($flat | Sort-Object -Unique) }
    else { @($flat | Sort-Object) }
    Add-Entry $id 'sort' ('"values":[' + ($specs -join ',') + '],"desc":' + $(if ($desc) { 'true' } else { 'false' }) + ',"unique":' + $(if ($unique) { 'true' } else { 'false' }) + ',"expected":' + (SpA @($sorted | ForEach-Object { Dump $_ })))
}
function Rec-SortKey([string]$id, [string[]]$specs) {
    $values = @(foreach ($s in $specs) { Build ($s | ConvertFrom-Json) })
    $sorted = @($values | Sort-Object { [int]$_['start'] })
    Add-Entry $id 'sortkey' ('"values":[' + ($specs -join ',') + '],"expected":' + (SpA @($sorted | ForEach-Object { Dump $_ })))
}
function Rec-Group([string]$id, [string[]]$specs) {
    $values = @(foreach ($s in $specs) { Build ($s | ConvertFrom-Json) })
    $groups = @($values | Group-Object | Sort-Object Count -Descending)
    $rows = @(foreach ($g in $groups) { '[' + (J ([string]$g.Name)) + ',' + $g.Count + ']' })
    Add-Entry $id 'group' ('"values":[' + ($specs -join ',') + '],"expected":[' + ($rows -join ',') + ']')
}
$texts = @{
    match    = { param($a, $b) $a -match $b }
    notmatch = { param($a, $b) $a -notmatch $b }
    cmatch   = { param($a, $b) $a -cmatch $b }
    replace  = { param($a, $b, $c) $a -replace $b, $c }
    creplace = { param($a, $b, $c) $a -creplace $b, $c }
    split    = { param($a, $b) $a -split $b }
    like     = { param($a, $b) $a -like $b }
    escape   = { param($a) [regex]::Escape($a) }
    trimend  = { param($a) $a.TrimEnd("`r", "`a") }
    join     = { param($a, $b) (@($a, $b) -join ', ') }
    lower    = { param($a) $a.ToLowerInvariant() }
    trim     = { param($a) $a.TrimStart('#') }
}
function Rec-Text([string]$id, [string]$op, [string[]]$strings) {
    $block = $texts[$op]
    $expected = Wrap { Dump (& $block @strings) }
    Add-Entry $id 'text' ('"op":"' + $op + '","args":[' + (($strings | ForEach-Object { J $_ }) -join ',') + '],"expected":' + $expected)
}
function Rec-Date([string]$id, [string]$oa) {
    $value = [double]::Parse($oa, $inv)
    try {
        $local = [DateTime]::FromOADate($value)
        $utc = $local.ToUniversalTime().ToString('o')
        Add-Entry $id 'date' ('"oa":' + (J $oa) + ',"local":' + (J ($local.ToString('o', $inv))) + ',"utc":' + (J $utc))
    }
    catch { Add-Entry $id 'date' ('"oa":' + (J $oa) + ',"error":' + (J $_.Exception.Message)) }
}

# ====================== entries ======================
$ascii = [string]::new([char[]](0..127))
$controls = (0..31 | ForEach-Object { [char]$_ }) -join ''

# ---- json writer: scalars ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- json writer: scalars ----"
$n = 0
foreach ($spec in @(
        (SpN), (SpDB), (SpB $true), (SpB $false), (SpI 0), (SpI -1), (SpI 2147483647), (SpI -2147483648),
        (SpL 2147483648), (SpL 9223372036854775807), (SpL -9223372036854775808),
        (SpD '0.30000000000000004'), (SpD '1E+20'), (SpD '0.1'), (SpD '1'), (SpD '-0'), (SpD '1E-05'), (SpD '0.0001'), (SpD '123456789012345678'),
        (SpD '1E+15'), (SpD '1E+16'), (SpD '100000000000000'), (SpD '5E-324'), (SpD '1.7976931348623157E+308'), (SpD '2.5'), (SpD '3.14159265358979'),
        (SpD 'NaN'), (SpD 'Infinity'), (SpD '-Infinity'), (SpD '0.1000000000000001'), (SpD '9007199254740993'), (SpD '4.35'), (SpD '1234567.891'),
        (SpF '0.1'), (SpF '1E+20'), (SpF '3.4028235E+38'), (SpF '16777216'), (SpF '0.3'), (SpF '1.4E-45'), (SpF '123456.79'), (SpF '72'), (SpF '-0'),
        (SpM '0'), (SpM '1.50'), (SpM '-0.0'), (SpM '79228162514264337593543950335'), (SpM '0.0000000000000000000000000001'), (SpM '123456789.123456789'),
        (SpE 0), (SpE 6), (SpS ''), (SpS 'plain'),
        (SpS ('a"b\c' + [char]8 + [char]12 + "`n`r`t")), (SpS $controls), (SpS "<>&'"), (SpS ([string][char]0x7f)), (SpS ([string][char]0x2028 + [char]0x2029 + [char]0x85)),
        (SpS '한글 텍스트'), (SpS ('emoji ' + [char]::ConvertFromUtf32(0x1F600))), (SpS ('lone ' + [char]0xD800)), (SpS ($ascii)), (SpS '/path\to/file'), (SpS '\/Date(0)\/'),
        (SpS '</script>'), (SpS ([string][char]0xFFFF + [char]0xFEFF)))) {
    $n++
    Rec-Json ("scalar-$n") $spec 20
}
# dates
$n = 0
foreach ($spec in @(
        (SpDT '2026-09-12T03:04:05.0000000' 'u'), (SpDT '2026-09-12T03:04:05.1234567' 'l'), (SpDT '2026-09-12T03:04:05.0000000' 'n'),
        (SpDT '0001-01-01T00:00:00.0000000' 'n'), (SpDT '9999-12-31T23:59:59.9999999' 'u'), (SpDT '1970-01-01T00:00:00.0000000' 'u'))) {
    $n++
    Rec-Json ("date-$n") $spec 20
}

# ---- json writer: containers ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- json writer: containers ----"
$n = 0
foreach ($spec in @(
        (SpA @()), (SpA @((SpI 1))), (SpA @((SpI 1), (SpI 2))), (SpA @((SpN))), (SpA @((SpA @()))), (SpA @((SpA @((SpI 1))))), (SpA @((SpS 'a'), (SpS 'b'), (SpN), (SpB $true))),
        (SpO @()), (SpP @()),
        (SpO @(, @('a', (SpI 1)))), (SpO @(@('b', (SpI 1)), @('a', (SpI 2)), @('C', (SpI 3)))),
        (SpP @(@('z', (SpS 'x')), @('a', (SpA @())), @('m', (SpA @((SpI 1)))))),
        (SpO @(@('arr', (SpA @((SpO @(, @('x', (SpI 1))))))), @('nul', (SpN)), @('db', (SpDB)))),
        (SpO @(@('한글', (SpS '값')), @('emoji', (SpS ([char]::ConvertFromUtf32(0x1F600)))), @('a"b', (SpI 1)), @('<k>', (SpI 2)))),
        (SpO @(, @('', (SpI 1)))),
        (SpO @(@('opened', (SpB $true)), @('appPid', (SpI 1234)), @('windowHwnd', (SpL 4294967296)), @('app', (SpS 'Word')), @('ratio', (SpD '0.30000000000000004')), @('left', (SpD '72')), @('single', (SpF '72.5')))),
        (SpO @(, @('nested', (SpP @(, @('inner', (SpO @(, @('deep', (SpA @((SpI 1), (SpI 2)))))))))))),
        (SpA @((SpO @(, @('a', (SpI 1)))), (SpO @(, @('a', (SpI 2)))))),
        (SpO @(@('items', (SpA @((SpE 1), (SpE 2)))), @('mixed', (SpA @((SpI 1), (SpS 'two'), (SpD '3.5'), (SpM '4.0'), (SpN), (SpA @()))))))
    )) {
    $n++
    Rec-Json ("container-$n") $spec 20
}

# ---- json writer: depth (Emit-Json 20, cleanup 8, fingerprint 30) ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- json writer: depth (Emit-Json 20, cleanup 8, fingerprint 30) ----"
foreach ($kind in @('o', 'p', 'a')) {
    foreach ($depth in @(0, 1, 2, 3, 5, 7, 8, 9, 10, 19, 20, 21, 22, 29, 30, 31, 32, 35)) {
        foreach ($limit in @(8, 20, 30)) {
            Rec-Json ("depth-$kind-$depth-$limit") (SpNest $kind $depth (SpS 'leaf')) $limit
        }
    }
}
foreach ($kind in @('o', 'p', 'a')) {
    foreach ($limit in @(2, 3)) {
        Rec-Json ("depthmix-$kind-$limit") (SpNest $kind 6 (SpO @(@('n', (SpI 5)), @('s', (SpS 'text')), @('d', (SpD '1.5')), @('b', (SpB $true)), @('z', (SpN)), @('q', (SpP @(, @('x', (SpI 1))))), @('r', (SpA @((SpI 1), (SpI 2))))))) $limit
    }
}
$pcoProps = @(@('a', (SpI 1)), @('b', (SpS 'two')), @('c', (SpD '0.5')), @('d', (SpB $true)), @('e', (SpN)), @('f', (SpM '1.50')), @('g', (SpF '1.5')), @('h', (SpL 5)), @('i', (SpP @(, @('x', (SpI 1))))), @('j', (SpO @(, @('x', (SpI 1))))), @('k', (SpA @((SpI 1), (SpI 2)))), @('l', (SpA @())), @('m', (SpDB)), @('n', (SpE 3)))
Rec-Json 'depth-pco-scalars' (SpP $pcoProps) 1
Rec-Json 'depth-pco-nested' (SpNest 'p' 1 (SpP $pcoProps)) 1
Rec-Json 'depth-string-quote' (SpNest 'p' 1 (SpP @(@('a', (SpS 'x "y" <z>')), @('b', (SpS "line1`nline2")), @('c', (SpS ''))))) 1
Rec-Json 'depth-array-in-pco' (SpNest 'p' 1 (SpP @(@('a', (SpA @((SpI 1), (SpP @(, @('x', (SpI 1))))))), @('b', (SpA @(, (SpA @((SpI 1))))))))) 1

# ---- pipeline unrolling (Emit-Json / Snapshot-Fingerprint) ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- pipeline unrolling (Emit-Json / Snapshot-Fingerprint) ----"
$n = 0
foreach ($spec in @(
        (SpN), (SpA @()), (SpA @((SpI 1))), (SpA @((SpS 'one'))), (SpA @((SpI 1), (SpI 2))), (SpA @((SpA @((SpI 1), (SpI 2))))), (SpA @((SpA @()))), (SpA @((SpN))), (SpA @((SpO @(, @('a', (SpI 1)))))),
        (SpO @(, @('a', (SpA @((SpI 1)))))), (SpO @()), (SpS 'text'), (SpI 5), (SpA @((SpO @(, @('a', (SpI 1)))), (SpO @(, @('a', (SpI 2)))))), (SpP @(, @('a', (SpI 1)))), (SpDB), (SpA @((SpA @((SpI 1), (SpI 2))), (SpA @((SpI 3))))), (SpA @((SpI 1), (SpN), (SpI 2))), (SpA @((SpA @((SpI 1))), (SpI 2))), (SpA @((SpN), (SpN))), (SpA @((SpDB), (SpI 1))), (SpA @((SpA @((SpI 1))), (SpA @())))  )) {
    $n++
    Rec-Pipe "pipe-$n" $spec
}

# ---- fingerprints ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- fingerprints ----"
$n = 0
foreach ($spec in @(
        (SpN), (SpA @()), (SpA @((SpI 1))), (SpO @(@('format', (SpS 'xlsx')), @('sheets', (SpA @((SpO @(@('name', (SpS 'Sheet1')), @('mergedRanges', (SpA @()))))))))),
        (SpNest 'o' 28 (SpS 'leaf')), (SpNest 'o' 29 (SpS 'leaf')), (SpNest 'o' 30 (SpS 'leaf')), (SpNest 'p' 31 (SpS 'leaf')),
        (SpO @(@('text', (SpS '한글 😀 text')), @('n', (SpD '0.30000000000000004')))))) {
    $n++
    Rec-Fp "fp-$n" $spec
}
$n = 0
foreach ($text in @('', 'abc', '한글', ('emoji ' + [char]::ConvertFromUtf32(0x1F600)), ('lone ' + [char]0xD800), ($ascii))) {
    $n++
    Rec-Sha "sha-$n" $text
}

# ---- ConvertFrom-Json payloads ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- ConvertFrom-Json payloads ----"
$n = 0
foreach ($text in @(
        '{}', '{"a":1}', '{"a":-1,"b":2147483647,"c":2147483648,"d":-2147483649,"e":9223372036854775807,"f":9223372036854775808,"g":-9223372036854775808,"h":-9223372036854775809}',
        '{"a":1.5,"b":0.1,"c":1.50,"d":-0.0,"e":1e3,"f":1E3,"g":2.5e-3,"h":1.0,"i":123456789012345678901234567890,"j":1.7976931348623157e308,"l":0.00000000000000000000000000001,"m":79228162514264337593543950336.5}', '{"k":1e400}',
        '{"a":0,"b":-0,"c":00,"d":1.}', '{"a":[]}', '{"a":[1]}', '{"a":[1,2,[3,[]]]}', '{"a":null,"b":true,"c":false}',
        '{"a":{"b":{"c":[{"d":1}]}}}', '{"Name":"x","name":"y"}', '{"a":1,"A":2}', '{"a":1,"a":2}', '{"a":{"b":1,"B":2}}', '{"a":[{"x":1,"X":2}]}',
        '{"ключ":1,"Ключ":2}', '{"é":1,"É":2}', '{"i":1,"I":2}', '{"ß":1,"SS":2}',
        '{"a":"\u0041\n\t\"\\\/","b":"\ud83d\ude00","c":"한글","d":"\u0000"}', '{"d":"\/Date(0)\/"}', '{"d":"\/Date(1700000000000)\/"}', '{"d":"\/Date(1700000000000+0900)\/"}', '{"d":"/Date(0)/"}', '{"d":"2026-09-12T03:04:05Z"}',
        '[1,2]', '[]', '[{"a":1}]', '"text"', '5', '1.5', 'null', 'true', '',
        '{"a":1,}', '{"a":}', '{', '{"a":1', '{a:1}', "{'a':1}", '{"a":01}', '{"a":+1}', '{"a":.5}', '{"a":NaN}', '{"a":Infinity}', '{"a":1} x', '{"a":1}{"b":2}', '{"a":"x}', '{"a":"\x"}', '{"a":"\u00G0"}',
        ('{"a":"' + [char]1 + '"}'), "{`"a`":`"line1`nline2`"}", "{`"a`":1,`n`"b`":2}", ' { "a" : 1 } ', ('{"x":' + ('[' * 100) + (']' * 100) + '}'), ('{"x":' + ('[' * 101) + (']' * 101) + '}'), ('{"x":' + ('[' * 200) + (']' * 200) + '}'),
        '{"a":1,"b":{"c":2,"C":3}}', '{"requestId":"r1","action":"open_session","format":"DOCX","path":"C:\\\\Users\\\\x\\\\a.docx","properties":{"Left":72,"top":"10"}}')) {
    $n++
    Rec-Payload "payload-$n" $text
}

# malformed and edge payloads (positions and texts of JavaScriptSerializer's errors, number kinds)
foreach ($text in @(
        '{"a":x}', '{"a":tru}', '{"a":nul}', '{"a":1x}', '{"a":--1}', '{"a":1e}', '{"a":1.2.3}', '[1,]', '[,1]', '[1 2]', '[1', '[', ']', '{"a" 1}', '{"a":1 "b":2}', '{,}', '{"a":1,,"b":2}', '{"a":[1,}', '{"a":"x',
        "{'a':'b'}", "{'a':`"b`"}", '{"a":"b''c"}', '{"a":"\u12"}', '{"a":"\u"}', '"abc', '"a\"', '{"aA":1}', '{"":1}', '{"a" :1}', '{ "a" : [ 1 , 2 ] }', '[1,2', '{"a":tRue}', '{"a":True}', '{"a":NULL}', '{"a":-}', '{"a":-Infinity}', '{"a":+Infinity}', '{"a":nan}', '{"a":0x10}',
        '{"a":1_0}', '{"a":1e5}', '{"a":1E+5}', '{"a":1e-5}', '{"a":-1.5e3}', '{"a":123456789012}', '{"a":9223372036854775807}', '{"a":-9223372036854775808}', '{"a":00012}', '{"a":1.50}', '{"a":0.00000000000000000000000000001}', '{"a":0.00000000000000000000000000009}',
        '{"a":79228162514264337593543950335}', '{"a":79228162514264337593543950336}', '{"a":1.7976931348623157e308}', '{"a":1e308}', '{"a":1e-400}', '{"a":4.9e-324}', '{"a":12345678901234567890.123}', '{"a":2147483648.5}', '{"a":-0.0}', '{"a":-0}', '{"a":-0e0}',
        ("{`"a`":`"" + [char]9 + "`"}"), '{"a":"\ud800"}', '{"a":"\udc00x"}', '{"a":"\ud83d"}', '{"a":"\ud83dx"}', '{"a":"\/Date(abc)\/"}', '{"a":"\/Date(1700000000000-0500)\/"}', '{"a":"\/Date(-1)\/"}', '{"a":"x\/Date(0)\/"}', '{"a":"\/Date(0)\/x"}', '{"a":"\/DATE(0)\/"}', '{"a":"\/Date()\/"}', '{"a":"\/Date(9223372036854775807)\/"}',
        '{"a":"\/Date(253402300800000)\/"}', '{"a":"\/Date(-62135596800001)\/"}', '{"a":"\/Date( 5 )\/"}', '{"a":"\/Date(1+2)\/"}', '{"a":"\/Date(1700000000000+09)\/"}', '{"a":"\/Date(1700000000000+0930)\/"}')) {
    $n++
    Rec-Payload "payload-$n" $text
}
foreach ($count in 95..106) {
    $n++
    Rec-Payload "payload-deepobj-$count" ('{"x":' + ('[' * $count) + (']' * $count) + '}')
    Rec-Payload "payload-deeproot-$count" (('[' * $count) + (']' * $count))
    Rec-Payload "payload-deepdict-$count" (('{"a":' * $count) + '1' + ('}' * $count))
}

# property reads
$doc = '{"Format":"Docx","action":"detect","n":5,"nul":null,"arr":[1,2],"empty":[],"obj":{"Inner":1},"flag":false,"zero":0,"str":"","length":3,"Count":7}'
$n = 0
foreach ($name in @('format', 'FORMAT', 'Action', 'n', 'nul', 'missing', 'arr', 'empty', 'obj', 'flag', 'zero', 'str', 'length', 'count', 'COUNT', 'Name', 'inner')) {
    $n++
    Rec-Get "get-$n" $doc $name
}
$opDoc = '{"left":72,"Top":0,"properties":{"left":10,"width":"5","nul":null,"Height":4.5},"zero":0,"nul":null,"flag":false,"s":""}'
$n = 0
foreach ($name in @('left', 'LEFT', 'top', 'width', 'height', 'nul', 'zero', 'flag', 's', 'absent', 'properties')) {
    $n++
    Rec-OpProp "opprop-$n" $opDoc $name (SpI 99)
}
Rec-OpProp 'opprop-noprops' '{"a":1}' 'b' (SpS 'fallback')
Rec-OpProp 'opprop-propsnull' '{"properties":null}' 'b' (SpN)
Rec-OpProp 'opprop-propsscalar' '{"properties":5}' 'b' (SpN)
Rec-OpProp 'opprop-propsarray' '{"properties":[1]}' 'b' (SpI 3)

# ---- casts ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- casts ----"
$int_inputs = @(
    (SpN), (SpB $true), (SpB $false), (SpI 5), (SpI -5), (SpL 7), (SpL 2147483648), (SpL -2147483649), (SpD '2.5'), (SpD '3.5'), (SpD '-2.5'), (SpD '-3.5'), (SpD '0.5'), (SpD '1.5'), (SpD '-0.5'), (SpD '2.4999999999999996'),
    (SpD '2147483647.4'), (SpD '2147483647.5'), (SpD '-2147483648.5'), (SpD '-2147483648.4'), (SpD '1E+20'), (SpD 'NaN'), (SpF '2.5'), (SpF '3.5'), (SpM '2.5'), (SpM '3.5'), (SpM '-2.5'), (SpM '79228162514264337593543950335'),
    (SpS '7'), (SpS '-7'), (SpS '+7'), (SpS ' 7 '), (SpS "`t7`n"), (SpS '0x10'), (SpS '0X1f'), (SpS '-0x10'), (SpS '0xFFFFFFFF'), (SpS '0x7FFFFFFF'), (SpS '0x80000000'), (SpS '0x'), (SpS '0xZZ'), (SpS '1,000'), (SpS '1,0,0,0'), (SpS '1e3'), (SpS '1E3'),
    (SpS '2.5'), (SpS '3.5'), (SpS '-2.5'), (SpS '2.'), (SpS '.5'), (SpS '1.5e1'), (SpS ''), (SpS ' '), (SpS 'abc'), (SpS '1 2'), (SpS '2147483647'), (SpS '2147483648'), (SpS '-2147483648'), (SpS '-2147483649'), (SpS '9999999999999'),
    (SpS '1e20'), (SpS '0b11'), (SpS '१२'), (SpS '１２'), (SpS '1_000'), (SpS '+-1'), (SpS '--1'), (SpS '(1)'), (SpS '1-'), (SpS 'NaN'), (SpS 'Infinity'), (SpS '$1'), (SpS '1%'), (SpS '007'), (SpS '7.0'), (SpS '7.99'), (SpS '1e-3'), (SpS '2147483647.5'),
    (SpA @()), (SpA @((SpI 4))), (SpA @((SpS '4'))), (SpA @((SpI 1), (SpI 2))), (SpO @()), (SpDB), (SpE 3), (SpP @(, @('a', (SpI 1)))))
$n = 0
foreach ($spec in $int_inputs) {
    $n++
    Rec-Cast "cast-int-$n" 'int' @($spec)
    Rec-Cast "cast-int64-$n" 'int64' @($spec)
    Rec-Cast "cast-double-$n" 'double' @($spec)
    Rec-Cast "cast-single-$n" 'single' @($spec)
    Rec-Cast "cast-bool-$n" 'bool' @($spec)
    Rec-Cast "cast-string-$n" 'string' @($spec)
    Rec-Cast "cast-asint-$n" 'asint' @($spec)
    Rec-Cast "cast-tryparse-$n" 'tryparse' @($spec)
}
$n = 0
foreach ($spec in @(
        (SpD '0.1'), (SpD '0.30000000000000004'), (SpD '1E+20'), (SpD '1E+15'), (SpD '1E+14'), (SpD '123456789012345678'), (SpD '100'), (SpD '-0'), (SpD '1E-05'), (SpD '0.0001'), (SpD '0.00001234'), (SpD '5E-324'), (SpD '1.7976931348623157E+308'),
        (SpD '3.14159265358979'), (SpD '0.1000000000000001'), (SpD '999999999999999'), (SpD '999999999999999.9'), (SpD '1234567.891'), (SpD '1E+300'), (SpD '72'), (SpD '72.5'), (SpD '1.005'), (SpD '2.675'), (SpD 'NaN'), (SpD 'Infinity'), (SpD '-Infinity'),
        (SpF '0.1'), (SpF '1E+20'), (SpF '16777216'), (SpF '123456.79'), (SpF '1234567.8'), (SpF '0.0001'), (SpF '1E-05'), (SpF '3.4028235E+38'), (SpF '72'), (SpF '1.4E-45'),
        (SpM '1.50'), (SpM '0'), (SpM '-0.0'), (SpM '79228162514264337593543950335'), (SpM '0.0000000000000000000000000001'),
        (SpI 0), (SpI -5), (SpL 9223372036854775807), (SpB $true), (SpB $false), (SpN), (SpDB), (SpS 'x'), (SpE 3), (SpA @()), (SpA @((SpI 1), (SpS 'a'), (SpN))), (SpA @((SpA @((SpI 1))))), (SpO @(, @('a', (SpI 1)))),
        (SpP @(, @('a', (SpI 1)))), (SpDT '2026-09-12T03:04:05.0000000' 'n'))) {
    $n++
    Rec-Cast "cast-string2-$n" 'string' @($spec)
    Rec-Cast "cast-interp-$n" 'interp' @($spec)
}
$n = 0
foreach ($spec in @((SpD '0.5'), (SpD '1.5'), (SpD '2.5'), (SpD '3.5'), (SpD '-0.5'), (SpD '-1.5'), (SpD '-2.5'), (SpD '0.49999999999999994'), (SpD '2.675'), (SpD '1.005'), (SpD '1.115'), (SpD '72.125'), (SpD '72.135'), (SpD '1E+20'), (SpD '1E+16'), (SpD '9007199254740993'), (SpD '4503599627370497'),
        (SpD '0.285'), (SpD '-72.125'), (SpD 'NaN'), (SpD '10.55'), (SpD '1.45'), (SpD '0.005'), (SpD '0.015'), (SpD '8.345'), (SpD '2147483647.5'), (SpD '2147483648.5'), (SpD '-2147483648.5'), (SpD '-2147483649.5'), (SpD '3E+9'))) {
    $n++
    Rec-Cast "cast-round0-$n" 'round0' @($spec)
    Rec-Cast "cast-round2-$n" 'round2' @($spec)
    Rec-Cast "cast-roundint-$n" 'roundint' @($spec)
}
$n = 0
foreach ($spec in @((SpI 5), (SpI -5), (SpL 5), (SpD '2.5'), (SpD '-2.5'), (SpD '2.4'), (SpD '-0.5'), (SpD '1E+20'), (SpF '2.5'), (SpM '2.5'), (SpM '-2.5'), (SpS '2.5'), (SpS '5'), (SpS 'abc'), (SpN), (SpB $true), (SpD 'NaN'), (SpD 'Infinity'), (SpD '-0'), (SpA @((SpI 1))))) {
    $n++
    Rec-Cast "cast-floor-$n" 'floor' @($spec)
}
$mm = @((SpI 0), (SpI 1), (SpI -3), (SpI 2147483647), (SpL 5), (SpL 9223372036854775807), (SpD '2.5'), (SpD '0'), (SpD '-0'), (SpD 'NaN'), (SpD '1E+20'), (SpF '2.5'), (SpM '2.5'), (SpM '1'), (SpS '3'), (SpS 'a'), (SpN), (SpB $true))
$n = 0
foreach ($a in $mm) {
    foreach ($b in $mm) {
        $n++
        Rec-Cast "cast-max-$n" 'max' @($a, $b)
        Rec-Cast "cast-min-$n" 'min' @($a, $b)
    }
}
$n = 0
foreach ($spec in @((SpI 0), (SpI 5), (SpI 255), (SpI 256), (SpI 4095), (SpI -1), (SpI -255), (SpL 255), (SpL 4294967296), (SpL -1), (SpD '255'), (SpD '254.5'), (SpD '255.5'), (SpD '-1'), (SpM '255'), (SpS '255'), (SpS 'x'), (SpN), (SpB $true), (SpI 2147483647))) {
    $n++
    Rec-Cast "cast-hex2-$n" 'hex2' @($spec)
}
$n = 0
foreach ($spec in @((SpS 'FF0000'), (SpS '#00FF00'), (SpS '0000ff'), (SpS '123456'), (SpS 'ffffff'), (SpS '000000'), (SpS '##123456'), (SpS '12345'), (SpS '1234567'), (SpS 'GG0000'), (SpS ''), (SpS '#'), (SpS ' 12345'), (SpS '#12 456'), (SpS '-12345'), (SpS '+12345'), (SpS '0x1234'), (SpN))) {
    $n++
    Rec-Cast "cast-cvalue-$n" 'cvalue' @($spec)
}
$n = 0
foreach ($spec in @((SpI 0), (SpI 255), (SpI 256), (SpI 65535), (SpI 65536), (SpI 16777215), (SpI 16777216), (SpI 33554431), (SpI -1), (SpI -256), (SpL 4294967295), (SpL 16777215), (SpL -16777216), (SpD '16711680'), (SpD '255.5'), (SpD '254.5'), (SpD '1E+10'), (SpS '255'), (SpS 'x'), (SpN), (SpB $true), (SpM '255.5'), (SpL 9223372036854775807), (SpL -9223372036854775808))) {
    $n++
    Rec-Cast "cast-chex-$n" 'chex' @($spec)
}
$arith = @((SpI 0), (SpI 1), (SpI 2), (SpI 3), (SpI -7), (SpI 256), (SpI 65536), (SpI 2147483647), (SpI -2147483648), (SpL 5), (SpL 9223372036854775807), (SpL -9223372036854775808), (SpD '2.5'), (SpD '0'), (SpD '0.1'), (SpD '0.2'), (SpD '-0'), (SpD 'NaN'), (SpD '1E+20'))
$n = 0
foreach ($a in $arith) {
    foreach ($b in $arith) {
        $n++
        Rec-Cast "cast-add-$n" 'add' @($a, $b)
        Rec-Cast "cast-sub-$n" 'sub' @($a, $b)
        Rec-Cast "cast-mul-$n" 'mul' @($a, $b)
        Rec-Cast "cast-div-$n" 'div' @($a, $b)
        Rec-Cast "cast-gt-$n" 'gt' @($a, $b)
        Rec-Cast "cast-eq-$n" 'eq' @($a, $b)
    }
}
$n = 0
foreach ($pair in @(@('detect', 'DETECT'), @('detect', 'detect'), @('a', 'b'), @('ß', 'SS'), @('İ', 'i'), @('한글', '한글'), @('é', 'É'), @('K', [string][char]0x212A))) {
    $n++
    Rec-Cast "cast-streq-$n" 'eq' @((SpS $pair[0]), (SpS $pair[1]))
    Rec-Cast "cast-strceq-$n" 'ceq' @((SpS $pair[0]), (SpS $pair[1]))
    Rec-Cast "cast-strgt-$n" 'gt' @((SpS $pair[0]), (SpS $pair[1]))
}

foreach ($spec in @((SpA @((SpI 0))), (SpA @((SpS ''))), (SpA @((SpS '0'))), (SpA @((SpB $false))), (SpA @((SpN))), (SpA @((SpA @()))), (SpA @((SpI 0), (SpI 0))), (SpS 'False'), (SpS '0'), (SpD '0'), (SpM '0.0'), (SpF '0'), (SpL 0), (SpI 0))) {
    $n++
    Rec-Cast "cast-bool2-$n" 'bool' @($spec)
}
foreach ($spec in @((SpD 'Infinity'), (SpD '-Infinity'), (SpS '-Infinity'), (SpS '+Infinity'), (SpS 'infinity'), (SpS 'nan'), (SpS ' NaN '), (SpS '1,5'), (SpS '1.5.5'), (SpS '1e'), (SpS 'e5'), (SpS '1e+'), (SpS '.'), (SpS '-'), (SpS '+'), (SpS '1 e5'), (SpS '1,000.5'), (SpS ',1'), (SpS '1,'), (SpS '1,,0'), (SpS '1e5.5'), (SpS '١'))) {
    $n++
    Rec-Cast "cast-double2-$n" 'double' @($spec)
    Rec-Cast "cast-single2-$n" 'single' @($spec)
    # The message of a refused infinity carries the culture's infinity sign, so the integer casts are not recorded for it.
    if ($spec -notlike '*"t":"d"*Infinity*') {
        Rec-Cast "cast-int2-$n" 'int' @($spec)
        Rec-Cast "cast-int642-$n" 'int64' @($spec)
    }
}

# ---- Sort-Object / Group-Object ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- Sort-Object / Group-Object ----"
$words = @('banana', 'Apple', 'apple', 'cherry', 'APPLE', 'Banana', 'a', 'B', 'ab', 'aB', 'Ab', 'a b', 'a-b', 'a_b', 'a.b', 'a1', 'a10', 'a2', 'A1', '1', '10', '2', '_x', '-x', '.x', ' x', 'x', 'é', 'e', 'f', 'E', 'É', 'z', 'Z', 'ä', 'a', 'æ', 'ss', 'ß', 'Ω', 'ω', 'я', 'Я', '', 'A1:B2', 'A1:A2', 'A10:B2', 'a1:b2', 'Sheet1!A1', "tab`there", 'cat', 'Cat', 'cAt')
$hangul = @('나', '가', '다', '하', '가나', '가가', '각', '개', '갸', '힣', '가A', 'A가', 'ㄱ', 'ㅏ', '한글', '漢字', '日本語', 'abc', 'ABC', '가1', '1가')
$sw = @($words | ForEach-Object { SpS $_ })
$sh = @($hangul | ForEach-Object { SpS $_ })
Rec-Sort 'sort-words' $sw $false $false
Rec-Sort 'sort-words-desc' $sw $true $false
Rec-Sort 'sort-words-unique' $sw $false $true
Rec-Sort 'sort-words-desc-unique' $sw $true $true
Rec-Sort 'sort-hangul' $sh $false $false
Rec-Sort 'sort-hangul-unique' $sh $false $true
Rec-Sort 'sort-mixed-words' @($sw + $sh) $false $false
Rec-Sort 'sort-ranges' @(@('B2:C3', 'A1:B2', 'a1:b2', 'A10:B20', 'A2:B3', 'AA1:AB2', 'Z1:Z9') | ForEach-Object { SpS $_ }) $false $false
Rec-Sort 'sort-empty' @() $false $false
Rec-Sort 'sort-single' @((SpS 'x')) $false $false
Rec-Sort 'sort-ints' @((SpI 3), (SpI 1), (SpI 2), (SpI 10), (SpI -1), (SpI 1)) $false $false
Rec-Sort 'sort-ints-unique' @((SpI 3), (SpI 1), (SpI 2), (SpI 10), (SpI -1), (SpI 1)) $false $true
Rec-Sort 'sort-ints-desc' @((SpI 3), (SpI 1), (SpI 2), (SpI 10), (SpI -1), (SpI 1)) $true $false
Rec-Sort 'sort-doubles' @((SpD '12'), (SpD '255'), (SpD '0'), (SpD '12'), (SpD '16711680'), (SpD '-1'), (SpD '0.5')) $false $true
Rec-Sort 'sort-doubles-plain' @((SpD '12'), (SpD '255'), (SpD '0'), (SpD '12'), (SpD '0.5')) $false $false
Rec-Sort 'sort-numeric-mixed' @((SpI 3), (SpD '2.5'), (SpL 2), (SpM '2.50'), (SpF '1.5'), (SpI 2)) $false $false
Rec-Sort 'sort-numeric-mixed-unique' @((SpI 3), (SpD '2.5'), (SpL 2), (SpM '2.50'), (SpF '1.5'), (SpI 2)) $false $true
Rec-Sort 'sort-null' @((SpS 'b'), (SpN), (SpS 'a')) $false $false
Rec-Sort 'sort-null-ints' @((SpI 2), (SpN), (SpI 1)) $false $false
Rec-Sort 'sort-null-ints-unique' @((SpI 2), (SpN), (SpI 1), (SpN)) $false $true
Rec-Sort 'sort-str-int' @((SpS '10'), (SpI 9), (SpS '9'), (SpI 10), (SpS 'a')) $false $false
Rec-Sort 'sort-int-str' @((SpI 10), (SpS '9'), (SpI 9)) $false $false
Rec-Sort 'sort-bool' @((SpB $true), (SpB $false), (SpB $true)) $false $false
Rec-SortKey 'sortkey-1' @((SpO @(@('type', (SpS 'p')), @('start', (SpI 30)))), (SpO @(@('type', (SpS 't')), @('start', (SpI 5)))), (SpO @(@('type', (SpS 'x')), @('start', (SpI 30)))), (SpO @(@('type', (SpS 'y')), @('start', (SpI 5)))), (SpO @(@('type', (SpS 'z')), @('start', (SpI 12)))))
Rec-Group 'group-1' @((SpI 1), (SpI 2), (SpI 2), (SpI 3), (SpI 3), (SpI 3))
Rec-Group 'group-2' @((SpI 2), (SpI 2), (SpI 1), (SpI 1), (SpI 3))
Rec-Group 'group-3' @((SpI 1), (SpI 2), (SpI 3))
Rec-Group 'group-4' @((SpI 3), (SpI 1), (SpI 1), (SpI 3), (SpI 2), (SpI 2))
Rec-Group 'group-5' @((SpS 'a'), (SpS 'A'), (SpS 'b'), (SpS 'B'), (SpS 'b'))
Rec-Group 'group-6' @((SpI 1), (SpS '1'), (SpD '1'), (SpI 2))
Rec-Group 'group-7' @((SpI 1))
Rec-Group 'group-8' @((SpD '1.5'), (SpD '1.5'), (SpI 2), (SpD '2'))
Rec-Group 'group-10' @((SpI 0), (SpI 1), (SpI 1), (SpI 0), (SpI 2), (SpI 0), (SpI 1))

# ---- text operators ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- text operators ----"
$dec = '^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+|[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?)%?$'
$n = 0
foreach ($row in @(
        @('match', 'ABC', 'abc'), @('match', 'abc', '^A'), @('cmatch', 'abc', '^A'), @('cmatch', 'Abc', '^A'), @('notmatch', 'abc', 'X'), @('match', 'a b', '\S'), @('match', ' ', '\S'), @('match', '', '\S'), @('match', "a`nb", '^b'), @('match', "a`n", 'a$'), @('match', "a`n", 'a\z'), @('match', "a`r`n", 'a$'),
        @('match', '12', $dec), @('match', '1,234.5%', $dec), @('match', "12`n", '^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)$'), @('match', '١٢', '^\d+$'), @('match', 'é', '^\w$'), @('match', '한', '^\w$'), @('match', 'İ', 'i'), @('match', 'K', 'k'), @('match', 'ß', 'SS'),
        @('match', 'x', '('), @('match', 'x', '[a'), @('match', 'x', '*'), @('match', 'x', '(?<n>x)'),
        @('replace', 'a  b   c', '\s+', ' '), @('replace', 'Hello World', 'o', '0'), @('replace', 'Hello World', 'O', '0'), @('creplace', 'Hello World', 'O', '0'), @('replace', 'Foo_Bar-baz qux', '[\s-]+', '_'), @('replace', ' Mixed - Case ', '[\s-]+', '_'),
        @('replace', 'abc', '(b)', '[$1]'), @('replace', 'abc', '(?<x>b)', '[${x}]'), @('replace', 'abc', '(b)', '$1$1'), @('replace', 'abc', '(b)', '${1}0'), @('replace', 'abc', 'b', '$&$&'), @('replace', 'abc', 'b', '$$'), @('replace', 'abc', 'b', '$0'), @('replace', 'abc', 'b', '$9'), @('replace', 'abc', '(b)', '$10'),
        @('replace', 'abc', 'b', '$`'), @('replace', 'abc', 'b', "`$'"), @('replace', 'abc', 'b', '$+'), @('replace', 'abc', '(a)(b)', '$+'), @('replace', 'abc', 'b', '$_'), @('replace', 'abc', 'b', '$'), @('replace', 'abc', 'b', '$z'), @('replace', 'abc', 'b', '${z}'), @('replace', 'abc', 'b', '${'), @('replace', 'abc', '', '-'), @('replace', 'abc', 'x*', '-'),
        @('replace', 'a.b', '\.', '\'), @('replace', 'a.b', '.', ''), @('replace', "line1`r`nline2", "`r`n", ' '), @('replace', 'x', '(', '1'),
        @('split', 'a,b,c', ','), @('split', 'a1b2c', '\d'), @('split', 'a1b2c', '(\d)'), @('split', 'A-b-C', 'b'), @('split', '', ','), @('split', 'abc', ''), @('split', ',a,', ','), @('split', 'a, b', ',\s*'), @('split', 'a||b', '\|'),
        @('like', 'abc', 'a*'), @('like', 'ABC', 'a*'), @('like', '=SUM(A1)', '=*'), @('like', 'SUM', '=*'), @('like', '', '=*'), @('like', '=', '=*'), @('like', 'a=b', '=*'), @('like', "=a`nb", '=*'), @('like', 'abc', 'a?c'), @('like', 'abc', 'a[b]c'), @('like', 'a*c', 'a`*c'), @('like', 'abc', '[a-c]bc'), @('like', 'abc', '*'),
        @('escape', 'a.b*c'), @('escape', 'a b'), @('escape', "tab`there"), @('escape', "a`nb`rc"), @('escape', '\^$.|?*+()[]{}#'), @('escape', ''), @('escape', 'x-y,z'), @('escape', "a`fb`vc"), @('escape', '한글 text'),
        @('trimend', "text`r`a`r"), @('trimend', "text`n"), @('trimend', "text`r`n"), @('trimend', "`r"), @('trimend', ''), @('trimend', "a`a b`a"), @('trimend', "a  "),
        @('join', 'a', 'b'), @('lower', 'ABC İ ß Σ'), @('trim', '##abc#'), @('trim', 'abc')
    )) {
    $n++
    Rec-Text "text-$n" $row[0] @($row[1..($row.Length - 1)])
}

# ---- VT_DATE ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- VT_DATE ----"
$n = 0
foreach ($oa in @('0', '1', '-1', '2', '25569', '36526', '45912.12345', '45912.5', '45912.999999999', '45912.0000000001', '45912.00000579', '45912.000005787', '45658.75', '44927.0000115', '-0.5', '-1.5', '-657434.9999999', '-657434.99999999', '-657435', '2958465.9999999', '2958466', '1E+20', 'NaN', '0.00001157407', '43831.04166666667', '43831.083333333336', '43830.99999999999', '61.5', '60.5', '59.5', '1.0000000001', '-0.0000001', '40000.123456789', '2.5', '3.5', '-2.5', '-3.5', '45000.0000057870', '45000.0000058')) {
    $n++
    Rec-Date "date-oa-$n" $oa
}

# ---- write ----
Write-Host ("[{0}] {1} " + $entries.Count) (Get-Date -Format HH:mm:ss) "# ---- write ----"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$corpus = '[' + "`n" + ($entries -join ",`n") + "`n" + ']' + "`n"
$corpusPath = Join-Path $Out 'corpus.json'
[System.IO.File]::WriteAllText($corpusPath, $corpus, $utf8)
$bytes = [System.IO.File]::ReadAllBytes($corpusPath)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
$culture = [System.Threading.Thread]::CurrentThread.CurrentCulture
$tz = [TimeZoneInfo]::Local
$manifest = '{' + "`n" +
'  "recorder": "recorder/pswire-corpus.ps1",' + "`n" +
'  "powershell": ' + (J $PSVersionTable.PSVersion.ToString()) + ',' + "`n" +
'  "clr": ' + (J $PSVersionTable.CLRVersion.ToString()) + ',' + "`n" +
'  "os": ' + (J ([System.Environment]::OSVersion.VersionString)) + ',' + "`n" +
'  "culture": ' + (J $culture.Name) + ',' + "`n" +
'  "uiCulture": ' + (J ([System.Threading.Thread]::CurrentThread.CurrentUICulture.Name)) + ',' + "`n" +
'  "timeZone": ' + (J $tz.Id) + ',' + "`n" +
'  "entries": ' + $entries.Count + ',' + "`n" +
'  "corpusSha256": ' + (J $hash) + "`n" + '}' + "`n"
[System.IO.File]::WriteAllText((Join-Path $Out 'MANIFEST.json'), $manifest, $utf8)
"wrote $($entries.Count) entries, sha256 $hash"
