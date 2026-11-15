//! The PDF cache and what lives beside it.
//!
//! Conversion is the expensive half (an external process, seconds), so its output is cached by SOURCE IDENTITY (path, mtime and
//! size) and reused until the document itself changes. Each document owns a cache DIRECTORY, `<cacheRoot>/document-previews/<key>/`,
//! because page rasters land beside their PDF: eviction is then one directory removal. At most [`MAX_CACHED_DOCUMENTS`] are kept,
//! the one least recently used (by the directory's modification time, touched on every use) going first.
//!
//! Two panes can open the same document in the same breath: they share one conversion ([`Conversions`]). A document opened with
//! its password is never written to the cache ([`Unlocked`]).

use std::collections::HashMap;
use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_fsio::{OpenOptions, WriteProof};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

use super::{PdfPreview, PreviewError, lock};

/// Bounded on purpose: a converted PDF is worth keeping for the session that opens it again, never worth growing without limit
/// inside the app's data directory.
pub const MAX_CACHED_DOCUMENTS: usize = 24;
pub const DOCUMENT_CACHE_DIRECTORY: &str = "document-previews";
pub const PREVIEW_PDF_NAME: &str = "preview.pdf";
/// Documents opened with a password that are kept unlocked in this process.
pub const MAX_UNLOCKED_DOCUMENTS: usize = 8;

/// The identity of a document or PDF: the pair a cache entry is keyed by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Identity {
    pub mtime_ms: f64,
    pub size: u64,
}

/// `info.mtimeMs`, `info.size`.
pub(super) fn identity_of(details: &Metadata) -> Identity {
    let mtime_ms = match details.modified().map(|time| time.duration_since(UNIX_EPOCH)) {
        Ok(Ok(since)) => since.as_secs() as f64 * 1000.0 + f64::from(since.subsec_nanos()) / 1e6,
        Ok(Err(before)) => -(before.duration().as_secs() as f64 * 1000.0 + f64::from(before.duration().subsec_nanos()) / 1e6),
        Err(_) => 0.0,
    };
    Identity { mtime_ms, size: details.len() }
}

/// The lowercase hex of the SHA-256 of `text`.
pub(super) fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `cacheKey(path, info)`: the first 32 hex digits of the SHA-256 of `path NUL mtimeMs NUL size`.
pub(super) fn cache_key(path: &str, identity: Identity) -> String {
    let text = format!("{path}\0{}\0{}", mixdog_js::number_to_string(identity.mtime_ms), identity.size);
    sha256_hex(&text)[..32].to_owned()
}

/// Sets the modification time of a directory to now, so eviction drops what nobody opens rather than what was made longest ago.
/// A directory that cannot be touched is left as it is.
pub(super) fn touch_directory<P: WriteProof>(proof: &P, directory: &Path) {
    let mut options = OpenOptions::new();
    // A directory is opened for its handle only: Windows needs the backup-semantics flag for that, Unix a plain read.
    #[cfg(windows)]
    options.write(true).custom_flags(0x0200_0000);
    #[cfg(not(windows))]
    options.read(true);
    if let Ok(handle) = options.open(proof, directory) {
        let _ = handle.set_modified(proof, SystemTime::now());
    }
}

/// `pruneCache(root)`: the directories past [`MAX_CACHED_DOCUMENTS`], least recently used first.
pub(super) fn prune_cache<P: WriteProof>(proof: &P, root: &Path) {
    let Ok(entries) = mixdog_fsio::read_dir(proof, root) else { return };
    let directories: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type(proof).is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    if directories.len() <= MAX_CACHED_DOCUMENTS {
        return;
    }
    let mut dated: Vec<(PathBuf, f64)> = directories
        .into_iter()
        .map(|path| {
            let used_at = mixdog_fsio::metadata(proof, &path).map_or(0.0, |details| identity_of(&details).mtime_ms);
            (path, used_at)
        })
        .collect();
    dated.sort_by(|left, right| right.1.total_cmp(&left.1));
    for (path, _) in dated.into_iter().skip(MAX_CACHED_DOCUMENTS) {
        let _ = mixdog_fsio::remove_dir_all(proof, path);
    }
}

/// The conversions running, by the PDF they write: a second open of the same document waits for the first instead of starting a
/// second LibreOffice run writing the same output file.
#[derive(Default)]
pub(super) struct Conversions(Mutex<HashMap<PathBuf, Arc<OnceCell<Result<PdfPreview, PreviewError>>>>>);

impl Conversions {
    /// The cell of the conversion writing `output`: the one running, or a new one.
    pub(super) fn of(&self, output: &Path) -> Arc<OnceCell<Result<PdfPreview, PreviewError>>> {
        Arc::clone(lock(&self.0).entry(output.to_path_buf()).or_default())
    }

    /// The conversion of `output` ended.
    pub(super) fn done(&self, output: &Path) {
        lock(&self.0).remove(output);
    }
}

/// An unlocked document's PDF and the directory it lives in.
#[derive(Clone, Debug)]
pub(super) struct UnlockedEntry {
    pub directory: PathBuf,
    pub output: PathBuf,
}

/// The PDFs of documents opened with their password: each lives in a private scratch directory for as long as this process runs
/// (or until newer unlocks push it out), so the viewer's later page requests are served without the password, and nothing of it
/// outlives the process. Keyed by source identity like the cache, so a changed document asks for its password again. Most
/// recently used last.
#[derive(Default)]
pub(super) struct Unlocked(Mutex<Vec<(String, UnlockedEntry)>>);

impl Unlocked {
    pub(super) fn get(&self, key: &str) -> Option<UnlockedEntry> {
        lock(&self.0).iter().find(|(name, _)| name == key).map(|(_, entry)| entry.clone())
    }

    /// Takes `key` out; the entry is returned so its directory can be removed.
    pub(super) fn forget(&self, key: &str) -> Option<UnlockedEntry> {
        let mut entries = lock(&self.0);
        let at = entries.iter().position(|(name, _)| name == key)?;
        Some(entries.remove(at).1)
    }

    /// Marks `key` as the one used last.
    pub(super) fn touch(&self, key: &str) {
        let mut entries = lock(&self.0);
        if let Some(at) = entries.iter().position(|(name, _)| name == key) {
            let used = entries.remove(at);
            entries.push(used);
        }
    }

    /// Remembers `entry` under `key` (the one it replaces and the ones pushed out are returned, to be removed).
    pub(super) fn remember(&self, key: &str, entry: UnlockedEntry) -> Vec<UnlockedEntry> {
        let mut entries = lock(&self.0);
        let mut pushed = Vec::new();
        if let Some(at) = entries.iter().position(|(name, _)| name == key) {
            pushed.push(entries.remove(at).1);
        }
        entries.push((key.to_owned(), entry));
        while entries.len() > MAX_UNLOCKED_DOCUMENTS {
            pushed.push(entries.remove(0).1);
        }
        pushed
    }
}

/// Whether `path` is a regular file (and how big): what a finished conversion leaves.
pub(super) fn file_size<P: mixdog_fsio::ReadProof>(proof: &P, path: &Path) -> Option<u64> {
    mixdog_fsio::metadata(proof, path).ok().filter(|details| details.is_file()).map(|details| details.len())
}

/// The error of a stat that failed, in Node's words.
pub(super) fn stat_error(error: &io::Error, path: &Path) -> PreviewError {
    super::system_error(error, "stat", path)
}
