use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use mixdog_fsio::{DirBuilder, WriteProof};
use mixdog_rt::time::sleep;
use mixdog_rt::{DurabilityIo, InLane, LaneTokens};

use super::{BoxFuture, PreviewEngines, PreviewError, job, lock};

/// How many times a removal that failed is tried again in the background.
const REMOVE_ATTEMPTS: u32 = 6;

static TRACKED: LazyLock<Mutex<BTreeSet<PathBuf>>> = LazyLock::new(|| Mutex::new(BTreeSet::new()));

/// Scratch directories whose removal is not confirmed yet (for diagnostics and tests).
pub fn tracked_preview_scratch() -> Vec<PathBuf> {
    lock(&TRACKED).iter().cloned().collect()
}

/// Removes every tracked scratch directory at once; the process does this as it ends. A directory that is already gone is
/// removed; one that cannot be removed stays tracked.
pub fn remove_tracked_preview_scratch_sync<P: WriteProof>(proof: &P) {
    let directories: Vec<PathBuf> = lock(&TRACKED).iter().cloned().collect();
    for directory in directories {
        if remove_tree(proof, &directory).is_ok() {
            lock(&TRACKED).remove(&directory);
        }
    }
}

fn remove_tree<P: WriteProof>(proof: &P, directory: &Path) -> io::Result<()> {
    match mixdog_fsio::remove_dir_all(proof, directory) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn private_builder() -> DirBuilder {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    builder
}

#[cfg(not(unix))]
fn private_builder() -> DirBuilder {
    DirBuilder::new()
}

/// `mkdtemp(join(tmpdir(), prefix))`, tracked: a private (owner-only) directory.
pub(super) async fn create_scratch(lanes: LaneTokens, prefix: &str) -> Result<PathBuf, PreviewError> {
    let prefix = prefix.to_owned();
    let created = job(lanes.durability_io, move |lane: &InLane<DurabilityIo>| -> io::Result<PathBuf> {
        loop {
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            let directory = std::env::temp_dir().join(format!("{prefix}{}", &suffix[..6]));
            match private_builder().create(lane, &directory) {
                Ok(()) => return Ok(directory),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    })
    .await?
    .map_err(|error| PreviewError::plain(error.to_string()))?;
    lock(&TRACKED).insert(created.clone());
    Ok(created)
}

/// Whether a path lies inside a tracked scratch directory (an unlocked PDF does).
pub(super) fn in_scratch(path: &Path) -> bool {
    let target = mixdog_js::nodepath::resolve_host(&[&path.to_string_lossy()]);
    lock(&TRACKED).iter().any(|directory| {
        let inside = mixdog_js::nodepath::relative_host(&directory.to_string_lossy(), &target);
        !inside.is_empty() && inside != ".." && !inside.starts_with("../") && !inside.starts_with("..\\") && !mixdog_js::nodepath::is_absolute_host(&inside)
    })
}

/// The removal of one directory: immediate, then in the background until it succeeds or the attempts are used.
pub(super) async fn remove_scratch(engines: Arc<dyn PreviewEngines>, scratch: PathBuf, host_exit: Option<BoxFuture<'static, ()>>) {
    if removed(&engines, &scratch).await {
        return;
    }
    let backoff = engines.remove_backoff();
    tokio::spawn(async move {
        if let Some(exit) = host_exit {
            exit.await;
        }
        for attempt in 0..REMOVE_ATTEMPTS {
            sleep(backoff * 2u32.pow(attempt)).await;
            if removed(&engines, &scratch).await {
                return;
            }
        }
    });
}

async fn removed(engines: &Arc<dyn PreviewEngines>, scratch: &Path) -> bool {
    if engines.remove_directory(scratch.to_path_buf()).await.is_err() {
        return false;
    }
    lock(&TRACKED).remove(scratch);
    true
}
