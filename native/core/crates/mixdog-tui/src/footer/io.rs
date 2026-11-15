//! What the footer reads of the machine: the files of the data directory and Claude Code's, and whether a process is alive.
//!
//! The render reads them from a background job, never on its own call stack, so the reads are blocking ones; a [`DiskIo`]
//! carries the proof the lane contract asks of a blocking read ([`mixdog_fsio::ReadProof`]), and a test hands the footer an
//! in-memory [`StatusIo`].

use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_fsio::ReadProof;

/// What a file is: its length, when it was created and when it was last written (epoch ms).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileStat {
    pub len: u64,
    pub created_ms: u128,
    pub mtime_ms: f64,
}

/// The reads of the footer.
pub trait StatusIo: Send + Sync {
    /// The text of a file; `None` when it cannot be read.
    fn read_text(&self, path: &Path) -> Option<String>;
    /// `stat` of a file; `None` when it does not exist.
    fn stat(&self, path: &Path) -> Option<FileStat>;
    /// `len` bytes of a file from `offset` (fewer at its end); `None` when it cannot be read.
    fn read_range(&self, path: &Path, offset: u64, len: usize) -> Option<Vec<u8>>;
    /// The names in a directory; `None` when it cannot be listed.
    fn list_dir(&self, path: &Path) -> Option<Vec<String>>;
    /// `isPidAlive(pid)`: a process with this pid exists (one this process may not signal counts).
    fn pid_alive(&self, pid: u64) -> bool;
}

/// [`StatusIo`] over the disk, run under the proof `proof` that blocking reads may happen where it is used.
pub struct DiskIo<P> {
    proof: P,
}

impl<P> DiskIo<P> {
    pub fn new(proof: P) -> Self {
        Self { proof }
    }
}

fn epoch_ms(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH).ok().map(|elapsed| elapsed.as_millis())
}

impl<P: ReadProof + Send + Sync> StatusIo for DiskIo<P> {
    fn read_text(&self, path: &Path) -> Option<String> {
        mixdog_fsio::read_to_string(&self.proof, path).ok()
    }

    fn stat(&self, path: &Path) -> Option<FileStat> {
        let meta = mixdog_fsio::metadata(&self.proof, path).ok()?;
        let mtime_ms = meta.modified().ok().and_then(epoch_ms).map_or(0.0, |ms| ms as f64);
        Some(FileStat { len: meta.len(), created_ms: meta.created().ok().and_then(epoch_ms).unwrap_or(0), mtime_ms })
    }

    fn read_range(&self, path: &Path, offset: u64, len: usize) -> Option<Vec<u8>> {
        let mut file = mixdog_fsio::File::open(&self.proof, path).ok()?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut bytes = Vec::with_capacity(len.min(1 << 20));
        file.take(len as u64).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    }

    fn list_dir(&self, path: &Path) -> Option<Vec<String>> {
        let entries = mixdog_fsio::read_dir(&self.proof, path).ok()?;
        Some(entries.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
    }

    fn pid_alive(&self, pid: u64) -> bool {
        u32::try_from(pid).is_ok_and(mixdog_statefile::process_exists)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_fsio::Unlaned;

    #[test]
    fn the_disk_reads_text_ranges_listings_and_liveness() {
        let dir = std::env::temp_dir().join(format!("footer-io-{}", std::process::id()));
        mixdog_fsio::create_dir_all(&Unlaned, dir.join("jobs")).expect("dir");
        mixdog_fsio::write(&Unlaned, dir.join("a.json"), b"0123456789").expect("write");
        mixdog_fsio::write(&Unlaned, dir.join("jobs").join("j.json"), b"{}").expect("write");
        let io = DiskIo::new(Unlaned);
        assert_eq!(io.read_text(&dir.join("a.json")).as_deref(), Some("0123456789"));
        assert_eq!(io.read_text(&dir.join("missing")), None);
        assert_eq!(io.stat(&dir.join("a.json")).map(|stat| stat.len), Some(10));
        assert!(io.stat(&dir.join("a.json")).is_some_and(|stat| stat.mtime_ms > 0.0));
        assert_eq!(io.read_range(&dir.join("a.json"), 3, 4), Some(b"3456".to_vec()));
        assert_eq!(io.read_range(&dir.join("a.json"), 8, 100), Some(b"89".to_vec()));
        assert_eq!(io.list_dir(&dir.join("jobs")), Some(vec!["j.json".to_owned()]));
        assert_eq!(io.list_dir(&dir.join("nope")), None);
        assert!(io.pid_alive(u64::from(std::process::id())));
        mixdog_fsio::remove_dir_all(&Unlaned, &dir).expect("clean");
    }
}
