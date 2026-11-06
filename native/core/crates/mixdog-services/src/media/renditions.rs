//! The still-image step of the media renditions (`src/runtime/media/renditions.mjs`
//! `ensureRendition` / `generate` for an image): cache lookup, then the webp from the extension
//! host's `sharp` (Node's own `encodeStill`, so the bytes are Node's), then the cache write.
//!
//! The source is read and the cache written on the durability lane. The host answering `None` is
//! Node's `null` (no sharp, or a source that does not decode): there is no rendition. A host that
//! cannot answer is an error, never `None`. Video posters (ffmpeg) are a different step and are
//! not here.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_core_api::domain::ext::ExtError;
use mixdog_exthost::{ExtImageCodec, RenditionVariant};
use mixdog_protocol::ThreadId;
use mixdog_rt::DurabilityIo;

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

#[derive(Debug, thiserror::Error)]
pub enum RenditionError {
    /// The extension host could not answer.
    #[error("image host: {0:?}")]
    Host(ExtError),
    /// The cache could not be written (and nobody else published the file).
    #[error("rendition cache: {0}")]
    Io(#[from] std::io::Error),
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

/// Still renditions of the media store, built by the extension host's `sharp`.
pub struct StillRenditions {
    codec: Arc<ExtImageCodec>,
    lane: DurabilityIo,
    cache_dir: PathBuf,
}

impl StillRenditions {
    /// `cache_dir` is the store's `renditions` directory.
    pub fn new(codec: Arc<ExtImageCodec>, lane: DurabilityIo, cache_dir: PathBuf) -> Self {
        Self { codec, lane, cache_dir }
    }

    /// `ensureRendition` for an image: the cached rendition, else (when `generate`) the host's
    /// webp of `source`, cached. `Ok(None)` is Node's `null`: nothing cached and none made.
    pub async fn ensure(&self, thread: &ThreadId, id: &str, source: PathBuf, variant: RenditionVariant, generate: bool) -> Result<Option<Rendition>, RenditionError> {
        let (cache_dir, owned_id) = (self.cache_dir.clone(), id.to_owned());
        if let Some(cached) = on_lane(self.lane, move || cached_rendition(&cache_dir, variant, &owned_id)).await? {
            return Ok(Some(cached));
        }
        if !generate {
            return Ok(None);
        }
        // A source `sharp` cannot open is "not a decodable image" to Node: no rendition.
        let Ok(bytes) = on_lane(self.lane, move || read_source(&source)).await? else { return Ok(None) };
        let Some(still) = self.codec.still_rendition(thread, &bytes, variant).await.map_err(RenditionError::Host)? else { return Ok(None) };
        let (cache_dir, owned_id) = (self.cache_dir.clone(), id.to_owned());
        Ok(on_lane(self.lane, move || write_rendition(&cache_dir, variant, &owned_id, &still.extension, &still.bytes)).await??)
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_source(path: &Path) -> std::io::Result<Vec<u8>> {
    fs::read(path)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::{ExtCall, ExtFrame, ExtPool, ExtWorkerId, ExtWorkerStatus};
    use serde_json::{Value, json};

    use super::*;

    struct One(Option<ExtFrame>);

    #[async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    /// A host that answers every call with `answer` and keeps the calls it was asked.
    struct Host {
        answer: Result<Value, ExtError>,
        calls: Mutex<Vec<ExtCall>>,
    }

    impl ExtPool for Host {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            self.calls.lock().unwrap().push(call);
            Ok(Box::new(One(Some(ExtFrame::Done(self.answer.clone())))))
        }
        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }
        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Err(ExtError::UnknownWorker)
        }
    }

    fn rig(answer: Result<Value, ExtError>) -> (tempfile::TempDir, Arc<Host>, StillRenditions, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(Host { answer, calls: Mutex::new(Vec::new()) });
        let source = dir.path().join("a.png");
        std::fs::write(&source, b"source bytes").unwrap();
        let renditions = StillRenditions::new(Arc::new(ExtImageCodec::new(host.clone())), mixdog_rt::testing::tokens().durability_io, dir.path().join("renditions"));
        (dir, host, renditions, source)
    }

    fn webp(data: &str) -> Result<Value, ExtError> {
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
}
