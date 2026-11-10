#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Transfers (DS §4.4): ranged reads of a project file, an absolute local file
//! or a zipped folder; chunked uploads staged beside the target and committed by
//! rename. A transfer belongs to its owner (a connection or a paired device) and
//! ends with it. Reads are ranged against one open handle, so a 2 GiB file never
//! sits in memory; every range re-checks the file's version.

use std::collections::HashMap;
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
    size: u64,
    version: String,
    name: String,
    mime: String,
    expires_at: i64,
    cleanup: Option<Cleanup>,
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

/// Debug builds only (a release build has no such entry): the instant, in epoch milliseconds, a replay of Node's recording has written to
/// the file named by `MIXDOG_DOWNLOAD_CLOCK_FILE`, so a spawned core can be moved in time by explicit steps as the recording's clock was.
#[cfg(debug_assertions)]
fn replayed_now_ms() -> Option<i64> {
    let path = std::env::var_os("MIXDOG_DOWNLOAD_CLOCK_FILE")?;
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

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
}

impl Generations {
    fn of(&self, owner: &str, session: &str) -> u64 {
        self.all + self.owners.get(owner).copied().unwrap_or(0) + self.sessions.get(session).copied().unwrap_or(0)
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
        if self.0.is_dir() {
            // Node's `rm(dir, { recursive, force, maxRetries: 5 })`: a handle still closing on
            // Windows is retried.
            for attempt in 0..=5 {
                if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                    return;
                }
                if attempt < 5 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
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
}

/// Monotonic time for the idle sweep of abandoned uploads; tests substitute a controllable one.
pub trait IdleClock: Send + Sync {
    fn now(&self) -> Instant;
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
    generations: Mutex<Generations>,
    sweeper: Sweeper,
    /// The epoch time and the monotonic instant at construction: a download's clock is the first plus the time since the second.
    epoch_ms: i64,
    origin: Instant,
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
            generations: Mutex::default(),
            sweeper: Sweeper::default(),
            epoch_ms: crate::editorcfg::now_ms(),
            origin: clock.now(),
            #[cfg(test)]
            pause: Mutex::default(),
            writes: Mutex::default(),
            clock,
            idle,
            armed: tokio::sync::Notify::new(),
        }
    }

    /// Node's `Date.now()` for grants and transfers: the epoch time at construction plus the monotonic time since (the clock that also
    /// times the idle sweep of uploads, which is what a virtual-time test moves).
    fn now_ms(&self) -> i64 {
        #[cfg(debug_assertions)]
        if let Some(replayed) = replayed_now_ms() {
            return replayed;
        }
        self.epoch_ms + i64::try_from(self.clock.now().saturating_duration_since(self.origin).as_millis()).unwrap_or(i64::MAX)
    }

    /// Sets the hook called at each named point of `authorize`, `begin_grant` and a lease read; a revoke run from it is one that came
    /// in the middle of the call.
    #[cfg(test)]
    pub(crate) fn on_point(&self, hook: Option<Arc<dyn Fn(&str) + Send + Sync>>) {
        *self.pause.lock().expect("pause") = hook;
    }

    #[cfg(test)]
    fn point(&self, name: &str) {
        let hook = self.pause.lock().expect("pause").clone();
        if let Some(hook) = hook {
            hook(name);
        }
    }

    #[cfg(not(test))]
    fn point(&self, _name: &str) {}

    fn generation(&self, owner: &str, session: &str) -> u64 {
        self.generations.lock().expect("generations").of(owner, session)
    }

    /// Ends every grant and phone transfer whose time is up (Node's `sweep`: run at the start of every call, and by the sweeper).
    fn sweep_downloads(&self) {
        let now = self.now_ms();
        self.grants.lock().expect("transfer grants").retain(|(_, grant)| grant.expires_at > now);
        self.reads.lock().expect("transfer reads").retain(|_, read| read.lease.is_none_or(|lease| lease.expires_at > now && lease.idle_until > now));
        self.stop_sweeper_when_idle();
    }

    /// Whether any grant or phone transfer is held (Node's three tables being empty, less the exports this core has no table for).
    fn downloads_held(&self) -> bool {
        !self.grants.lock().expect("transfer grants").is_empty() || self.reads.lock().expect("transfer reads").values().any(|read| read.lease.is_some())
    }

    fn arm_sweeper(&self) {
        let mut anchor = self.sweeper.anchor.lock().expect("sweeper");
        if anchor.is_none() {
            *anchor = Some(self.clock.now());
            self.sweeper.changed.notify_one();
        }
    }

    fn stop_sweeper_when_idle(&self) {
        let held = self.downloads_held();
        let mut anchor = self.sweeper.anchor.lock().expect("sweeper");
        if !held && anchor.take().is_some() {
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
        let mut gate = self.generations.lock().expect("generations");
        *gate.owners.entry(owner.to_owned()).or_default() += 1;
        self.end_owner(owner);
        self.stop_sweeper_when_idle();
    }

    /// The conversation was deleted: every grant and phone transfer on it ends now, and a call on it that is in flight finds it revoked
    /// (Node's `retainSessions`).
    pub fn revoke_session(&self, session: &str) {
        let mut gate = self.generations.lock().expect("generations");
        *gate.sessions.entry(session.to_owned()).or_default() += 1;
        self.grants.lock().expect("transfer grants").retain(|(_, g)| g.session != session);
        self.reads.lock().expect("transfer reads").retain(|_, r| r.session != session);
        self.stop_sweeper_when_idle();
    }

    /// The conversations the grants and phone transfers held belong to.
    pub fn held_sessions(&self) -> Vec<String> {
        let mut sessions: Vec<String> = self.grants.lock().expect("transfer grants").iter().map(|(_, g)| g.session.clone()).collect();
        sessions.extend(self.reads.lock().expect("transfer reads").values().filter(|r| r.lease.is_some()).map(|r| r.session.clone()));
        sessions.sort();
        sessions.dedup();
        sessions
    }

    /// The conversation a grant or phone transfer of `owners` belongs to, if one is held under `id`.
    pub fn session_of(&self, owners: &[&str], id: &str) -> Option<String> {
        let grants = self.grants.lock().expect("transfer grants");
        if let Some((_, grant)) = grants.iter().find(|(grant, g)| grant == id && owners.contains(&g.owner.as_str())) {
            return Some(grant.session.clone());
        }
        drop(grants);
        self.reads.lock().expect("transfer reads").get(id).filter(|r| r.lease.is_some() && owners.contains(&r.owner.as_str())).map(|r| r.session.clone())
    }

    /// The relay closed, or this host unpaired every device.
    pub fn revoke_all(&self) {
        let mut gate = self.generations.lock().expect("generations");
        gate.all += 1;
        self.grants.lock().expect("transfer grants").clear();
        self.reads.lock().expect("transfer reads").retain(|_, read| read.lease.is_none());
        self.stop_sweeper_when_idle();
    }

    /// Opens the download a phone asked for as a grant: the file stays open, so what was authorized is what is read. `mark` is
    /// [`Self::mark`] taken before the file work.
    pub fn authorize(&self, owner: &str, session: &str, mark: u64, opened: SourceFile) -> WsResult<Authorized> {
        self.sweep_downloads();
        let SourceFile { file, name, mime_type, cleanup } = opened;
        let size = file.metadata()?.len();
        if size > DOWNLOAD_MAX_BYTES {
            return Err(download("file-download:too-large", "Files larger than 256 MB cannot be downloaded."));
        }
        self.point("authorize.opened");
        let version = version_string(&file_version(&file)?);
        let name = sanitized_file_name(&name);
        let grant_id = new_id();
        // Checking the marks and publishing the grant are one step for a revoke (Node's `stillAuthorized` and `addGrant`, synchronous).
        let gate = self.generations.lock().expect("generations");
        if gate.of(owner, session) != mark {
            return Err(WsError::expired());
        }
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
                    size,
                    version: version.clone(),
                    name: name.clone(),
                    mime: mime_type.clone(),
                    expires_at,
                    cleanup: cleanup.map(Cleanup),
                },
            ));
        }
        drop(gate);
        self.arm_sweeper();
        Ok(Authorized { grant_id, name, size, mime: mime_type, version, expires_at })
    }

    /// The revocation generation of `owner` and `session`, read before the file work of a call that checks it again afterwards.
    pub fn mark(&self, owner: &str, session: &str) -> u64 {
        self.generation(owner, session)
    }

    /// Consumes the grant (once) into one transfer (Node's `begin`).
    pub fn begin_grant(&self, owner: &str, grant_id: &str) -> WsResult<Leased> {
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
        if version_string(&file_version(&grant.file)?) != grant.version {
            return Err(download_changed());
        }
        self.point("begin.verify");
        // The check and the publication of the transfer are one step for a revoke.
        let gate = self.generations.lock().expect("generations");
        if gate.of(owner, &grant.session) != mark {
            return Err(WsError::expired());
        }
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.values().filter(|r| r.owner == owner && r.lease.is_some()).count() >= MAX_LEASES_PER_DEVICE {
            return Err(download("file-download:busy", "Too many downloads are in progress on this device."));
        }
        let at = self.now_ms();
        let times = LeaseTimes { expires_at: at + LEASE_MAX_MS, idle_until: at + LEASE_IDLE_MS };
        let transfer_id = new_id();
        let Grant { file, session, size, version, name, mime, cleanup, .. } = grant;
        reads.insert(
            transfer_id.clone(),
            Read { owner: owner.to_owned(), session, file, size, version: version.clone(), lease: Some(times), _cleanup: cleanup, opened: Instant::now() },
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
        self.sweep_downloads();
        let read = {
            let mut reads = self.reads.lock().expect("transfer reads");
            if !reads.get(id).is_some_and(|r| r.owner == owner && r.lease.is_some()) {
                return Err(WsError::expired());
            }
            reads.remove(id).expect("checked")
        };
        if version_string(&file_version(&read.file)?) != read.version {
            return Err(download_changed());
        }
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
            Read { owner: owner.to_owned(), session: String::new(), file, size, version: version.clone(), lease: None, _cleanup: cleanup.map(Cleanup), opened: Instant::now() },
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
                crate::zip::write_archive(&mut out, &files, ZIP_MAX_BYTES)?;
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
        self.sweep_downloads();
        let (file, size, version, leased) = {
            let reads = self.reads.lock().expect("transfer reads");
            let read = reads.get(id).filter(|r| owners.contains(&r.owner.as_str())).ok_or_else(WsError::expired)?;
            (read.file.try_clone()?, read.size, read.version.clone(), read.lease.is_some())
        };
        if expected.is_some_and(|expected| expected != version) {
            return Err(download_changed());
        }
        let current = version_string(&file_version(&file)?);
        if current != version {
            if leased {
                self.reads.lock().expect("transfer reads").remove(id);
                return Err(download_changed());
            }
            return Err(WsError::changed());
        }
        if offset > size {
            return Err(WsError::invalid("offset is past the end of the file."));
        }
        let length = length.min(RANGE_MAX_BYTES).min(size - offset);
        let mut data = vec![0u8; length as usize];
        let mut filled = 0usize;
        while filled < data.len() {
            let n = read_at(&file, &mut data[filled..], offset + filled as u64)?;
            if n == 0 {
                return Err(WsError::changed());
            }
            filled += n;
        }
        self.point("read.read");
        // Revoked while reading: nothing more leaves the transfer.
        {
            let mut reads = self.reads.lock().expect("transfer reads");
            let read = reads.get_mut(id).filter(|r| owners.contains(&r.owner.as_str())).ok_or_else(WsError::expired)?;
            if let Some(lease) = read.lease.as_mut() {
                lease.idle_until = self.now_ms() + LEASE_IDLE_MS;
            }
        }
        Ok(Range {
            transfer_id: id.to_owned(),
            offset,
            length,
            eof: offset + length >= size,
            version,
            data: STANDARD.encode(&data),
        })
    }

    /// Ends a transfer, or an unredeemed grant, of `owner`; whether anything was released.
    pub fn end_read(&self, owners: &[&str], id: &str) -> bool {
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
        self.reads.lock().expect("transfer reads").retain(|_, r| r.owner != owner);
        self.grants.lock().expect("transfer grants").retain(|(_, g)| g.owner != owner);
        let stale: Vec<Upload> = {
            let mut writes = self.writes.lock().expect("transfer writes");
            let ids: Vec<String> = writes.iter().filter(|(_, w)| w.owner == owner).map(|(k, _)| k.clone()).collect();
            ids.into_iter().filter_map(|id| writes.remove(&id)).collect()
        };
        for write in stale {
            let _ = std::fs::remove_file(write.temp);
        }
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

pub type SharedTransfers = Arc<Transfers>;

/// Node's `openRegularFile`: a regular file by its real path, never a network path, a folder or a device.
fn open_regular(path: &Path) -> WsResult<(PathBuf, File)> {
    let not_local = || download("file-download:not-a-file", "Only files on this PC can be downloaded.");
    let network = |p: &Path| {
        let text = p.to_string_lossy();
        text.starts_with("//") || text.starts_with("\\\\")
    };
    if network(path) {
        return Err(not_local());
    }
    let missing = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => download("file-download:not-found", "The file no longer exists."),
        _ => WsError::from(error),
    };
    let real = canonical(path).map_err(missing)?;
    if network(&real) || !std::fs::metadata(&real).map_err(missing)?.is_file() {
        return Err(not_local());
    }
    let file = File::open(&real).map_err(missing)?;
    Ok((real, file))
}

fn offered(path: &Path, file: File) -> SourceFile {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    SourceFile { file, mime_type: mime_type(path).to_owned(), name, cleanup: None }
}

/// A project file of a conversation (`authorizeProjectFile`): the relative path may not leave `root`, and neither may its real place.
pub fn open_project_download(root: &Path, rel: &str) -> WsResult<SourceFile> {
    let outside = || download("file-download:outside-project", "The file is outside the conversation's project.");
    let lexical_path = project_entry_path(root, rel).map_err(|_| outside())?;
    let (real, file) = open_regular(&lexical_path)?;
    if !crate::pathguard::is_within(root, &real) {
        return Err(outside());
    }
    Ok(offered(&lexical_path, file))
}

/// A file a conversation names, absolute (`openSessionPath`): anywhere on this PC, but a path inside the conversation's project may not
/// leave it through a link. `project` is the registered project's real folder and `project_given` the folder as the conversation
/// states it.
pub fn open_session_download(path: &str, project: Option<&Path>, project_given: Option<&Path>) -> WsResult<SourceFile> {
    let requested = Path::new(path);
    if !requested.is_absolute() || path.starts_with("//") || path.starts_with("\\\\") {
        return Err(download("file-download:not-a-file", "Only files on this PC can be downloaded."));
    }
    let requested = crate::pathguard::lexical(requested);
    let in_project = project.is_some_and(|root| {
        crate::pathguard::is_within(root, &requested) || project_given.is_some_and(|given| crate::pathguard::is_within(&crate::pathguard::lexical(given), &requested))
    });
    let (real, file) = open_regular(&requested)?;
    if in_project && !project.is_some_and(|root| crate::pathguard::is_within(root, &real)) {
        return Err(download("file-download:outside-project", "The link resolves outside the conversation's project."));
    }
    Ok(offered(&requested, file))
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
        elapsed_ms: tokio::sync::watch::Sender<u64>,
    }

    impl Manual {
        pub(super) fn new() -> Arc<Self> {
            Arc::new(Self { base: Instant::now(), elapsed_ms: tokio::sync::watch::Sender::new(0) })
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
        let opened = open_session_download(&path.to_string_lossy(), None, None).unwrap();
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

    /// The first window of an unpair against a redeem: the grant is out of the table and the revoke finds nothing to end. The
    /// marks are read in the one step that consumes the grant, so the revoke is seen when the transfer would be published.
    #[test]
    fn a_revoke_after_the_grant_is_consumed_leaves_no_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.taken", |t| t.revoke_owner("dev"));
        assert_eq!(t.begin_grant("dev", &grant.grant_id).unwrap_err().reason, Reason::DownloadExpired);
        assert_eq!(t.open_reads(), 0);
    }

    /// The second window: the file check is done and the transfer is about to be published.
    #[test]
    fn a_revoke_after_the_file_check_leaves_no_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.verify", |t| t.revoke_owner("dev"));
        assert_eq!(t.begin_grant("dev", &grant.grant_id).unwrap_err().reason, Reason::DownloadExpired);
        assert_eq!(t.open_reads(), 0);
    }

    /// A revoke the moment the transfer is published reaches it: publishing and the check are one step for a revoke.
    #[test]
    fn a_revoke_right_after_the_transfer_is_published_ends_it() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.published", |t| t.revoke_owner("dev"));
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        assert_eq!(range_of(&t, "dev", &leased).unwrap_err().reason, Reason::DownloadExpired);
        assert_eq!(t.open_reads(), 0);
    }

    /// Whatever the interleaving, a device's reads fail from its unpair on: a read in flight, an authorize in flight, and the other
    /// device untouched.
    #[test]
    fn after_an_unpair_no_read_of_the_device_succeeds_whatever_was_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        let leased = t.begin_grant("dev", &grant.grant_id).unwrap();
        at(&t, "read.read", |t| t.revoke_owner("dev"));
        assert_eq!(range_of(&t, "dev", &leased).unwrap_err().reason, Reason::DownloadExpired);
        // An authorize that was opening its file when the device was revoked leaves no grant.
        at(&t, "authorize.opened", |t| t.revoke_owner("dev"));
        let path = dir.path().join("a.bin");
        let opened = open_session_download(&path.to_string_lossy(), None, None).unwrap();
        let mark = t.mark("dev", "s1");
        assert_eq!(t.authorize("dev", "s1", mark, opened).unwrap_err().reason, Reason::DownloadExpired);
        t.on_point(None);
        assert!(t.grants.lock().unwrap().is_empty());
        // Another device is untouched.
        let other = grant_of(&t, dir.path(), "other", "s1");
        let kept = t.begin_grant("other", &other.grant_id).unwrap();
        t.revoke_owner("dev");
        assert!(range_of(&t, "other", &kept).is_ok());
    }

    /// The same two windows for a conversation that is deleted, and a deletion ends what the conversation held and nothing else.
    #[test]
    fn a_deleted_conversation_ends_its_grants_and_transfers_in_every_window() {
        let dir = tempfile::tempdir().unwrap();
        let t = Arc::new(Transfers::default());
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.taken", |t| t.revoke_session("s1"));
        assert_eq!(t.begin_grant("dev", &grant.grant_id).unwrap_err().reason, Reason::DownloadExpired);
        let grant = grant_of(&t, dir.path(), "dev", "s1");
        at(&t, "begin.verify", |t| t.revoke_session("s1"));
        assert_eq!(t.begin_grant("dev", &grant.grant_id).unwrap_err().reason, Reason::DownloadExpired);
        t.on_point(None);
        assert_eq!(t.open_reads(), 0);
        let unbegun = grant_of(&t, dir.path(), "dev", "s1");
        let kept = grant_of(&t, dir.path(), "dev", "s2");
        let live = t.begin_grant("dev", &kept.grant_id).unwrap();
        t.revoke_session("s1");
        assert_eq!(t.begin_grant("dev", &unbegun.grant_id).unwrap_err().reason, Reason::DownloadExpired);
        assert!(range_of(&t, "dev", &live).is_ok(), "the other conversation's transfer lives");
        at(&t, "authorize.opened", |t| t.revoke_session("s2"));
        let opened = open_session_download(&dir.path().join("a.bin").to_string_lossy(), None, None).unwrap();
        let mark = t.mark("dev", "s2");
        assert_eq!(t.authorize("dev", "s2", mark, opened).unwrap_err().reason, Reason::DownloadExpired);
        assert!(range_of(&t, "dev", &live).is_err(), "s2 was deleted too");
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
