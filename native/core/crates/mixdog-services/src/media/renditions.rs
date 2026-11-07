//! The still-image step of the media renditions (`src/runtime/media/renditions.mjs`
//! `ensureRendition` / `generate` for an image): cache lookup, then the webp from the extension
//! host's `sharp` (Node's own `encodeStill`, so the bytes are Node's), then the cache write.
//!
//! The source is read and the cache written on the durability lane. The host answering `None` is
//! Node's `null` (no sharp, or a source that does not decode): there is no rendition. A host that
//! cannot answer is an error, never `None`. Video posters (ffmpeg) are a different step and are
//! not here.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mixdog_core_api::domain::ext::ExtError;
use mixdog_exthost::{ExtImageCodec, RenditionVariant};
use mixdog_protocol::ThreadId;
use mixdog_rt::DurabilityIo;
use tokio::sync::oneshot;

use super::store::write_atomic;
use crate::lane::on_lane;

/// Probe order when reading a cached rendition (`EXTENSION_MIME`).
const EXTENSION_MIME: [(&str, &str); 3] = [(".webp", "image/webp"), (".png", "image/png"), (".jpg", "image/jpeg")];
const VARIANTS: [RenditionVariant; 2] = [RenditionVariant::Thumb, RenditionVariant::Display];
const MAX_CACHED_RENDITION_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_RENDITION_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const PROBE_BYTES: usize = 4096;

/// A rendition on disk: `{ path, mime, bytes }`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Rendition {
    pub path: PathBuf,
    pub mime: &'static str,
    pub bytes: u64,
}

/// Cloneable because one generation answers every caller waiting on it.
#[derive(Debug, Clone, thiserror::Error)]
pub enum RenditionError {
    /// The extension host could not answer.
    #[error("image host: {0:?}")]
    Host(ExtError),
    /// The cache could not be written (and nobody else published the file).
    #[error("rendition cache: {0}")]
    Io(Arc<std::io::Error>),
}

impl From<std::io::Error> for RenditionError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(Arc::new(error))
    }
}

/// `FAILED_RENDITION_COOLDOWN_MS`: how long a rendition that could not be made is not retried.
pub const FAILED_RENDITION_COOLDOWN: Duration = Duration::from_secs(30);
/// `FAILED_RENDITION_CACHE_MAX`.
const FAILED_RENDITION_CACHE_MAX: usize = 256;
/// `createPriorityScheduler(2)`.
const SCHEDULER_LIMIT: usize = 2;

/// Who is asking: a tile the user is looking at, or the warm-up after a generation.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Priority {
    #[default]
    Foreground,
    Background,
}

type Outcome = Result<Option<Rendition>, RenditionError>;

/// A waiter is told "your slot is taken" (the slot is already counted); the waiting side turns that
/// into a [`Permit`], which keeps the queue free of the permits it hands out.
struct SchedulerState {
    active: usize,
    background_active: usize,
    foreground: VecDeque<oneshot::Sender<()>>,
    background: VecDeque<oneshot::Sender<()>>,
}

struct SchedulerInner {
    limit: usize,
    background_limit: usize,
    state: Mutex<SchedulerState>,
}

/// `createPriorityScheduler`: at most `limit` jobs run at once, foreground ahead of background,
/// and background jobs never take the last slot (`limit - 1` of them at most, at least one).
#[derive(Clone)]
pub(crate) struct Scheduler(Arc<SchedulerInner>);

/// A running slot. Dropping it frees the slot and starts the next waiting job.
pub(crate) struct Permit {
    scheduler: Arc<SchedulerInner>,
    background: bool,
}

/// Frees one counted slot and starts the next waiting job.
fn release(scheduler: &Arc<SchedulerInner>, background: bool) {
    {
        let mut state = scheduler.state.lock().unwrap();
        state.active -= 1;
        if background {
            state.background_active -= 1;
        }
    }
    pump(scheduler);
}

impl Drop for Permit {
    fn drop(&mut self) {
        release(&self.scheduler, self.background);
    }
}

/// A place in the queue.
pub(crate) struct Waiting {
    receiver: oneshot::Receiver<()>,
    scheduler: Arc<SchedulerInner>,
    background: bool,
    /// False once the slot became a [`Permit`].
    unclaimed: bool,
}

impl Waiting {
    /// The slot, once one is free.
    pub(crate) async fn permit(mut self) -> Permit {
        // The sender lives in the queue until it is told, so it is never dropped unanswered.
        let _ = (&mut self.receiver).await;
        self.unclaimed = false;
        Permit { scheduler: self.scheduler.clone(), background: self.background }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        if !self.unclaimed {
            return;
        }
        // Gave up: a slot already granted is handed back; one not yet granted is never granted.
        self.receiver.close();
        if self.receiver.try_recv().is_ok() {
            release(&self.scheduler, self.background);
        }
    }
}

fn pump(scheduler: &Arc<SchedulerInner>) {
    loop {
        let (waiter, background) = {
            let mut state = scheduler.state.lock().unwrap();
            if state.active >= scheduler.limit {
                return;
            }
            let (waiter, background) = if let Some(waiter) = state.foreground.pop_front() {
                (waiter, false)
            } else if state.background_active < scheduler.background_limit {
                match state.background.pop_front() {
                    Some(waiter) => (waiter, true),
                    None => return,
                }
            } else {
                return;
            };
            state.active += 1;
            if background {
                state.background_active += 1;
            }
            (waiter, background)
        };
        // A waiter that already gave up never sees its slot: it goes to the next one.
        if waiter.send(()).is_err() {
            let mut state = scheduler.state.lock().unwrap();
            state.active -= 1;
            if background {
                state.background_active -= 1;
            }
        }
    }
}

impl Scheduler {
    pub(crate) fn new(limit: usize) -> Self {
        let limit = limit.max(1);
        Self(Arc::new(SchedulerInner {
            limit,
            background_limit: limit.saturating_sub(1).max(1),
            state: Mutex::new(SchedulerState { active: 0, background_active: 0, foreground: VecDeque::new(), background: VecDeque::new() }),
        }))
    }

    /// Queues for a slot.
    pub(crate) fn enqueue(&self, priority: Priority) -> Waiting {
        let (tx, receiver) = oneshot::channel();
        {
            let mut state = self.0.state.lock().unwrap();
            match priority {
                Priority::Foreground => state.foreground.push_back(tx),
                Priority::Background => state.background.push_back(tx),
            }
        }
        pump(&self.0);
        Waiting { receiver, scheduler: self.0.clone(), background: priority == Priority::Background, unclaimed: true }
    }
}

/// The variant's directory name under the cache (`SPECS` keys).
pub fn variant_name(variant: RenditionVariant) -> &'static str {
    match variant {
        RenditionVariant::Thumb => "thumb",
        RenditionVariant::Display => "display",
    }
}

fn rendition_path(cache_dir: &Path, variant: RenditionVariant, id: &str, extension: &str) -> PathBuf {
    cache_dir.join(variant_name(variant)).join(format!("{id}{extension}"))
}

/// `MIXDOG_RENDITION_CACHE_MAX_BYTES` when it is a number of at least one rendition's cap, else
/// 512 MiB.
pub fn cache_max_bytes() -> u64 {
    let configured = std::env::var("MIXDOG_RENDITION_CACHE_MAX_BYTES").map_or(f64::NAN, |raw| mixdog_js::string_to_number(&raw));
    if configured.is_finite() && configured >= MAX_CACHED_RENDITION_BYTES as f64 { configured.floor() as u64 } else { DEFAULT_RENDITION_CACHE_MAX_BYTES }
}

/// `holdsNoData`: only NUL and white space.
fn holds_no_data(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// `fileHasData`: absent or data-less is false; a file that cannot be read right now still counts.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn file_has_data(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) => return !matches!(e.kind(), std::io::ErrorKind::NotFound) && e.raw_os_error() != Some(20),
    };
    let mut head = [0u8; PROBE_BYTES];
    match file.read(&mut head) {
        Ok(n) => !holds_no_data(&head[..n]),
        Err(_) => true,
    }
}

/// `cachedRendition`: the first of webp, png, jpg that is a file with data. A data-less file a
/// crash left is dropped so the miss rebuilds it.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn cached_rendition(cache_dir: &Path, variant: RenditionVariant, id: &str) -> Option<Rendition> {
    for (extension, mime) in EXTENSION_MIME {
        let path = rendition_path(cache_dir, variant, id, extension);
        let Ok(info) = fs::metadata(&path) else { continue };
        if !info.is_file() {
            continue;
        }
        if !file_has_data(&path) {
            let _ = fs::remove_file(&path);
            continue;
        }
        return Some(Rendition { path, mime, bytes: info.len() });
    }
    None
}

/// `pruneRenditionCache`: evicts the oldest files (then by path) until the tree fits `max_bytes`,
/// sparing `protected`.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn prune_cache(cache_dir: &Path, max_bytes: u64, protected: &Path) {
    let mut rows = Vec::new();
    let mut total: u64 = 0;
    for variant in VARIANTS {
        let dir = cache_dir.join(variant_name(variant));
        let Ok(names) = fs::read_dir(&dir) else { continue };
        for entry in names.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !EXTENSION_MIME.iter().any(|(extension, _)| name.ends_with(extension)) {
                continue;
            }
            let path = dir.join(&name);
            let Ok(stat) = fs::metadata(&path) else { continue };
            if !stat.is_file() {
                continue;
            }
            rows.push((path, stat.len(), stat.modified().ok()));
            total += stat.len();
        }
    }
    rows.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| mixdog_js::locale_compare(&a.0.to_string_lossy(), &b.0.to_string_lossy())));
    for (path, bytes, _) in rows {
        if total <= max_bytes {
            break;
        }
        if path == protected {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total -= bytes;
        }
    }
}

/// `writeRendition`: nothing for an empty or over-cap buffer; otherwise published whole (stage,
/// then rename), then the cache pruned around it. A failed write is forgiven when the file exists
/// (another writer won the same publication).
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn write_rendition(cache_dir: &Path, variant: RenditionVariant, id: &str, extension: &str, bytes: &[u8]) -> std::io::Result<Option<Rendition>> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_CACHED_RENDITION_BYTES {
        return Ok(None);
    }
    let Some((_, mime)) = EXTENSION_MIME.iter().find(|(known, _)| *known == extension) else { return Ok(None) };
    let path = rendition_path(cache_dir, variant, id, extension);
    if let Err(error) = write_atomic(&path, bytes, false) {
        if !path.exists() {
            return Err(error);
        }
    }
    let size = fs::metadata(&path).map_or(bytes.len() as u64, |m| m.len());
    prune_cache(cache_dir, cache_max_bytes(), &path);
    Ok(Some(Rendition { path, mime, bytes: size }))
}

/// `removeRenditions`: every cached rendition of one asset, in every variant and format.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn remove_renditions(cache_dir: &Path, id: &str) {
    for variant in VARIANTS {
        for (extension, _) in EXTENSION_MIME {
            let _ = fs::remove_file(rendition_path(cache_dir, variant, id, extension));
        }
    }
}

/// One `ensureRendition` call.
pub struct Request {
    pub thread: ThreadId,
    pub id: String,
    /// A video's poster is ffmpeg's, not this step's: only a cached one is served.
    pub video: bool,
    pub source: PathBuf,
    pub variant: RenditionVariant,
    pub priority: Priority,
    /// `false` serves the cache only.
    pub generate: bool,
}

#[derive(Default)]
struct State {
    /// Two tiles asking for the same missing rendition share one generation.
    inflight: HashMap<String, Vec<oneshot::Sender<Outcome>>>,
    /// `failedUntil`, oldest first.
    failed: VecDeque<(String, Instant)>,
}

impl State {
    fn prune_failed(&mut self, now: Instant) {
        self.failed.retain(|(_, expires)| *expires > now);
        while self.failed.len() > FAILED_RENDITION_CACHE_MAX {
            self.failed.pop_front();
        }
    }

    fn forget(&mut self, key: &str) {
        self.failed.retain(|(known, _)| known != key);
    }

    fn remember(&mut self, key: String, cooldown: Duration, now: Instant) {
        self.forget(&key);
        self.failed.push_back((key, now + cooldown));
        self.prune_failed(now);
    }
}

struct Inner {
    codec: Arc<ExtImageCodec>,
    lane: DurabilityIo,
    cache_dir: PathBuf,
    cooldown: Duration,
    scheduler: Scheduler,
    state: Mutex<State>,
}

/// Still renditions of the media store, built by the extension host's `sharp`.
#[derive(Clone)]
pub struct StillRenditions(Arc<Inner>);

impl StillRenditions {
    /// `cache_dir` is the store's `renditions` directory.
    pub fn new(codec: Arc<ExtImageCodec>, lane: DurabilityIo, cache_dir: PathBuf) -> Self {
        Self::with_cooldown(codec, lane, cache_dir, FAILED_RENDITION_COOLDOWN)
    }

    pub fn with_cooldown(codec: Arc<ExtImageCodec>, lane: DurabilityIo, cache_dir: PathBuf, cooldown: Duration) -> Self {
        Self(Arc::new(Inner { codec, lane, cache_dir, cooldown, scheduler: Scheduler::new(SCHEDULER_LIMIT), state: Mutex::default() }))
    }

    /// [`ensure_request`](Self::ensure_request) for a foreground still.
    pub async fn ensure(&self, thread: &ThreadId, id: &str, source: PathBuf, variant: RenditionVariant, generate: bool) -> Outcome {
        self.ensure_request(Request { thread: thread.clone(), id: id.to_owned(), video: false, source, variant, priority: Priority::Foreground, generate }).await
    }

    /// `ensureRendition`: the cached rendition, else (when `generate`, and not within the cooldown
    /// of a failure) the host's webp of the source, cached. Callers asking for the same variant
    /// and asset while it is made share the one generation. `Ok(None)` is Node's `null`.
    pub async fn ensure_request(&self, request: Request) -> Outcome {
        let inner = &self.0;
        let (cache_dir, id, variant) = (inner.cache_dir.clone(), request.id.clone(), request.variant);
        if let Some(cached) = on_lane(inner.lane, move || cached_rendition(&cache_dir, variant, &id)).await? {
            return Ok(Some(cached));
        }
        if !request.generate {
            return Ok(None);
        }
        let key = format!("{}:{}", variant_name(variant), request.id);
        let receiver = {
            let mut state = inner.state.lock().unwrap();
            let now = Instant::now();
            state.prune_failed(now);
            if state.failed.iter().any(|(known, expires)| *known == key && *expires > now) {
                return Ok(None);
            }
            let (tx, rx) = oneshot::channel();
            if let Some(waiters) = state.inflight.get_mut(&key) {
                waiters.push(tx);
            } else {
                state.inflight.insert(key.clone(), vec![tx]);
                tokio::spawn(generate_shared(inner.clone(), key, request));
            }
            rx
        };
        receiver.await.unwrap_or_else(|_| Err(std::io::Error::other("rendition task ended").into()))
    }

    /// `cacheRendition`: stores a browser-made thumbnail so a codec miss is paid once. `None` for
    /// a mime this cache does not hold, or a buffer that is empty or over the cap.
    pub async fn cache(&self, id: &str, variant: RenditionVariant, mime: &str, bytes: Vec<u8>) -> Result<Option<Rendition>, RenditionError> {
        let Some(extension) = self.0.admit_cached(id, variant, mime, bytes.len()).map(str::to_owned) else { return Ok(None) };
        let (cache_dir, id) = (self.0.cache_dir.clone(), id.to_owned());
        Ok(on_lane(self.0.lane, move || write_rendition(&cache_dir, variant, &id, &extension, &bytes)).await??)
    }
}

impl Inner {
    /// The extension a browser-made thumbnail of this type and size is cached under; a cached one
    /// also ends the cooldown of its rendition.
    fn admit_cached(&self, id: &str, variant: RenditionVariant, mime: &str, len: usize) -> Option<&'static str> {
        let extension = EXTENSION_MIME.iter().find(|(_, known)| *known == mime).map(|(extension, _)| *extension)?;
        if len == 0 || len as u64 > MAX_CACHED_RENDITION_BYTES {
            return None;
        }
        self.state.lock().unwrap().forget(&format!("{}:{id}", variant_name(variant)));
        Some(extension)
    }
}

/// The generation of one key, run under the scheduler; its answer goes to every waiter. A failure
/// of the asset (no rendition, or the cache write) starts the cooldown; a host that could not
/// answer says nothing about the asset, so it does not.
async fn generate_shared(inner: Arc<Inner>, key: String, request: Request) {
    let permit = inner.scheduler.enqueue(request.priority).permit().await;
    let outcome = generate(&inner, &request).await;
    drop(permit);
    let waiters = {
        let mut state = inner.state.lock().unwrap();
        match &outcome {
            Ok(Some(_)) => state.forget(&key),
            Err(RenditionError::Host(_)) => {}
            _ => state.remember(key.clone(), inner.cooldown, Instant::now()),
        }
        state.inflight.remove(&key).unwrap_or_default()
    };
    for waiter in waiters {
        drop(waiter.send(outcome.clone()));
    }
}

async fn generate(inner: &Inner, request: &Request) -> Outcome {
    if request.video {
        return Ok(None);
    }
    let variant = request.variant;
    let source = request.source.clone();
    // A source `sharp` cannot open is "not a decodable image" to Node: no rendition.
    let Ok(bytes) = on_lane(inner.lane, move || read_source(&source)).await? else { return Ok(None) };
    let Some(still) = inner.codec.still_rendition(&request.thread, &bytes, variant).await.map_err(RenditionError::Host)? else { return Ok(None) };
    let (cache_dir, id) = (inner.cache_dir.clone(), request.id.clone());
    Ok(on_lane(inner.lane, move || write_rendition(&cache_dir, variant, &id, &still.extension, &still.bytes)).await??)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_source(path: &Path) -> std::io::Result<Vec<u8>> {
    fs::read(path)
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::{ExtCall, ExtFrame, ExtPool, ExtWorkerId, ExtWorkerStatus};
    use serde_json::{Value, json};

    use super::*;

    struct One(Option<ExtFrame>, Duration);

    #[async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            tokio::time::sleep(self.1).await;
            self.0.take()
        }
    }

    /// A host that answers every call with `answer` and keeps the calls it was asked.
    pub(in crate::media) struct Host {
        answer: Result<Value, ExtError>,
        pub(in crate::media) calls: Mutex<Vec<ExtCall>>,
        delay: Duration,
    }

    /// A host answering every call with `answer` after `delay`.
    pub(in crate::media) fn scripted(answer: Result<Value, ExtError>, delay: Duration) -> Arc<Host> {
        Arc::new(Host { answer, calls: Mutex::new(Vec::new()), delay })
    }

    impl ExtPool for Host {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            self.calls.lock().unwrap().push(call);
            Ok(Box::new(One(Some(ExtFrame::Done(self.answer.clone())), self.delay)))
        }
        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }
        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Err(ExtError::UnknownWorker)
        }
    }

    fn rig(answer: Result<Value, ExtError>) -> (tempfile::TempDir, Arc<Host>, StillRenditions, PathBuf) {
        rig_with(answer, Duration::ZERO, FAILED_RENDITION_COOLDOWN)
    }

    fn rig_with(answer: Result<Value, ExtError>, delay: Duration, cooldown: Duration) -> (tempfile::TempDir, Arc<Host>, StillRenditions, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(Host { answer, calls: Mutex::new(Vec::new()), delay });
        let source = dir.path().join("a.png");
        std::fs::write(&source, b"source bytes").unwrap();
        let renditions = StillRenditions::with_cooldown(Arc::new(ExtImageCodec::new(host.clone())), mixdog_rt::testing::tokens().durability_io, dir.path().join("renditions"), cooldown);
        (dir, host, renditions, source)
    }

    pub(in crate::media) fn webp(data: &str) -> Result<Value, ExtError> {
        Ok(json!({"ok": {"extension": ".webp", "data": data}}))
    }

    #[tokio::test]
    async fn the_hosts_webp_is_cached_under_the_variant_and_served_from_the_cache_next_time() {
        let (dir, host, renditions, source) = rig(webp("AQID"));
        let thread = ThreadId::from("t");
        let made = renditions.ensure(&thread, "id-1", source.clone(), RenditionVariant::Thumb, true).await.unwrap().unwrap();
        assert_eq!(made.path, dir.path().join("renditions").join("thumb").join("id-1.webp"));
        assert_eq!((made.mime, made.bytes), ("image/webp", 3));
        assert_eq!(std::fs::read(&made.path).unwrap(), [1, 2, 3]);
        // The host was given the source file's bytes and the variant.
        let call = host.calls.lock().unwrap()[0].clone();
        assert_eq!((call.method.as_str(), call.params["variant"].as_str(), call.params["data"].as_str()), ("image.still", Some("thumb"), Some("c291cmNlIGJ5dGVz")));
        // The second ask is a cache hit: the host is not asked again, even with `generate` off.
        let again = renditions.ensure(&thread, "id-1", source, RenditionVariant::Thumb, false).await.unwrap();
        assert_eq!(again, Some(made));
        assert_eq!(host.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn no_rendition_is_none_and_a_host_failure_is_an_error() {
        let thread = ThreadId::from("t");
        // Node's `null` (no sharp, or an undecodable source): no rendition and nothing cached.
        for answer in [Ok(json!({"ok": null})), Ok(json!({"error": "invalid"})), Ok(json!({"error": "environment"}))] {
            let (dir, _, renditions, source) = rig(answer);
            assert_eq!(renditions.ensure(&thread, "id", source, RenditionVariant::Display, true).await.unwrap(), None);
            assert!(!dir.path().join("renditions").exists());
        }
        // Not generating, with nothing cached, never asks the host.
        let (_dir, host, renditions, source) = rig(webp("AQID"));
        assert_eq!(renditions.ensure(&thread, "id", source, RenditionVariant::Thumb, false).await.unwrap(), None);
        assert!(host.calls.lock().unwrap().is_empty());
        // A source that cannot be read is not a decodable image: no rendition, host not asked.
        assert_eq!(renditions.ensure(&thread, "id", PathBuf::from("missing.png"), RenditionVariant::Thumb, true).await.unwrap(), None);
        assert!(host.calls.lock().unwrap().is_empty());
        // A host that cannot answer is surfaced, not turned into `None`.
        let (_dir, _, renditions, source) = rig(Err(ExtError::Overloaded));
        let error = renditions.ensure(&thread, "id", source, RenditionVariant::Thumb, true).await.unwrap_err();
        assert!(matches!(error, RenditionError::Host(ExtError::Overloaded)), "{error:?}");
    }

    #[test]
    fn writing_follows_nodes_caps_and_pruning_keeps_the_newest_and_the_protected_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        // Empty and over-cap buffers are not rendered.
        assert_eq!(write_rendition(cache, RenditionVariant::Thumb, "e", ".webp", &[]).unwrap(), None);
        let too_big = vec![1u8; MAX_CACHED_RENDITION_BYTES as usize + 1];
        assert_eq!(write_rendition(cache, RenditionVariant::Thumb, "big", ".webp", &too_big).unwrap(), None);
        assert!(!cache.join("thumb").join("big.webp").exists());
        // Oldest first, until the tree fits; the protected file is spared.
        for (name, mtime) in [("old", 1_000_000_000u64), ("mid", 1_100_000_000), ("new", 1_200_000_000)] {
            let path = cache.join("thumb").join(format!("{name}.webp"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, [7u8; 10]).unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime)).unwrap();
        }
        prune_cache(cache, 15, &cache.join("thumb").join("old.webp"));
        let left: Vec<bool> = ["old", "mid", "new"].iter().map(|n| cache.join("thumb").join(format!("{n}.webp")).exists()).collect();
        assert_eq!(left, [true, false, false], "evicts mid then new (oldest unprotected first) until it fits");
        // A rendition a crash left NUL-filled is dropped, and the miss is a miss.
        std::fs::write(cache.join("thumb").join("nul.webp"), [0u8; 64]).unwrap();
        assert_eq!(cached_rendition(cache, RenditionVariant::Thumb, "nul"), None);
        assert!(!cache.join("thumb").join("nul.webp").exists());
    }

    fn aged(path: &Path, seconds: u64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, [7u8; 10]).unwrap();
        std::fs::File::options().write(true).open(path).unwrap().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds)).unwrap();
    }

    #[test]
    fn pruning_counts_both_variants_and_evicts_the_oldest_across_them() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let files = [("thumb", "t1.webp", 1), ("display", "d2.webp", 2), ("thumb", "t3.png", 3), ("display", "d4.jpg", 4)];
        for (variant, name, age) in files {
            aged(&cache.join(variant).join(name), age);
        }
        // A file that is no rendition format is neither counted nor evicted.
        aged(&cache.join("thumb").join("notes.txt"), 0);
        prune_cache(cache, 25, Path::new(""));
        let left: Vec<bool> = files.iter().map(|(variant, name, _)| cache.join(variant).join(name).exists()).collect();
        assert_eq!(left, [false, false, true, true], "40 bytes over a 25 byte budget: the two oldest go, one from each variant");
        assert!(cache.join("thumb").join("notes.txt").exists());
        // Within the budget nothing is evicted.
        prune_cache(cache, 20, Path::new(""));
        assert!(cache.join("thumb").join("t3.png").exists() && cache.join("display").join("d4.jpg").exists());
    }

    #[test]
    fn removing_an_assets_renditions_takes_every_variant_and_format_and_only_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path();
        let mine = [("thumb", "a.webp"), ("thumb", "a.png"), ("display", "a.jpg"), ("display", "a.webp")];
        let others = [("thumb", "b.webp"), ("display", "ab.webp"), ("thumb", "a.webp.bak")];
        for (variant, name) in mine.iter().chain(&others) {
            aged(&cache.join(variant).join(name), 1);
        }
        remove_renditions(cache, "a");
        assert!(mine.iter().all(|(variant, name)| !cache.join(variant).join(name).exists()));
        assert!(others.iter().all(|(variant, name)| cache.join(variant).join(name).exists()));
        remove_renditions(cache, "never-existed");
    }

    #[tokio::test]
    async fn callers_asking_for_the_same_rendition_share_one_generation() {
        let (_dir, host, renditions, source) = rig_with(webp("AQID"), Duration::from_millis(80), FAILED_RENDITION_COOLDOWN);
        let thread = ThreadId::from("t");
        let asks = (0..4).map(|_| renditions.ensure(&thread, "same", source.clone(), RenditionVariant::Thumb, true));
        let answers = futures::future::join_all(asks).await;
        assert_eq!(host.calls.lock().unwrap().len(), 1, "one host call for four callers");
        let first = answers[0].as_ref().unwrap().clone().unwrap();
        assert!(answers.iter().all(|a| a.as_ref().unwrap().as_ref() == Some(&first)));
        // Another variant of the same asset is its own generation.
        renditions.ensure(&thread, "same", source, RenditionVariant::Display, true).await.unwrap().unwrap();
        assert_eq!(host.calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_rendition_that_could_not_be_made_is_not_retried_until_the_cooldown_ends() {
        assert_eq!(FAILED_RENDITION_COOLDOWN, Duration::from_secs(30));
        let (_dir, host, renditions, source) = rig_with(Ok(json!({"ok": null})), Duration::ZERO, Duration::from_millis(300));
        let thread = ThreadId::from("t");
        let ask = |variant| renditions.ensure(&thread, "id", source.clone(), variant, true);
        assert_eq!(ask(RenditionVariant::Thumb).await.unwrap(), None);
        assert_eq!(ask(RenditionVariant::Thumb).await.unwrap(), None);
        assert_eq!(host.calls.lock().unwrap().len(), 1, "the second ask is turned away without the host");
        // The cooldown is per variant.
        assert_eq!(ask(RenditionVariant::Display).await.unwrap(), None);
        assert_eq!(host.calls.lock().unwrap().len(), 2);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(ask(RenditionVariant::Thumb).await.unwrap(), None);
        assert_eq!(host.calls.lock().unwrap().len(), 3, "asked again once the cooldown has ended");
    }

    #[tokio::test]
    async fn a_host_that_cannot_answer_does_not_start_a_cooldown() {
        let (_dir, host, renditions, source) = rig_with(Err(ExtError::Overloaded), Duration::ZERO, Duration::from_secs(30));
        let thread = ThreadId::from("t");
        for _ in 0..2 {
            assert!(renditions.ensure(&thread, "id", source.clone(), RenditionVariant::Thumb, true).await.is_err());
        }
        assert_eq!(host.calls.lock().unwrap().len(), 2, "an outage says nothing about the asset");
    }

    #[tokio::test]
    async fn a_thumbnail_cached_from_the_browser_is_kept_and_ends_the_cooldown() {
        let (dir, host, renditions, source) = rig_with(Ok(json!({"ok": null})), Duration::ZERO, Duration::from_secs(30));
        let thread = ThreadId::from("t");
        assert_eq!(renditions.ensure(&thread, "id", source.clone(), RenditionVariant::Thumb, true).await.unwrap(), None);
        // Types and sizes the cache does not hold are refused.
        for (mime, bytes) in [("image/gif", vec![1u8; 5]), ("image/png", Vec::new()), ("image/png", vec![1u8; MAX_CACHED_RENDITION_BYTES as usize + 1])] {
            assert_eq!(renditions.cache("id", RenditionVariant::Thumb, mime, bytes).await.unwrap(), None, "{mime}");
        }
        let kept = renditions.cache("id", RenditionVariant::Thumb, "image/png", vec![1u8; 5]).await.unwrap().unwrap();
        assert_eq!((kept.path.clone(), kept.mime, kept.bytes), (dir.path().join("renditions").join("thumb").join("id.png"), "image/png", 5));
        assert_eq!(renditions.ensure(&thread, "id", source.clone(), RenditionVariant::Thumb, false).await.unwrap(), Some(kept.clone()));
        // The failure was forgotten: with the file gone the host is asked again at once.
        std::fs::remove_file(&kept.path).unwrap();
        renditions.ensure(&thread, "id", source, RenditionVariant::Thumb, true).await.unwrap();
        assert_eq!(host.calls.lock().unwrap().len(), 2);
    }

    async fn settled<T>(handle: &tokio::task::JoinHandle<T>) -> bool {
        tokio::time::sleep(Duration::from_millis(40)).await;
        handle.is_finished()
    }

    #[tokio::test(start_paused = true)]
    async fn the_scheduler_runs_two_at_once_foreground_first_and_keeps_the_last_slot_from_background() {
        let scheduler = Scheduler::new(2);
        let take = |priority| tokio::spawn(scheduler.enqueue(priority).permit());
        let background_a = take(Priority::Background);
        assert!(settled(&background_a).await);
        // One background job at a time, though a slot is free.
        let background_b = take(Priority::Background);
        assert!(!settled(&background_b).await);
        let foreground_c = take(Priority::Foreground);
        assert!(settled(&foreground_c).await);
        // Full now; a foreground job queued after the background one still goes first.
        let foreground_d = take(Priority::Foreground);
        assert!(!settled(&foreground_d).await);
        drop(background_a.await.unwrap());
        assert!(settled(&foreground_d).await, "foreground before background");
        assert!(!settled(&background_b).await);
        drop(foreground_c.await.unwrap());
        assert!(settled(&background_b).await, "the background job takes the slot the foreground left");
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiter_that_gives_up_loses_its_place_and_holds_no_slot() {
        let scheduler = Scheduler::new(2);
        let first = scheduler.enqueue(Priority::Foreground).permit().await;
        let second = scheduler.enqueue(Priority::Foreground).permit().await;
        let abandoned = scheduler.enqueue(Priority::Foreground);
        let next = tokio::spawn(scheduler.enqueue(Priority::Foreground).permit());
        drop(abandoned);
        drop(first);
        assert!(settled(&next).await, "the slot went past the abandoned place");
        drop(second);
        drop(next.await.unwrap());
        let state = scheduler.0.state.lock().unwrap();
        assert_eq!((state.active, state.background_active), (0, 0));
    }

    fn within<T>(future: impl std::future::Future<Output = T>) -> impl std::future::Future<Output = T> {
        future
    }

    fn sha_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The real sharp worker: the cached bytes are Node's `encodeStill` (the expected sizes and
    /// hashes are the ones the host's own test records for this 64x48 gradient).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_real_sharp_host_makes_nodes_webp_for_both_variants() {
        use mixdog_exthost::{ExtHostConfig, ExtHostPool, RenderBrowserConfig};
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
        let pool = Arc::new(
            ExtHostPool::new(ExtHostConfig {
                program: "node".into(),
                args: vec![root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
                electron: false,
                workers: 1,
                pending_cap: 64,
                spawn_io: mixdog_rt::testing::tokens().spawn_io,
                render_browser: RenderBrowserConfig { command: None, profile_root: std::env::temp_dir().join("mixdog-exthost-tests"), no_sandbox: false },
            })
            .unwrap(),
        );
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("gradient.jpg");
        std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-exthost/tests/fixtures/image/gradient.jpg"), &source).unwrap();
        let junk = dir.path().join("junk.png");
        std::fs::write(&junk, b"not an image at all").unwrap();
        let renditions = StillRenditions::new(Arc::new(ExtImageCodec::new(pool.clone())), mixdog_rt::testing::tokens().durability_io, dir.path().join("renditions"));
        let thread = ThreadId::from("t");

        for (variant, id, len, sha) in [
            (RenditionVariant::Thumb, "thumb-id", 222, "d380e48dd72a6df4e76e627f9f998b2ddf48422be3cf8ad3ddf15b3ae007f1c6"),
            (RenditionVariant::Display, "display-id", 258, "3b548906e0a790213c3f51289a9a30cf03a40c2388feb69e656356333206e1ed"),
        ] {
            let made = within(renditions.ensure(&thread, id, source.clone(), variant, true)).await.unwrap().unwrap();
            assert_eq!((made.mime, made.bytes), ("image/webp", len), "{id}");
            assert_eq!(made.path, dir.path().join("renditions").join(variant_name(variant)).join(format!("{id}.webp")));
            assert_eq!(sha_hex(&std::fs::read(&made.path).unwrap()), sha, "{id}");
            // The cache answers the second ask; it is the same file.
            assert_eq!(within(renditions.ensure(&thread, id, source.clone(), variant, false)).await.unwrap(), Some(made));
        }
        // A source no decoder takes is Node's null: no rendition and nothing cached.
        assert_eq!(within(renditions.ensure(&thread, "junk-id", junk, RenditionVariant::Thumb, true)).await.unwrap(), None);
        assert!(!dir.path().join("renditions").join("thumb").join("junk-id.webp").exists());
        within(pool.close()).await;
        // A host that is gone is an error, never "no rendition".
        let gone = within(renditions.ensure(&thread, "late", source, RenditionVariant::Thumb, true)).await;
        assert!(matches!(gone, Err(RenditionError::Host(_))), "{gone:?}");
    }
}
