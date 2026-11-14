#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! "Download to this PC": a stepwise, cancellable copy of one server file into this PC's download folder
//! (`createServerDownloads` of the desktop's server-file-access.ts). Each step moves one ranged read, so the
//! caller owns progress and cancel. The server is untrusted: every size, offset and byte count it returns is
//! checked here before anything is decoded, allocated or written because of it. Only a file fetched here may
//! later be opened ([`ServerDownloads::was_downloaded`]).

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::alphabet;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use crate::error::WsError;
use crate::error::WsResult;
use crate::lanes;
use crate::lanes::Lanes;

/// Raw bytes per ranged read (the daemon's own ceiling).
const SERVER_READ_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// A download nobody steps for this long is discarded with its part file.
pub const SERVER_DOWNLOAD_IDLE: Duration = Duration::from_secs(120);
/// Largest download (`SERVER_DOWNLOAD_MAX_BYTES` of shared/server-files).
pub const SERVER_DOWNLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// The server's side of a window: its answers are the raw, unchecked JSON of `statProjectFileIn` and `serverFileReadRange`.
#[async_trait]
pub trait RemoteFileReader: Send + Sync {
    async fn stat(&self, root: &str, rel: &str) -> WsResult<serde_json::Value>;
    async fn read_range(&self, root: &str, rel: &str, offset: u64, length: u64) -> WsResult<serde_json::Value>;
}

// ── Server answers ──────────────────────────────────────────────────────────

fn bad(what: impl std::fmt::Display) -> WsError {
    WsError::plain(format!("The server sent an invalid response: {what}."))
}

/// `String(value).slice(0, 32)` of what the server sent.
fn shown(value: Option<&serde_json::Value>) -> String {
    let text = match value {
        None => "undefined".to_owned(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    text.chars().take(32).collect()
}

fn server_record<'a>(value: &'a serde_json::Value, what: &str) -> WsResult<&'a serde_json::Map<String, serde_json::Value>> {
    value.as_object().ok_or_else(|| bad(format!("no {what}")))
}

/// A JSON number that is a safe integer (`Number.isSafeInteger`: 5.0 is one).
fn safe_integer(value: Option<&serde_json::Value>) -> Option<u64> {
    let serde_json::Value::Number(number) = value? else { return None };
    if let Some(n) = number.as_u64() {
        return (n <= MAX_SAFE).then_some(n);
    }
    let f = number.as_f64()?;
    (f >= 0.0 && f.fract() == 0.0 && f <= MAX_SAFE as f64).then_some(f as u64)
}

/// A server-supplied integer within [min, max].
fn server_integer(value: Option<&serde_json::Value>, what: &str, min: u64, max: u64) -> WsResult<u64> {
    match safe_integer(value) {
        Some(n) if n >= min && n <= max => Ok(n),
        _ => Err(bad(format!("{what} {} is not an integer from {min} to {max}", shown(value)))),
    }
}

fn server_timestamp(value: Option<&serde_json::Value>) -> WsResult<f64> {
    match value.and_then(serde_json::Value::as_f64) {
        Some(t) if t.is_finite() && t >= 0.0 => Ok(t),
        _ => Err(bad("the file time is not a valid timestamp")),
    }
}

/// Node's lenient `Buffer.from(_, 'base64')` accepts a last symbol with stray low bits.
fn lenient_base64() -> GeneralPurpose {
    GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true))
}

/// `/^[A-Za-z0-9+/]*={0,2}$/` with a length divisible by 4.
fn base64_shaped(text: &str) -> bool {
    if text.len() % 4 != 0 {
        return false;
    }
    let body = text.trim_end_matches('=');
    text.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// A read's base64 bytes, decoded only after their length proves they hold at most the `requested` bytes.
fn server_chunk_bytes(value: Option<&serde_json::Value>, requested: u64) -> WsResult<Bytes> {
    let Some(text) = value.and_then(serde_json::Value::as_str).filter(|t| base64_shaped(t)) else {
        return Err(bad("the chunk data is not base64"));
    };
    let too_long = || bad(format!("a chunk longer than the {requested} bytes requested"));
    if text.len() as u64 > requested.div_ceil(3) * 4 {
        return Err(too_long());
    }
    let bytes = lenient_base64().decode(text).map_err(|_| bad("the chunk data is not base64"))?;
    if bytes.len() as u64 > requested {
        return Err(too_long());
    }
    Ok(Bytes::from(bytes))
}

/// The stat a download is sized by: (size, mtimeMs).
pub fn server_file_stat(value: &serde_json::Value) -> WsResult<(u64, f64)> {
    let info = server_record(value, "file information")?;
    Ok((server_integer(info.get("size"), "the file size", 0, MAX_SAFE)?, server_timestamp(info.get("mtimeMs"))?))
}

/// One ranged read of `requested` bytes at `offset`: (bytes, size, mtimeMs).
pub fn server_read_range(value: &serde_json::Value, offset: u64, requested: u64) -> WsResult<(Bytes, u64, f64)> {
    let chunk = server_record(value, "file chunk")?;
    if safe_integer(chunk.get("offset")) != Some(offset) {
        return Err(bad(format!("a chunk for offset {}, not {offset}", shown(chunk.get("offset")))));
    }
    let (size, mtime) = server_file_stat(value)?;
    Ok((server_chunk_bytes(chunk.get("data"), requested)?, size, mtime))
}

// ── Local names ─────────────────────────────────────────────────────────────

/// JS `\s`.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn trim_end_space_dots(text: &str) -> &str {
    text.trim_end_matches(|c: char| js_space(c) || c == '.')
}

/// A plain file name this PC's filesystem accepts: no separators, no traversal, no Windows device names.
pub fn local_download_name(name: &str) -> String {
    let mut replaced = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if c <= '\u{1f}' || "<>:\"/\\|?*".contains(c) {
            if !in_run {
                replaced.push('_');
            }
            in_run = true;
        } else {
            replaced.push(c);
            in_run = false;
        }
    }
    let trimmed = trim_end_space_dots(&replaced).trim_start_matches('.');
    // `.slice(0, 200)` counts UTF-16 code units.
    let mut units = 0;
    let mut cut = String::new();
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > 200 {
            break;
        }
        cut.push(c);
    }
    let clean = trim_end_space_dots(&cut);
    if clean.is_empty() {
        return "download".to_owned();
    }
    let lower = clean.to_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            let mut chars = rest.chars();
            matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'))
        })
    };
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt");
    if reserved { format!("_{clean}") } else { clean.to_owned() }
}

/// `posix.basename`.
fn posix_basename(rel: &str) -> &str {
    rel.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

// ── The machine ─────────────────────────────────────────────────────────────

pub struct Begun {
    pub download_id: String,
    pub name: String,
    pub size: u64,
}

pub struct Stepped {
    pub received: u64,
    pub size: u64,
    pub done: bool,
}

struct Download {
    reader: Arc<dyn RemoteFileReader>,
    root: String,
    rel: String,
    name: String,
    size: u64,
    mtime_ms: f64,
    received: u64,
    dir: PathBuf,
    temp: PathBuf,
    file: Arc<File>,
    busy: bool,
    /// Bumped each time the idle timer is re-armed; a timer that wakes to another value is stale.
    armed: u64,
}

pub struct ServerDownloads {
    me: Weak<ServerDownloads>,
    max_bytes: u64,
    idle: Duration,
    lanes: Lanes,
    downloads: Mutex<HashMap<String, Download>>,
    finished: Mutex<HashSet<PathBuf>>,
}

#[cfg(unix)]
fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let n = std::os::unix::fs::FileExt::write_at(file, bytes, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        bytes = &bytes[n..];
        offset += n as u64;
    }
    Ok(())
}

#[cfg(windows)]
fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !bytes.is_empty() {
        let n = std::os::windows::fs::FileExt::seek_write(file, bytes, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        bytes = &bytes[n..];
        offset += n as u64;
    }
    Ok(())
}

fn gone() -> WsError {
    WsError::plain("The download is gone: it was cancelled or sat idle too long.")
}

impl ServerDownloads {
    pub fn new(max_bytes: u64, lanes: Lanes) -> Arc<Self> {
        Self::with_idle(max_bytes, SERVER_DOWNLOAD_IDLE, lanes)
    }

    fn with_idle(max_bytes: u64, idle: Duration, lanes: Lanes) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { me: me.clone(), max_bytes, idle, lanes, downloads: Mutex::default(), finished: Mutex::default() })
    }

    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce() -> WsResult<R> + Send + 'static) -> WsResult<R> {
        lanes::run_fallible(self.lanes.durability, &CancellationToken::new(), job).await
    }

    /// Starts (or restarts) the idle clock of `id`; the download is discarded when nothing steps it before it runs out.
    fn arm(&self, id: &str) {
        let Some(armed) = self.downloads.lock().expect("downloads").get_mut(id).map(|d| {
            d.armed += 1;
            d.armed
        }) else {
            return;
        };
        let (me, id, idle) = (self.me.clone(), id.to_owned(), self.idle);
        drop(mixdog_rt::spawn("server-download-idle", mixdog_rt::TaskClass::Work, async move {
            tokio::time::sleep(idle).await;
            let Some(this) = me.upgrade() else { return };
            let expired = {
                let mut downloads = this.downloads.lock().expect("downloads");
                // A step in flight re-arms when it ends.
                if downloads.get(&id).is_some_and(|d| d.armed == armed && !d.busy) { downloads.remove(&id) } else { None }
            };
            if let Some(download) = expired {
                this.discard(download).await;
            }
        }));
    }

    /// Closes and removes the part file of a download already taken out of the table.
    async fn discard(&self, download: Download) {
        let temp = download.temp.clone();
        drop(download);
        let _ = self
            .on_lane(move || {
                let _ = std::fs::remove_file(temp);
                Ok(())
            })
            .await;
    }

    pub async fn begin(&self, reader: Arc<dyn RemoteFileReader>, downloads_dir: &Path, root: &str, rel: &str) -> WsResult<Begun> {
        let (size, mtime_ms) = server_file_stat(&reader.stat(root, rel).await?)?;
        if size > self.max_bytes {
            return Err(WsError::plain(format!(
                "The file is larger than the {} MB download limit.",
                (self.max_bytes as f64 / 1024.0 / 1024.0).round()
            )));
        }
        if downloads_dir.as_os_str().is_empty() {
            return Err(WsError::plain("This PC has no download folder."));
        }
        let dir = downloads_dir.to_path_buf();
        let id = uuid::Uuid::new_v4().to_string();
        let temp = dir.join(format!(".mixdog-{id}.part"));
        let file = {
            let (dir, temp) = (dir.clone(), temp.clone());
            self.on_lane(move || {
                std::fs::create_dir_all(&dir)?;
                Ok(File::options().write(true).create_new(true).open(&temp)?)
            })
            .await?
        };
        let name = local_download_name(posix_basename(rel));
        self.downloads.lock().expect("downloads").insert(
            id.clone(),
            Download {
                reader,
                root: root.to_owned(),
                rel: rel.to_owned(),
                name: name.clone(),
                size,
                mtime_ms,
                received: 0,
                dir,
                temp,
                file: Arc::new(file),
                busy: false,
                armed: 0,
            },
        );
        self.arm(&id);
        Ok(Begun { download_id: id, name, size })
    }

    /// Moves one ranged read.
    pub async fn step(&self, id: &str) -> WsResult<Stepped> {
        let (reader, root, rel, offset, size, mtime_ms, file) = {
            let mut downloads = self.downloads.lock().expect("downloads");
            let d = downloads.get_mut(id).ok_or_else(gone)?;
            if d.busy {
                return Err(WsError::plain("The download is already reading."));
            }
            if d.received >= d.size {
                return Ok(Stepped { received: d.received, size: d.size, done: true });
            }
            d.busy = true;
            (d.reader.clone(), d.root.clone(), d.rel.clone(), d.received, d.size, d.mtime_ms, d.file.clone())
        };
        let moved = async {
            let requested = SERVER_READ_CHUNK_BYTES.min(size - offset);
            let answer = reader.read_range(&root, &rel, offset, requested).await?;
            let (bytes, chunk_size, chunk_mtime) = server_read_range(&answer, offset, requested)?;
            if chunk_size != size || chunk_mtime != mtime_ms || bytes.is_empty() {
                return Err(WsError::plain("The server file changed while it was downloading."));
            }
            let len = bytes.len() as u64;
            self.on_lane(move || Ok(write_all_at(&file, &bytes, offset)?)).await?;
            Ok::<u64, WsError>(len)
        }
        .await;
        let received = match moved {
            Ok(len) => {
                let mut downloads = self.downloads.lock().expect("downloads");
                // A cancel that landed during the read took the download out; its part file is already gone.
                let d = downloads.get_mut(id).ok_or_else(gone)?;
                d.busy = false;
                d.received += len;
                d.received
            }
            Err(error) => {
                let taken = self.downloads.lock().expect("downloads").remove(id);
                if let Some(download) = taken {
                    self.discard(download).await;
                }
                return Err(error);
            }
        };
        self.arm(id);
        Ok(Stepped { received, size, done: received >= size })
    }

    /// Publishes the part file under the first free "name", "name (2)", ... and answers its path.
    pub async fn finish(&self, id: &str) -> WsResult<PathBuf> {
        let download = {
            let mut downloads = self.downloads.lock().expect("downloads");
            let d = downloads.get(id).ok_or_else(gone)?;
            if d.busy || d.received != d.size {
                return Err(WsError::plain("The download is incomplete."));
            }
            downloads.remove(id).ok_or_else(gone)?
        };
        let Download { name, dir, temp, file, .. } = download;
        drop(file);
        let linked = self
            .on_lane(move || {
                let path = Path::new(&name);
                let stem = path.file_stem().map_or_else(|| name.clone(), |s| s.to_string_lossy().into_owned());
                let extension = path.extension().map_or_else(String::new, |e| format!(".{}", e.to_string_lossy()));
                let result: WsResult<PathBuf> = (|| {
                    for attempt in 1..1000 {
                        let candidate = dir.join(if attempt == 1 { name.clone() } else { format!("{stem} ({attempt}){extension}") });
                        match std::fs::hard_link(&temp, &candidate) {
                            Ok(()) => return Ok(candidate),
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                            Err(e) => return Err(e.into()),
                        }
                    }
                    Err(WsError::plain("Too many downloads with this name."))
                })();
                let _ = std::fs::remove_file(&temp);
                result
            })
            .await?;
        self.finished.lock().expect("finished").insert(linked.clone());
        Ok(linked)
    }

    /// Cancels a download and removes its part file; false when there is none.
    pub fn abort(&self, id: &str) -> bool {
        let Some(download) = self.downloads.lock().expect("downloads").remove(id) else { return false };
        let me = self.me.clone();
        drop(mixdog_rt::spawn("server-download-abort", mixdog_rt::TaskClass::Work, async move {
            if let Some(this) = me.upgrade() {
                this.discard(download).await;
            }
        }));
        true
    }

    /// Only a file this process downloaded may be handed to the OS.
    pub fn was_downloaded(&self, path: &Path) -> bool {
        self.finished.lock().expect("finished").contains(path)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fake {
        data: Vec<u8>,
        /// The size the stat claims.
        stat_size: u64,
        /// The size each chunk claims.
        chunk_size: u64,
        /// At most this many bytes per read.
        per_read: usize,
        /// Answers the requested length plus this many bytes (a server that ignores the request).
        extra: usize,
    }

    impl Fake {
        fn of(data: &[u8]) -> Self {
            Self { data: data.to_vec(), stat_size: data.len() as u64, chunk_size: data.len() as u64, per_read: usize::MAX, extra: 0 }
        }
    }

    #[async_trait]
    impl RemoteFileReader for Fake {
        async fn stat(&self, _: &str, _: &str) -> WsResult<serde_json::Value> {
            Ok(json!({ "size": self.stat_size, "mtimeMs": 1700.5 }))
        }
        async fn read_range(&self, _: &str, _: &str, offset: u64, length: u64) -> WsResult<serde_json::Value> {
            let start = (offset as usize).min(self.data.len());
            let end = (start + (length as usize).min(self.per_read) + self.extra).min(self.data.len());
            Ok(json!({
                "offset": offset,
                "size": self.chunk_size,
                "mtimeMs": 1700.5,
                "data": base64::engine::general_purpose::STANDARD.encode(&self.data[start..end]),
            }))
        }
    }

    fn lanes() -> Lanes {
        let tokens = mixdog_rt::testing::tokens();
        Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk }
    }

    async fn fetch(downloads: &ServerDownloads, reader: Fake, dir: &Path, rel: &str) -> WsResult<PathBuf> {
        let begun = downloads.begin(Arc::new(reader), dir, "/srv", rel).await?;
        loop {
            if downloads.step(&begun.download_id).await?.done {
                return downloads.finish(&begun.download_id).await;
            }
        }
    }

    fn parts(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".part")).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_download_lands_under_its_name_and_may_then_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let begun = downloads.begin(Arc::new(Fake::of(b"0123456789")), dir.path(), "/srv", "a/b/report.txt").await.unwrap();
        assert_eq!((begun.name.as_str(), begun.size), ("report.txt", 10));
        assert_eq!(parts(dir.path()).len(), 1);
        assert!(downloads.finish(&begun.download_id).await.unwrap_err().message.contains("incomplete"));
        let step = downloads.step(&begun.download_id).await.unwrap();
        assert_eq!((step.received, step.size, step.done), (10, 10, true));
        assert!(downloads.step(&begun.download_id).await.unwrap().done);
        let path = downloads.finish(&begun.download_id).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"0123456789");
        assert!(downloads.was_downloaded(&path));
        assert!(!downloads.was_downloaded(&dir.path().join("other.txt")));
        assert!(parts(dir.path()).is_empty());
        assert!(!downloads.abort(&begun.download_id));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_short_read_advances_by_what_arrived() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let mut reader = Fake::of(b"abcdefghij");
        reader.per_read = 3;
        let path = fetch(&downloads, reader, dir.path(), "x.bin").await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"abcdefghij");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_over_the_cap_is_refused_before_anything_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(5, lanes());
        let error = downloads.begin(Arc::new(Fake::of(b"0123456789")), dir.path(), "/srv", "x").await.err().unwrap();
        assert!(error.message.contains("download limit"), "{}", error.message);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_server_that_sends_more_than_asked_fails_and_leaves_no_part() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let mut reader = Fake::of(b"0123456789");
        reader.stat_size = 4;
        reader.chunk_size = 4;
        reader.extra = 3;
        let error = fetch(&downloads, reader, dir.path(), "x").await.unwrap_err();
        assert!(error.message.contains("longer than the 4 bytes requested"), "{}", error.message);
        assert!(parts(dir.path()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_size_that_changes_between_stat_and_read_fails_the_download() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let mut reader = Fake::of(b"0123456789");
        reader.chunk_size = 11;
        let error = fetch(&downloads, reader, dir.path(), "x").await.unwrap_err();
        assert!(error.message.contains("changed while it was downloading"), "{}", error.message);
        assert!(parts(dir.path()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_lying_stat_size_larger_than_the_file_ends_on_an_empty_read() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let mut reader = Fake::of(b"0123");
        reader.stat_size = 9;
        reader.chunk_size = 9;
        let error = fetch(&downloads, reader, dir.path(), "x").await.unwrap_err();
        assert!(error.message.contains("changed while it was downloading"), "{}", error.message);
        assert!(parts(dir.path()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_taken_name_gets_the_next_number_and_never_clobbers() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), b"mine").unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let second = fetch(&downloads, Fake::of(b"one"), dir.path(), "f.txt").await.unwrap();
        let third = fetch(&downloads, Fake::of(b"two"), dir.path(), "f.txt").await.unwrap();
        assert_eq!(second.file_name().unwrap(), "f (2).txt");
        assert_eq!(third.file_name().unwrap(), "f (3).txt");
        assert_eq!(std::fs::read(dir.path().join("f.txt")).unwrap(), b"mine");
        assert_eq!(std::fs::read(third).unwrap(), b"two");
        assert!(parts(dir.path()).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_idle_download_expires_with_its_part() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::with_idle(1 << 20, Duration::from_millis(60), lanes());
        let begun = downloads.begin(Arc::new(Fake::of(b"0123")), dir.path(), "/srv", "x").await.unwrap();
        assert_eq!(parts(dir.path()).len(), 1);
        for _ in 0..100 {
            if parts(dir.path()).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(parts(dir.path()).is_empty());
        assert!(downloads.step(&begun.download_id).await.unwrap_err().message.contains("gone"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn abort_removes_the_part_and_the_download() {
        let dir = tempfile::tempdir().unwrap();
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let begun = downloads.begin(Arc::new(Fake::of(b"0123")), dir.path(), "/srv", "x").await.unwrap();
        assert!(downloads.abort(&begun.download_id));
        for _ in 0..100 {
            if parts(dir.path()).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(parts(dir.path()).is_empty());
        assert!(!downloads.abort(&begun.download_id));
        assert!(downloads.step(&begun.download_id).await.is_err());
        assert!(downloads.finish(&begun.download_id).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_download_folder_is_refused() {
        let downloads = ServerDownloads::new(1 << 20, lanes());
        let error = downloads.begin(Arc::new(Fake::of(b"0")), Path::new(""), "/srv", "x").await.err().unwrap();
        assert!(error.message.contains("no download folder"));
    }

    #[test]
    fn names_lose_separators_dots_and_device_names() {
        assert_eq!(local_download_name("a/b\\c"), "a_b_c");
        assert_eq!(local_download_name("a<>:\"|?*b"), "a_b");
        assert_eq!(local_download_name("..hidden"), "hidden");
        assert_eq!(local_download_name(".."), "download");
        assert_eq!(local_download_name(""), "download");
        assert_eq!(local_download_name("trailing. . "), "trailing");
        assert_eq!(local_download_name("con"), "_con");
        assert_eq!(local_download_name("NUL.txt"), "_NUL.txt");
        assert_eq!(local_download_name("com1.log"), "_com1.log");
        assert_eq!(local_download_name("LPT\u{b2}"), "_LPT\u{b2}");
        assert_eq!(local_download_name("console.txt"), "console.txt");
        assert_eq!(local_download_name("com10"), "com10");
        assert_eq!(local_download_name(&"x".repeat(300)).len(), 200);
        assert_eq!(posix_basename("/a/b/c.txt"), "c.txt");
        assert_eq!(posix_basename("/a/b/"), "b");
    }

    #[test]
    fn a_stat_is_checked() {
        assert_eq!(server_file_stat(&json!({ "size": 12, "mtimeMs": 3.5 })).unwrap(), (12, 3.5));
        assert_eq!(server_file_stat(&json!({ "size": 12.0, "mtimeMs": 0 })).unwrap(), (12, 0.0));
        for bad in [json!(null), json!([]), json!({ "mtimeMs": 1 }), json!({ "size": -1, "mtimeMs": 1 }), json!({ "size": 1.5, "mtimeMs": 1 }), json!({ "size": "7", "mtimeMs": 1 }), json!({ "size": 9007199254740992u64, "mtimeMs": 1 }), json!({ "size": 1, "mtimeMs": -1 }), json!({ "size": 1 })] {
            assert!(server_file_stat(&bad).unwrap_err().message.starts_with("The server sent an invalid response"), "{bad}");
        }
    }

    #[test]
    fn a_chunk_is_checked_before_it_is_decoded() {
        let ok = |offset: serde_json::Value, data: &str| json!({ "offset": offset, "size": 9, "mtimeMs": 1, "data": data });
        let (bytes, size, mtime) = server_read_range(&ok(json!(3), "YWJj"), 3, 3).unwrap();
        assert_eq!((&bytes[..], size, mtime), (&b"abc"[..], 9, 1.0));
        assert!(server_read_range(&ok(json!(3), ""), 3, 3).unwrap().0.is_empty());
        for (offset, data, requested) in [(json!(4), "YWJj", 3u64), (json!("3"), "YWJj", 3), (json!(3), "YWJjZA==", 3), (json!(3), "YW Jj", 3), (json!(3), "YWJ", 3), (json!(3), "=YWJ", 3), (json!(3), "YQ===", 3), (json!(3), "YWJj", 2)] {
            assert!(server_read_range(&ok(offset.clone(), data), 3, requested).is_err(), "{offset} {data} {requested}");
        }
        assert!(server_read_range(&json!({ "offset": 3, "size": 9, "mtimeMs": 1, "data": 5 }), 3, 3).is_err());
        assert!(server_read_range(&json!("x"), 3, 3).is_err());
    }
}
