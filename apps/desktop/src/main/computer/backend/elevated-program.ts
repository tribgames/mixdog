import { BLOCKED_COMPUTER_KEY_PATTERN_SOURCE } from '../input/guards';
import { deflateRawSync } from 'node:zlib';

/** Keep both Windows launcher command lines below CreateProcess's size limit. */
export function elevatedProgramInvocation(program = ELEVATED_BOOTSTRAP): string {
  const compressed = deflateRawSync(Buffer.from(program, 'utf8')).toString('base64');
  return [
    `$compressed = [IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'))`,
    '$inflater = [IO.Compression.DeflateStream]::new($compressed, [IO.Compression.CompressionMode]::Decompress)',
    '$reader = [IO.StreamReader]::new($inflater, [Text.Encoding]::UTF8)',
    'try { $program = $reader.ReadToEnd() } finally { $reader.Dispose(); $inflater.Dispose(); $compressed.Dispose() }',
    '. ([scriptblock]::Create($program))',
  ].join('\n');
}

export const ELEVATED_SUPERVISION = String.raw`
function Test-Cancelled {
  if ([DateTime]::UtcNow -ge $deadline -or [System.IO.File]::Exists($cancelPath)) { return $true }
  try {
    $parent = [System.Diagnostics.Process]::GetProcessById([int]$env:MIXDOG_ELEVATED_PARENT_PID)
    try {
      return $parent.StartTime.ToUniversalTime().Ticks -ne [long]$env:MIXDOG_ELEVATED_PARENT_TICKS
    } finally { $parent.Dispose() }
  } catch { return $true }
}

function Stop-InputWorker {
  if ($null -eq $worker -or $workerStopped) { return }
  if (-not $worker.HasExited) { $worker.Kill() }
  if (-not $worker.WaitForExit(5000)) { throw 'privileged_worker_cleanup_unconfirmed' }
  $script:workerStopped = $true
  & $releaseInput
}

function Wait-InputWorker {
  while (-not $worker.WaitForExit(50)) {
    if (Test-Cancelled) { throw 'privileged_worker_cancelled' }
  }
  $script:workerStopped = $true
}

function Write-Receipt([string]$line) {
  if (-not $workerStopped) { throw 'privileged_worker_cleanup_unconfirmed' }
  [System.IO.File]::WriteAllText(
    $responsePath, $token + [Environment]::NewLine + 'STOPPED' + [Environment]::NewLine + $line,
    [System.Text.Encoding]::UTF8)
}
`;

/** Extract a literal source value only after the host bytes pass authentication. */
export const ELEVATED_INPUT_SOURCE = String.raw`
function Read-OwnedInputSource([byte[]]$hostBytes) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput(
    [Text.Encoding]::UTF8.GetString($hostBytes), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'privileged worker host source could not be parsed' }
  $assignments = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
      $node.Left.VariablePath.UserPath -ceq 'MixdogHostSource'
  }, $true))
  if ($assignments.Count -ne 1) { throw 'privileged worker native source is ambiguous' }
  if ($assignments[0].Right -isnot [System.Management.Automation.Language.CommandExpressionAst]) {
    throw 'privileged worker native source is not literal'
  }
  $expression = $assignments[0].Right.Expression
  if ($expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
    if ($expression.NestedExpressions.Count -ne 0) { throw 'privileged worker native source is not literal' }
  } elseif ($expression -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
    throw 'privileged worker native source is not literal'
  }
  return [string]$expression.Value
}
`;

/**
 * The elevated parent owns its one input child. Losing the unelevated launcher,
 * cancellation, and the deadline all stop that child before issuing a receipt.
 */
export const ELEVATED_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$token = [string]$env:MIXDOG_ELEVATED_TOKEN
$hostScript = [string]$env:MIXDOG_ELEVATED_HOST_SCRIPT
$hostSha256 = [string]$env:MIXDOG_ELEVATED_HOST_SHA256
$requestPath = [string]$env:MIXDOG_ELEVATED_REQUEST
$requestSha256 = [string]$env:MIXDOG_ELEVATED_REQUEST_SHA256
$responsePath = [string]$env:MIXDOG_ELEVATED_RESPONSE
$cancelPath = [string]$env:MIXDOG_ELEVATED_CANCEL
$marker = [string]$env:MIXDOG_ELEVATED_MARKER
$protectedHost = $null
$worker = $null
$workerStopped = $true
$ownedInputSource = $null
$deadline = [DateTime]::UtcNow.AddSeconds(110)
$releaseInput = {
  if ([string]::IsNullOrWhiteSpace($ownedInputSource)) { throw 'input_cleanup_unconfirmed: authenticated native source is unavailable' }
  Add-Type -AssemblyName Accessibility
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition $ownedInputSource
  [MixNativeInput]::ReleaseOwned([IntPtr][long]$env:MIXDOG_COMPUTER_INPUT_MARKER)
}

${ELEVATED_SUPERVISION}
${ELEVATED_INPUT_SOURCE}

function Get-Sha256Hex([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Set-AdminOnlyDirectory([string]$path) {
  [void][System.IO.Directory]::CreateDirectory($path)
  $administrators = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $system = New-Object System.Security.Principal.SecurityIdentifier(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($administrators)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $administrators, $full, $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $system, $full, $inheritance, $propagation, $allow)))
  [System.IO.Directory]::SetAccessControl($path, $acl)
}

try {
  foreach ($value in @($token,$hostScript,$hostSha256,$requestPath,$requestSha256,$responsePath,$cancelPath,$marker)) {
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'privileged worker environment is incomplete' }
  }
  if ($token -notmatch '^[A-Za-z0-9_-]{32,}$') { throw 'privileged worker token is malformed' }
  if (Test-Cancelled) { throw 'privileged_worker_cancelled' }
  $hostBytes = [System.IO.File]::ReadAllBytes($hostScript)
  if ((Get-Sha256Hex $hostBytes) -ne $hostSha256.ToLowerInvariant()) {
    throw 'privileged worker host authentication failed'
  }
  $ownedInputSource = Read-OwnedInputSource $hostBytes
  $requestBytes = [System.IO.File]::ReadAllBytes($requestPath)
  if ((Get-Sha256Hex $requestBytes) -ne $requestSha256.ToLowerInvariant()) {
    throw 'privileged worker request authentication failed'
  }
  $requestText = [System.Text.Encoding]::UTF8.GetString($requestBytes)
  $request = $requestText | ConvertFrom-Json
  if ($null -ne $request.authorization_expires_at) {
    $authorizationDeadline = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.authorization_expires_at).UtcDateTime
    if ($authorizationDeadline -lt $deadline) { $deadline = $authorizationDeadline }
    if (Test-Cancelled) { throw 'computer_policy_expired: authorization expired before elevated input' }
  }
  $allowed = @('click','double_click','right_click','middle_click','triple_click','mouse_move','drag','scroll','key','type')
  if (-not ($allowed -contains [string]$request.action)) {
    throw "privileged worker action is not allowed: $($request.action)"
  }
  if ([string]$request.delivery -ne 'foreground') { throw 'privileged worker requires delivery=foreground' }
  if ([string]$request.window_id -notmatch '^hwnd:0x[0-9a-fA-F]+$') {
    throw 'privileged worker requires exact window_id'
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$request.ref) -or
      -not [string]::IsNullOrWhiteSpace([string]$request.to)) {
    throw 'privileged worker requires frame-bound coordinates or direct keys/text'
  }
  $normalizedKeys = ([string]$request.keys).Trim()
  if ($normalizedKeys -match '(?i)${BLOCKED_COMPUTER_KEY_PATTERN_SOURCE}') {
    throw 'privileged worker blocked a destructive or session-ending key combination'
  }
  $workerDirectory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Mixdog\ComputerWorker'
  Set-AdminOnlyDirectory $workerDirectory
  $protectedHost = Join-Path $workerDirectory ('host-' + $token + '.ps1')
  [System.IO.File]::WriteAllBytes($protectedHost, $hostBytes)
  if (Test-Cancelled) { throw 'privileged_worker_cancelled' }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $PSHOME 'powershell.exe'
  $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $protectedHost + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo = $start
  if (-not $worker.Start()) { throw 'privileged worker could not start' }
  $workerStopped = $false
  $stdout = $worker.StandardOutput.ReadToEndAsync()
  $stderr = $worker.StandardError.ReadToEndAsync()
  if (Test-Cancelled) { throw 'privileged_worker_cancelled' }
  $writeTask = $worker.StandardInput.WriteLineAsync($requestText)
  while (-not $writeTask.IsCompleted) {
    if (Test-Cancelled) { throw 'privileged_worker_cancelled' }
    Start-Sleep -Milliseconds 50
  }
  $writeTask.GetAwaiter().GetResult()
  $worker.StandardInput.Close()
  Wait-InputWorker
  $lines = $stdout.GetAwaiter().GetResult() -split "\r?\n"
  $response = @($lines | Where-Object { $_.StartsWith($marker) } | Select-Object -Last 1)
  if ($response.Count -ne 1) { throw 'privileged worker host returned no structured response' }
  Write-Receipt ([string]$response[0])
  exit 0
} catch {
  $detail = [string]$_.Exception.Message
  try {
    Stop-InputWorker
    Write-Receipt ('ERROR:' + $detail)
  } catch {}
  exit 1
} finally {
  if ($null -ne $worker) {
    try { Stop-InputWorker } catch {}
    $worker.Dispose()
  }
  if (-not [string]::IsNullOrWhiteSpace($protectedHost) -and $workerStopped) {
    Remove-Item -LiteralPath $protectedHost -Force -ErrorAction SilentlyContinue
  }
}
`;
