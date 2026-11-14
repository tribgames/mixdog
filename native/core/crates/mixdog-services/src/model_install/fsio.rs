//! File access of the model install and memory paths as lane jobs. An async path never touches
//! the file system itself: each call here hands the blocking body to the lane the caller owns
//! and awaits the answer. A job that cannot be queued or is dropped is an `io::Error`.

use std::io;
use std::path::{Path, PathBuf};

use mixdog_rt::LaneToken;

use crate::lane::{io_on_lane, on_lane};

/// Received bytes are written in batches of this size, one lane job per batch.
const WRITE_BATCH: usize = 1 << 20;

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn read<L: LaneToken>(lane: L, path: &Path) -> io::Result<Vec<u8>> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::read(path)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn read_to_string<L: LaneToken>(lane: L, path: &Path) -> io::Result<String> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::read_to_string(path)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn write<L: LaneToken>(lane: L, path: &Path, bytes: Vec<u8>) -> io::Result<()> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::write(path, bytes)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn create_dir_all<L: LaneToken>(lane: L, path: &Path) -> io::Result<()> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::create_dir_all(path)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn rename<L: LaneToken>(lane: L, from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (from.to_owned(), to.to_owned());
    io_on_lane(lane, move || std::fs::rename(from, to)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn remove_file<L: LaneToken>(lane: L, path: &Path) -> io::Result<()> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::remove_file(path)).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn remove_dir<L: LaneToken>(lane: L, path: &Path) -> io::Result<()> {
    let path = path.to_owned();
    io_on_lane(lane, move || std::fs::remove_dir(path)).await
}

/// Removes `path` and everything in it; a missing one is no error (`rmSync(path, { recursive: true, force: true })`).
pub async fn remove_dir_all<L: LaneToken>(lane: L, path: &Path) -> io::Result<()> {
    let path = path.to_owned();
    io_on_lane(lane, move || mixdog_core_base::support::remove_dir_all_forced(&path).map_err(|failure| failure.error)).await
}

/// The names directly inside `path`; a directory that cannot be read has none (`readdirSync` in a
/// `try`).
#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn list_names<L: LaneToken>(lane: L, path: &Path) -> Vec<String> {
    let path = path.to_owned();
    let names = io_on_lane(lane, move || match std::fs::read_dir(path) {
        Ok(read) => Ok(read.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()),
        Err(_) => Ok(Vec::new()),
    })
    .await;
    names.unwrap_or_default()
}

/// Makes the file runnable (`chmodSync(path, 0o755)`, best effort); nothing to do off Unix.
#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn make_executable<L: LaneToken>(lane: L, path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = path.to_owned();
        let _ = io_on_lane(lane, move || std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))).await;
    }
    #[cfg(not(unix))]
    let _ = (lane, path);
}

/// Whether `path` exists; a lane failure is an error, not "absent".
#[allow(clippy::disallowed_methods, reason = "the call is a lane job")]
pub async fn exists<L: LaneToken>(lane: L, path: &Path) -> io::Result<bool> {
    let path = path.to_owned();
    on_lane(lane, move || path.exists()).await
}

/// A file being written in lane-sized batches: created, written and synced on `lane`.
#[allow(clippy::disallowed_types, reason = "opened, written and synced only inside lane jobs")]
pub struct LaneWriter<L: LaneToken> {
    lane: L,
    file: Option<std::fs::File>,
    pending: Vec<u8>,
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every file call is a lane job")]
impl<L: LaneToken> LaneWriter<L> {
    pub async fn create(lane: L, path: &Path) -> io::Result<Self> {
        let path: PathBuf = path.to_owned();
        let file = io_on_lane(lane, move || std::fs::File::create(path)).await?;
        Ok(Self { lane, file: Some(file), pending: Vec::new() })
    }

    pub async fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() >= WRITE_BATCH { self.flush().await } else { Ok(()) }
    }

    async fn flush(&mut self) -> io::Result<()> {
        use std::io::Write;
        if self.pending.is_empty() {
            return Ok(());
        }
        let mut file = self.file.take().ok_or_else(|| io::Error::other("the file is closed"))?;
        let batch = std::mem::take(&mut self.pending);
        // The handle comes back with the answer, so a failed write leaves it with the caller.
        let (file, written) = on_lane(self.lane, move || {
            let written = file.write_all(&batch);
            (file, written)
        })
        .await?;
        self.file = Some(file);
        written
    }

    /// Writes what is pending and syncs the file to disk.
    pub async fn finish(mut self) -> io::Result<()> {
        self.flush().await?;
        let file = self.file.take().ok_or_else(|| io::Error::other("the file is closed"))?;
        io_on_lane(self.lane, move || file.sync_all()).await
    }
}
