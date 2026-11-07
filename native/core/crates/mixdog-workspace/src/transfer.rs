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

struct Read {
    owner: String,
    file: File,
    size: u64,
    version: String,
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

#[derive(Default)]
pub struct Transfers {
    reads: Mutex<HashMap<String, Read>>,
    writes: Mutex<HashMap<String, Upload>>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Transfers {
    fn register(&self, owner: &str, file: File, name: String, mime: &str, cleanup: Option<PathBuf>) -> WsResult<Opened> {
        let version = file_version(&file)?;
        let version = version_string(&version);
        let size = file.metadata()?.len();
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.len() >= MAX_OPEN_READS {
            return Err(WsError::new(Reason::Busy, "Too many downloads are open."));
        }
        let id = new_id();
        reads.insert(
            id.clone(),
            Read { owner: owner.to_owned(), file, size, version: version.clone(), _cleanup: cleanup.map(Cleanup), opened: Instant::now() },
        );
        // Every source's offered name goes through Node's `sanitizedFileName`, here and nowhere else.
        let name = sanitized_file_name(&name);
        Ok(Opened { transfer_id: id, size, mime_type: mime.to_owned(), name, version, range_max_bytes: RANGE_MAX_BYTES })
    }

    /// A project file. The real path is verified from the open handle.
    pub fn begin_project_read(&self, owner: &str, root: &Path, rel: &str) -> WsResult<Opened> {
        let path = project_entry_path(root, rel)?;
        let opened = open_authorized_ro(&path, root)?;
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
    pub fn read_range(&self, owner: &str, id: &str, offset: u64, length: u64) -> WsResult<Range> {
        let (file, size, version) = {
            let reads = self.reads.lock().expect("transfer reads");
            let read = reads.get(id).filter(|r| r.owner == owner).ok_or_else(WsError::expired)?;
            (read.file.try_clone()?, read.size, read.version.clone())
        };
        let current = version_string(&file_version(&file)?);
        if current != version {
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
        Ok(Range {
            transfer_id: id.to_owned(),
            offset,
            length,
            eof: offset + length >= size,
            version,
            data: STANDARD.encode(&data),
        })
    }

    pub fn end_read(&self, owner: &str, id: &str) -> bool {
        let mut reads = self.reads.lock().expect("transfer reads");
        if reads.get(id).is_some_and(|r| r.owner == owner) {
            reads.remove(id);
            return true;
        }
        false
    }

    pub fn begin_write(&self, owner: &str, root: &Path, rel: &str, size: u64) -> WsResult<String> {
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
            .insert(id.clone(), Upload { owner: owner.to_owned(), temp, target, file, size, written: 0, unique: false, writing: false });
        Ok(id)
    }

    /// `serverUploadBegin(name, size, scope)`: an upload into the staging folder `dir`, published at
    /// commit under `name`, or `name (2).ext`... when that is taken.
    pub fn begin_staged(&self, owner: &str, dir: &Path, name: &str, size: u64) -> WsResult<String> {
        std::fs::create_dir_all(dir)?;
        let id = new_id();
        let temp = dir.join(format!(".{id}.part"));
        let file = File::options().write(true).create_new(true).open(&temp)?;
        self.writes.lock().expect("transfer writes").insert(
            id.clone(),
            Upload { owner: owner.to_owned(), temp, target: dir.join(upload_file_name(name)), file, size, written: 0, unique: true, writing: false },
        );
        Ok(id)
    }

    /// `serverUploadChunk(id, offset, data)`, check for check as Node orders them: the upload
    /// must exist, the offset must be an integer within the declared size, the data canonical
    /// base64 of 1..=[`UPLOAD_CHUNK_BYTES`] bytes. A chunk the upload already holds as its last
    /// one is acknowledged, not rewritten; one that does not start at the received bytes is out
    /// of order; one that arrives while another is being written is refused; one that would pass
    /// the declared size discards the upload. Answers the bytes received.
    pub fn write_chunk(&self, owner: &str, id: &str, offset: Option<u64>, encoded: &str) -> WsResult<u64> {
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
        let write = {
            let mut writes = self.writes.lock().expect("transfer writes");
            if !writes.get(id).is_some_and(|w| w.owner == owner) {
                return Err(WsError::expired());
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
        let removed = {
            let mut writes = self.writes.lock().expect("transfer writes");
            if writes.get(id).is_some_and(|w| w.owner == owner) { writes.remove(id) } else { None }
        };
        if let Some(write) = removed {
            let _ = std::fs::remove_file(write.temp);
            return true;
        }
        self.end_read(owner, id)
    }

    /// Ends every transfer of `owner` (a closed connection, a revoked device); in-flight
    /// reads fail with `expired` from then on.
    pub fn end_owner(&self, owner: &str) {
        self.reads.lock().expect("transfer reads").retain(|_, r| r.owner != owner);
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
}

pub type SharedTransfers = Arc<Transfers>;

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
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
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
        let range = t.read_range("dev-a", &opened.transfer_id, 0, 64).unwrap();
        assert_eq!((range.length, range.eof), (64, false));
        assert_eq!(STANDARD.decode(&range.data).unwrap(), b"0123456789abcdef".repeat(4));
        assert_eq!(t.read_range("dev-b", &opened.transfer_id, 0, 8).unwrap_err().reason, Reason::Expired);
        assert_eq!(
            t.read_range("dev-a", &opened.transfer_id, 1000, 8).unwrap_err().message,
            "offset is past the end of the file."
        );
        std::fs::OpenOptions::new().append(true).open(root.join("report.bin")).unwrap().write_all(b"x").unwrap();
        assert_eq!(t.read_range("dev-a", &opened.transfer_id, 0, 8).unwrap_err().message, "The file changed on the host.");
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
        assert!(t.end_read("dev", &opened.transfer_id));
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
    fn path_outside_is_refused_and_upload_commits_by_rename() {
        let (_d, root) = project();
        let t = Transfers::default();
        assert!(t.begin_project_read("o", &root, "../x").is_err());
        let id = t.begin_write("o", &root, "in/up.txt", 5).unwrap();
        t.write_chunk("o", &id, Some(0), "aGU=").unwrap();
        // The last chunk again is acknowledged, not rewritten.
        assert_eq!(t.write_chunk("o", &id, Some(0), "eHg=").unwrap(), 2);
        t.write_chunk("o", &id, Some(2), "bGxv").unwrap();
        assert_eq!(t.commit("o", &id).unwrap().0, 5);
        assert_eq!(std::fs::read(root.join("in/up.txt")).unwrap(), b"hello");
    }
}
