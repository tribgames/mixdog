#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "blocking file bodies run only as lane jobs (lanes::run); the service never calls them on an async thread"
)]
//! Media leases of a paired device's project-file previews: an unguessable id for a file that is no gallery asset, so a phone
//! streams a preview's image, audio or video by ranged requests.
//!
//! A lease records the folder its file was authorized within and the file's identity; every request opens the path again through
//! [`open_authorized_ro`] and serves only that file, still inside the folder. A lease lasts [`LEASE_TTL_MS`], the oldest of more
//! than [`MAX_LEASES`] is dropped, and it answers only the paired device it was minted for.

use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::error::WsResult;
use crate::ident::FileId;
use crate::ident::file_version;
use crate::ident::mtime_ms;
use crate::inplace::open_authorized_ro;
use crate::lanes::Lanes;
use crate::lease_end::EndOnDrop;
use crate::lease_end::Sleeper;
use crate::lease_end::TokioSleeper;
use crate::lease_end::run_deadlines;
use crate::pathguard::project_entry_path;

/// `LEASE_TTL_MS`.
pub const LEASE_TTL_MS: u64 = 60 * 60 * 1000;
/// `MAX_LEASES`.
pub const MAX_LEASES: usize = 256;

struct Lease {
    /// The folder the file was authorized within, and the file's path in it.
    root: PathBuf,
    path: PathBuf,
    /// The identity of the authorized file.
    id: FileId,
    mime: String,
    /// The paired device the lease belongs to.
    device: String,
    authorize: Option<Authorize>,
    expires_at: u64,
    /// This lease's terminal event, published when the entry leaves the table by any way (expiry, the cap's eviction, the unpair's
    /// removal): the entry owns it, so no way out of the table can forget to publish it.
    end: EndOnDrop,
}

/// The live leases, oldest first.
pub struct ProjectFileLeases {
    lanes: Lanes,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    sleeper: Arc<dyn Sleeper>,
    /// Woken when a lease is added, so the expiry scheduler looks again at the earliest deadline.
    changed: Notify,
    leases: Mutex<Vec<(String, Lease)>>,
}

/// Whether what authorized a stream still holds: asked before every read of it.
type Valid = Arc<dyn Fn() -> bool + Send + Sync>;
/// Re-resolve the permission that minted this preview against the current project or file-grant state.
pub(crate) type Authorize = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

async fn authorized(check: Option<&Authorize>) -> bool {
    match check {
        Some(check) => check().await,
        None => true,
    }
}

/// Runs a delivery only while the lease holds, in one step with that test and serialized against what ends the lease (its removal on
/// an unpair, its expiry, its eviction); false, running nothing, when it does not. The delivery must not wait. Asking it reads no
/// bytes and renews nothing.
pub type Commit = Arc<dyn Fn(&mut dyn FnMut()) -> bool + Send + Sync>;

/// A lease's authority as the media lane takes it: the guarded commit (the enforcement) and the terminal event its owner publishes
/// when the lease ends (termination and release of every wait made under it). The event stays published, so one that subscribes
/// after the end is released at once.
#[derive(Clone)]
pub struct LeaseHandle {
    pub commit: Commit,
    pub ended: CancellationToken,
}

/// A leased file, opened again for one request. The authorization is not a fact of the opening: [`Self::read`] asks `valid` before
/// every read, so a lease that was revoked or expired, or a file that left its folder, ends a stream that is already running; and
/// reading is no permission to deliver what was read, which is asked again at the commit of each delivery ([`Self::lease`]).
pub struct LeasedFile {
    file: Arc<File>,
    lanes: Lanes,
    size: u64,
    mime: String,
    version: String,
    valid: Valid,
    authorize: Option<Authorize>,
    /// `None` for a gallery file, which is leased to no one.
    lease: Option<LeaseHandle>,
}

impl LeasedFile {
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn mime(&self) -> &str {
        &self.mime
    }

    /// The file's size and modification time, which tell a stream the file changed.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// The lease's authority for the commit of each delivery of this stream; `None` for a gallery file (no lease: the requesting
    /// credential alone permits it).
    pub fn lease(&self) -> Option<LeaseHandle> {
        self.lease.clone()
    }

    /// Up to `length` bytes from `offset`; fewer when the file is shorter than it was; `NotFound` once the authorization is gone.
    pub async fn read(&self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        if !authorized(self.authorize.as_ref()).await {
            return Err(std::io::ErrorKind::NotFound.into());
        }
        let (file, valid) = (Arc::clone(&self.file), Arc::clone(&self.valid));
        let read = crate::lanes::run(self.lanes.interactive, &CancellationToken::new(), move || -> std::io::Result<Vec<u8>> {
            if !valid() {
                return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
            }
            let mut file = &*file;
            file.seek(SeekFrom::Start(offset))?;
            let mut bytes = vec![0u8; length];
            let mut filled = 0;
            while filled < length {
                let read = file.read(&mut bytes[filled..])?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            bytes.truncate(filled);
            if !valid() {
                return Err(std::io::ErrorKind::NotFound.into());
            }
            Ok(bytes)
        })
        .await;
        // The job's own error comes back as it was (`NotFound` stays `NotFound`, which the lane answers as an ended lease).
        let bytes = read.map_err(|error| std::io::Error::other(error.message))??;
        if !authorized(self.authorize.as_ref()).await {
            return Err(std::io::ErrorKind::NotFound.into());
        }
        Ok(bytes)
    }
}

/// A phone's file-download lease, read through the transfer table by the media lane (Node's `downloads.resolveMedia` target): every
/// read has the transfer's own checks (the version leased, the file still where it was authorized, the idle time renewed).
pub struct DownloadFile {
    transfers: Arc<crate::transfer::Transfers>,
    lanes: Lanes,
    lease: crate::transfer::MediaLease,
}

impl DownloadFile {
    pub fn size(&self) -> u64 {
        self.lease.size
    }

    pub fn mime(&self) -> &str {
        &self.lease.mime
    }

    pub fn version(&self) -> &str {
        &self.lease.version
    }

    /// The lease's authority for the commit of each delivery: the transfer table's own state (the transfer held by its device, inside
    /// its idle time and its thirty minutes), asked without reading and without renewing the idle time; and the terminal event the
    /// table publishes when the transfer ends or its deadline passes.
    pub fn lease(&self) -> LeaseHandle {
        let (transfers, lease) = (Arc::clone(&self.transfers), self.lease.clone());
        LeaseHandle { ended: lease.ended.clone(), commit: Arc::new(move |write: &mut dyn FnMut()| transfers.media_commit(&lease, write)) }
    }

    /// Up to `length` bytes from `offset`; a lease that ended or a file that changed is `NotFound` or a short read.
    pub async fn read(&self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        let (transfers, lease) = (Arc::clone(&self.transfers), self.lease.clone());
        let read = crate::lanes::run(self.lanes.interactive, &CancellationToken::new(), move || transfers.read_media(&lease, offset, length as u64)).await;
        use crate::error::Reason;
        match read.and_then(|inner| inner) {
            Ok(bytes) => Ok(bytes),
            Err(error) => match error.reason {
                Reason::DownloadExpired | Reason::NotFound | Reason::Download("file-download:expired") => {
                    Err(std::io::Error::from(std::io::ErrorKind::NotFound))
                }
                Reason::Changed | Reason::Download("file-download:changed") => Ok(Vec::new()),
                _ => Err(std::io::Error::other(error.message)),
            },
        }
    }
}

/// The lease `media_id` is for `device` in `transfers`, as a source the lane can read.
pub fn download_file(transfers: &Arc<crate::transfer::Transfers>, lanes: Lanes, device: &str, media_id: &str) -> Option<DownloadFile> {
    let lease = transfers.media_lease(device, media_id)?;
    Some(DownloadFile { transfers: Arc::clone(transfers), lanes, lease })
}

/// A file opened again the way `openAuthorizedFile(path, within)` opens it, for one request of the lane: a regular file whose real
/// place is inside `within`. `None` for one that is not there or does not qualify. Every read of the stream asks again: the path
/// must still be the very file that was opened, inside `within` (a deleted asset or a replaced file ends the stream).
pub async fn open_within(lanes: Lanes, path: PathBuf, within: PathBuf, mime: String) -> Option<LeasedFile> {
    let (check_path, check_within) = (path.clone(), within.clone());
    let opened = crate::lanes::run(lanes.interactive, &CancellationToken::new(), move || {
        let opened = open_authorized_ro(&path, &within).ok()?;
        let meta = opened.file.metadata().ok()?;
        Some((opened.file, opened.id, meta.len(), format!("{}:{}", mtime_ms(&meta), meta.len())))
    })
    .await
    .ok()??;
    let id = opened.1;
    let valid: Valid = Arc::new(move || open_authorized_ro(&check_path, &check_within).is_ok_and(|now| now.id == id));
    // A gallery file is leased to no one: its deliveries are permitted by the requesting credential alone.
    Some(LeasedFile { file: Arc::new(opened.0), lanes, size: opened.2, mime, version: opened.3, valid, authorize: None, lease: None })
}

fn system_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

impl ProjectFileLeases {
    pub fn new(lanes: Lanes) -> Arc<Self> {
        Self::with_clock(lanes, Arc::new(system_now))
    }

    /// The clock is the caller's (the tests'), in milliseconds.
    pub fn with_clock(lanes: Lanes, now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Arc<Self> {
        Self::with_clock_and_sleeper(lanes, now, Arc::new(TokioSleeper))
    }

    /// [`with_clock`](Self::with_clock) with the sleep of the expiry scheduler also the caller's, so a test that moves the clock
    /// moves the scheduler's wait with it.
    pub fn with_clock_and_sleeper(lanes: Lanes, now: Arc<dyn Fn() -> u64 + Send + Sync>, sleeper: Arc<dyn Sleeper>) -> Arc<Self> {
        Arc::new(Self { lanes, now, sleeper, changed: Notify::new(), leases: Mutex::default() })
    }

    fn leases(&self) -> std::sync::MutexGuard<'_, Vec<(String, Lease)>> {
        self.leases.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The expiry scheduler: one task for the owner, not one timer per stream. It ends each lease at its stored deadline (the entry
    /// leaves the table and its terminal event is published) and sleeps to the earliest deadline left; a mint wakes it. Run it once,
    /// on the daemon's runtime.
    pub async fn run_expiry(&self) {
        run_deadlines(&self.changed, |ms| self.sleeper.sleep(ms), || self.end_due()).await;
    }

    /// Ends every lease whose deadline has come, under the table's lock and with the time sampled after taking it (a timer that runs
    /// late changes nothing: the commit's own check stays authoritative), and answers the delay to the earliest deadline left.
    fn end_due(&self) -> Option<u64> {
        let mut leases = self.leases();
        let now = (self.now)();
        leases.retain(|(_, lease)| lease.expires_at > now);
        leases.iter().map(|(_, lease)| lease.expires_at - now).min()
    }

    /// `leaseMediaFile` over `openAuthorizedFile`: opens `rel` of `root` for `device` (a path outside the folder, through a link
    /// out of it, or that is no regular file is refused) and leases it. Blocking: a lane job.
    pub fn mint(&self, root: &Path, rel: &str, mime: &str, device: &str) -> WsResult<String> {
        self.mint_with_authority(root, rel, mime, device, None)
    }

    pub(crate) fn mint_with_authority(&self, root: &Path, rel: &str, mime: &str, device: &str, authorize: Option<Authorize>) -> WsResult<String> {
        let path = project_entry_path(root, rel)?;
        let opened = open_authorized_ro(&path, root)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut leases = self.leases();
        let now = (self.now)();
        leases.retain(|(_, lease)| lease.expires_at > now);
        leases.push((
            id.clone(),
            Lease {
                root: root.to_path_buf(),
                path,
                id: opened.id,
                mime: mime.to_owned(),
                device: device.to_owned(),
                authorize,
                expires_at: now + LEASE_TTL_MS,
                end: EndOnDrop::new(),
            },
        ));
        while leases.len() > MAX_LEASES {
            leases.remove(0);
        }
        drop(leases);
        self.changed.notify_one();
        Ok(id)
    }

    /// `leasedMediaFile` and `openLeasedFile`: the file `asset_id` leases to `device`, opened again the way it was authorized, or
    /// `None` for an id that is no lease, a lease that ended or belongs to another device, a file that was replaced, and one that
    /// now resolves outside its folder.
    pub async fn open(self: &Arc<Self>, asset_id: &str, device: &str) -> Option<LeasedFile> {
        let (root, path, id, mime, end, authorize) = {
            let mut leases = self.leases();
            let now = (self.now)();
            let at = leases.iter().position(|(name, _)| name == asset_id)?;
            if leases[at].1.expires_at <= now {
                leases.remove(at);
                return None;
            }
            let lease = &leases[at].1;
            if lease.device != device {
                return None;
            }
            (lease.root.clone(), lease.path.clone(), lease.id, lease.mime.clone(), lease.end.token(), lease.authorize.clone())
        };
        if !authorized(authorize.as_ref()).await {
            return None;
        }
        let lanes = self.lanes;
        let (check_root, check_path) = (root.clone(), path.clone());
        let opened = crate::lanes::run(lanes.interactive, &CancellationToken::new(), move || {
            let opened = open_authorized_ro(&path, &root).ok()?;
            if opened.id != id {
                return None;
            }
            let version = file_version(&opened.file).ok()?;
            Some((opened.file, version))
        })
        .await
        .ok()??;
        let version = opened.1;
        // Reopen and prove the path again around every read; holding a descriptor is not proof that its path is still authorized.
        let valid: Valid = {
            let (leases, asset, device) = (Arc::clone(self), asset_id.to_owned(), device.to_owned());
            Arc::new(move || {
                leases.holds(&asset, &device)
                    && open_authorized_ro(&check_path, &check_root).is_ok_and(|current| file_version(&current.file).is_ok_and(|current| current == version))
            })
        };
        let commit: Commit = {
            let (leases, asset, device) = (Arc::clone(self), asset_id.to_owned(), device.to_owned());
            Arc::new(move |write: &mut dyn FnMut()| leases.commit(&asset, &device, write))
        };
        Some(LeasedFile {
            file: Arc::new(opened.0),
            lanes,
            size: version.size,
            mime,
            version: crate::transfer::version_string(&version),
            valid,
            authorize,
            lease: Some(LeaseHandle { commit, ended: end }),
        })
    }

    /// Whether `asset_id` is still a live lease of `device`: present, unexpired, and the device's own.
    fn holds(&self, asset_id: &str, device: &str) -> bool {
        let leases = self.leases();
        let now = (self.now)();
        leases.iter().any(|(name, lease)| name == asset_id && lease.device == device && lease.expires_at > now)
    }

    /// Runs `write` in one step with the test that the lease still holds, under the table's lock: an unpair, an eviction or a mint
    /// that evicts it is ordered before the test (the write is refused) or after the write (it was allowed). The time is sampled
    /// after the lock is taken: a delivery that waited for the lock across the deadline is judged at the time it holds it.
    fn commit(&self, asset_id: &str, device: &str, write: &mut dyn FnMut()) -> bool {
        let leases = self.leases();
        let now = (self.now)();
        if !leases.iter().any(|(name, lease)| name == asset_id && lease.device == device && lease.expires_at > now) {
            return false;
        }
        write();
        true
    }

    /// An unpaired device's leases end with it.
    pub fn revoke_device(&self, device: &str) {
        self.leases().retain(|(_, lease)| lease.device != device);
    }

    pub(crate) fn revoke_all(&self) {
        self.leases().clear();
    }

    /// How many leases are live (for the tests).
    pub fn len(&self) -> usize {
        self.leases().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::lease_end::Sleeper;

    fn lanes() -> Lanes {
        let tokens = mixdog_rt::testing::tokens();
        Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk }
    }

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = crate::pathguard::canonical(dir.path()).unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        (dir, root)
    }

    /// A 100 MB video (sparse on disk) with a marker 60 MB in, seeked to by range: the lease serves the bytes at any offset
    /// without reading the file whole.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hundred_megabyte_video_is_served_by_range_from_any_offset() {
        let (_dir, root) = project();
        let mut video = std::fs::File::create(root.join("clip.mp4")).unwrap();
        video.set_len(100 * 1024 * 1024).unwrap();
        video.seek(SeekFrom::Start(60 * 1024 * 1024)).unwrap();
        video.write_all(b"SEEKED-HERE").unwrap();
        drop(video);
        let leases = ProjectFileLeases::new(lanes());
        let id = leases.mint(&root, "clip.mp4", "video/mp4", "phone-1").unwrap();
        let served = leases.open(&id, "phone-1").await.expect("lease opens");
        assert_eq!((served.size(), served.mime()), (100 * 1024 * 1024, "video/mp4"));
        assert_eq!(served.read(60 * 1024 * 1024, 11).await.unwrap(), b"SEEKED-HERE");
        // A range reaching past the end is cut at the end, and each request opens the file again.
        assert_eq!(served.read(100 * 1024 * 1024 - 2, 10).await.unwrap(), vec![0, 0]);
        assert!(leases.open(&id, "phone-1").await.is_some());
    }

    /// The lease is bound to the authorization of the call that minted it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_lease_is_refused_outside_the_project_for_another_device_and_after_it_expires() {
        let (_dir, root) = project();
        let outside = root.parent().unwrap().join("outside.mp4");
        std::fs::write(&outside, b"secret").unwrap();
        std::fs::write(root.join("in.mp3"), b"sound").unwrap();
        let clock = Arc::new(AtomicU64::new(1_000));
        let leases = ProjectFileLeases::with_clock(lanes(), {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        });
        // A path outside the project is never leased, by `..` or by an absolute name.
        assert!(leases.mint(&root, "../outside.mp4", "video/mp4", "phone-1").is_err());
        assert!(leases.mint(&root, &outside.to_string_lossy(), "video/mp4", "phone-1").is_err());
        assert!(leases.is_empty());
        let id = leases.mint(&root, "in.mp3", "audio/mpeg", "phone-1").unwrap();
        assert!(leases.open(&id, "phone-1").await.is_some());
        assert!(leases.open(&id, "phone-2").await.is_none(), "another client");
        assert!(leases.open("not-a-lease", "phone-1").await.is_none());
        // Node's hour: still served just before it, gone at it.
        clock.store(1_000 + LEASE_TTL_MS - 1, Ordering::SeqCst);
        assert!(leases.open(&id, "phone-1").await.is_some());
        clock.store(1_000 + LEASE_TTL_MS, Ordering::SeqCst);
        assert!(leases.open(&id, "phone-1").await.is_none(), "expired");
        assert!(leases.is_empty(), "an expired lease is dropped when it is met");
    }

    /// A lease is asked where the bytes are read, for every read, not where the source was obtained: a stream already open ends at
    /// its next read when its device is unpaired, when the hour runs out, or when its lease is dropped; an untouched one goes on.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_open_stream_ends_at_its_next_read_when_its_lease_is_revoked_or_expires() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.mp4"), b"0123456789").unwrap();
        let clock = Arc::new(AtomicU64::new(1_000));
        let leases = ProjectFileLeases::with_clock(lanes(), {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        });
        let not_found = |result: std::io::Result<Vec<u8>>| result.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        // Unpair: the device's open stream reads no more; another device's goes on.
        let (mine, theirs) = (leases.mint(&root, "a.mp4", "video/mp4", "phone-1").unwrap(), leases.mint(&root, "a.mp4", "video/mp4", "phone-2").unwrap());
        let (open_mine, open_theirs) = (leases.open(&mine, "phone-1").await.unwrap(), leases.open(&theirs, "phone-2").await.unwrap());
        assert_eq!(open_mine.read(0, 4).await.unwrap(), b"0123");
        leases.revoke_device("phone-1");
        assert!(not_found(open_mine.read(4, 4).await), "the unpaired device's stream");
        assert_eq!(open_theirs.read(4, 4).await.unwrap(), b"4567", "another device's stream");
        // Expiry: Node's hour ends a stream that began inside it.
        clock.store(1_000 + LEASE_TTL_MS - 1, Ordering::SeqCst);
        assert_eq!(open_theirs.read(0, 2).await.unwrap(), b"01");
        clock.store(1_000 + LEASE_TTL_MS, Ordering::SeqCst);
        assert!(not_found(open_theirs.read(2, 2).await), "an expired lease");
        // The cap drops the oldest lease, and with it the stream.
        let first = leases.mint(&root, "a.mp4", "video/mp4", "phone-3").unwrap();
        let open_first = leases.open(&first, "phone-3").await.unwrap();
        for _ in 0..MAX_LEASES {
            leases.mint(&root, "a.mp4", "video/mp4", "phone-4").unwrap();
        }
        assert!(not_found(open_first.read(0, 2).await), "a lease dropped for the cap");
    }

    struct CommitFixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        clock: Arc<AtomicU64>,
        leases: Arc<ProjectFileLeases>,
    }

    fn commit_fixture() -> CommitFixture {
        let (dir, root) = project();
        std::fs::write(root.join("a.mp4"), b"0123456789").unwrap();
        let clock = Arc::new(AtomicU64::new(1_000));
        let leases = ProjectFileLeases::with_clock(lanes(), {
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::SeqCst))
        });
        CommitFixture { _dir: dir, root, clock, leases }
    }

    impl CommitFixture {
        async fn commit_of(&self, id: &str, device: &str) -> Commit {
            self.leases.open(id, device).await.unwrap().lease().unwrap().commit
        }
    }

    /// The permission to deliver is the lease's own state at the commit: allowed while it holds, refused (running nothing) after the hour.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_commit_is_refused_once_the_lease_expires() {
        let f = commit_fixture();
        let mut ran = 0;
        let expiring = f.leases.mint(&f.root, "a.mp4", "video/mp4", "phone-1").unwrap();
        let commit = f.commit_of(&expiring, "phone-1").await;
        assert!(commit(&mut || ran += 1));
        f.clock.store(1_000 + LEASE_TTL_MS, Ordering::SeqCst);
        assert!(!commit(&mut || ran += 1), "the hour is over");
        assert_eq!(ran, 1, "a refused commit runs nothing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_commit_is_refused_once_the_cap_evicts_the_lease() {
        let f = commit_fixture();
        let mut ran = 0;
        let evicted = f.leases.mint(&f.root, "a.mp4", "video/mp4", "phone-3").unwrap();
        let commit = f.commit_of(&evicted, "phone-3").await;
        for _ in 0..MAX_LEASES {
            f.leases.mint(&f.root, "a.mp4", "video/mp4", "phone-4").unwrap();
        }
        assert!(!commit(&mut || ran += 1), "evicted for the cap");
        assert_eq!(ran, 0, "a refused commit runs nothing");
    }

    /// A revoke that races a commit in progress waits for it (commit first is allowed), and one that came first refuses it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_revoke_is_ordered_against_a_commit_in_progress() {
        let f = commit_fixture();
        let leases = f.leases.clone();
        let mut ran = 0;
        let mine = leases.mint(&f.root, "a.mp4", "video/mp4", "phone-1").unwrap();
        let commit = f.commit_of(&mine, "phone-1").await;
        let (entered, inside) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel::<()>();
        let committing = std::thread::spawn({
            let commit = commit.clone();
            move || {
                let mut wrote = false;
                let allowed = commit(&mut || {
                    wrote = true;
                    entered.send(()).unwrap();
                    held.recv().unwrap();
                });
                (allowed, wrote)
            }
        });
        inside.recv().unwrap();
        let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let revoking = std::thread::spawn({
            let (leases, revoked) = (leases.clone(), revoked.clone());
            move || {
                leases.revoke_device("phone-1");
                revoked.store(true, Ordering::SeqCst);
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!revoked.load(Ordering::SeqCst), "the unpair waits for the commit in progress");
        release.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), (true, true), "commit first is allowed");
        revoking.join().unwrap();
        assert!(!commit(&mut || ran += 1), "revoke first is refused");
        assert_eq!(ran, 0, "a refused commit runs nothing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_gallery_file_has_no_lease() {
        let f = commit_fixture();
        std::fs::write(f.root.join("g.png"), b"x").unwrap();
        assert!(open_within(lanes(), f.root.join("g.png"), f.root.clone(), "image/png".into()).await.unwrap().lease().is_none());
    }

    /// A clock the test moves, whose sleep moves with it: the scheduler's wait ends when the test advances past it, and `sleeps`
    /// counts the waits begun, so a test knows the scheduler is asleep before it moves the clock.
    struct Manual {
        now: AtomicU64,
        moved: tokio::sync::watch::Sender<u64>,
        sleeps: std::sync::atomic::AtomicUsize,
    }

    impl Manual {
        fn new(start: u64) -> Arc<Self> {
            Arc::new(Self { now: AtomicU64::new(start), moved: tokio::sync::watch::Sender::new(start), sleeps: std::sync::atomic::AtomicUsize::new(0) })
        }

        fn clock(self: &Arc<Self>) -> Arc<dyn Fn() -> u64 + Send + Sync> {
            let me = self.clone();
            Arc::new(move || me.now.load(Ordering::SeqCst))
        }

        fn advance(&self, ms: u64) {
            let now = self.now.fetch_add(ms, Ordering::SeqCst) + ms;
            self.moved.send_replace(now);
        }

        /// Returns once the scheduler has begun `n` waits in all.
        async fn asleep(&self, n: usize) {
            for _ in 0..500 {
                if self.sleeps.load(Ordering::SeqCst) >= n {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            panic!("the scheduler did not begin wait {n}");
        }
    }

    impl Sleeper for Manual {
        fn sleep(&self, ms: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
            let target = self.now.load(Ordering::SeqCst) + ms;
            let mut moved = self.moved.subscribe();
            self.sleeps.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                loop {
                    if *moved.borrow_and_update() >= target {
                        return;
                    }
                    if moved.changed().await.is_err() {
                        return;
                    }
                }
            })
        }
    }

    async fn ended_within(token: &CancellationToken) -> bool {
        tokio::time::timeout(std::time::Duration::from_secs(5), token.cancelled()).await.is_ok()
    }

    async fn not_ended(token: &CancellationToken) -> bool {
        tokio::time::timeout(std::time::Duration::from_millis(100), token.cancelled()).await.is_err()
    }

    /// A delivery that waits for the table's lock across the lease's expiry is judged at the time it holds the lock: the time is
    /// sampled after the lock is taken, so nothing is written on the earlier timestamp.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_commit_blocked_on_the_table_lock_across_expiry_writes_nothing() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.mp4"), b"0123456789").unwrap();
        let manual = Manual::new(1_000);
        let leases = ProjectFileLeases::with_clock_and_sleeper(lanes(), manual.clock(), manual.clone());
        let id = leases.mint(&root, "a.mp4", "video/mp4", "phone-1").unwrap();
        let commit = leases.open(&id, "phone-1").await.unwrap().lease().unwrap().commit;
        let held = leases.leases();
        let writing = std::thread::spawn({
            let commit = commit.clone();
            move || {
                let mut wrote = false;
                let allowed = commit(&mut || wrote = true);
                (allowed, wrote)
            }
        });
        // The delivery is at the lock; the hour ends while it waits.
        std::thread::sleep(std::time::Duration::from_millis(100));
        manual.advance(LEASE_TTL_MS);
        drop(held);
        assert_eq!(writing.join().unwrap(), (false, false), "judged at the time it held the lock, not the time it began to wait");
    }

    /// The owner's scheduler ends an untouched lease at its stored deadline, with no stream asking: the entry leaves the table and
    /// the terminal event is published, a stream's open handle or not. A lease evicted, or removed by an unpair, ends the same event;
    /// ending one lease leaves the others' untouched.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_owners_timer_ends_an_untouched_lease_at_its_deadline_and_every_removal_ends_its_event() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.mp4"), b"0123456789").unwrap();
        let manual = Manual::new(1_000);
        let leases = ProjectFileLeases::with_clock_and_sleeper(lanes(), manual.clock(), manual.clone());
        let scheduler = tokio::spawn({
            let leases = leases.clone();
            async move { leases.run_expiry().await }
        });
        let first = leases.mint(&root, "a.mp4", "video/mp4", "phone-1").unwrap();
        let ended = leases.open(&first, "phone-1").await.unwrap().lease().unwrap().ended;
        manual.asleep(1).await;
        // A second lease, minted half an hour later, has a later deadline of its own.
        manual.advance(LEASE_TTL_MS / 2);
        let second = leases.mint(&root, "a.mp4", "video/mp4", "phone-2").unwrap();
        let later = leases.open(&second, "phone-2").await.unwrap().lease().unwrap().ended;
        manual.asleep(2).await;
        manual.advance(LEASE_TTL_MS / 2 - 1);
        assert!(not_ended(&ended).await && !leases.is_empty(), "one millisecond before the deadline");
        manual.advance(1);
        assert!(ended_within(&ended).await, "the timer published the end at the deadline");
        assert_eq!(leases.len(), 1, "the expired entry left the table");
        assert!(not_ended(&later).await, "the other lease is untouched");
        // An unpair removes its device's lease and ends its event; an eviction for the cap ends the oldest one's.
        leases.revoke_device("phone-2");
        assert!(ended_within(&later).await && leases.is_empty());
        let evicted = leases.mint(&root, "a.mp4", "video/mp4", "phone-3").unwrap();
        let evicted = leases.open(&evicted, "phone-3").await.unwrap().lease().unwrap().ended;
        let kept = leases.mint(&root, "a.mp4", "video/mp4", "phone-4").unwrap();
        for _ in 1..MAX_LEASES {
            leases.mint(&root, "a.mp4", "video/mp4", "phone-4").unwrap();
        }
        assert_eq!(leases.len(), MAX_LEASES);
        assert!(ended_within(&evicted).await, "the cap evicted the oldest and ended its event");
        assert!(leases.open(&kept, "phone-4").await.is_some(), "the newer leases are untouched");
        scheduler.abort();
    }

    /// A gallery source has no lease; what authorizes it is the file being, at every read, the very file in its folder: one that was
    /// deleted or replaced after the stream opened is not read on.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_open_gallery_stream_ends_when_its_file_is_deleted_or_replaced() {
        let (_dir, root) = project();
        let (gone, swapped) = (root.join("gone.png"), root.join("swapped.png"));
        std::fs::write(&gone, b"0123456789").unwrap();
        std::fs::write(&swapped, b"0123456789").unwrap();
        let open_gone = open_within(lanes(), gone.clone(), root.clone(), "image/png".into()).await.unwrap();
        let open_swapped = open_within(lanes(), swapped.clone(), root.clone(), "image/png".into()).await.unwrap();
        assert_eq!(open_gone.read(0, 4).await.unwrap(), b"0123");
        assert_eq!(open_swapped.read(0, 4).await.unwrap(), b"0123");
        std::fs::remove_file(&gone).unwrap();
        std::fs::write(root.join("other.png"), b"another one").unwrap();
        std::fs::rename(root.join("other.png"), &swapped).unwrap();
        assert!(open_gone.read(4, 4).await.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound));
        assert!(open_swapped.read(4, 4).await.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound));
    }

    /// The lane serves only the very file that was authorized: a name replaced by another file, or by a link out of the
    /// project, reaches nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_replaced_file_is_not_served() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.webm"), b"first").unwrap();
        let leases = ProjectFileLeases::new(lanes());
        let id = leases.mint(&root, "a.webm", "video/webm", "phone-1").unwrap();
        let opened = leases.open(&id, "phone-1").await.unwrap();
        assert_eq!(opened.read(0, 2).await.unwrap(), b"fi");
        std::fs::write(root.join("b.webm"), b"swapped in").unwrap();
        std::fs::rename(root.join("b.webm"), root.join("a.webm")).unwrap();
        assert_eq!(opened.read(2, 3).await.unwrap_err().kind(), std::io::ErrorKind::NotFound);
        assert!(leases.open(&id, "phone-1").await.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_open_project_stream_stops_when_its_permission_ends() {
        use std::sync::atomic::AtomicBool;

        let (_dir, root) = project();
        std::fs::write(root.join("a.webm"), b"abcdef").unwrap();
        let leases = ProjectFileLeases::new(lanes());
        let permission = Arc::new(AtomicBool::new(true));
        let check: Authorize = {
            let permission = permission.clone();
            Arc::new(move || {
                let permission = permission.clone();
                Box::pin(async move { permission.load(Ordering::Acquire) })
            })
        };
        let asset = leases.mint_with_authority(&root, "a.webm", "video/webm", "phone-1", Some(check)).unwrap();
        let opened = leases.open(&asset, "phone-1").await.unwrap();
        assert_eq!(opened.read(0, 3).await.unwrap(), b"abc");
        permission.store(false, Ordering::Release);
        assert_eq!(opened.read(3, 3).await.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }

    /// A gallery file is opened again per request within its own folder (`openAuthorizedFile(path, dirname(path))`): a regular file is
    /// served at any offset with its size and type; a missing file and a folder are nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_gallery_file_is_opened_within_its_folder_and_a_missing_one_is_nothing() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.png"), b"0123456789").unwrap();
        let path = root.join("a.png");
        let file = open_within(lanes(), path.clone(), root.clone(), "image/png".into()).await.expect("the file");
        assert_eq!((file.size(), file.mime()), (10, "image/png"));
        assert_eq!(file.read(4, 3).await.unwrap(), b"456");
        assert!(open_within(lanes(), root.join("missing.png"), root.clone(), "image/png".into()).await.is_none());
        assert!(open_within(lanes(), root.clone(), root.clone(), "image/png".into()).await.is_none(), "a folder");
        // A file whose real place is outside `within` is refused.
        let elsewhere = root.join("sub");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert!(open_within(lanes(), path, elsewhere, "image/png".into()).await.is_none());
    }

    /// Node's 256 leases: the oldest goes first; an unpair ends the device's.
    #[test]
    fn the_oldest_lease_goes_past_the_cap_and_an_unpair_ends_the_devices() {
        let (_dir, root) = project();
        std::fs::write(root.join("a.png"), b"x").unwrap();
        let leases = ProjectFileLeases::new(lanes());
        let first = leases.mint(&root, "a.png", "image/png", "phone-1").unwrap();
        for _ in 0..MAX_LEASES {
            leases.mint(&root, "a.png", "image/png", "phone-2").unwrap();
        }
        assert_eq!(leases.len(), MAX_LEASES);
        assert!(leases.leases().iter().all(|(id, _)| *id != first));
        leases.revoke_device("phone-2");
        assert!(leases.is_empty());
    }
}
