//! One provider's credential file (`antigravity-oauth.json`, `openai-oauth.json`,
//! ...): the file name and field names are the stored ones. Unknown fields
//! survive a rewrite, a write is atomic (`mixdog-statefile`: temp file, fsync,
//! rename) and compare-and-swap under the file's lock (Node's `file-lock.mjs`
//! protocol, 2 s wait), and an unreadable file is never mistaken for a logout.
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
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_statefile::LockOpts;
use mixdog_statefile::Opts;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// A credential lane job that never ran (the lane refused or dropped it). It says nothing about
/// the file: callers that would otherwise take the failure for "nothing stored" test
/// [`is_lane_unrun`].
#[derive(Debug)]
pub struct LaneUnrun;

impl std::fmt::Display for LaneUnrun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the provider account store could not be reached: its lane did not run the call")
    }
}

impl std::error::Error for LaneUnrun {}

/// Whether `error` is a [`LaneUnrun`].
pub fn is_lane_unrun(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<LaneUnrun>())
}

#[derive(Clone, Copy)]
pub struct CredentialIo {
    pub read: InteractiveIo,
    pub write: DurabilityIo,
}

impl CredentialIo {
    /// Runs `body` as a read-lane job.
    pub(crate) async fn read_job<R: Send + 'static>(
        &self,
        body: impl FnOnce(&InLane<InteractiveIo>) -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        let job = self
            .read
            .submit(&CancellationToken::new(), body)
            .map_err(|_| io::Error::other(LaneUnrun))?;
        job.await.map_err(|_| io::Error::other(LaneUnrun))?
    }

    /// Runs `body` as a durability-lane job; it takes its own file locks.
    pub(crate) async fn write_job<R: Send + 'static>(
        &self,
        body: impl FnOnce(&InLane<DurabilityIo>) -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        let job = self
            .write
            .submit(&CancellationToken::new(), body)
            .map_err(|_| io::Error::other(LaneUnrun))?;
        job.await.map_err(|_| io::Error::other(LaneUnrun))?
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
    pub(super) io: CredentialIo,
    /// `MIXDOG_MODEL_PROXY=client`: the server holds no model credentials, so the file reads as
    /// absent and refuses every write (`modelProxyClientMode()` at each Node credential loader).
    remote_client: bool,
}

type Document = Map<String, Value>;

fn read_document(path: &Path) -> Probe<Document> {
    #[cfg(feature = "count-work")]
    crate::work::credential_read();
    match fs::read(path) {
        Ok(bytes) => match mixdog_statefile::parse_json_text(&bytes) {
            Ok(Value::Object(map)) => Probe::Present(map),
            _ => Probe::Unreadable,
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Probe::Absent,
        Err(_) => Probe::Unreadable,
    }
}

/// Node's token files: `writeJsonAtomicAsync({ lock, fsyncDir, mode: 0o600, secret })`; the
/// caller holds the lock already.
fn publish(lane: &InLane<DurabilityIo>, path: &Path, document: &Document) -> io::Result<()> {
    let opts = Opts { secret: true, fsync_dir: true, ..Opts::default() };
    mixdog_statefile::write_json(lane, path, &Value::Object(document.clone()), &opts)
        .map(drop)
        .map_err(|error| match error {
            mixdog_statefile::StateError::Io(error) => error,
            other => io::Error::other(other.to_string()),
        })
}

/// A busy lock is a timeout (`ELOCKTIMEOUT`); a write cannot go on without it.
fn lock_error(error: mixdog_statefile::LockError) -> io::Error {
    match error {
        mixdog_statefile::LockError::Io(error) => error,
        busy => io::Error::new(io::ErrorKind::TimedOut, busy.to_string()),
    }
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
        Self { path, io, remote_client: false }
    }

    /// The file of a server that holds no model credentials when `on`.
    pub fn remote_client(mut self, on: bool) -> Self {
        self.remote_client = on;
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The credentials this file's account holds now, as its provider read or wrote them: each is a credential the process
    /// redacts from then on (`carried::keep`, the file naming the account).
    pub fn keep(&self, values: &[&str]) {
        super::carried::keep(&format!("file {}", self.path.display()), values);
    }

    async fn read_job(&self) -> Probe<Document> {
        if self.remote_client {
            return Probe::Absent;
        }
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
        body: impl FnOnce(&InLane<DurabilityIo>, &Path) -> io::Result<R> + Send + 'static,
    ) -> io::Result<R> {
        if self.remote_client {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "model credentials are not available on this server: MIXDOG_MODEL_PROXY=client runs every model call on the client PC.",
            ));
        }
        let path = self.path.clone();
        let job = self
            .io
            .write
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::with_lock(lane, &path, &LockOpts::default(), || body(lane, &path))
                    .map_err(lock_error)?
            })
            .map_err(io::Error::other)?;
        job.await.map_err(io::Error::other)?
    }

    /// Stores `value`'s fields over the file, keeping unknown ones.
    pub async fn save<T: Serialize>(&self, value: &T) -> io::Result<()> {
        let Value::Object(update) = serde_json::to_value(value).map_err(io::Error::other)? else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        self.write_job(move |lane, path| publish(lane, path, &merged(path, update)))
            .await
    }

    /// Stores `document` as the whole file, dropping the fields it lacks (Node's `forget…` writes
    /// the file back without the credential, and the sign-out of one provider overwrites it).
    pub async fn replace(&self, document: Document) -> io::Result<()> {
        self.write_job(move |lane, path| publish(lane, path, &document)).await
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
        self.write_job(move |lane, path| {
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
            publish(lane, path, &next)?;
            Ok(true)
        })
        .await
    }

    /// Runs `refresh` for this credential, or joins the one already running
    /// (any handle on the same file) and returns its result. Re-read the
    /// credential at the start of `refresh`: it may just have been renewed. A
    /// refresh that outlives its deadline ends for every joiner as `Expired`.
    pub async fn refresh_once<T, F>(&self, refresh: F) -> Result<T, mixdog_rt::Expired>
    where
        T: Clone + Send + Sync + 'static,
        F: std::future::Future<Output = T> + Send + 'static,
    {
        super::single_flight::refresh_once(&self.path, refresh).await
    }

    /// Removes the credential (logout).
    pub async fn remove(&self) -> io::Result<()> {
        self.write_job(|_, path| match fs::remove_file(path) {
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