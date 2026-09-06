
function Assert-ExecutionAuthorization($req, $actualTarget = [IntPtr]::Zero) {
  if ($null -eq $req) { return }
  if ($null -ne $req.authorization_expires_at -and
      [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$req.authorization_expires_at) {
    throw 'computer_policy_expired: authorization expired before native dispatch'
  }
  if ($null -ne $req.authorization_pid) {
    $expected = [MixWin32]::ParseWindowId([string]$req.authorization_window_id)
    $requested = [MixWin32]::ParseWindowId([string]$req.window_id)
    if ($expected -eq [IntPtr]::Zero -or $requested -ne $expected -or
        ($actualTarget -ne [IntPtr]::Zero -and $actualTarget -ne $expected)) {
      throw 'computer_policy_denied: native target is outside the authorization'
    }
    $info = [MixWin32]::Info($expected)
    if ($null -eq $info -or [long]$info.Pid -ne [long]$req.authorization_pid) {
      throw 'computer_policy_denied: native target process identity changed'
    }
  }
}
