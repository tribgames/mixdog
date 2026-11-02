# Local Provider recovery

Read when an installation fails, stalls or is interrupted, when the user wants
to stop, pause or resume a download, or when a model fails to start or load.

## Stopping and resuming

- Background installation is independent of a chat's lifetime. Stopping the
  conversation does not stop its download.
- For an explicit download-stop request, use `cancel_local_installation` with
  the current `jobId` from status. This pauses the shared job for all
  observers and keeps partial files. `cancelling` means cancellation was
  accepted; `paused` means it settled.
- Resume an approved paused or failed job with `start_local_installation`
  using its phase and model id. After an app restart, partial files appear as
  resumable installations without an active job id.

## Failures

- Insufficient space: report the requirement and the available space. Never
  delete user files to make room.
- An interrupted download can be explicitly retried through the same
  installer. Never bypass a checksum failure.
- Startup failure: use the `starting`, `lastError` and `lastExit` diagnostics.
  Do not print authentication keys or attempt unmanaged server commands.
- Resource checks: all NVIDIA GPUs on Windows, or the Apple Silicon GPU on a
  Mac (Metal, on unified memory), are checked without blocking the app.
  Loading chooses a compatible GPU with enough free memory for the catalog's
  estimate. That estimate is a guard, not a guarantee against driver or
  runtime allocation failure. Never bypass a failed resource check.
