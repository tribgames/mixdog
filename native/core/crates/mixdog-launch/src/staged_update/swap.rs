//! SWAP (`performPendingSwap`, `swapStagedIntoGlobal`): at a clean start the running executable is renamed aside and the staged
//! binary put in its place. A Windows executable that runs can be renamed, not overwritten, so the new one is copied next to it
//! first (any volume), then two renames in the executable's own folder do the swap.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use super::Context;
use super::layout;
use super::lock;

/// How long a start that lost the swap lock waits for its owner.
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// The pauses between the attempts of a refused rename (an antivirus scan or an indexer holding the file clears in moments).
const RENAME_PAUSES_MS: [u64; 7] = [25, 50, 100, 200, 200, 200, 200];

/// What `performPendingSwap` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapOutcome {
    /// No completed staged version is newer than the running one, or the swap is off for this run (`MIXDOG_SWAP_REEXEC`,
    /// `MIXDOG_DISABLE_STAGED_SWAP`, a build in a source checkout).
    NothingStaged,
    /// A newer version is staged but another live session runs, or another start holds the swap: the swap retries at the next start.
    Deferred,
    /// The swap was tried and failed with the running executable in place: it retries at the next start.
    Failed,
    /// The staged version is now at the path (where this process started from): the caller starts it again and returns its exit code.
    Swapped(PathBuf),
    /// The executable was renamed aside, the new one could not be put in place and the old one could not be restored: this
    /// is the backup to recover from. The process must not go on.
    Stranded(PathBuf),
}

/// `performPendingSwap()` over a context.
pub fn perform_pending_swap_in(context: &Context) -> SwapOutcome {
    if context.swap_reexec || context.disable_swap || context.dev {
        return SwapOutcome::NothingStaged;
    }
    let lock_file = layout::staging_root(context).join(".swap.lock");
    // Two rounds: round 0 is the normal attempt; a start that finds another one swapping waits for it to settle, then round 1
    // looks again (the winner removed what it swapped in, or it failed and this one tries).
    for _ in 0..2 {
        let Some(best) = layout::best_staged(context, &context.version) else {
            layout::cleanup_staging(context, &context.version);
            return SwapOutcome::NothingStaged;
        };
        // Another live session: defer; the swap applies at the next clean start.
        if context.other_live_session_exists() {
            return SwapOutcome::Deferred;
        }
        if let Some(parent) = lock_file.parent() {
            drop(std::fs::create_dir_all(parent));
        }
        if lock::claim(context, &lock_file) {
            let outcome = if context.other_live_session_exists() { SwapOutcome::Deferred } else { swap_into_place(context, &best) };
            drop(std::fs::remove_file(&lock_file));
            let done = matches!(outcome, SwapOutcome::Swapped(_));
            layout::cleanup_staging(context, if done { &best.version } else { &context.version });
            return outcome;
        }
        // Lost the lock: do not touch the executable mid-swap; wait for the owner to finish.
        if !lock::wait_clear(context, &lock_file, LOCK_WAIT) {
            return SwapOutcome::Deferred;
        }
    }
    SwapOutcome::Deferred
}

/// `rename`, repeated on a refusal for the pauses above.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut pauses = RENAME_PAUSES_MS.iter();
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => match pauses.next() {
                Some(pause) => std::thread::sleep(Duration::from_millis(*pause)),
                None => return Err(error),
            },
        }
    }
}

/// `swapStagedIntoGlobal`: the executable renamed aside as the backup and the staged binary renamed into its place. The backup is
/// removed only once the executable is verified in place; when the second rename fails the backup is renamed back. Never returns
/// with the executable missing unless both directions keep failing ([`SwapOutcome::Stranded`], backup kept).
fn swap_into_place(context: &Context, best: &layout::Staged) -> SwapOutcome {
    let exe = &context.exe;
    let (Some(parent), Some(name)) = (exe.parent(), exe.file_name().map(|name| name.to_string_lossy().into_owned())) else { return SwapOutcome::Failed };
    // The staged binary must still say it is the version the marker names.
    if !best.binary.is_file() || (context.probe_version)(&best.binary).as_deref() != Some(best.version.as_str()) {
        return SwapOutcome::Failed;
    }
    let stamp = super::now_ms();
    let incoming = parent.join(format!("{name}.update-{stamp}"));
    let backup = parent.join(format!("{name}.old-{stamp}"));
    if std::fs::copy(&best.binary, &incoming).is_err() {
        // A folder that cannot be written (an install the user cannot update): abort, run the current version.
        drop(std::fs::remove_file(&incoming));
        return SwapOutcome::Failed;
    }
    if rename_with_retry(exe, &backup).is_err() {
        drop(std::fs::remove_file(&incoming));
        return SwapOutcome::Failed;
    }
    // From here the path is momentarily EMPTY until a rename lands there.
    let mut forward = rename_with_retry(&incoming, exe).is_ok();
    if !forward {
        // Repopulate the path: prefer restoring the original; if that keeps failing, drive the swap forward.
        for _ in 0..5 {
            if exe.is_file() {
                break;
            }
            if rename_with_retry(&backup, exe).is_ok() {
                break;
            }
            if rename_with_retry(&incoming, exe).is_ok() {
                forward = true;
                break;
            }
        }
    }
    if !exe.is_file() {
        return SwapOutcome::Stranded(backup);
    }
    // Removed only now that the executable is verified at its place; a running Windows executable keeps its backup until the
    // next start sweeps it.
    drop(std::fs::remove_file(&backup));
    drop(std::fs::remove_file(&incoming));
    if forward { SwapOutcome::Swapped(exe.clone()) } else { SwapOutcome::Failed }
}
