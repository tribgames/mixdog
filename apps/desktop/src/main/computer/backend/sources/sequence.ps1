
# Batch one step's native work, not the whole sequence. The host still receives
# every checkpoint and decides whether a following step may run.
function Invoke-SequenceStep($req) {
  $step = $req.step
  $actions = @('invoke', 'click', 'right_click', 'middle_click', 'double_click',
    'mouse_move', 'drag', 'scroll', 'type', 'key', 'wait')
  if ($null -eq $step -or $actions -notcontains [string]$step.action -or
      $step.delivery -ne 'background' -or $req.delivery -ne 'background' -or
      -not $step.window_id -or $step.window -or
      [string]$step.session_id -ne [string]$req.session_id -or $step.read_only) {
    throw 'sequence_step_invalid: expected one exact-window background input'
  }
  if ($step.action -eq 'wait' -and
      ($null -eq $step.duration -or [double]$step.duration -lt 0 -or
       [double]$step.duration -gt 5 -or [double]::IsNaN([double]$step.duration))) {
    throw 'sequence_step_invalid: wait requires 0..5 seconds'
  }
  Assert-ExecutionAuthorization $step
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $before = Do-WindowSnapshot
  $beforeMs = $clock.Elapsed.TotalMilliseconds
  # Handle rechecks the original request's authorization and all input guards.
  # Never retry a dispatched step, including when the following observation fails.
  $result = Handle $step
  $deliveredAt = $clock.Elapsed.TotalMilliseconds
  $deliveryMs = $deliveredAt - $beforeMs
  $settleMs = @@MIXDOG_SEQUENCE_SETTLE_MS@@
  $creditMs = 0
  # A wait sends no input. Its elapsed time already satisfies this part of the
  # settle budget. Actual input always retains the full post-delivery interval.
  if ($step.action -eq 'wait') {
    $creditMs = [Math]::Min($settleMs, [Math]::Floor($deliveryMs))
  }
  $remainingMs = [int]($settleMs - $creditMs)
  if ($remainingMs -gt 0) { [System.Threading.Thread]::Sleep($remainingMs) }
  $settledAt = $clock.Elapsed.TotalMilliseconds
  $after = Do-WindowSnapshot
  $finishedAt = $clock.Elapsed.TotalMilliseconds
  return @{
    step_result = $result
    windows_before = @($before.windows)
    windows_after = @($after.windows)
    settle_delay_ms = $remainingMs
    timings_ms = @{
      before_windows_ms = $beforeMs
      delivery_ms = $deliveryMs
      settle_ms = ($settledAt - $deliveredAt)
      settle_credit_ms = $creditMs
      after_windows_ms = ($finishedAt - $settledAt)
      backend_ms = $finishedAt
    }
  }
}
