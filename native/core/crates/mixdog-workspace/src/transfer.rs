#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Transfers (DS §4.4): ranged reads of a project file, an absolute local file
//! or a zipped folder; chunked uploads staged beside the target and committed by
//! rename. A transfer belongs to its owner (a connection or a paired device) and
//! ends with it. Reads are ranged against one open handle, so a 2 GiB file never
//! sits in memory; every range re-checks the file's version.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::fsops::mime_type;
use crate::ident::FileVersion;
use crate::ident::file_version;
use crate::inplace::open_authorized_ro;
use crate::pathguard::absolute_local_path;
use crate::pathguard::canonical;
use crate::pathguard::comparable;
use crate::pathguard::project_entry_path;

pub const RANGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// Raw bytes of one upload chunk at most (`SERVER_UPLOAD_CHUNK_BYTES`).
pub const UPLOAD_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
/// Largest upload (`SERVER_UPLOAD_MAX_BYTES`).
pub const UPLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const ZIP_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const ZIP_MAX_FILES: usize = 2_000;
const MAX_OPEN_READS: usize = 64;

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

/// The opaque version string of a file's identity, size and modification time.
pub fn version_string(version: &FileVersion) -> String {
    let text = format!("{}:{}:{}", version.id.key(), version.size, version.mtime_ns);
    URL_SAFE_NO_PAD.encode(Sha256::digest(text.as_bytes()))
}

/// An unredeemed download authorization (Node's `Grant`, `file-downloads.ts`): the file opened once at authorize time and what the
/// phone was told of it.
struct Grant {
    owner: String,
    /// The conversation the request named (Node's `Grant.sessionId`): its deletion ends the grant.
    session: String,
    file: File,
    /// Where the file was authorized (Node's `OpenedFile.location`): the real path the handle was proved to be the file at.
    location: PathBuf,
    size: u64,
    version: String,
    name: String,
    mime: String,
    expires_at: i64,
}

/// A file the service staged for a phone's download (a folder's zip, an attachment's bytes): Node's `ExportRecord` made by
/// `stageTemporaryDownload` (`file-downloads.ts:678-711`). It lives [`STAGED_TTL_MS`] from staging whether or not its download has ended,
/// counts toward the device's [`MAX_STAGED_PER_DEVICE`], keeps the sweeper running, and its file goes when the sweep finds it expired and
/// read by no grant or transfer, when room is made for a newer one, or when its device or conversation is revoked.
struct Staged {
    owner: String,
    session: String,
    /// The staged file's path, its real one once opened: a grant or transfer reading it was opened there (Node's `readsRecord`).
    location: PathBuf,
    expires_at: i64,
    /// Its payload is still being written and opened (Node's `staging`): never dropped to make room or by the sweep, but a revocation
    /// removes it as any other.
    staging: bool,
    /// Held for its drop: the folder goes with the record.
    _file: Cleanup,
}

/// How long a staged download stays (`EXPORT_TTL_MS`).
pub const STAGED_TTL_MS: i64 = 10 * 60_000;
/// Staged downloads one device holds; room is made by dropping its oldest that no transfer reads (`MAX_EXPORTS_PER_DEVICE`).
const MAX_STAGED_PER_DEVICE: usize = 8;

/// Whether the staged download is still being staged or a grant or a phone transfer reads its file (Node's `exportHeld`).
fn staged_held(grants: &[(String, Grant)], reads: &HashMap<String, Read>, staged: &Staged) -> bool {
    staged.staging || grants.iter().any(|(_, grant)| grant.location == staged.location) || leased(reads, &staged.location)
}

/// Whether a phone transfer reads the file at `location`.
fn leased(reads: &HashMap<String, Read>, location: &Path) -> bool {
    reads.values().any(|read| read.lease.is_some() && read.location.as_deref() == Some(location))
}

/// The times a phone's transfer ends at (Node's `Lease`): after the idle time without a read, and after the absolute lifetime.
#[derive(Clone, Copy)]
struct LeaseTimes {
    expires_at: i64,
    idle_until: i64,
}

/// An unredeemed grant lives this long (`FILE_DOWNLOAD_GRANT_TTL_MS`).
pub const GRANT_TTL_MS: i64 = 60_000;
/// A phone's transfer ends this long after its last read (`FILE_DOWNLOAD_LEASE_IDLE_MS`).
pub const LEASE_IDLE_MS: i64 = 2 * 60_000;
/// A phone's transfer ends this long after it began, however active (`FILE_DOWNLOAD_LEASE_MAX_MS`).
pub const LEASE_MAX_MS: i64 = 30 * 60_000;
/// Largest downloadable file, inclusive (`FILE_DOWNLOAD_MAX_BYTES`).
pub const DOWNLOAD_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Unredeemed grants one device holds; its oldest go first (`MAX_GRANTS_PER_DEVICE`).
const MAX_GRANTS_PER_DEVICE: usize = 8;
/// Concurrent phone transfers per device (`MAX_LEASES_PER_DEVICE`).
const MAX_LEASES_PER_DEVICE: usize = 4;

/// How often the sweeper looks for expired grants and transfers once any is held (`SWEEP_INTERVAL_MS`).
pub const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

fn download(code: &'static str, message: &str) -> WsError {
    WsError::new(Reason::Download(code), message)
}

/// Node's `FileDownloadError('changed')`: what a phone is told when the file is no longer the version it was offered.
fn download_changed() -> WsError {
    download("file-download:changed", "The file changed on the host.")
}

/// Node's `FileDownloadError('unavailable')`: the conversation a download names has left the host's catalog.
pub fn unavailable() -> WsError {
    download("file-download:unavailable", "This conversation is not available.")
}

/// What `authorize` tells the phone (Node's `FileDownloadGrant`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Authorized {
    pub grant_id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub version: String,
    pub expires_at: i64,
    /// A folder's zip only: what it left out (Node's `FolderLeftOut`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_out: Option<LeftOut>,
}

/// Node's `FolderLeftOut` of a folder's zip: the ignored files it left out; `secret` is always 0 on this host.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LeftOut {
    pub ignored: u64,
    pub secret: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseMedia {
    pub asset_id: String,
    pub variant: &'static str,
    pub expires_at: i64,
}

/// What `begin` tells the phone (Node's `FileDownloadTransfer`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Leased {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub version: String,
    pub expires_at: i64,
    pub range_max_bytes: u64,
    pub media: LeaseMedia,
}

/// What `finish` tells the phone (Node's `FileDownloadFinished`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub transfer_id: String,
    pub size: u64,
    pub version: String,
}

/// Revocation generations: each only grows, so a changed value says something revoked the owner, the conversation or everything
/// meanwhile. The lock on them is the one gate every revoke and every consume-and-publish step passes (order: generations, grants,
/// reads), so a revoke runs wholly before or wholly after each such step, as Node's synchronous steps do.
#[derive(Default)]
struct Generations {
    all: u64,
    owners: HashMap<String, u64>,
    sessions: HashMap<String, u64>,
    /// The conversations the host's catalog has dropped (Node's `sessionRemoved`): a call that finds its conversation here is
    /// `unavailable`, ahead of any other revocation.
    removed: HashSet<String>,
}

impl Generations {
    fn of(&self, owner: &str, session: &str) -> u64 {
        self.all + self.owners.get(owner).copied().unwrap_or(0) + self.sessions.get(session).copied().unwrap_or(0)
    }

    /// Node's `stillAuthorized`, after awaited work: the conversation left the catalog (`unavailable`), else anything revoked the owner,
    /// the conversation or everything since `mark` (`expired`).
    fn still_authorized(&self, owner: &str, session: &str, mark: u64) -> WsResult<()> {
        if self.removed.contains(session) {
            return Err(unavailable());
        }
        if self.of(owner, session) != mark {
            return Err(WsError::expired());
        }
        Ok(())
    }
}

/// Who a transfer belongs to. The origin is part of the owner, so a connection of this machine (a local client or an SSH window, which
/// the daemon numbers) and a paired phone (which the relay names by its credential, a string a phone's pairing makes) can never be the
/// same owner, whatever the credential spells: the key of each kind starts with its own tag.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Owner(String);

impl Owner {
    /// A connection of the daemon, by its number.
    pub fn connection(id: u64) -> Self {
        Self(format!("connection:{id}"))
    }

    /// A caller inside the daemon, by its name.
    pub fn internal(name: &str) -> Self {
        Self(format!("internal:{name}"))
    }

    /// A paired phone, by the credential the relay admitted it under.
    pub fn device(credential: &str) -> Self {
        Self(format!("device:{credential}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::ops::Deref for Owner {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Owner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Node's `createDownloadTables` sweeper: started by the first grant or transfer added, ticking every [`SWEEP_INTERVAL`] from then,
/// stopped once nothing is held.
#[derive(Default)]
struct Sweeper {
    anchor: Mutex<Option<Instant>>,
    changed: tokio::sync::Notify,
    /// Raised after each tick's sweep, so a test moving the clock tick by tick knows the tick has run.
    #[cfg(test)]
    swept: tokio::sync::Notify,
}

struct Read {
    owner: String,
    session: String,
    file: File,
    /// A phone's transfer: where its file was authorized (see [`Grant::location`]); a read of it must find the open file still there.
    location: Option<PathBuf>,
    size: u64,
    version: String,
    lease: Option<LeaseTimes>,
    // Declared after `file`, so the handle is closed before the removal (Windows cannot remove a
    // folder that holds an open file).
    _cleanup: Option<Cleanup>,
    #[allow(dead_code)]
    opened: Instant,
}

/// What a transfer removes when it ends: a staged file, or the folder its source owns.
struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        // A removal can wait on a handle still closing (up to 1.5 s). Every table drops its records where it stands, some
        // on a runtime worker: there the wait is declared to the runtime, which hands the worker's other tasks on. The
        // folder is gone (or given up on) when this returns, wherever it ran.
        let on_runtime = tokio::runtime::Handle::try_current().is_ok_and(|runtime| runtime.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
        if on_runtime { tokio::task::block_in_place(|| self.remove()) } else { self.remove() }
    }
}

impl Cleanup {
    fn remove(&self) {
        if self.0.is_dir() {
            // Node's `rm(dir, { recursive, force, maxRetries: 5 })`: a handle still closing on
            // Windows is retried, each wait `retryDelay` (100 ms) longer than the one before.
            for attempt in 0..=5u64 {
                if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                    return;
                }
                if attempt < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
                }
            }
        } else {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

struct Upload {
    owner: String,
    temp: PathBuf,
    target: PathBuf,
    file: File,
    size: u64,
    written: u64,
    /// A staged upload: the name is made unique at commit (name (2).ext) instead of refused.
    unique: bool,
    /// A chunk is being written (Node's `upload.writing`): a second one is refused, not queued.
    writing: bool,
    /// When the upload was last fed (begun, or a chunk written): the idle sweep's reference.
    fed: Instant,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub transfer_id: String,
    pub size: u64,
    pub mime_type: String,
    pub name: String,
    pub version: String,
    pub range_max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub transfer_id: String,
    pub offset: u64,
    pub length: u64,
    pub eof: bool,
    pub version: String,
    pub data: String,
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// Node's `sanitizedFileName` (`ipc-validation.ts`): runs of control and reserved characters
/// become `-`, leading blanks, dots and dashes and trailing blanks and dots go, at most 120
/// UTF-16 units remain (a pair cut in two becomes U+FFFD, as a Rust string cannot hold half),
/// and an empty result is `download`.
pub fn sanitized_file_name(value: &str) -> String {
    let mut replaced = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        let reserved = (c as u32) < 0x20 || "<>:\"/\\|?*".contains(c);
        if reserved {
            if !in_run {
                replaced.push('-');
            }
        } else {
            replaced.push(c);
        }
        in_run = reserved;
    }
    let trimmed = replaced.trim_start_matches(|c: char| js_space(c) || c == '.' || c == '-');
    let trimmed = trimmed.trim_end_matches(|c: char| js_space(c) || c == '.');
    let mut out = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        let width = c.len_utf16();
        if units + width > 120 {
            if units < 120 {
                out.push('\u{fffd}');
            }
            break;
        }
        units += width;
        out.push(c);
    }
    if out.is_empty() { "download".into() } else { out }
}

/// A file opened for a phone's download (Node's `OpenedFile` with its `name` and `mime`): `location` is the real path the open handle was
/// proved, from the handle itself, to be the file at.
pub struct DownloadFile {
    pub file: File,
    pub location: PathBuf,
    pub name: String,
    pub mime_type: String,
}

/// Bytes a source domain hands over for the service to stage as a phone's download (Node's `readSessionAttachment` result): the
/// checked bytes, the offered name and the type.
pub struct SourceBytes {
    pub bytes: Vec<u8>,
    pub name: String,
    pub mime_type: String,
}

/// A readable file a source domain hands to the transfer service.
pub struct SourceFile {
    pub file: File,
    pub name: String,
    pub mime_type: String,
    /// Removed when the transfer ends: a staged temp file, or the folder the source owns, which
    /// goes whole with everything in it (Node's `dropExport` removes the export's
    /// `mixdog-visualize-export-*` folder). A source that names a folder owns all of it.
    pub cleanup: Option<PathBuf>,
}

/// One `transfer/beginRead` source kind served by another domain: `mediaAsset` (media),
/// `attachment` (blob) and `export` (session). `open` runs on the caller's task; it authorizes
/// the request itself and returns the open file.
#[async_trait::async_trait]
pub trait TransferSource: Send + Sync + 'static {
    /// The `source.kind` this serves.
    fn kind(&self) -> &'static str;
    /// `source` is the request's whole `source` object.
    async fn open(&self, source: &serde_json::Value, cancel: &tokio_util::sync::CancellationToken) -> WsResult<SourceFile>;
    /// The source's bytes for a phone's download, which the service stages itself ([`Transfers::stage`]); only a source whose bytes Node
    /// stages (`attachment`) has them.
    async fn bytes(&self, _source: &serde_json::Value, _cancel: &tokio_util::sync::CancellationToken) -> WsResult<SourceBytes> {
        Err(WsError::new(Reason::Unsupported, "This download source has no bytes to stage."))
    }
}

/// Monotonic time for the idle sweep of abandoned uploads and the deadlines of downloads; tests substitute a controllable one.
pub trait IdleClock: Send + Sync {
    fn now(&self) -> Instant;

    /// Node's `Date.now()`, which the download service reads afresh at each use (`file-downloads.ts:774`): the wall clock now, placed on
    /// this clock by how far it stands from the real monotonic one. A wall-clock change moves the answer like Node's, and a clock a test
    /// moves (`tokio::time::advance` on a paused runtime) moves it by exactly that much, since the wall clock and the real monotonic one
    /// advance together.
    fn epoch_ms(&self) -> i64 {
        let wall = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX));
        let (now, real) = (self.now(), Instant::now());
        let ahead = |from: Instant, to: Instant| i64::try_from(to.saturating_duration_since(from).as_millis()).unwrap_or(i64::MAX);
        wall + ahead(real, now) - ahead(now, real)
    }
}

/// The daemon's clock: the monotonic one, read through the runtime's own so that a test of the whole service on a paused runtime moves
/// every deadline of it (uploads, downloads, grants) by one `tokio::time::advance`. Outside a paused runtime it is `Instant::now()`.
pub struct SystemClock;

impl IdleClock for SystemClock {
    fn now(&self) -> Instant {
        tokio::time::Instant::now().into_std()
    }
}

/// An upload nobody feeds for this long is abandoned and its partial file removed
/// (`SERVER_UPLOAD_IDLE_MS`).
pub const UPLOAD_IDLE: std::time::Duration = std::time::Duration::from_secs(120);

/// Sleeps until a monotonic instant; tests substitute a controllable one, so none of them waits.
pub trait IdleTimer: Send + Sync {
    fn sleep_until(&self, deadline: Instant) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

/// The daemon's timer: tokio's.
pub struct TokioTimer;

impl IdleTimer for TokioTimer {
    fn sleep_until(&self, deadline: Instant) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)))
    }
}

pub struct Transfers {
    reads: Mutex<HashMap<String, Read>>,
    /// Insertion ordered, so a device's oldest grant is the first of its own.
    grants: Mutex<Vec<(String, Grant)>>,
    /// Staged downloads, oldest first. Locked after `grants` and `reads` when taken with them.
    staged: Mutex<Vec<Staged>>,
    generations: Mutex<Generations>,
    /// How many conversations carry a removed mark (`Generations::removed`), so a relist with none pays no lock.
    removed_marks: std::sync::atomic::AtomicUsize,
    sweeper: Sweeper,
    /// Test seam: called with the name of a point in `authorize`, `begin_grant` or a lease read, where a revoke may run meanwhile.
    #[cfg(test)]
    pause: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
    writes: Mutex<HashMap<String, Upload>>,
    clock: Arc<dyn IdleClock>,
    idle: std::time::Duration,
    /// Raised when an upload is begun or fed: the idle deadlines moved.
    armed: tokio::sync::Notify,
}

impl Default for Transfers {
    fn default() -> Self {
        // A core built for the replay of the download recording, and told where to find its clock, runs on that clock.
        #[cfg(feature = "replay-controls")]
        if let Some(clock) = crate::replay_controls::clock() {
            crate::replay_controls::publish("held", "0");
            crate::replay_controls::publish("staged", "0");
            crate::replay_controls::publish("anchor", "none");
            return Self::with_clock(clock, UPLOAD_IDLE);
        }
        Self::with_clock(Arc::new(SystemClock), UPLOAD_IDLE)
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Transfers {
    pub fn with_clock(clock: Arc<dyn IdleClock>, idle: std::time::Duration) -> Self {
        Self {
            reads: Mutex::default(),
            grants: Mutex::default(),
            staged: Mutex::default(),
            generations: Mutex::default(),
            removed_marks: std::sync::atomic::AtomicUsize::new(0),
            sweeper: Sweeper::default(),
            #[cfg(test)]
            pause: Mutex::default(),
            writes: Mutex::default(),
            clock,
            idle,
            armed: tokio::sync::Notify::new(),
        }
    }

    /// Node's `Date.now()` for grants and transfers, read afresh at each use, from the same clock seam as the uploads' idle sweep and
    /// the paired devices' grants.
    fn now_ms(&self) -> i64 {
        self.clock.epoch_ms()
    }

    /// Sets the hook called at each named point of `authorize`, `begin_grant` and a lease read; a revoke run from it is one that came
    /// in the middle of the call.
    #[cfg(test)]
    pub(crate) fn on_point(&self, hook: Option<Arc<dyn Fn(&str) + Send + Sync>>) {
        *self.pause.lock().expect("pause") = hook;
    }

    /// A named point in a download call, where a test (or the replay's hold) lets something else happen to the host meanwhile.
    pub(crate) fn point(&self, name: &str) {
        #[cfg(test)]
        {
            let hook = self.pause.lock().expect("pause").clone();
            if let Some(hook) = hook {
                hook(name);
            }
        }
        #[cfg(feature = "replay-controls")]
        crate::replay_controls::gate(name);
        #[cfg(not(any(test, feature = "replay-controls")))]
        let _ = name;
    }

    /// Tells the replay how many files the downloads hold open, and the instant the sweeper counts from (see `replay_controls.rs`).
    #[cfg(feature = "replay-controls")]
    fn report(&self) {
        let held = self.grants.lock().expect("transfer grants").len() + self.reads.lock().expect("transfer reads").values().filter(|r| r.lease.is_some()).count();
        crate::replay_controls::publish("held", &held.to_string());
        crate::replay_controls::publish("staged", &self.staged_files().to_string());
    }

    /// The staged downloads whose file is on disk (what Node's staging folder holds).
    #[cfg(any(test, feature = "replay-controls"))]
    pub(crate) fn staged_files(&self) -> usize {
        self.staged.lock().expect("staged downloads").iter().filter(|staged| staged._file.0.exists()).count()
    }

    /// Adds a staged download of `owner` in its `staging` state, its folder made and its payload not yet written (Node's `addRecord` in
    /// `stageTemporaryDownload`): room is made first by dropping the device's oldest staged downloads that are neither being staged nor
    /// read by a transfer, with the unredeemed grants reading them, and the sweeper runs while it is held.
    fn add_staged(&self, owner: &str, session: &str, folder: &Path) {
        let expires_at = self.now_ms() + STAGED_TTL_MS;
        let (dropped_grants, dropped) = {
            let mut grants = self.grants.lock().expect("transfer grants");
            let reads = self.reads.lock().expect("transfer reads");
            let mut staged = self.staged.lock().expect("staged downloads");
            let mut excess = (staged.iter().filter(|held| held.owner == owner).count() + 1).saturating_sub(MAX_STAGED_PER_DEVICE);
            let (mut dropped_grants, mut dropped) = (Vec::new(), Vec::new());
            let mut at = 0;
            while at < staged.len() && excess > 0 {
                if staged[at].owner != owner || staged[at].staging || leased(&reads, &staged[at].location) {
                    at += 1;
                    continue;
                }
                let stale = staged.remove(at);
                let (reading, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *grants).into_iter().partition(|(_, grant)| grant.location == stale.location);
                *grants = kept;
                dropped_grants.extend(reading);
                dropped.push(stale);
                excess -= 1;
            }
            let location = folder.join(STAGED_PAYLOAD);
            staged.push(Staged { owner: owner.to_owned(), session: session.to_owned(), location, expires_at, staging: true, _file: Cleanup(folder.to_owned()) });
            (dropped_grants, dropped)
        };
        // The grants' handles close before their files are removed.
        drop(dropped_grants);
        drop(dropped);
        self.arm_sweeper();
    }

    /// Node's `stageTemporaryDownload`: bytes the host built (a folder's zip, an attachment) staged for `owner`'s download in a private
    /// folder of their own, the record added before the payload is written, then opened as the download. A revocation meanwhile removes
    /// the record and its folder, and the write or open then fails the call as Node's does; any failure drops the record (`dropExport`),
    /// and the record leaves its `staging` state whatever the outcome.
    pub fn stage(&self, owner: &str, session: &str, bytes: &[u8], name: String, mime_type: String) -> WsResult<DownloadFile> {
        let folder = staged_folder()?;
        self.add_staged(owner, session, &folder);
        self.point("stage.write");
        let payload = folder.join(STAGED_PAYLOAD);
        let opened = staged_file(&folder)
            .map_err(|error| crate::nodeerr::io_error(&error, "open", &payload))
            .and_then(|mut out| Ok(out.write_all(bytes)?))
            .and_then(|()| open_regular(&payload, &|_| {}));
        let gone: Vec<Staged> = {
            let mut staged = self.staged.lock().expect("staged downloads");
            let at = staged.iter().position(|held| held._file.0 == folder);
            match (&opened, at) {
                (Ok((real, _)), Some(at)) => {
                    staged[at].staging = false;
                    staged[at].location = real.clone();
                    Vec::new()
                }
                (Err(_), Some(at)) => vec![staged.remove(at)],
                (_, None) => Vec::new(),
            }
        };
        drop(gone);
        let (real, file) = opened?;
        Ok(DownloadFile { file, location: real, name, mime_type })
    }

    /// Ends the staged downloads `ends` names (Node's `dropMatching` over its records); their files go after the lock is released.
    fn drop_staged(&self, ends: impl Fn(&Staged) -> bool) {
        let gone: Vec<Staged> = {
            let mut staged = self.staged.lock().expect("staged downloads");
            let (gone, kept) = std::mem::take(&mut *staged).into_iter().partition(|held| ends(held));
            *staged = kept;
            gone
        };
        drop(gone);
    }


    fn generation(&self, owner: &str, session: &str) -> u64 {
        self.generations.lock().expect("generations").of(owner, session)
    }

    /// Ends every grant and phone transfer whose time is up (Node's `sweep`: run at the start of every call, and by the sweeper).
    fn sweep_downloads(&self) {
        let _reporting = Reporting(self);
        let now = self.now_ms();
        self.grants.lock().expect("transfer grants").retain(|(_, grant)| grant.expires_at > now);
        self.reads.lock().expect("transfer reads").retain(|_, read| read.lease.is_none_or(|lease| lease.expires_at > now && lease.idle_until > now));
        let expired: Vec<Staged> = {
            let grants = self.grants.lock().expect("transfer grants");
            let reads = self.reads.lock().expect("transfer reads");
            let mut staged = self.staged.lock().expect("staged downloads");
            let (kept, expired) = std::mem::take(&mut *staged).into_iter().partition(|held| held.expires_at > now || staged_held(&grants, &reads, held));
            *staged = kept;
            expired
        };
        drop(expired);
        self.stop_sweeper_when_idle();
    }

    /// Whether any grant, phone transfer or staged download is held (Node's three tables being empty).
    fn downloads_held(&self) -> bool {
        !self.grants.lock().expect("transfer grants").is_empty()
            || self.reads.lock().expect("transfer reads").values().any(|read| read.lease.is_some())
            || !self.staged.lock().expect("staged downloads").is_empty()
    }

    fn arm_sweeper(&self) {
        let mut anchor = self.sweeper.anchor.lock().expect("sweeper");
        if anchor.is_none() {
            *anchor = Some(self.clock.now());
            #[cfg(feature = "replay-controls")]
            crate::replay_controls::publish("anchor", &self.now_ms().to_string());
            self.sweeper.changed.notify_one();
        }
    }

    /// Node's `stopSweeperWhenIdle`: the look at what is held and the stop are one step for an authorize or a begin, which publishes and
    /// then arms under the same lock (`arm_sweeper`), so a grant published meanwhile is either seen here or arms after the stop.
    fn stop_sweeper_when_idle(&self) {
        self.point("idle.enter");
        let mut anchor = self.sweeper.anchor.lock().expect("sweeper");
        let held = self.downloads_held();
        self.point("idle.checked");
        if !held && anchor.take().is_some() {
            #[cfg(feature = "replay-controls")]
            crate::replay_controls::publish("anchor", "none");
            self.sweeper.changed.notify_one();
        }
    }

    /// Node's 15 s sweeper: from the moment the first grant or transfer is held it sweeps every [`SWEEP_INTERVAL`] on `timer`, so a
    /// handle closes at its tick although no call comes, and it stops when nothing is held. Never returns; run it as one task.
    pub async fn run_download_sweeper(&self, timer: &dyn IdleTimer) {
        loop {
            let anchor = loop {
                let changed = self.sweeper.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(anchor) = *self.sweeper.anchor.lock().expect("sweeper") {
                    break anchor;
                }
                changed.await;
            };
            let mut tick = anchor + SWEEP_INTERVAL;
            loop {
                let changed = self.sweeper.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let current = *self.sweeper.anchor.lock().expect("sweeper");
                if current != Some(anchor) {
                    break;
                }
                tokio::select! {
                    () = timer.sleep_until(tick) => {
                        if *self.sweeper.anchor.lock().expect("sweeper") != Some(anchor) {
                            break;
                        }
                        self.sweep_downloads();
                        #[cfg(feature = "replay-controls")]
                        crate::replay_controls::publish("swept", &self.now_ms().to_string());
                        #[cfg(test)]
                        self.sweeper.swept.notify_one();
                        tick += SWEEP_INTERVAL;
                    }
                    () = &mut changed => {}
                }
            }
        }
    }

    /// Unpair: everything `owner` holds ends now, and a call of it that is in flight finds it revoked.
    pub fn revoke_owner(&self, owner: &str) {
        let _reporting = Reporting(self);
        let mut gate = self.generations.lock().expect("generations");
        *gate.owners.entry(owner.to_owned()).or_default() += 1;
        self.end_owner(owner);
        self.stop_sweeper_when_idle();
    }

    /// The catalog dropped the conversation (Node's `retainSessions`): every grant and phone transfer on it ends now, in the same step
    /// the catalog change is published, and a call on it that is in flight finds it removed.
    pub fn remove_session(&self, session: &str) {
        let _reporting = Reporting(self);
        let mut gate = self.generations.lock().expect("generations");
        *gate.sessions.entry(session.to_owned()).or_default() += 1;
        if gate.removed.insert(session.to_owned()) {
            // Raised under the generations lock, before the lock is released: a relist that loads zero ran wholly before this removal.
            self.removed_marks.fetch_add(1, std::sync::atomic::Ordering::Release);
        }
        self.grants.lock().expect("transfer grants").retain(|(_, g)| g.session != session);
        self.reads.lock().expect("transfer reads").retain(|_, r| r.session != session);
        self.drop_staged(|held| held.session == session);
        self.stop_sweeper_when_idle();
    }

    /// A catalog publication lists these conversations: one that was removed is a member again (Node's `retainCatalog` replaces the
    /// catalog, so `sessionRemoved` is false for a listed id, `file-downloads.ts:449-450,468-472`). Its generation stays bumped, so what
    /// was authorized before the removal stays ended and a call that marked it before then is still `expired`; a fresh authorize works.
    /// The removed marks are only the conversations removed and not listed since.
    pub fn relisted(&self, sessions: &[&str]) {
        // Every list page and row publication passes here: with no removed mark (the ordinary case) it costs one atomic load.
        if self.removed_marks.load(std::sync::atomic::Ordering::Acquire) == 0 {
            return;
        }
        let mut gate = self.generations.lock().expect("generations");
        for session in sessions {
            if gate.removed.remove(*session) {
                self.removed_marks.fetch_sub(1, std::sync::atomic::Ordering::Release);
            }
        }
    }

    /// Whether `owners` still hold the transfer `id`: the last look a call takes before it answers.
    pub fn holds(&self, owners: &[&str], id: &str) -> bool {
        self.reads.lock().expect("transfer reads").get(id).is_some_and(|r| owners.contains(&r.owner.as_str()))
    }

    /// The relay closed, or this host unpaired every device.
    pub fn revoke_all(&self) {
        let _reporting = Reporting(self);
        let mut gate = self.generations.lock().expect("generations");
        // Node's next relay handle starts a new service with no generations and no catalog (`remote-relay.ts:185`): the per-owner and
        // per-conversation counts and the removed marks go, which is all that bounds them. `all` moves past every sum a mark taken before
        // could hold, so no earlier mark matches again.
        let highest = gate.owners.values().max().copied().unwrap_or(0) + gate.sessions.values().max().copied().unwrap_or(0);
        gate.all += highest + 1;
        gate.owners.clear();
        gate.sessions.clear();
        gate.removed.clear();
        self.removed_marks.store(0, std::sync::atomic::Ordering::Release);
        self.grants.lock().expect("transfer grants").clear();
        self.reads.lock().expect("transfer reads").retain(|_, read| read.lease.is_none());
        self.drop_staged(|_| true);
        self.stop_sweeper_when_idle();
    }

    /// Opens the download a phone asked for as a grant: the file stays open, so what was authorized is what is read. `mark` is
    /// [`Self::mark`] taken before the file work.
    pub fn authorize(&self, owner: &str, session: &str, mark: u64, opened: DownloadFile) -> WsResult<Authorized> {
        let _reporting = Reporting(self);
        self.sweep_downloads();
        // A staged download's record was added by [`Self::stage`] before the marks are checked: a revoked authorize leaves it to its time.
        let DownloadFile { file, location, name, mime_type } = opened;
        let size = file.metadata()?.len();
        self.point("authorize.opened");
        let version = version_string(&file_version(&file)?);
        let name = sanitized_file_name(&name);
        let grant_id = new_id();
        // Checking the marks and publishing the grant are one step for a revoke (Node's `stillAuthorized` and `addGrant`, synchronous).
        let gate = self.generations.lock().expect("generations");
        gate.still_authorized(owner, session, mark)?;
        let expires_at = self.now_ms() + GRANT_TTL_MS;
        {
            let mut grants = self.grants.lock().expect("transfer grants");
            let held: Vec<String> = grants.iter().filter(|(_, g)| g.owner == owner).map(|(id, _)| id.clone()).collect();
            for stale in held.iter().take((held.len() + 1).saturating_sub(MAX_GRANTS_PER_DEVICE)) {
                grants.retain(|(id, _)| id != stale);
            }
            grants.push((
                grant_id.clone(),
                Grant {
                    owner: owner.to_owned(),
                    session: session.to_owned(),
                    file,
                    location,
                    size,
                    version: version.clone(),
                    name: name.clone(),
                    mime: mime_type.clone(),
                    expires_at,
                },
            ));
        }
        drop(gate);
        self.arm_sweeper();
        Ok(Authorized { grant_id, name, size, mime: mime_type, version, expires_at, left_out: None })
    }

    /// The revocation generation of `owner` and `session`, read before the file work of a call that checks it again afterwards.
    pub fn mark(&self, owner: &str, session: &str) -> u64 {
        self.generation(owner, session)
    }

    /// Consumes the grant (once) into one transfer (Node's `begin`).
    pub fn begin_grant(&self, owner: &str, grant_id: &str) -> WsResult<Leased> {
        let _reporting = Reporting(self);
        self.sweep_downloads();
        // Consuming the grant and reading the marks are one step for a revoke: it either ends the grant first or finds it consumed
        // and is seen by the check after the file work.
        let (grant, mark) = {
            let gate = self.generations.lock().expect("generations");
            let mut grants = self.grants.lock().expect("transfer grants");
            let at = grants.iter().position(|(id, g)| id == grant_id && g.owner == owner).ok_or_else(WsError::expired)?;
            let grant = grants.remove(at).1;
            let mark = gate.of(owner, &grant.session);
            (grant, mark)
        };
        self.point("begin.taken");
        verify_unchanged(&grant.file, &grant.version, &grant.location)?;
        self.point("begin.verify");
        // The check and the publication of the transfer are one step for a revoke.
        let gate = self.generations.lock().expect("generations");
        gate.still_authorized(owner, &grant.session, mark)?;
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.values().filter(|r| r.owner == owner && r.lease.is_some()).count() >= MAX_LEASES_PER_DEVICE {
            return Err(download("file-download:busy", "Too many downloads are in progress on this device."));
        }
        let at = self.now_ms();
        let times = LeaseTimes { expires_at: at + LEASE_MAX_MS, idle_until: at + LEASE_IDLE_MS };
        let transfer_id = new_id();
        let Grant { file, location, session, size, version, name, mime, .. } = grant;
        reads.insert(
            transfer_id.clone(),
            Read { owner: owner.to_owned(), session, file, location: Some(location), size, version: version.clone(), lease: Some(times), _cleanup: None, opened: Instant::now() },
        );
        drop(reads);
        drop(gate);
        self.point("begin.published");
        self.arm_sweeper();
        Ok(Leased {
            transfer_id,
            name,
            size,
            mime,
            version,
            expires_at: times.expires_at,
            range_max_bytes: RANGE_MAX_BYTES,
            media: LeaseMedia { asset_id: new_id(), variant: "download", expires_at: times.expires_at },
        })
    }

    /// The phone is done: the file must still be the version that was leased, and the transfer ends either way.
    pub fn finish_read(&self, owner: &str, id: &str) -> WsResult<Finished> {
        let _reporting = Reporting(self);
        self.sweep_downloads();
        let read = {
            let mut reads = self.reads.lock().expect("transfer reads");
            if !reads.get(id).is_some_and(|r| r.owner == owner && r.lease.is_some()) {
                return Err(WsError::expired());
            }
            reads.remove(id).expect("checked")
        };
        verify_unchanged(&read.file, &read.version, read.location.as_deref().expect("a phone's transfer has its location"))?;
        Ok(Finished { transfer_id: id.to_owned(), size: read.size, version: read.version.clone() })
    }

    /// When the first upload goes idle (`fed + idle`), or none while no upload is open.
    fn next_idle_deadline(&self) -> Option<Instant> {
        self.writes.lock().expect("transfer writes").values().map(|upload| upload.fed + self.idle).min()
    }

    /// Returns when the earliest open upload reaches its idle deadline, as Node's per-upload
    /// `setTimeout(idleMs)` fires; an upload begun or fed meanwhile moves the deadline and the wait
    /// is recomputed, and with no upload open it waits for the next one. The caller then runs
    /// [`Self::sweep_idle`] (on a lane: it removes files).
    pub async fn wait_idle_due(&self, timer: &dyn IdleTimer) {
        loop {
            let moved = self.armed.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            match self.next_idle_deadline() {
                None => moved.await,
                Some(deadline) => {
                    tokio::select! {
                        () = timer.sleep_until(deadline) => {
                            // A chunk may have moved the deadline while this sleep was already due: only a
                            // deadline that has really passed ends the wait.
                            if self.next_idle_deadline().is_some_and(|next| next <= self.clock.now()) {
                                return;
                            }
                        }
                        () = &mut moved => {}
                    }
                }
            }
        }
    }

    /// Discards every upload not fed for the idle time and removes its partial file, as Node's
    /// per-upload idle timer does. Run before each upload call; a daemon with nothing calling may
    /// run it itself, since no timer here fires on its own.
    pub fn sweep_idle(&self) {
        let now = self.clock.now();
        let abandoned: Vec<Upload> = {
            let mut writes = self.writes.lock().expect("transfer writes");
            let stale: Vec<String> = writes
                .iter()
                .filter(|(_, upload)| now.saturating_duration_since(upload.fed) >= self.idle)
                .map(|(id, _)| id.clone())
                .collect();
            stale.into_iter().filter_map(|id| writes.remove(&id)).collect()
        };
        for upload in abandoned {
            let _ = std::fs::remove_file(upload.temp);
        }
    }

    fn register(&self, owner: &str, file: File, name: String, mime: &str, cleanup: Option<PathBuf>) -> WsResult<Opened> {
        let version = file_version(&file)?;
        let version = version_string(&version);
        let size = file.metadata()?.len();
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.len() >= MAX_OPEN_READS {
            return Err(WsError::new(Reason::Busy, "Too many downloads are open."));
        }
        let id = new_id();
        // Every source's offered name goes through Node's `sanitizedFileName`, here and nowhere else.
        let name = sanitized_file_name(&name);
        reads.insert(
            id.clone(),
            Read { owner: owner.to_owned(), session: String::new(), file, location: None, size, version: version.clone(), lease: None, _cleanup: cleanup.map(Cleanup), opened: Instant::now() },
        );
        Ok(Opened { transfer_id: id, size, mime_type: mime.to_owned(), name, version, range_max_bytes: RANGE_MAX_BYTES })
    }

    /// A project file. The real path is verified from the open handle.
    pub fn begin_project_read(&self, owner: &str, root: &Path, rel: &str) -> WsResult<Opened> {
        // Node's `authorizeProjectFile` (file-downloads.ts:319-340): a path `projectEntryPathIn` refuses, or a file whose real place is outside
        // the root, is one `FileDownloadError('outside-project', ...)`.
        let outside = || WsError::denied("The file is outside the conversation's project.");
        let path = project_entry_path(root, rel).map_err(|_| outside())?;
        let opened = open_authorized_ro(&path, root).map_err(|error| if error.reason.code() == "MIXDOG_LOCAL_ACCESS_DENIED" { outside() } else { error })?;
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        self.register(owner, opened.file, name, mime_type(&path), None)
    }

    /// An absolute path the connection may read (the caller's origin rules apply).
    pub fn begin_local_read(&self, owner: &str, path: &str) -> WsResult<Opened> {
        let absolute = absolute_local_path(path)?;
        let file = File::open(&absolute)?;
        if !file.metadata()?.is_file() {
            return Err(WsError::new(Reason::NotAFile, "Only files can be downloaded."));
        }
        let name = absolute.file_name().unwrap_or_default().to_string_lossy().into_owned();
        self.register(owner, file, name, mime_type(&absolute), None)
    }

    /// A file another domain produced (`TransferSource`), read like any file.
    pub fn begin_source(&self, owner: &str, file: SourceFile) -> WsResult<Opened> {
        self.register(owner, file.file, file.name, &file.mime_type, file.cleanup)
    }

    /// A folder as a zip staged in a temp file, then read like any file. The walk runs on
    /// the maintenance lane, the compression on the bulk CPU lane.
    pub async fn begin_zip(
        &self,
        owner: &str,
        git: &dyn crate::zip::TrackedFiles,
        lanes: crate::lanes::Lanes,
        cancel: &tokio_util::sync::CancellationToken,
        root: &Path,
        rel: &str,
    ) -> WsResult<Opened> {
        let probe = project_entry_path(root, rel)?;
        let folder = crate::lanes::run_fallible(lanes.maintenance, cancel, move || {
            let folder = canonical(&probe)?;
            if folder.is_dir() { Ok(folder) } else { Err(WsError::new(Reason::NotAFile, "Not a folder.")) }
        })
        .await?;
        let scan = crate::zip::scan_folder(git, lanes, cancel, &folder, ZIP_MAX_BYTES, ZIP_MAX_FILES, None).await?;
        let temp = std::env::temp_dir().join(format!("mixdog-zip-{}.zip", new_id()));
        let (out_path, files) = (temp.clone(), scan.files);
        let file = crate::lanes::run_fallible(lanes.cpu_bulk, cancel, move || {
            let build = (|| -> WsResult<File> {
                let mut out = File::options().read(true).write(true).create_new(true).open(&out_path)?;
                crate::zip::write_archive(&mut out, &files, ZIP_MAX_BYTES, &|_| {})?;
                out.flush()?;
                Ok(out)
            })();
            build.inspect_err(|_| {
                let _ = std::fs::remove_file(&out_path);
            })
        })
        .await?;
        let mut name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
        name.push_str(".zip");
        self.register(owner, file, name, "application/zip", Some(temp))
    }
    /// `expected`: the version the phone leased (a phone's read names it; a mismatch is `changed`). A phone's transfer also ends
    /// when its file changed, and its idle time starts over with each read.
    pub fn read_range(&self, owners: &[&str], id: &str, offset: u64, length: u64, expected: Option<&str>) -> WsResult<Range> {
        let _reporting = Reporting(self);
        self.sweep_downloads();
        let (file, location, size, version) = {
            let reads = self.reads.lock().expect("transfer reads");
            let read = reads.get(id).filter(|r| owners.contains(&r.owner.as_str())).ok_or_else(WsError::expired)?;
            (read.file.try_clone()?, read.location.clone(), read.size, read.version.clone())
        };
        if expected.is_some_and(|expected| expected != version) {
            return Err(download_changed());
        }
        // A phone's transfer ends when its file changed or moved (Node's `readLease` drops the lease on `changed`).
        if let Some(location) = &location {
            if let Err(changed) = verify_unchanged(&file, &version, location) {
                self.reads.lock().expect("transfer reads").remove(id);
                return Err(changed);
            }
        } else if version_string(&file_version(&file)?) != version {
            return Err(WsError::changed());
        }
        if offset > size {
            return Err(WsError::invalid("offset is past the end of the file."));
        }
        let length = length.min(RANGE_MAX_BYTES).min(size - offset);
        // Where Node's `handle.read` is held (and so where something else happens to the host meanwhile).
        self.point("read.read");
        let mut data = vec![0u8; length as usize];
        let mut filled = 0usize;
        while filled < data.len() {
            let n = read_at(&file, &mut data[filled..], offset + filled as u64)?;
            if n == 0 {
                // The file ended before the window did (truncated after it was checked): Node's `readExact` rejects `changed`, and
                // `readLease` drops the lease on it.
                if location.is_some() {
                    self.reads.lock().expect("transfer reads").remove(id);
                    self.stop_sweeper_when_idle();
                    return Err(download_changed());
                }
                return Err(WsError::changed());
            }
            filled += n;
        }
        let data = STANDARD.encode(&data);
        // Revoked while reading: nothing more leaves the transfer. This look is the last step before the answer is built.
        {
            let mut reads = self.reads.lock().expect("transfer reads");
            let read = reads.get_mut(id).filter(|r| owners.contains(&r.owner.as_str())).ok_or_else(WsError::expired)?;
            if let Some(lease) = read.lease.as_mut() {
                lease.idle_until = self.now_ms() + LEASE_IDLE_MS;
            }
        }
        let range = Range { transfer_id: id.to_owned(), offset, length, eof: offset + length >= size, version, data };
        self.point("read.checked");
        Ok(range)
    }

    /// Ends a transfer, or an unredeemed grant, of `owner`; whether anything was released.
    pub fn end_read(&self, owners: &[&str], id: &str) -> bool {
        let _reporting = Reporting(self);
        self.sweep_downloads();
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.get(id).is_some_and(|r| owners.contains(&r.owner.as_str())) {
            reads.remove(id);
            drop(reads);
            self.stop_sweeper_when_idle();
            return true;
        }
        drop(reads);
        let mut grants = self.grants.lock().expect("transfer grants");
        let before = grants.len();
        grants.retain(|(grant, g)| !(grant == id && owners.contains(&g.owner.as_str())));
        let ended = grants.len() != before;
        drop(grants);
        self.stop_sweeper_when_idle();
        ended
    }

    pub fn begin_write(&self, owner: &str, root: &Path, rel: &str, size: u64) -> WsResult<String> {
        self.sweep_idle();
        let target = project_entry_path(root, rel)?;
        if target.exists() {
            return Err(WsError::new(Reason::AlreadyExists, "An entry with that name already exists in the target folder."));
        }
        let parent = target.parent().ok_or_else(|| WsError::invalid("Path is invalid."))?;
        std::fs::create_dir_all(parent)?;
        let id = new_id();
        let temp = parent.join(format!(".{id}.part"));
        let file = File::options().write(true).create_new(true).open(&temp)?;
        self.writes
            .lock()
            .expect("transfer writes")
            .insert(id.clone(), Upload { owner: owner.to_owned(), temp, target, file, size, written: 0, unique: false, writing: false, fed: self.clock.now() });
        self.armed.notify_one();
        Ok(id)
    }

    /// `serverUploadBegin(name, size, scope)`: an upload into the staging folder `dir`, published at
    /// commit under `name`, or `name (2).ext`... when that is taken.
    pub fn begin_staged(&self, owner: &str, dir: &Path, name: &str, size: u64) -> WsResult<String> {
        self.sweep_idle();
        std::fs::create_dir_all(dir)?;
        let id = new_id();
        let temp = dir.join(format!(".{id}.part"));
        let file = File::options().write(true).create_new(true).open(&temp)?;
        self.writes.lock().expect("transfer writes").insert(
            id.clone(),
            Upload { owner: owner.to_owned(), temp, target: dir.join(upload_file_name(name)), file, size, written: 0, unique: true, writing: false, fed: self.clock.now() },
        );
        self.armed.notify_one();
        Ok(id)
    }

    /// `serverUploadChunk(id, offset, data)`, check for check as Node orders them: the upload
    /// must exist, the offset must be an integer within the declared size, the data canonical
    /// base64 of 1..=[`UPLOAD_CHUNK_BYTES`] bytes. A chunk the upload already holds as its last
    /// one is acknowledged, not rewritten; one that does not start at the received bytes is out
    /// of order; one that arrives while another is being written is refused; one that would pass
    /// the declared size discards the upload. Answers the bytes received.
    pub fn write_chunk(&self, owner: &str, id: &str, offset: Option<u64>, encoded: &str) -> WsResult<u64> {
        self.sweep_idle();
        let (file, bytes) = {
            let mut writes = self.writes.lock().expect("transfer writes");
            let (size, written, writing) = {
                let write = writes.get(id).filter(|w| w.owner == owner).ok_or_else(upload_gone)?;
                (write.size, write.written, write.writing)
            };
            let offset = offset.filter(|offset| *offset <= size).ok_or_else(|| WsError::invalid("offset is invalid."))?;
            let bytes = decode_chunk(encoded)?;
            let length = bytes.len() as u64;
            if offset < written && offset + length == written {
                return Ok(written);
            }
            if offset != written {
                return Err(WsError::new(Reason::OutOfOrder, "The upload chunk is out of order."));
            }
            if writing {
                return Err(WsError::new(Reason::Busy, "The upload is already writing a chunk."));
            }
            if written + length > size {
                if let Some(discarded) = writes.remove(id) {
                    let _ = std::fs::remove_file(discarded.temp);
                }
                return Err(WsError::new(Reason::TooLarge, "The upload is larger than it declared."));
            }
            let write = writes.get_mut(id).expect("checked above");
            let file = write.file.try_clone()?;
            write.writing = true;
            (file, bytes)
        };
        // The write runs outside the table lock so a second chunk meets `writing` instead of waiting.
        let outcome = (&file).write_all(&bytes);
        let mut writes = self.writes.lock().expect("transfer writes");
        match outcome {
            Ok(()) => {
                let write = writes.get_mut(id).ok_or_else(upload_gone)?;
                write.written += bytes.len() as u64;
                write.writing = false;
                write.fed = self.clock.now();
                self.armed.notify_one();
                Ok(write.written)
            }
            Err(error) => {
                if let Some(discarded) = writes.remove(id) {
                    let _ = std::fs::remove_file(discarded.temp);
                }
                Err(error.into())
            }
        }
    }
    pub fn commit(&self, owner: &str, id: &str) -> WsResult<(u64, PathBuf)> {
        self.sweep_idle();
        let write = {
            let mut writes = self.writes.lock().expect("transfer writes");
            if !writes.get(id).is_some_and(|w| w.owner == owner) {
                return Err(upload_gone());
            }
            writes.remove(id).expect("checked")
        };
        let Upload { temp, target, file, size, written, unique, .. } = write;
        let outcome = (|| -> WsResult<PathBuf> {
            if written != size {
                return Err(WsError::invalid("Upload is incomplete."));
            }
            file.sync_all()?;
            drop(file);
            if unique {
                return publish_unique(&temp, &target);
            }
            if target.exists() {
                return Err(WsError::new(Reason::AlreadyExists, "An entry with that name already exists in the target folder."));
            }
            std::fs::rename(&temp, &target)?;
            Ok(target.clone())
        })();
        // A published staged upload keeps its hard link only; the temp name always goes.
        let _ = std::fs::remove_file(&temp);
        outcome.map(|path| (size, path))
    }

    pub fn abort(&self, owner: &str, id: &str) -> bool {
        self.sweep_idle();
        let removed = {
            let mut writes = self.writes.lock().expect("transfer writes");
            if writes.get(id).is_some_and(|w| w.owner == owner) { writes.remove(id) } else { None }
        };
        if let Some(write) = removed {
            let _ = std::fs::remove_file(write.temp);
            return true;
        }
        self.end_read(&[owner], id)
    }

    /// Ends every transfer of `owner` (a closed connection, a revoked device); in-flight
    /// reads fail with `expired` from then on.
    pub fn end_owner(&self, owner: &str) {
        let _reporting = Reporting(self);
        self.reads.lock().expect("transfer reads").retain(|_, r| r.owner != owner);
        self.grants.lock().expect("transfer grants").retain(|(_, g)| g.owner != owner);
        self.drop_staged(|held| held.owner == owner);
        let stale: Vec<Upload> = {
            let mut writes = self.writes.lock().expect("transfer writes");
            let ids: Vec<String> = writes.iter().filter(|(_, w)| w.owner == owner).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| writes.remove(&id)).collect()
        };
        for write in stale {
            let _ = std::fs::remove_file(write.temp);
        }
        self.stop_sweeper_when_idle();
    }

    pub fn open_reads(&self) -> usize {
        self.reads.lock().expect("transfer reads").len()
    }

    /// The files held open for phone downloads: unredeemed grants and begun transfers (what Node's handle count shows).
    #[cfg(test)]
    pub(crate) fn held_downloads(&self) -> usize {
        self.grants.lock().expect("transfer grants").len() + self.reads.lock().expect("transfer reads").values().filter(|r| r.lease.is_some()).count()
    }
}

/// Held by a call that changes what the downloads hold: when the call ends, after every file it let go of is closed, the replay is told
/// the count (declared first in the call, so dropped last). Nothing without the `replay-controls` feature.
#[cfg_attr(not(feature = "replay-controls"), allow(dead_code))]
struct Reporting<'a>(&'a Transfers);

impl Drop for Reporting<'_> {
    fn drop(&mut self) {
        #[cfg(feature = "replay-controls")]
        self.0.report();
    }
}

pub type SharedTransfers = Arc<Transfers>;

fn not_local() -> WsError {
    download("file-download:not-a-file", "Only files on this PC can be downloaded.")
}

/// Node's `NETWORK_PATH` (`/^[\\/]{2}/`): a UNC path, however its separators are written.
fn is_network_path(text: &str) -> bool {
    let mut leading = text.chars();
    matches!((leading.next(), leading.next()), (Some('/' | '\\'), Some('/' | '\\')))
}

/// Node's `requiredText` (`file-downloads.ts`, over `requiredString`, `ipc-validation.ts:656-661`): a string, trimmed as JavaScript trims,
/// not empty, at most `maximum` UTF-16 units, with no NUL; the trimmed text is what the call goes on with.
pub(crate) fn required_text(value: Option<&serde_json::Value>, name: &str, maximum: usize) -> WsResult<String> {
    let Some(text) = value.and_then(serde_json::Value::as_str) else {
        return Err(WsError::invalid(format!("{name} must be a string.")));
    };
    let text = text.trim_matches(js_space);
    if text.is_empty() || text.encode_utf16().count() > maximum || text.contains('\0') {
        return Err(WsError::invalid(format!("{name} is invalid.")));
    }
    Ok(text.to_owned())
}

/// Node's `requiredSessionId` (`desktop-state.ts:50-65`): a string, trimmed, 1..=256 units of `[A-Za-z0-9_-]`.
pub(crate) fn required_session_id(value: Option<&serde_json::Value>) -> WsResult<String> {
    let Some(text) = value.and_then(serde_json::Value::as_str) else {
        return Err(WsError::invalid("session id must be a string."));
    };
    let id = text.trim_matches(js_space);
    if id.is_empty() || id.len() > 256 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(WsError::invalid("session id is invalid."));
    }
    Ok(id.to_owned())
}

/// Node's `requiredFileDownloadId`: a lower-case hexadecimal UUID, as written (not trimmed).
pub(crate) fn required_download_id(value: Option<&serde_json::Value>, name: &str) -> WsResult<String> {
    let valid = |id: &str| {
        let groups: Vec<&str> = id.split('-').collect();
        groups.iter().map(|group| group.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|group| group.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    };
    value.and_then(serde_json::Value::as_str).filter(|id| valid(id)).map(str::to_owned).ok_or_else(|| WsError::invalid(format!("{name} is invalid.")))
}

/// What a phone's authorize names, checked as Node's `requiredFileDownloadRequest` checks each kind (the core's kinds: `file` is Node's
/// `project`, `sessionFile` its `session`, `mediaAsset` its `media`); any other kind is `download source is invalid.`.
pub(crate) enum DownloadRequest {
    Project(String),
    Session(String),
    Media(String),
    /// Node's `link`: the `href` of a link the conversation shows (its `itemId` is checked and not used, as Node's).
    Link(String),
    /// Node's `attachment`: an attachment id the conversation's transcript names.
    Attachment(String),
    /// Node's `folder`: a folder the conversation names, zipped.
    Folder(String),
}

impl DownloadRequest {
    pub(crate) fn of(source: &serde_json::Value) -> WsResult<Self> {
        match source.get("kind").and_then(serde_json::Value::as_str) {
            Some("file") => {
                let rel = required_text(source.get("rel"), "relPath", 4_096)?;
                if is_absolute_path(&rel) {
                    return Err(WsError::invalid("relPath must be project-relative."));
                }
                Ok(Self::Project(rel))
            }
            Some("sessionFile") => Ok(Self::Session(required_text(source.get("path"), "path", 4_096)?)),
            Some("folder") => Ok(Self::Folder(required_text(source.get("path"), "path", 4_096)?)),
            Some("mediaAsset") => {
                let asset = required_text(source.get("assetId"), "asset id", 128)?;
                // `MEDIA_ASSET_ID`: `[A-Za-z0-9_-]{1,128}`.
                if !asset.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    return Err(WsError::invalid("asset id is invalid."));
                }
                Ok(Self::Media(asset))
            }
            Some("link") => {
                required_text(source.get("itemId"), "item id", 256)?;
                Ok(Self::Link(required_text(source.get("href"), "href", 4_096)?))
            }
            Some("attachment") => {
                // `requiredAttachmentId`: any non-string, or a string off `/^[a-f0-9]{64}$/`, is one TypeError (no trim).
                let id = source.get("attachmentId").and_then(serde_json::Value::as_str).unwrap_or_default();
                if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return Err(WsError::invalid("attachment id is invalid."));
                }
                Ok(Self::Attachment(id.to_owned()))
            }
            _ => Err(WsError::invalid("download source is invalid.")),
        }
    }
}

/// JavaScript's `decodeURIComponent`, or `None` where it throws (a `%` not followed by two hex digits, or bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok())?;
            out.push(hex);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The path part of a link, without the `path:12`, `path:12:4`, `path:12-20` or `path#L12…` location it carries (`parseLocalFileLocation`,
/// `shared/local-files.ts`): the location is dropped whether or not its numbers are valid, and a drive letter is never a line.
fn link_location_path(raw: &str) -> &str {
    static HASH: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$").expect("pattern"));
    static COLON: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r":(\d+)(?::(\d+))?(?:-(\d+))?$").expect("pattern"));
    if let Some(found) = HASH.find(raw) {
        return &raw[..found.start()];
    }
    if let Some(found) = COLON.find(raw) {
        let before = &raw[..found.start()];
        if found.start() > 0 && !(before.len() == 1 && before.as_bytes()[0].is_ascii_alphabetic()) {
            return before;
        }
    }
    raw
}

/// The host path a link's `href` names as the desktop decodes it (`linkPath`, `transcript-file-links.ts:17-25`, over `isLocalMarkdownLink`
/// and `localMarkdownPath`, `renderer/markdown-url.ts`): trailing punctuation goes, a web link or an anchor names nothing, a `file:` URL
/// loses its scheme, the query and fragment go, the rest is percent-decoded once and its backslashes become slashes. `None` names nothing.
pub(crate) fn link_path(href: &str) -> Option<String> {
    let text = href.trim_matches(js_space).trim_end_matches(['.', ',', ';', ':', '!', '?', '\'', '"', ')', ']', '}', '>']);
    // `isLocalMarkdownLink`.
    static SCHEME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z][a-z\d+.-]*:").expect("pattern"));
    static WINDOWS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^[a-z]:(?:[/\\]|%2f|%5c)").expect("pattern"));
    static FILE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^file:").expect("pattern"));
    let target = text.trim_matches(js_space);
    if target.is_empty() || target.starts_with(['#', '?']) || target.starts_with("//") {
        return None;
    }
    if !(FILE.is_match(target) || WINDOWS.is_match(target)) && SCHEME.is_match(target) {
        return None;
    }
    // `localMarkdownPath(parseLocalFileLocation(text).path)`.
    let mut path = link_location_path(text.trim_matches(js_space)).trim_matches(js_space).to_owned();
    if FILE.is_match(&path) {
        static PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^file://(?:localhost)?").expect("pattern"));
        static DRIVE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^/[a-z]:").expect("pattern"));
        path = PREFIX.replace(&path, "").into_owned();
        if DRIVE.is_match(&path) {
            path.remove(0);
        }
    }
    let before = path.split(['?', '#']).next().unwrap_or_default();
    let decoded = decode_uri_component(before).unwrap_or_else(|| before.to_owned()).replace('\\', "/");
    (!decoded.is_empty() && !decoded.contains('\0')).then_some(decoded)
}

/// Node's `path.isAbsolute` on the host: a Windows host takes a drive path and a rooted one, any other only a rooted one.
pub(crate) fn is_absolute_path(text: &str) -> bool {
    let rooted = text.starts_with('/') || (cfg!(windows) && text.starts_with('\\'));
    let drive = cfg!(windows) && matches!(text.as_bytes(), [letter, b':', b'/' | b'\\', ..] if letter.is_ascii_alphabetic());
    rooted || drive
}

/// What `openRegularFile` proves of an open file after opening it, from the handle alone: a regular file, living where it was resolved
/// to, no larger than a download may be. A file that is none of these is closed (dropped) by the caller.
fn prove_opened(file: &File, location: &Path) -> WsResult<()> {
    if !file.metadata()?.is_file() {
        return Err(not_local());
    }
    verify_location(file, location)?;
    if file.metadata()?.len() > DOWNLOAD_MAX_BYTES {
        return Err(download("file-download:too-large", "Files larger than 256 MB cannot be downloaded."));
    }
    Ok(())
}

/// Node's `verifyLocation`: `changed` unless the open file itself lives at `location`. On Windows `location` must also still open as that
/// very file (Node's locator opens it by that path and compares the file index), which a file deleted while open no longer does.
fn verify_location(file: &File, location: &Path) -> WsResult<()> {
    #[cfg(windows)]
    if crate::ident::path_id(location).ok() != crate::ident::file_id(file).ok() {
        return Err(download_changed());
    }
    match crate::ident::handle_path(file) {
        Ok(at) if comparable(&at) == comparable(location) => Ok(()),
        _ => Err(download_changed()),
    }
}

/// Node's `verifyUnchanged`: the open file is still the version authorized (identity, size, modification time) and still lives where it
/// was authorized.
fn verify_unchanged(file: &File, version: &str, location: &Path) -> WsResult<()> {
    if version_string(&file_version(file)?) != version {
        return Err(download_changed());
    }
    verify_location(file, location)
}

/// The file opened the way Node opens it: never following a final link and never blocking on a swapped-in pipe where the platform has
/// those flags; Windows shares the file with every other opener, as libuv does, so the user can rename or delete it during a download.
fn open_read_only(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
    }
    #[cfg(not(unix))]
    {
        File::open(path)
    }
}

/// Node's `openRegularFile`: a regular file by its real path, never a network path, a folder or a device, and proved from the open handle
/// to be the file at that path (an ancestor swapped for a link between resolving and opening opens another file and is `changed`).
/// `between` is called after the path is resolved and before it is opened (Node's `afterResolve`).
fn open_regular(path: &Path, between: &dyn Fn(&str)) -> WsResult<(PathBuf, File)> {
    let missing = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => download("file-download:not-found", "The file no longer exists."),
        _ => WsError::from(error),
    };
    if is_network_path(&path.to_string_lossy()) {
        return Err(not_local());
    }
    let real = canonical(path).map_err(missing)?;
    if is_network_path(&real.to_string_lossy()) || !std::fs::metadata(&real).map_err(missing)?.is_file() {
        return Err(not_local());
    }
    between("authorize.resolved");
    let file = open_read_only(&real).map_err(missing)?;
    prove_opened(&file, &real)?;
    Ok((real, file))
}

fn offered(path: &Path, real: PathBuf, file: File) -> DownloadFile {
    // The offered name and type are the requested path's (`basename(lexical)`), not the real one's.
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    DownloadFile { file, location: real, mime_type: mime_type(path).to_owned(), name }
}

/// A project file of a conversation (`authorizeProjectFile`): the relative path may not leave `root`, and neither may its real place.
pub fn open_project_download(root: &Path, rel: &str, between: &dyn Fn(&str)) -> WsResult<DownloadFile> {
    let outside = || download("file-download:outside-project", "The file is outside the conversation's project.");
    let lexical_path = project_entry_path(root, rel).map_err(|_| outside())?;
    let (real, file) = open_regular(&lexical_path, between)?;
    if !crate::pathguard::is_within(root, &real) {
        return Err(outside());
    }
    Ok(offered(&lexical_path, real, file))
}

/// Recorded on Node (`windows path names`): a final name ending in a dot, or a DOS device name (`NUL`), is not found. The host's own path
/// normalization (`std::path::absolute`) would drop the dot and turn the device into `\\.\NUL`, so the name is judged as the caller wrote it.
fn refuse_windows_name(path: &str) -> WsResult<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let last = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = last.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    if (last.ends_with('.') && last != "." && last != "..") || device {
        return Err(download("file-download:not-found", "The file no longer exists."));
    }
    Ok(())
}

/// A file a conversation names (`authorizeSessionFile` / `openSessionPath`): absolute, or relative to the conversation's folder `cwd`
/// (`resolveLinkedPath`); anywhere on this PC, but a path inside the conversation's project may not leave it through a link. `project` is
/// the registered project's real folder and `project_given` the folder as the conversation states it.
pub fn open_session_download(path: &str, cwd: &str, project: Option<&Path>, project_given: Option<&Path>, between: &dyn Fn(&str)) -> WsResult<DownloadFile> {
    if is_network_path(path) {
        return Err(not_local());
    }
    refuse_windows_name(path)?;
    let requested = requested_session_path(path, cwd)?;
    let in_project = lexically_in_project(&requested, project, project_given);
    let (real, file) = open_regular(&requested, between)?;
    left_project(in_project, project, &real)?;
    Ok(offered(&requested, real, file))
}

/// `requestedPath(resolveLinkedPath(path, cwd))`: absolute as written, or relative to the conversation's folder; a network path, or a
/// relative one with no folder, names nothing on this PC.
fn requested_session_path(path: &str, cwd: &str) -> WsResult<PathBuf> {
    if is_network_path(path) {
        Err(not_local())
    } else if is_absolute_path(path) {
        Ok(crate::pathguard::resolve(Path::new(path)))
    } else if is_absolute_path(cwd) {
        Ok(crate::pathguard::resolve(&Path::new(cwd).join(path)))
    } else {
        Err(not_local())
    }
}

/// `lexicalInProject`: the requested path is inside the registered project, or inside the project as the conversation states it.
fn lexically_in_project(requested: &Path, project: Option<&Path>, project_given: Option<&Path>) -> bool {
    project.is_some_and(|root| {
        crate::pathguard::is_within(root, requested) || project_given.is_some_and(|given| crate::pathguard::is_within(&crate::pathguard::resolve(given), requested))
    })
}

/// A path inside the project may not leave it through a link.
fn left_project(in_project: bool, project: Option<&Path>, real: &Path) -> WsResult<()> {
    if in_project && !project.is_some_and(|root| crate::pathguard::is_within(root, real)) {
        return Err(download("file-download:outside-project", "The link resolves outside the conversation's project."));
    }
    Ok(())
}

/// A folder a conversation names (`authorizeFolderZip`, before the zip): absolute, or relative to its folder; it must be a folder, its
/// real place on this PC, and inside the project it may not leave it. The real folder is what is zipped.
pub fn phone_folder(path: &str, cwd: &str, project: Option<&Path>, project_given: Option<&Path>) -> WsResult<PathBuf> {
    let missing = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => download("file-download:not-found", "The file no longer exists."),
        _ => WsError::from(error),
    };
    let requested = requested_session_path(path, cwd)?;
    if !std::fs::metadata(&requested).map_err(missing)?.is_dir() {
        return Err(download("file-download:not-a-file", "Only a folder can be downloaded as a zip."));
    }
    let real = canonical(&requested).map_err(missing)?;
    if is_network_path(&real.to_string_lossy()) {
        return Err(download("file-download:not-a-file", "Only folders on this PC can be downloaded."));
    }
    left_project(lexically_in_project(&requested, project, project_given), project, &real)?;
    Ok(real)
}

/// What the zip of a phone's folder refuses with, as Node's `authorizeFolderZip` maps `zipFolder`'s errors: a moved folder is `changed`,
/// one past a cap `folder-too-large` with Node's `folderTooLargeMessage`.
pub fn phone_folder_refusal(error: WsError) -> WsError {
    match error.reason {
        Reason::Changed => download_changed(),
        Reason::FolderTooLarge { files, bytes } => download("file-download:folder-too-large", &folder_too_large_message(files, bytes)),
        _ => error,
    }
}

/// `folderTooLargeMessage(files, bytes)` (`shared/file-downloads.ts`): the counts against the caps, `toLocaleString('en-US')` and
/// `toFixed(1)` megabytes.
fn folder_too_large_message(files: u64, bytes: u64) -> String {
    format!(
        "This folder has {} files ({} MB) after leaving out ignored files, over the limit of {} files and {} MB. Pick a subfolder to download instead.",
        grouped(files),
        megabytes(bytes),
        grouped(ZIP_MAX_FILES as u64),
        megabytes(ZIP_MAX_BYTES)
    )
}

/// `(bytes / 2^20).toFixed(1)`: the nearest tenth, a tie going up (computed exactly from the integer).
fn megabytes(bytes: u64) -> String {
    let tenths = (u128::from(bytes) * 10 + (1 << 19)) >> 20;
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// `n.toLocaleString('en-US')` of a whole number: thousands grouped with commas.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The file a staged download's bytes are written to, inside its own folder (Node's `join(folder, 'payload')`).
pub const STAGED_PAYLOAD: &str = "payload";

/// A private folder for one staged download, as Node's `stageTemporaryDownload` makes it (`mkdtemp(join(tmpdir(), 'mixdog-download-'))`,
/// mode 0700 on Unix), and its payload file created new for writing with mode 0600 (`writeFile(path, bytes, { mode: 0o600 })`). On
/// Windows both inherit the ACL of the user's temp folder, as Node's do (its modes do not apply there). The folder is the cleanup: it
/// goes whole. A failure removes what was made.
pub fn staged_payload() -> std::io::Result<(PathBuf, File)> {
    let folder = staged_folder()?;
    match staged_file(&folder) {
        Ok(file) => Ok((folder, file)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&folder);
            Err(error)
        }
    }
}

/// The private folder of one staged download (`mkdtemp`, 0700 on Unix).
fn staged_folder() -> std::io::Result<PathBuf> {
    let folder = std::env::temp_dir().join(format!("mixdog-download-{}", new_id().replace('-', "")));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut dir = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
    dir.create(&folder)?;
    Ok(folder)
}

/// The payload of a staged download's folder, created new for writing (0600 on Unix).
fn staged_file(folder: &Path) -> std::io::Result<File> {
    let mut options = File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(folder.join(STAGED_PAYLOAD))
}

/// The zip of a phone's folder, whole in memory as Node's `zipFolder` builds it before it is staged, and the name it is offered by:
/// `<folder>.zip` by its real name.
pub fn folder_zip(folder: &Path, files: &[crate::zip::FolderFile], between: &dyn Fn(&str)) -> WsResult<(Vec<u8>, String)> {
    let mut out = std::io::Cursor::new(Vec::new());
    crate::zip::write_archive(&mut out, files, ZIP_MAX_BYTES, between).map_err(phone_folder_refusal)?;
    let base = folder.file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| !name.is_empty()).unwrap_or_else(|| "folder".into());
    Ok((out.into_inner(), format!("{base}.zip")))
}

/// A media asset, by the file the host resolved its id to (`authorizeMediaAsset`): an absolute path, opened and proved like any file. The
/// offered name is the entry's, and the type is the entry's own when it states one, else the real path's.
pub fn open_media_download(entry: Option<&crate::grants::MediaEntry>, between: &dyn Fn(&str)) -> WsResult<DownloadFile> {
    let gone = || download("file-download:not-found", "This media file is not available.");
    let entry = entry.ok_or_else(gone)?;
    if !is_absolute_path(&entry.path) {
        return Err(gone());
    }
    let path = Path::new(&entry.path);
    let (real, file) = open_regular(path, between)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mime_type = entry.mime.as_deref().filter(|mime| !mime.is_empty()).map_or_else(|| mime_type(&real).to_owned(), str::to_owned);
    Ok(DownloadFile { file, location: real, name, mime_type })
}

/// A source domain's refusal of the bytes to stage (an attachment) as Node's download error, with its code, as `readSessionAttachment`
/// throws it.
pub fn source_refusal(error: WsError) -> WsError {
    match error.reason {
        Reason::NotLinked => download("file-download:not-linked", &error.message),
        Reason::NotFound => download("file-download:not-found", &error.message),
        Reason::Changed => download("file-download:changed", &error.message),
        Reason::TooLarge => download("file-download:too-large", &error.message),
        _ => error,
    }
}

fn upload_gone() -> WsError {
    WsError::new(Reason::Expired, "The upload is gone: it was cancelled or sat idle too long.")
}

/// The bytes of one base64 upload chunk, which must round-trip exactly (`decodeUploadChunk`).
fn decode_chunk(encoded: &str) -> WsResult<Vec<u8>> {
    let invalid = || WsError::invalid("chunk data is invalid.");
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
    if bytes.is_empty() || bytes.len() as u64 > UPLOAD_CHUNK_BYTES || STANDARD.encode(&bytes) != encoded {
        return Err(invalid());
    }
    Ok(bytes)
}
/// `serverFileReadRange(root, rel, offset, length)`: one stateless read of up to
/// [`RANGE_MAX_BYTES`] at `offset`, as `{data, offset, size, mtimeMs}` (`data` base64).
pub fn read_path_range(root: &Path, rel: &str, offset: u64, length: u64) -> WsResult<serde_json::Value> {
    let file = File::open(project_entry_path(root, rel)?)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(WsError::invalid("Not a file."));
    }
    let size = meta.len();
    let wanted = length.min(RANGE_MAX_BYTES).min(size.saturating_sub(offset));
    let mut data = vec![0u8; wanted as usize];
    let mut filled = 0usize;
    while filled < data.len() {
        let n = read_at(&file, &mut data[filled..], offset + filled as u64)?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    data.truncate(filled);
    // Node's `mtimeMs` of the file: an unreadable time is the stat's own error, and a time before the
    // epoch is a negative number of milliseconds.
    let mtime_ms = match meta.modified()?.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -(before.duration().as_secs_f64() * 1000.0),
    };
    Ok(serde_json::json!({ "data": STANDARD.encode(&data), "offset": offset, "size": size, "mtimeMs": mtime_ms }))
}

/// One path segment naming an uploaded file: the last segment of a `/`- or `\`-separated name,
/// control characters and `/` replaced by `_`, at most 200 characters, `attachment` when empty
/// (`serverUploadFileName`).
fn upload_file_name(raw: &str) -> String {
    let last = raw.replace('\\', "/");
    let last = last.rsplit('/').next().unwrap_or_default();
    let cleaned: String = last.chars().map(|c| if c.is_control() { '_' } else { c }).collect();
    let name: String = cleaned.trim().chars().take(200).collect();
    if name.is_empty() || name == "." || name == ".." { "attachment".to_owned() } else { name }
}

/// `name`, then `name (2).ext`, `name (3).ext`...: each candidate is reserved with a hard link, so
/// two uploads of one name never overwrite each other.
fn publish_unique(temp: &Path, target: &Path) -> WsResult<PathBuf> {
    let dir = target.parent().ok_or_else(|| WsError::invalid("Path is invalid."))?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, extension) = match Path::new(&name).extension() {
        Some(ext) => (name[..name.len() - ext.len() - 1].to_owned(), format!(".{}", ext.to_string_lossy())),
        None => (name.clone(), String::new()),
    };
    for attempt in 1..1000 {
        let candidate = if attempt == 1 { dir.join(&name) } else { dir.join(format!("{stem} ({attempt}){extension}")) };
        match std::fs::hard_link(temp, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(WsError::new(Reason::AlreadyExists, "Too many files with this name in the upload folder."))
}
#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::write(root.join("report.bin"), b"0123456789abcdef".repeat(8)).unwrap();
        (dir, root)
    }

    #[test]
    fn ranged_read_checks_owner_version_and_bounds() {
        let (_d, root) = project();
        let t = Transfers::default();
        let opened = t.begin_project_read("dev-a", &root, "report.bin").unwrap();
        assert_eq!((opened.size, opened.range_max_bytes), (128, 4_194_304));
        let range = t.read_range(&["dev-a"], &opened.transfer_id, 0, 64, None).unwrap();
        assert_eq!((range.length, range.eof), (64, false));
        assert_eq!(STANDARD.decode(&range.data).unwrap(), b"0123456789abcdef".repeat(4));
        assert_eq!(t.read_range(&["dev-b"], &opened.transfer_id, 0, 8, None).unwrap_err().reason, Reason::DownloadExpired);
        assert_eq!(
            t.read_range(&["dev-a"], &opened.transfer_id, 1000, 8, None).unwrap_err().message,
            "offset is past the end of the file."
        );
        std::fs::OpenOptions::new().append(true).open(root.join("report.bin")).unwrap().write_all(b"x").unwrap();
        assert_eq!(t.read_range(&["dev-a"], &opened.transfer_id, 0, 8, None).unwrap_err().message, "The file changed on the host.");
        t.end_owner("dev-a");
        assert_eq!(t.open_reads(), 0);
    }

    #[test]
    fn a_source_owned_folder_is_removed_whole_when_the_transfer_ends_and_a_staged_file_alone() {
        let base = tempfile::tempdir().unwrap();
        let t = Transfers::default();
        let folder = base.path().join("mixdog-visualize-export-abc");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("chart.png"), b"png").unwrap();
        std::fs::write(folder.join("nested").join("sidecar"), b"x").unwrap();
        let source = |cleanup: PathBuf, file: &Path| SourceFile {
            file: File::open(file).unwrap(),
            name: "chart.png".into(),
            mime_type: "image/png".into(),
            cleanup: Some(cleanup),
        };
        let opened = t.begin_source("dev", source(folder.clone(), &folder.join("chart.png"))).unwrap();
        assert!(folder.exists(), "the folder lives while the transfer is open");
        assert!(t.end_read(&["dev"], &opened.transfer_id));
        assert!(!folder.exists(), "the whole folder goes with the transfer, open handle included");

        let staged = base.path().join("staged.bin");
        std::fs::write(&staged, b"abc").unwrap();
        let opened = t.begin_source("dev", source(staged.clone(), &staged)).unwrap();
        t.end_owner("dev");
        assert!(!staged.exists());
        assert!(base.path().exists() && opened.size == 3);
    }

    /// Node's `serverUploadChunk` outcomes, recorded by `fixtures/desktop/chunks/record.mjs`.
    #[test]
    fn chunk_outcomes_match_the_recorded_node_cases() {
        let recorded: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/desktop/chunks/corpus.json"
        )))
        .unwrap();
        let case = |label: &str| {
            recorded["cases"].as_array().unwrap().iter().find(|c| c["label"] == label).unwrap_or_else(|| panic!("{label}")).clone()
        };
        // The answer must equal the recorded one: bytes received, or the recorded message.
        let same = |recorded: &serde_json::Value, got: WsResult<u64>| match recorded.get("ok") {
            Some(ok) => assert_eq!(got.unwrap(), ok["received"].as_u64().unwrap(), "{recorded}"),
            None => assert_eq!(got.unwrap_err().message, recorded["error"]["message"].as_str().unwrap(), "{recorded}"),
        };
        let (_d, root) = project();
        let t = Transfers::default();
        let id = t.begin_write("o", &root, "up.txt", 4).unwrap();
        let small = t.begin_write("o", &root, "small.txt", 2).unwrap();
        same(&case("first chunk"), t.write_chunk("o", &id, Some(0), "aGk="));
        same(&case("retry of the last chunk"), t.write_chunk("o", &id, Some(0), "aGk="));
        same(&case("chunk ahead of the received bytes"), t.write_chunk("o", &id, Some(3), "aGk="));
        same(&case("data that is not canonical base64"), t.write_chunk("o", &id, Some(2), "!!"));
        same(&case("empty data"), t.write_chunk("o", &id, Some(2), ""));
        same(&case("offset past the declared size"), t.write_chunk("o", &id, Some(5), "aGk="));
        same(&case("offset that is not an integer"), t.write_chunk("o", &id, None, "aGk="));
        same(&case("unknown upload"), t.write_chunk("o", "nope", Some(0), "aGk="));
        // Two chunks at one offset at once: the second meets the first mid-write.
        let both = case("two chunks at the same offset at once");
        t.writes.lock().unwrap().get_mut(&id).unwrap().writing = true;
        same(&both["results"][1], t.write_chunk("o", &id, Some(2), "aGk="));
        t.writes.lock().unwrap().get_mut(&id).unwrap().writing = false;
        same(&both["results"][0], t.write_chunk("o", &id, Some(2), "aGk="));
        same(&case("retry after the upload completed"), t.write_chunk("o", &id, Some(2), "aGk="));
        same(&case("chunk larger than declared"), t.write_chunk("o", &small, Some(0), "YWJj"));
        same(&case("the upload is gone after that"), t.write_chunk("o", &small, Some(0), "YWI="));
    }

    #[test]
    fn an_upload_nobody_feeds_is_swept_after_the_idle_time() {
        use std::sync::atomic::{AtomicU64, Ordering};
        struct Steady(Instant, AtomicU64);
        impl IdleClock for Steady {
            fn now(&self) -> Instant {
                self.0 + std::time::Duration::from_millis(self.1.load(Ordering::SeqCst))
            }
        }
        let clock = Arc::new(Steady(Instant::now(), AtomicU64::new(0)));
        let advance = |ms: u64| {
            clock.1.fetch_add(ms, Ordering::SeqCst);
        };
        let t = Transfers::with_clock(clock.clone(), UPLOAD_IDLE);
        let dir = tempfile::tempdir().unwrap();
        let id = t.begin_staged("o", dir.path(), "a.txt", 4).unwrap();
        let part = dir.path().join(format!(".{id}.part"));
        // Each chunk written re-arms the idle time, as Node's `arm` does.
        advance(119_999);
        assert_eq!(t.write_chunk("o", &id, Some(0), "aGk=").unwrap(), 2);
        advance(119_999);
        assert!(part.exists());
        assert_eq!(t.write_chunk("o", &id, Some(2), "aGk=").unwrap(), 4);
        // Past the idle time the upload is gone and its partial file removed, without any call of its own.
        advance(120_000);
        t.sweep_idle();
        assert!(!part.exists());
        let gone = t.commit("o", &id).unwrap_err();
        assert_eq!(gone.message, "The upload is gone: it was cancelled or sat idle too long.");
        // A call on another upload sweeps too: the stale one is gone before the new one starts.
        let stale = t.begin_staged("o", dir.path(), "b.txt", 2).unwrap();
        advance(120_000);
        t.begin_staged("o", dir.path(), "c.txt", 2).unwrap();
        assert!(!dir.path().join(format!(".{stale}.part")).exists());
    }

    /// One shared manual time source for the idle clock and the idle timer: nothing here waits.
    pub(super) struct Manual {
        base: Instant,
        /// The epoch time at elapsed 0.
        start_ms: i64,
        elapsed_ms: tokio::sync::watch::Sender<u64>,
    }

    impl Manual {
        pub(super) fn new() -> Arc<Self> {
            Self::starting_at(1_000_000)
        }
        /// A clock whose epoch time is `start_ms` plus the time it was moved by.
        pub(super) fn starting_at(start_ms: i64) -> Arc<Self> {
            Arc::new(Self { base: Instant::now(), start_ms, elapsed_ms: tokio::sync::watch::Sender::new(0) })
        }
        pub(super) fn advance(&self, ms: u64) {
            self.elapsed_ms.send_modify(|elapsed| *elapsed += ms);
        }
        pub(super) fn elapsed(&self) -> u64 {
            *self.elapsed_ms.borrow()
        }
        /// The elapsed milliseconds at which `at` falls.
        pub(super) fn ms_of(&self, at: Instant) -> u64 {
            u64::try_from(at.saturating_duration_since(self.base).as_millis()).unwrap_or(u64::MAX)
        }
    }

    impl IdleClock for Manual {
        fn now(&self) -> Instant {
            self.base + std::time::Duration::from_millis(*self.elapsed_ms.borrow())
        }
        fn epoch_ms(&self) -> i64 {
            self.start_ms + i64::try_from(*self.elapsed_ms.borrow()).unwrap()
        }
    }

    impl IdleTimer for Manual {
        fn sleep_until(&self, deadline: Instant) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            let mut elapsed = self.elapsed_ms.subscribe();
            let base = self.base;
            Box::pin(async move {
                loop {
                    if base + std::time::Duration::from_millis(*elapsed.borrow_and_update()) >= deadline {
                        return;
                    }
                    if elapsed.changed().await.is_err() {
                        return;
                    }
                }
            })
        }
    }

    /// Node's per-upload idle timer: the wait ends at the deadline of the upload fed longest ago, a
    /// chunk written moves it, and the partial file is gone without any upload call.
    #[tokio::test]
    async fn the_idle_timer_fires_at_the_deadline_and_a_chunk_moves_it() {
        let manual = Manual::new();
        let t = Transfers::with_clock(manual.clone(), UPLOAD_IDLE);
        let dir = tempfile::tempdir().unwrap();
        // Nothing open: the wait has nothing to end at.
        let mut waiting = Box::pin(t.wait_idle_due(&*manual));
        assert!(tokio::time::timeout(std::time::Duration::ZERO, &mut waiting).await.is_err());
        let id = t.begin_staged("o", dir.path(), "a.txt", 4).unwrap();
        let part = dir.path().join(format!(".{id}.part"));
        // Begun at 0: due at 120 000 ms, not before.
        manual.advance(119_999);
        assert!(tokio::time::timeout(std::time::Duration::ZERO, &mut waiting).await.is_err());
        // A chunk written at 119 999 ms moves the deadline to 239 999 ms.
        assert_eq!(t.write_chunk("o", &id, Some(0), "aGk=").unwrap(), 2);
        manual.advance(120_000 - 1);
        assert!(tokio::time::timeout(std::time::Duration::ZERO, &mut waiting).await.is_err());
        manual.advance(1);
        waiting.await;
        t.sweep_idle();
        assert!(!part.exists(), "the abandoned upload's partial file is removed by the timer's sweep alone");
    }
    /// A grant of `owner` on `session` for a file of `dir`, made as the service makes one.
    fn grant_of(t: &Transfers, dir: &Path, owner: &str, session: &str) -> Authorized {
        let path = dir.join("a.bin");
        std::fs::write(&path, b"0123456789abcdef").unwrap();
        let opened = open_session_download(&path.to_string_lossy(), "", None, None, &|_| {}).unwrap();
        t.authorize(owner, session, t.mark(owner, session), opened).unwrap()
    }

    /// Runs `revoke` when the call under test reaches `point`.
    fn at(t: &Arc<Transfers>, point: &'static str, revoke: impl Fn(&Transfers) + Send + Sync + 'static) {
        let table = t.clone();
        t.on_point(Some(Arc::new(move |reached: &str| {
            if reached == point {
                revoke(&table);
            }
        })));
    }

    fn range_of(t: &Transfers, owner: &str, leased: &Leased) -> WsResult<Range> {
        t.read_range(&[owner], &leased.transfer_id, 0, 4, Some(&leased.version))
    }

    /// What the recording of Node's service holds at the `n`th step with `op` of the scenario `name`.
    fn recorded(name: &str, op: &str, n: usize) -> serde_json::Value {
        let recording: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/file-downloads/file-downloads.json")).unwrap();
        let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}"));
        scenario["steps"].as_array().unwrap().iter().filter(|step| step["op"] == op).nth(n).unwrap_or_else(|| panic!("{name} {op} {n}")).clone()
    }

    /// The frame Node's phone got for the `n`th call of the scenario, and for the call it held (the `answer` step).
    fn frame_of_call(name: &str, n: usize) -> serde_json::Value {
        recorded(name, "call", n)["frame"].clone()
    }

    fn frame_of_held(name: &str) -> serde_json::Value {
        recorded(name, "answer", 0)["frame"].clone()
    }

    /// How many files Node's service held open at the `n`th count of the scenario.
    fn open_in(name: &str, n: usize) -> usize {
        recorded(name, "handles", n)["open"].as_u64().unwrap() as usize
    }

    /// The refusal is the one Node's phone got: its code and its sentence.
    fn assert_refused_as(refused: WsError, frame: &serde_json::Value) {
        assert_eq!(frame["ok"], false);
        assert_eq!((refused.reason.code(), refused.message.as_str()), (frame["errorCode"].as_str().unwrap(), frame["error"].as_str().unwrap()));
    }

    /// The first window of an unpair against a redeem: the grant is out of the table and the revoke finds nothing to end. The
    /// marks are read in the one step that consumes the grant, so the revoke is seen when the transfer would be published. The answer
    /// and the files held are Node's for a begin revoked while its file is checked (`unpair during begin`).
    #[test]
    fn a_revoke_after_the_grant_is_consumed_leaves_no_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.taken", |t| t.revoke_owner("dev"));
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &frame_of_held("unpair during begin"));
        assert_eq!(t.held_downloads(), open_in("unpair during begin", 0));
    }

    /// The second window: the file check is done and the transfer is about to be published.
    #[test]
    fn a_revoke_after_the_file_check_leaves_no_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.verify", |t| t.revoke_owner("dev"));
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &frame_of_held("unpair during begin"));
        assert_eq!(t.held_downloads(), open_in("unpair during begin", 0));
    }

    /// A revoke the moment the transfer is published reaches it: publishing and the check are one step for a revoke. Node's next range
    /// after an unpair is `unpair during a read`'s last call.
    #[test]
    fn a_revoke_right_after_the_transfer_is_published_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.published", |t| t.revoke_owner("dev"));
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &frame_of_call("unpair during a read", 2));
        assert_eq!(t.held_downloads(), open_in("unpair during a read", 0));
    }

    /// Whatever the interleaving, a device's reads fail from its unpair on: a read in flight, an authorize in flight, and the other
    /// device untouched. Each answer and count is Node's for that window (`unpair during a read`, `unpair during authorize`).
    #[test]
    fn after_an_unpair_no_read_of_the_device_succeeds_whatever_was_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        at(&t, "read.read", |t| t.revoke_owner("dev"));
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &frame_of_held("unpair during a read"));
        assert_eq!(t.held_downloads(), open_in("unpair during a read", 0));
        // An authorize that was opening its file when the device was revoked leaves no grant.
        for point in ["authorize.resolved", "authorize.opened"] {
            at(&t, point, |t| t.revoke_owner("dev"));
            let path = dir.path().join("a.bin");
            let mark = t.mark("dev", "s1");
            let refused = match open_session_download(&path.to_string_lossy(), "", None, None, &|reached| t.point(reached)) {
                Ok(opened) => t.authorize("dev", "s1", mark, opened).unwrap_err(),
                Err(refused) => refused,
            };
            // The revoke came after the open for `authorize.opened`, and before the grant is published for both: Node's answer.
            assert_refused_as(refused, &frame_of_held("unpair during authorize"));
            t.on_point(None);
            assert_eq!(t.held_downloads(), open_in("unpair during authorize", 0), "{point}");
        }
        // Another device is untouched.
        let other = grant_of(&t, dir.path(), "other", "s1");
        let kept = t.begin_grant("other", &other.grant_id).unwrap();
        t.revoke_owner("dev");
        assert!(range_of(&t, "other", &kept).is_ok());
    }

    /// A deletion ends what the conversation held and nothing else, in every window, and the answer is Node's for the window: a begin or an
    /// authorize that the deletion lands in the middle of is `unavailable` (`session deleted during begin` / `during authorize`), a call
    /// that finds the grant or the transfer already gone is `expired` (`session deleted before begin`, `between ranges`). A conversation
    /// that is gone stays gone, so each window has a conversation of its own.
    #[test]
    fn a_deleted_conversation_ends_its_grants_and_transfers_in_every_window() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.taken", |t| t.remove_session("s1"));
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &frame_of_held("session deleted during begin"));
        let grant = grant_of(&t, dir.path(), "dev", "s3");
        at(&t, "begin.verify", |t| t.remove_session("s3"));
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &frame_of_held("session deleted during begin"));
        t.on_point(None);
        assert_eq!(t.held_downloads(), open_in("session deleted during begin", 0));
        let unbegun = grant_of(&t, dir.path(), "dev", "s4");
        let kept = grant_of(&t, dir.path(), "dev", "s2");
        let live = t.begin_grant("dev", &kept.grant_id).unwrap();
        assert_eq!(t.held_downloads(), open_in("session deleted before begin", 0));
        t.remove_session("s4");
        assert_eq!(t.held_downloads(), open_in("session deleted before begin", 1));
        assert_refused_as(t.begin_grant("dev", &unbegun.grant_id).unwrap_err(), &frame_of_call("session deleted before begin", 2));
        assert!(range_of(&t, "dev", &live).is_ok(), "the other conversation's transfer lives");
        at(&t, "authorize.opened", |t| t.remove_session("s2"));
        let opened = open_session_download(&dir.path().join("a.bin").to_string_lossy(), "", None, None, &|_| {}).unwrap();
        let mark = t.mark("dev", "s2");
        assert_refused_as(t.authorize("dev", "s2", mark, opened).unwrap_err(), &frame_of_held("session deleted during authorize"));
        t.on_point(None);
        assert_refused_as(range_of(&t, "dev", &live).unwrap_err(), &frame_of_call("session deleted between ranges", 3));
        assert_eq!(t.held_downloads(), open_in("session deleted between ranges", 0));
    }
    /// A folder `link` that is another folder `target` (a junction on Windows, a symlink elsewhere): an ancestor swapped for a link.
    pub(super) fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            // `mklink` refuses a path that mixes separators; a recorded step names its folders with `/`.
            let backslashed = |path: &Path| path.to_string_lossy().replace('/', "\\");
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(backslashed(link)).arg(backslashed(target)).output().unwrap();
            assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stdout));
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// Whether `path` is open anywhere in this process: Windows refuses an open that shares with nobody while any handle is open; elsewhere
    /// the descriptors of the process are counted by the caller.
    #[cfg(windows)]
    fn held_open(path: &Path) -> bool {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).is_err()
    }

    #[cfg(target_os = "linux")]
    fn descriptors() -> usize {
        std::fs::read_dir("/proc/self/fd").unwrap().count()
    }

    /// A folder above the file replaced by a link after the path was resolved and before it is opened opens another file; the open is
    /// proved from the handle to be the file at the resolved path, so it is refused as Node refuses it (`changed`) and the handle is
    /// closed (`ancestor swapped between resolving and opening`).
    #[test]
    fn an_ancestor_swapped_for_a_link_between_resolving_and_opening_is_refused_and_leaves_no_handle() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        let (project, outside) = (base.join("project"), base.join("outside"));
        std::fs::create_dir_all(project.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("sub/a.bin"), b"inside bytes").unwrap();
        std::fs::write(outside.join("a.bin"), b"outside bytes").unwrap();
        #[cfg(target_os = "linux")]
        let before = descriptors();
        let swap = |reached: &str| {
            if reached == "authorize.resolved" {
                std::fs::remove_dir_all(project.join("sub")).unwrap();
                link_folder(&outside, &project.join("sub"));
            }
        };
        let refused = open_project_download(&project, "sub/a.bin", &swap).err().expect("the swapped open is refused");
        assert_refused_as(refused, &frame_of_held("ancestor swapped between resolving and opening"));
        #[cfg(windows)]
        assert!(!held_open(&outside.join("a.bin")), "the handle of the swapped open is closed");
        #[cfg(target_os = "linux")]
        assert_eq!(descriptors(), before, "the handle of the swapped open is closed");
        // The link now stays: a new authorize of the same path is Node's refusal of a path that leaves the project.
        let again = open_project_download(&project, "sub/a.bin", &|_| {}).err().unwrap();
        assert_refused_as(again, &frame_of_call("ancestor swapped between resolving and opening", 0));
    }

    /// A grant's expiry reads the runtime's clock afresh at each use, as Node reads `Date.now`: moving that clock 1 ms short of the grant's life
    /// leaves it, moving it the whole life ends it (`grant expiry`: the begin at 59 999 ms succeeds, at 60 000 ms it is expired).
    #[tokio::test(start_paused = true)]
    async fn a_grant_lives_exactly_as_long_as_the_runtime_clock_says() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::with_clock(Arc::new(SystemClock), UPLOAD_IDLE));
        let first = grant_of(&t, dir.path(), "dev", "s1");
        tokio::time::advance(std::time::Duration::from_millis(59_999)).await;
        t.begin_grant("dev", &first.grant_id).expect("one millisecond before the limit");
        let second = grant_of(&t, dir.path(), "dev", "s1");
        tokio::time::advance(std::time::Duration::from_millis(60_000)).await;
        assert_refused_as(t.begin_grant("dev", &second.grant_id).unwrap_err(), &frame_of_call("grant expiry", 3));
    }

    /// A conversation a later publication lists again under the same id is a member again (Node's catalog is replaced at each publication,
    /// `sessionRemoved` = seen and not in the latest one, `file-downloads.ts:449-450,468-472`): what was authorized before its removal stays
    /// ended (`expired`, as Node's `session deleted before begin` begin), a call that marked before the removal is `expired`, no longer
    /// `unavailable` (the generation moved, as for Node's revoked authorize, `unpair during authorize`), and a fresh authorize works.
    #[test]
    fn a_conversation_listed_again_takes_new_downloads_and_keeps_the_old_ones_ended() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let before = grant_of(&t, dir.path(), "dev", "s1");
        let stale = t.mark("dev", "s1");
        t.remove_session("s1");
        t.relisted(&["s1"]);
        assert_refused_as(t.begin_grant("dev", &before.grant_id).unwrap_err(), &frame_of_call("session deleted before begin", 2));
        let opened = open_session_download(&dir.path().join("a.bin").to_string_lossy(), "", None, None, &|_| {}).unwrap();
        assert_refused_as(t.authorize("dev", "s1", stale, opened).unwrap_err(), &frame_of_held("unpair during authorize"));
        let fresh = grant_of(&t, dir.path(), "dev", "s1");
        assert!(t.begin_grant("dev", &fresh.grant_id).is_ok(), "a fresh authorize of the listed conversation is a transfer");
    }

    /// A relay close drops the per-conversation bookkeeping as Node's next service starts without it, and still ends what was marked
    /// before: the removed mark and the counts are gone, and a mark taken before the close is `expired` (`revoke all`), never accepted.
    #[test]
    fn a_relay_close_drops_the_removed_marks_and_no_earlier_mark_matches_again() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let stale = t.mark("dev", "s2");
        t.remove_session("s1");
        t.revoke_owner("dev");
        t.revoke_all();
        {
            let gate = t.generations.lock().unwrap();
            assert!(gate.removed.is_empty() && gate.owners.is_empty() && gate.sessions.is_empty(), "the bookkeeping is gone");
        }
        assert_eq!(t.removed_marks.load(std::sync::atomic::Ordering::SeqCst), 0);
        std::fs::write(dir.path().join("a.bin"), b"0123").unwrap();
        let opened = open_session_download(&dir.path().join("a.bin").to_string_lossy(), "", None, None, &|_| {}).unwrap();
        assert_refused_as(t.authorize("dev", "s2", stale, opened).unwrap_err(), &frame_of_held("unpair during authorize"));
        assert!(t.begin_grant("dev", &grant_of(&t, dir.path(), "dev", "s1").grant_id).is_ok(), "a conversation removed before the close is no longer marked");
    }

    /// A staged download's folder is private to the user and its payload readable by the user alone (Node's `mkdtemp` 0700 and
    /// `writeFile(..., { mode: 0o600 })`), whatever the umask.
    #[cfg(unix)]
    #[test]
    fn a_staged_download_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let (folder, file) = staged_payload().unwrap();
        drop(file);
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let (dir, payload) = (mode(&folder), mode(&folder.join(STAGED_PAYLOAD)));
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!((dir & 0o077, payload & 0o077), (0, 0), "no access for group or others");
    }

    /// Node's `relay close during a read`: a range held at the file when the relay closes (every download revoked) answers what Node's phone
    /// got, the file is let go (nothing holds it: an exclusive open succeeds on Windows, where a held handle refuses one) and can be removed,
    /// and a later range of the transfer is refused as Node's is.
    #[test]
    fn a_read_held_when_the_relay_closes_ends_as_nodes_and_lets_the_file_go() {
        const NAME: &str = "relay close during a read";
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        let closing = t.clone();
        t.on_point(Some(Arc::new(move |reached: &str| {
            if reached == "read.read" {
                closing.revoke_all();
            }
        })));
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &frame_of_held(NAME));
        t.on_point(None);
        assert_eq!(t.held_downloads(), open_in(NAME, 0));
        let file = dir.path().join("a.bin");
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            drop(std::fs::OpenOptions::new().read(true).share_mode(0).open(&file).expect("no handle of the download is left open"));
        }
        std::fs::remove_file(&file).unwrap();
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &frame_of_call(NAME, 2));
    }

    /// The sweeper's stop and an authorize's arm never lose the schedule (Node's `stopSweeperWhenIdle` and `addGrant` + `ensureSweeper` are
    /// each one synchronous step, `file-downloads.ts:527-545`): the abort of the last grant has looked at what is held and found nothing,
    /// and an authorize on another thread publishes its grant at that very moment. Either the authorize waits for the stop's step to end
    /// (and then arms), or, without one step, it publishes and finds the old schedule still set, and the stop then clears it: a grant held
    /// with no sweeper, which would outlive its 60 s until something armed it again.
    #[test]
    fn a_grant_published_while_the_sweeper_stops_keeps_the_sweeper_armed() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let first = grant_of(&t, dir.path(), "dev", "s1");
        assert!(t.sweeper.anchor.lock().unwrap().is_some(), "the first grant arms the sweeper");
        let main = std::thread::current().id();
        let (told, heard) = std::sync::mpsc::channel::<&'static str>();
        let thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
        let heard = Mutex::new(heard);
        // The abort's own sweep looks first, with the grant still held; its second look, after the grant is gone, is the one that stops.
        let looks = std::sync::atomic::AtomicUsize::new(0);
        let (table, base, slot) = (t.clone(), dir.path().to_path_buf(), thread.clone());
        t.on_point(Some(Arc::new(move |reached: &str| {
            let here = std::thread::current().id();
            if here == main && reached == "idle.checked" && looks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                // The stop has looked: an authorize starts now, on its own thread.
                let (t, base, told) = (table.clone(), base.clone(), told.clone());
                *slot.lock().unwrap() = Some(std::thread::spawn(move || {
                    grant_of(&t, &base, "dev", "s1");
                    let _ = told.send("published and armed");
                }));
                match heard.lock().unwrap().recv_timeout(std::time::Duration::from_secs(30)) {
                    Ok(_) => {}
                    Err(_) => panic!("the authorize neither finished nor met the stop's step within 30 s"),
                }
            } else if here != main && reached == "idle.enter" && table.sweeper.anchor.try_lock().is_err() {
                // The authorize's own sweep reaches the stop's step while the stop holds it: it waits for the stop to end.
                let _ = told.send("waits for the stop");
            }
        })));
        assert!(t.end_read(&["dev"], &first.grant_id), "the last grant is aborted");
        let authorizing = thread.lock().unwrap().take().expect("the authorize ran");
        authorizing.join().unwrap();
        t.on_point(None);
        assert_eq!(t.held_downloads(), 1, "the new grant is held");
        assert!(t.sweeper.anchor.lock().unwrap().is_some(), "a held grant has the sweeper armed");
    }

    /// A file renamed or removed after it was authorized is not the file that was authorized, though its identity, size and modification
    /// time are unchanged: begin, a range and finish refuse it as Node does, and the transfer ends; renamed away and back it is the same
    /// (`file moved`).
    #[test]
    fn a_file_moved_after_it_was_authorized_is_changed_for_begin_range_and_finish() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let moved = |n: usize| frame_of_call("file moved", n);
        let rename = |from: &str, to: &str| std::fs::rename(dir.path().join(from), dir.path().join(to)).unwrap();
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        rename("a.bin", "moved.bin");
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &moved(1));
        assert_eq!(t.held_downloads(), open_in("file moved", 0));
        rename("moved.bin", "a.bin");
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        rename("a.bin", "moved.bin");
        rename("moved.bin", "a.bin");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        assert_eq!((moved(3)["ok"].clone(), moved(4)["ok"].clone()), (true.into(), true.into()));
        assert!(range_of(&t, "dev", &leased).is_ok());
        rename("a.bin", "moved.bin");
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &moved(5));
        assert_eq!(t.held_downloads(), open_in("file moved", 1));
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &moved(6));
        rename("moved.bin", "a.bin");
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        rename("a.bin", "moved.bin");
        assert_refused_as(t.finish_read("dev", &leased.transfer_id).unwrap_err(), &moved(9));
        assert_eq!(t.held_downloads(), open_in("file moved", 2));
        rename("moved.bin", "a.bin");
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        std::fs::remove_file(dir.path().join("a.bin")).unwrap();
        assert_refused_as(t.begin_grant("dev", &grant.grant_id).unwrap_err(), &moved(11));
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        std::fs::remove_file(dir.path().join("a.bin")).unwrap();
        assert_refused_as(range_of(&t, "dev", &leased).unwrap_err(), &moved(14));
        assert_eq!(t.held_downloads(), open_in("file moved", 3));
    }

    /// Node's `createDownloadTables` sweeper on a virtual clock: ticks of 15 s counted from the first thing held, a handle closed at the
    /// first tick at or after its expiry with no call, and a new count after nothing was held.
    #[tokio::test]
    async fn the_sweeper_closes_expired_handles_at_its_ticks_with_no_call() {
        let manual = Manual::new();
        let t = Arc::new(Transfers::with_clock(manual.clone(), UPLOAD_IDLE));
        let sweeping = { let (t, manual) = (t.clone(), manual.clone()); tokio::spawn(async move { t.run_download_sweeper(&*manual).await }) };
        let dir = tempfile::tempdir().unwrap();
        grant_of(&t, dir.path(), "dev", "s1");
        manual.advance(5_000);
        grant_of(&t, dir.path(), "dev", "s1");
        let held = || t.grants.lock().unwrap().len();
        // Ticks at 15, 30, 45, 60 s: the first grant (expires at 60 s) goes at the 60 s tick, the second (65 s) at the 75 s tick.
        for (to, expected) in [(15_000, 2), (30_000, 2), (45_000, 2), (59_999, 2), (60_000, 1), (74_999, 1), (75_000, 0)] {
            manual.advance(to - manual.elapsed());
            if to % 15_000 == 0 {
                t.sweeper.swept.notified().await;
            }
            assert_eq!(held(), expected, "held at {to} ms");
        }
        assert!(t.sweeper.anchor.lock().unwrap().is_none(), "the sweeper stops once nothing is held");
        sweeping.abort();
    }


    #[test]
    fn a_project_path_beyond_the_project_is_nodes_outside_project_refusal() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/desktop/transfer/corpus.json")).unwrap();
        let recorded = corpus["entries"].as_array().unwrap().iter().find(|entry| entry["op"] == "authorize(outside)").unwrap();
        let (_d, root) = project();
        let refused = Transfers::default().begin_project_read("o", &root, "../x").err().unwrap();
        assert_eq!(refused.reason, Reason::PermissionDenied);
        assert_eq!(refused.message, recorded["error"]["message"].as_str().unwrap());
    }

    #[test]
    fn path_outside_is_refused_and_upload_commits_by_rename() {
        let (_d, root) = project();
        let t = Transfers::default();
        let id = t.begin_write("o", &root, "in/up.txt", 5).unwrap();
        t.write_chunk("o", &id, Some(0), "aGU=").unwrap();
        // The last chunk again is acknowledged, not rewritten.
        assert_eq!(t.write_chunk("o", &id, Some(0), "eHg=").unwrap(), 2);
        t.write_chunk("o", &id, Some(2), "bGxv").unwrap();
        assert_eq!(t.commit("o", &id).unwrap().0, 5);
        assert_eq!(std::fs::read(root.join("in/up.txt")).unwrap(), b"hello");
    }
}

#[cfg(test)]
mod replay;
