use std::collections::HashMap;
use std::fs::Metadata;
use std::fs::TryLockError;
use std::future::Future;
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

/// Where conversions in progress work, beside the cache root and outside the bounded cache.
pub(super) const STAGING_DIRECTORY: &str = "document-previews-staging";

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
    let directories: Vec<PathBuf> =
        entries.flatten().filter(|entry| entry.file_type(proof).is_ok_and(|kind| kind.is_dir())).map(|entry| entry.path()).collect();
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
    for (path, used_at) in dated.into_iter().skip(MAX_CACHED_DOCUMENTS) {
        // The directory is removed under its key's lock, so no publisher is between creating it and renaming into it; a key whose
        // lock is held is skipped this pass. The snapshot above is stale by now: a directory that was used or published into since
        // is not the one chosen, and one already gone needs nothing.
        let Some(key) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else { continue };
        let Ok(Some(_held)) = try_lock_named(proof, root.parent().unwrap_or(root), &key_lock_name(&key)) else { continue };
        let unchanged = mixdog_fsio::metadata(proof, &path).is_ok_and(|details| identity_of(&details).mtime_ms == used_at);
        if unchanged {
            let _ = mixdog_fsio::remove_dir_all(proof, path);
        }
    }
}

// Two things are shared between worker processes and need an owner the operating system enforces: a key directory of the cache
// (published into and evicted from) and a staging directory. Both are guarded by an exclusive lock on a file (`File::lock`,
// `LockFileEx` on Windows, `flock` elsewhere), which the system releases when the holding process ends, however it ends.
//
// Locks are advisory and need a filesystem that supports them. A cache root on one that does not (some network filesystems) makes
// the call that needs the lock fail with the system's own error; nothing proceeds unlocked.

/// The directory the cache root's shared locks live in.
fn locks_directory(cache_root: &Path) -> PathBuf {
    let name = cache_root.file_name().map_or_else(|| "cache".to_owned(), |name| name.to_string_lossy().into_owned());
    cache_root.with_file_name(format!("{name}.preview-locks"))
}

/// The lock of every key directory whose key starts with the same hex digit.
pub(super) fn key_lock_name(key: &str) -> String {
    format!("key-{}.lock", key.chars().next().unwrap_or('0'))
}

fn open_lock_file<P: WriteProof>(proof: &P, directory: &Path, name: &str) -> io::Result<mixdog_fsio::File> {
    mixdog_fsio::create_dir_all(proof, directory)?;
    OpenOptions::new().write(true).create(true).open(proof, directory.join(name))
}

/// The named lock of this cache root, waiting for its holder: a critical section here is a rename or a directory removal.
pub(super) fn lock_named<P: WriteProof>(proof: &P, cache_root: &Path, name: &str) -> io::Result<mixdog_fsio::File> {
    let file = open_lock_file(proof, &locks_directory(cache_root), name)?;
    file.lock(proof)?;
    Ok(file)
}

/// The named lock of this cache root when nobody holds it, `None` when somebody does.
fn try_lock_named<P: WriteProof>(proof: &P, cache_root: &Path, name: &str) -> io::Result<Option<mixdog_fsio::File>> {
    let file = open_lock_file(proof, &locks_directory(cache_root), name)?;
    try_lock_file(proof, file)
}

fn try_lock_file<P: WriteProof>(proof: &P, file: mixdog_fsio::File) -> io::Result<Option<mixdog_fsio::File>> {
    match file.try_lock(proof) {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// The lock of the key directory `directory` of the cache (`<cacheRoot>/document-previews/<key>`); hold it to publish into it.
pub(super) fn lock_key<P: WriteProof>(proof: &P, directory: &Path) -> io::Result<mixdog_fsio::File> {
    let key = directory.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let cache_root = directory.parent().and_then(Path::parent).unwrap_or(directory);
    lock_named(proof, cache_root, &key_lock_name(&key))
}

pub(super) fn publish<P: WriteProof>(proof: &P, from: &Path, to: &Path, directory: &Path) -> io::Result<()> {
    let _held = lock_key(proof, directory)?;
    if file_size(proof, to).is_some_and(|size| size > 0) {
        return Ok(());
    }
    mixdog_fsio::create_dir_all(proof, directory)?;
    mixdog_fsio::rename(proof, from, to)
}

const STAGING_LOCK_SUFFIX: &str = ".lock";
/// Serialises making and removing the staging folder itself, which is removed once empty so the cache keeps the listing it had.
const STAGING_FOLDER_LOCK: &str = "staging-folder.lock";

/// One conversion's staging directory and the lock that says it is in use. The lock file is made and locked before the directory
/// exists and removed after it is gone, so a directory with no lock file is a leftover and one whose lock is held is live.
pub(super) struct StagingOwner {
    cache_root: PathBuf,
    directory: PathBuf,
    lock_path: PathBuf,
    lock: Option<mixdog_fsio::File>,
}

impl StagingOwner {
    pub(super) fn claim<P: WriteProof>(proof: &P, cache_root: &Path, name: &str) -> io::Result<Self> {
        let _folder = lock_named(proof, cache_root, STAGING_FOLDER_LOCK)?;
        let parent = cache_root.join(STAGING_DIRECTORY);
        mixdog_fsio::create_dir_all(proof, &parent)?;
        let lock_path = parent.join(format!("{name}{STAGING_LOCK_SUFFIX}"));
        let lock = OpenOptions::new().write(true).create_new(true).open(proof, &lock_path)?;
        lock.lock(proof)?;
        let directory = parent.join(name);
        mixdog_fsio::create_dir_all(proof, &directory)?;
        Ok(Self { cache_root: cache_root.to_path_buf(), directory, lock_path, lock: Some(lock) })
    }

    pub(super) fn directory(&self) -> &Path {
        &self.directory
    }

    /// Removes the directory, then the lock, then the staging folder if it is empty.
    pub(super) fn release<P: WriteProof>(mut self, proof: &P) {
        let _ = mixdog_fsio::remove_dir_all(proof, &self.directory);
        drop(self.lock.take());
        let _ = mixdog_fsio::remove_file(proof, &self.lock_path);
        if let Ok(_folder) = lock_named(proof, &self.cache_root, STAGING_FOLDER_LOCK) {
            let _ = mixdog_fsio::remove_dir(proof, self.cache_root.join(STAGING_DIRECTORY));
        }
    }
}

/// Removes the staging directories whose conversion is gone: a lock file that can be locked has no holder, so its directory is
/// nobody's; one that cannot is left alone, and so is everything else in the folder.
pub(super) fn reclaim_staging<P: WriteProof>(proof: &P, cache_root: &Path) {
    // A claim holds this while it makes its lock file, locks it and makes its directory: a scan between those steps would see a
    // lock file nobody holds yet.
    let Ok(_folder) = lock_named(proof, cache_root, STAGING_FOLDER_LOCK) else { return };
    let parent = cache_root.join(STAGING_DIRECTORY);
    let Ok(entries) = mixdog_fsio::read_dir(proof, &parent) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else { continue };
        if entry.file_type(proof).is_ok_and(|kind| kind.is_dir()) {
            // A directory is made after its lock file and removed before it, so without one it is a leftover.
            if !mixdog_fsio::exists(proof, parent.join(format!("{name}{STAGING_LOCK_SUFFIX}"))).unwrap_or(true) {
                let _ = mixdog_fsio::remove_dir_all(proof, &path);
            }
            continue;
        }
        let Some(stem) = name.strip_suffix(STAGING_LOCK_SUFFIX) else { continue };
        let Ok(file) = OpenOptions::new().write(true).open(proof, &path) else { continue };
        let Ok(Some(held)) = try_lock_file(proof, file) else { continue };
        let _ = mixdog_fsio::remove_dir_all(proof, parent.join(stem));
        drop(held);
        let _ = mixdog_fsio::remove_file(proof, &path);
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

    /// Runs the conversion of `output` once for every caller that asks while it runs. `existing` looks for the output inside
    /// the cell: a caller looks at the cache before it asks for the cell, and a conversion that ended in between has left its
    /// output and removed its cell, so without this look the caller would convert the same document again.
    pub(super) async fn run<E, EF, C, CF>(&self, output: &Path, existing: E, convert: C) -> Result<PdfPreview, PreviewError>
    where
        E: FnOnce() -> EF,
        EF: Future<Output = Result<Option<PdfPreview>, PreviewError>>,
        C: FnOnce() -> CF,
        CF: Future<Output = Result<PdfPreview, PreviewError>>,
    {
        let cell = self.of(output);
        cell.get_or_init(|| async {
            let outcome = match existing().await {
                Ok(Some(found)) => Ok(found),
                Ok(None) => convert().await,
                Err(error) => Err(error),
            };
            self.done(output);
            outcome
        })
        .await
        .clone()
    }
}

/// An unlocked document's PDF and the directory it lives in.
#[derive(Clone, Debug)]
pub(super) struct UnlockedEntry {
    pub directory: PathBuf,
    pub output: PathBuf,
}

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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_fsio::Unlaned;

    use super::*;

    fn folder(test: &str) -> PathBuf {
        static NUMBER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir =
            std::env::temp_dir().join(format!("office-pdf-cache-{test}-{}-{}", std::process::id(), NUMBER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        mixdog_testkit::create_dir_all(&dir);
        dir
    }

    /// Sets a directory's modification time `seconds` into the past.
    fn age(directory: &Path, seconds: u64) {
        let mut options = OpenOptions::new();
        #[cfg(windows)]
        options.write(true).custom_flags(0x0200_0000);
        #[cfg(not(windows))]
        options.read(true);
        let handle = options.open(&Unlaned, directory).expect("open directory");
        handle.set_modified(&Unlaned, SystemTime::now() - Duration::from_secs(seconds)).expect("set time");
    }

    fn preview(output: &Path, cached: bool) -> PdfPreview {
        PdfPreview { path: output.to_path_buf(), format: "docx".to_owned(), mtime_ms: 1.0, size: 1, cached }
    }

    /// A conversion that ended between a caller's look at the cache and its asking for the cell left its output and no cell:
    /// the caller must take the output, not convert again; and callers that arrive while a conversion runs share it.
    #[test]
    fn a_caller_that_finds_the_output_made_while_it_looked_converts_nothing() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let conversions = Conversions::default();
        let output = PathBuf::from("made/preview.pdf");
        let runs = AtomicUsize::new(0);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
        runtime.block_on(async {
            let found = conversions
                .run(
                    &output,
                    || async { Ok(Some(preview(&output, true))) },
                    || async {
                        runs.fetch_add(1, Ordering::SeqCst);
                        Ok(preview(&output, false))
                    },
                )
                .await
                .expect("a result");
            assert!(found.cached);
            assert_eq!(runs.load(Ordering::SeqCst), 0);
            // Nothing there yet: one conversion, shared by two callers that ask while it runs.
            let convert = || async {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok(preview(&output, false))
            };
            let (one, two) = tokio::join!(conversions.run(&output, || async { Ok(None) }, convert), conversions.run(&output, || async { Ok(None) }, convert));
            assert!(!one.expect("one").cached && !two.expect("two").cached);
            assert_eq!(runs.load(Ordering::SeqCst), 1);
        });
    }

    fn names(root: &Path) -> usize {
        mixdog_testkit::entry_names(root).len()
    }

    #[test]
    fn staging_is_reclaimed_only_once_its_owner_is_gone() {
        let root = folder("staging");
        let live = StagingOwner::claim(&Unlaned, &root, "live").expect("claim");
        let dead = StagingOwner::claim(&Unlaned, &root, "dead").expect("claim");
        mixdog_testkit::write(live.directory().join("preview.pdf"), "live");
        mixdog_testkit::write(dead.directory().join("preview.pdf"), "dead");
        // The owner of `dead` ends without cleaning up (its handle is released as a killed process's is); `live` still holds its lock.
        let dead_directory = dead.directory().to_path_buf();
        drop(dead.lock);
        reclaim_staging(&Unlaned, &root);
        assert!(!mixdog_testkit::exists(&dead_directory), "no owner: reclaimed");
        assert!(mixdog_testkit::exists(live.directory().join("preview.pdf")), "an owner holds its lock: left alone");
        live.release(&Unlaned);
        assert!(!mixdog_testkit::exists(root.join(STAGING_DIRECTORY)), "nothing of a finished conversion stays in the cache root");
    }

    #[test]
    fn eviction_skips_a_key_whose_lock_is_held_and_a_publish_after_it_leaves_the_pdf() {
        let root = folder("interleave");
        let documents = root.join(DOCUMENT_CACHE_DIRECTORY);
        for index in 0..MAX_CACHED_DOCUMENTS + 1 {
            mixdog_testkit::create_dir_all(documents.join(format!("a{index:02}")));
        }
        age(&documents.join("a00"), 7200);
        // A publisher holds the key's lock between creating the directory and renaming into it: eviction leaves the key alone.
        let held = lock_key(&Unlaned, &documents.join("a00")).expect("lock");
        prune_cache(&Unlaned, &documents);
        assert!(mixdog_testkit::exists(documents.join("a00")), "a key whose lock is held is skipped this pass");
        drop(held);
        // Eviction wins the lock first and removes the directory; the publisher then creates it again under its lock.
        prune_cache(&Unlaned, &documents);
        assert!(!mixdog_testkit::exists(documents.join("a00")));
        let staged = root.join("staged.pdf");
        mixdog_testkit::write(&staged, "pdf");
        let target = documents.join("a00");
        publish(&Unlaned, &staged, &target.join(PREVIEW_PDF_NAME), &target).expect("publish");
        assert_eq!(mixdog_testkit::read_string(target.join(PREVIEW_PDF_NAME)), "pdf");
    }

    #[test]
    fn eviction_past_the_count_takes_the_least_recently_used() {
        let root = folder("prune");
        for index in 0..MAX_CACHED_DOCUMENTS + 2 {
            mixdog_testkit::create_dir_all(root.join(format!("d{index}")));
        }
        age(&root.join("d0"), 7200);
        age(&root.join("d1"), 3600);
        prune_cache(&Unlaned, &root);
        assert_eq!(names(&root), MAX_CACHED_DOCUMENTS);
        assert!(!mixdog_testkit::exists(root.join("d0")) && !mixdog_testkit::exists(root.join("d1")));
    }
}

/// The error of a stat that failed, in Node's words.
pub(super) fn stat_error(error: &io::Error, path: &Path) -> PreviewError {
    super::system_error(error, "stat", path)
}
