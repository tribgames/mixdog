//! One provider's credential file (`antigravity-oauth.json`, `openai-oauth.json`,
//! ...): the file name and field names are the stored ones. Unknown fields
//! survive a rewrite, a write is atomic (temp file, fsync, rename) and
//! compare-and-swap under an OS advisory lock, and an unreadable file is
//! never mistaken for a logout.
//!
//! All file I/O runs as lane jobs: reads on io-interactive, writes and locks
//! on io-durability.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "every std::fs call in this module is the body of a lane job"
)]

use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub struct CredentialIo {
    pub read: InteractiveIo,
    pub write: DurabilityIo,
}

impl CredentialIo {
    /// Runs `body` as a read-lane job.
    pub(crate) async fn read_job<R: Send + 'static>(
        &self,
        body: impl FnOnce() -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        let job = self
            .read
            .submit(&CancellationToken::new(), move |_| body())
            .map_err(io::Error::other)?;
        job.await.map_err(io::Error::other)?
    }

    /// Runs `body` as a durability-lane job; it takes its own file locks.
    pub(crate) async fn write_job<R: Send + 'static>(
        &self,
        body: impl FnOnce() -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        let job = self
            .write
            .submit(&CancellationToken::new(), move |_| body())
            .map_err(io::Error::other)?;
        job.await.map_err(io::Error::other)?
    }
}

/// Tri-state presence. `Unreadable` means the file exists but cannot be read
/// or parsed now; it is never treated as logged out.
#[derive(Clone, PartialEq, Debug)]
pub enum Probe<T> {
    Present(T),
    Absent,
    Unreadable,
}

#[derive(Clone)]
pub struct CredentialFile {
    path: PathBuf,
    io: CredentialIo,
}

type Document = Map<String, Value>;

fn read_document(path: &Path) -> Probe<Document> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Probe::Present(map),
            _ => Probe::Unreadable,
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Probe::Absent,
        Err(_) => Probe::Unreadable,
    }
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

/// Writes `document` beside `path` and renames it into place.
fn publish(path: &Path, document: &Document) -> io::Result<()> {
    publish_bytes(path, &serde_json::to_vec_pretty(document).map_err(io::Error::other)?)
}

/// Atomically replaces `path` with `bytes` (temp file, fsync, rename), under
/// the path's advisory lock. Shared by every on-disk cache of this crate;
/// call it from a lane job.
pub(crate) fn write_atomic_locked(path: &Path, bytes: &[u8]) -> io::Result<()> {
    with_lock(path, || publish_bytes(path, bytes))
}

pub(crate) fn publish_bytes(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut name = path
        .file_name()
        .map(|n| n.to_owned())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    name.push(format!(".mixdog-tmp-{:016x}", rand::random::<u64>()));
    let temp = path.with_file_name(name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return result;
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Runs `body` holding the exclusive advisory lock of `path`'s lock file. The
/// lock dies with the process.
pub(crate) fn with_lock<R>(path: &Path, body: impl FnOnce() -> io::Result<R>) -> io::Result<R> {
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(path))?;
    lock.lock()?;
    let result = body();
    let _ = lock.unlock();
    result
}

/// Node's lock wait (`file-lock.mjs` `DEFAULT_LOCK_TIMEOUT_MS`).
pub(crate) const LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2000);

/// `DEFAULT_BACKOFFS_MS`: 25, 50, 100, then 200 ms.
fn backoff_ms(attempt: u32) -> u64 {
    [25, 50, 100].get(attempt as usize).copied().unwrap_or(200)
}

/// [`with_lock`] with Node's acquisition: poll with jittered backoff until
/// `timeout`, then give up (`ELOCKTIMEOUT`). `None` is a lock another holder
/// kept for the whole wait; `body` did not run. Call it from a lane job,
/// which is where the waiting sleeps.
pub(crate) fn with_lock_within<R>(
    path: &Path,
    timeout: std::time::Duration,
    body: impl FnOnce() -> io::Result<R>,
) -> io::Result<Option<R>> {
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(path))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut attempt = 0;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) => {}
            Err(fs::TryLockError::Error(err)) => return Err(err),
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Ok(None);
        }
        let base = backoff_ms(attempt);
        let jitter = rand::random::<u64>() % base.min(75);
        std::thread::sleep(left.min(std::time::Duration::from_millis(base + jitter)));
        attempt += 1;
    }
    let result = body();
    let _ = lock.unlock();
    result.map(Some)
}

/// The merged document: `update`'s fields over what is stored, so fields this
/// code does not know stay.
fn merged(path: &Path, update: Document) -> Document {
    let mut stored = match read_document(path) {
        Probe::Present(map) => map,
        _ => Document::new(),
    };
    stored.extend(update);
    stored
}

impl CredentialFile {
    pub fn new(path: PathBuf, io: CredentialIo) -> Self {
        Self { path, io }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn read_job(&self) -> Probe<Document> {
        let path = self.path.clone();
        match self
            .io
            .read
            .submit(&CancellationToken::new(), move |_| read_document(&path))
        {
            Ok(job) => job.await.unwrap_or(Probe::Unreadable),
            Err(_) => Probe::Unreadable,
        }
    }

    pub async fn load_document(&self) -> Probe<Document> {
        self.read_job().await
    }

    /// The typed view of the file; a document that does not fit `T` is
    /// `Unreadable`.
    pub async fn load<T: DeserializeOwned>(&self) -> Probe<T> {
        match self.read_job().await {
            Probe::Present(map) => match serde_json::from_value(Value::Object(map)) {
                Ok(value) => Probe::Present(value),
                Err(_) => Probe::Unreadable,
            },
            Probe::Absent => Probe::Absent,
            Probe::Unreadable => Probe::Unreadable,
        }
    }

    async fn write_job<R: Send + 'static>(
        &self,
        body: impl FnOnce(&Path) -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        let path = self.path.clone();
        let job = self
            .io
            .write
            .submit(&CancellationToken::new(), move |_| {
                with_lock(&path, || body(&path))
            })
            .map_err(io::Error::other)?;
        job.await.map_err(io::Error::other)?
    }

    /// Stores `value`'s fields over the file, keeping unknown ones.
    pub async fn save<T: Serialize>(&self, value: &T) -> io::Result<()> {
        let Value::Object(update) = serde_json::to_value(value).map_err(io::Error::other)? else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        self.write_job(move |path| publish(path, &merged(path, update)))
            .await
    }

    /// Publishes `update` only if `unchanged` accepts the stored document: a
    /// refresher that read the pair before another process refreshed it must
    /// not overwrite the newer login. A missing file is offered as an empty
    /// document. Returns whether it published.
    pub async fn replace_if(
        &self,
        unchanged: impl FnOnce(&Document) -> bool + Send + 'static,
        update: Document,
    ) -> io::Result<bool> {
        self.write_job(move |path| {
            let current = match read_document(path) {
                Probe::Present(map) => map,
                Probe::Absent => Document::new(),
                Probe::Unreadable => return Err(io::Error::from(io::ErrorKind::InvalidData)),
            };
            if !unchanged(&current) {
                return Ok(false);
            }
            let mut next = current;
            next.extend(update);
            publish(path, &next)?;
            Ok(true)
        })
        .await
    }

    /// Runs `refresh` for this credential, or joins the one already running
    /// (any handle on the same file) and returns its result. Re-read the
    /// credential at the start of `refresh`: it may just have been renewed.
    pub async fn refresh_once<T, F>(&self, refresh: F) -> T
    where
        T: Clone + Send + Sync + 'static,
        F: std::future::Future<Output = T> + Send + 'static,
    {
        super::single_flight::refresh_once(&self.path, refresh).await
    }

    /// Removes the credential (logout).
    pub async fn remove(&self) -> io::Result<()> {
        self.write_job(|path| match fs::remove_file(path) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Tokens {
        access: String,
        refresh: String,
    }

    fn file(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("x-oauth.json"),
            CredentialIo {
                read: tokens.interactive_io,
                write: tokens.durability_io,
            },
        )
    }

    #[tokio::test]
    async fn save_keeps_unknown_fields_and_load_is_tri_state() {
        let dir = tempfile::tempdir().unwrap();
        let f = file(&dir);
        assert_eq!(f.load::<Tokens>().await, Probe::Absent);
        fs::write(f.path(), r#"{"access":"a","refresh":"r","future":{"k":1}}"#).unwrap();
        f.save(&Tokens {
            access: "a2".into(),
            refresh: "r2".into(),
        })
        .await
        .unwrap();
        let Probe::Present(doc) = f.load_document().await else {
            panic!("present")
        };
        assert_eq!(doc["future"], json!({"k": 1}));
        assert_eq!(doc["access"], "a2");
        assert_eq!(
            f.load::<Tokens>().await,
            Probe::Present(Tokens {
                access: "a2".into(),
                refresh: "r2".into()
            })
        );
        fs::write(f.path(), "{ half").unwrap();
        assert_eq!(f.load::<Tokens>().await, Probe::Unreadable);
        assert!(
            f.replace_if(|_| true, Map::new()).await.is_err(),
            "an unreadable file is never overwritten as if absent"
        );
    }

    #[tokio::test]
    async fn replace_if_publishes_only_over_the_pair_the_refresher_read() {
        let dir = tempfile::tempdir().unwrap();
        let f = file(&dir);
        fs::write(f.path(), r#"{"access":"old","refresh":"r1"}"#).unwrap();
        let fresh = |a: &str, r: &str| {
            let mut m = Map::new();
            m.insert("access".into(), a.into());
            m.insert("refresh".into(), r.into());
            m
        };
        let read_pair = |d: &Document| d["access"] == "old" && d["refresh"] == "r1";
        assert!(f.replace_if(read_pair, fresh("new", "r2")).await.unwrap());
        // A second refresher that read the same old pair loses.
        assert!(!f.replace_if(read_pair, fresh("stale", "r9")).await.unwrap());
        let Probe::Present(doc) = f.load_document().await else {
            panic!("present")
        };
        assert_eq!(doc["access"], "new");
        f.remove().await.unwrap();
        assert_eq!(f.load_document().await, Probe::Absent);
    }
}