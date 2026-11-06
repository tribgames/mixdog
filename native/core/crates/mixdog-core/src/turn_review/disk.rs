//! The review store's files on the I/O lanes ([`ReviewDisk`]): reads on the interactive lane,
//! writes and removals on the durability lane, as every other store of the core.
// Every std::fs call here is the body of a lane job.
#![allow(clippy::disallowed_methods, reason = "blocking file I/O inside lane jobs")]

use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_statefile::Opts;
use tokio_util::sync::CancellationToken;

use super::nodepath;
use super::patch::change_path_key;
use super::ports::CurrentText;
use super::ports::BlockingFs;
use super::ports::BlockingJob;
use super::ports::CurrentFile;
use super::ports::FileStamp;
use super::ports::ReadFs;
use super::ports::ReadJob;
use super::ports::LinkStat;
use super::ports::ReviewDisk;

/// Largest recorded file the legacy measure reads (`NET_TEXT_MAX_BYTES`).
const NET_TEXT_MAX_BYTES: u64 = 1024 * 1024;

pub struct LaneDisk {
    tokens: LaneTokens,
}

impl LaneDisk {
    pub fn new(tokens: LaneTokens) -> Self {
        Self { tokens }
    }

    async fn interactive<R: Send + 'static>(&self, job: impl FnOnce(&InLane<InteractiveIo>) -> R + Send + 'static) -> std::io::Result<R> {
        let cancel = CancellationToken::new();
        let handle = self.tokens.interactive_io.submit_wait(&cancel, job).await.map_err(std::io::Error::other)?;
        handle.await.map_err(std::io::Error::other)
    }

    async fn durable<R: Send + 'static>(&self, job: impl FnOnce(&InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> std::io::Result<R> {
        let cancel = CancellationToken::new();
        let handle = self.tokens.durability_io.submit_wait(&cancel, job).await.map_err(std::io::Error::other)?;
        handle.await.map_err(std::io::Error::other)
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// ctimeMs: the inode change time where the platform has one, else the last write.
fn change_ms(meta: &std::fs::Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.ctime() as f64 * 1000.0 + meta.ctime_nsec() as f64 / 1e6
    }
    #[cfg(not(unix))]
    {
        mtime_ms(meta)
    }
}

fn stamp(meta: &std::fs::Metadata) -> FileStamp {
    FileStamp { mtime_ms: mtime_ms(meta), size: meta.len() }
}

fn missing(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::NotFound) || error.raw_os_error().is_some_and(|c| c == 20 || c == 267)
}

/// `realpath` without the `\\?\` prefix Windows' canonicalize adds.
fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    let text = real.display().to_string();
    Ok(match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => real,
    })
}

fn inside_directory(parent: &str, child: &str) -> bool {
    let rel = nodepath::relative_host(parent, child);
    rel.is_empty() || (!nodepath::is_absolute_host(&rel) && nodepath::split_segments(&rel)[0] != "..")
}

pub(super) fn is_outside_path(path: &str) -> bool {
    let mut chars = path.chars();
    nodepath::is_absolute_host(path)
        || matches!((chars.next(), chars.next(), chars.next()), (Some(d), Some(':'), Some('\\' | '/')) if d.is_ascii_alphabetic())
}

/// `safeCurrentFile`: the recorded file's absolute path when it may be read; `Ok(None)` when
/// absent, `Err(())` when it is reached through a link or cannot be told.
fn safe_current_file(root: &str, path: &str) -> Result<Option<PathBuf>, ()> {
    let outside = is_outside_path(path);
    let file = if outside { nodepath::resolve_host(&[path]) } else { nodepath::resolve_host(&[root, path]) };
    let meta = match std::fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(e) if missing(&e) => return Ok(None),
        Err(_) => return Err(()),
    };
    if outside {
        // An outside file is read only at its exact recorded path, never through a link.
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(());
        }
        let real = real_path(Path::new(&file)).map_err(|e| if missing(&e) { () } else { () })?;
        if change_path_key(&real.display().to_string()) != change_path_key(&file) {
            return Err(());
        }
    } else {
        // An in-root file is followed only while it stays inside the recorded root.
        let real_root = real_path(Path::new(root)).map_err(|_| ())?;
        let real_file = match real_path(Path::new(&file)) {
            Ok(f) => f,
            Err(e) if missing(&e) => return Ok(None),
            Err(_) => return Err(()),
        };
        if !inside_directory(&real_root.display().to_string(), &real_file.display().to_string()) {
            return Err(());
        }
    }
    Ok(Some(PathBuf::from(file)))
}

/// `readBounded`: at most `max_bytes` of a regular file, sized by the file plus one byte so a
/// file that grew since its stat is not read part-way; `None` when it is larger.
fn bounded_read(file: &Path, max_bytes: u64) -> std::io::Result<Option<Vec<u8>>> {
    let mut handle = std::fs::File::open(file)?;
    let meta = handle.metadata()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return Ok(None);
    }
    let mut buffer = Vec::with_capacity(meta.len() as usize + 1);
    (&mut handle).take(meta.len() + 1).read_to_end(&mut buffer)?;
    Ok(if buffer.len() as u64 > meta.len() { None } else { Some(buffer) })
}

struct LaneFs<'a> {
    lane: &'a InLane<mixdog_rt::DurabilityIo>,
}

struct ReadOnlyFs;

fn fs_read(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn fs_stat(path: &Path) -> std::io::Result<Option<FileStamp>> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(stamp(&meta))),
        Err(e) if missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn fs_list(path: &Path) -> std::io::Result<Vec<(String, bool, bool)>> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if missing(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        out.push((entry.file_name().to_string_lossy().into_owned(), kind.is_file(), kind.is_dir()));
    }
    Ok(out)
}

impl ReadFs for ReadOnlyFs {
    fn read(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>> {
        fs_read(path)
    }
    fn stat(&self, path: &Path) -> std::io::Result<Option<FileStamp>> {
        fs_stat(path)
    }
    fn list(&self, path: &Path) -> std::io::Result<Vec<(String, bool, bool)>> {
        fs_list(path)
    }
}

impl ReadFs for LaneFs<'_> {
    fn read(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>> {
        fs_read(path)
    }
    fn stat(&self, path: &Path) -> std::io::Result<Option<FileStamp>> {
        fs_stat(path)
    }
    fn list(&self, path: &Path) -> std::io::Result<Vec<(String, bool, bool)>> {
        fs_list(path)
    }
}

impl BlockingFs for LaneFs<'_> {
    fn write_atomic(&self, path: &Path, bytes: &[u8], create_only: bool, fsync: bool) -> std::io::Result<()> {
        let opts = Opts { create_only, fsync, ..Opts::default() };
        mixdog_statefile::write_file(self.lane, path, bytes, &opts).map(|_| ()).map_err(|e| std::io::Error::other(e.to_string()))
    }

    fn remove(&self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if missing(&e) => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn remove_tree(&self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(e) if missing(&e) => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn create_private_dir_all(&self, path: &Path) -> std::io::Result<()> {
        mixdog_statefile::create_private_dir_all(self.lane, path)
    }
}

fn fs_current_text(root: &str, path: &str) -> CurrentText {
    let file = match safe_current_file(root, path) {
        Ok(Some(file)) => file,
        Ok(None) => return CurrentText::Absent,
        Err(()) => return CurrentText::Unreadable,
    };
    let read = || -> std::io::Result<Option<Vec<u8>>> {
        let mut handle = std::fs::File::open(&file)?;
        let meta = handle.metadata()?;
        if !meta.is_file() || meta.len() > NET_TEXT_MAX_BYTES {
            return Ok(None);
        }
        // Sized by the file, one byte over: a file that grew since its stat is not read part-way.
        let mut buffer = Vec::with_capacity(meta.len() as usize + 1);
        (&mut handle).take(meta.len() + 1).read_to_end(&mut buffer)?;
        Ok(if buffer.len() as u64 > meta.len() { None } else { Some(buffer) })
    };
    match read() {
        Ok(Some(bytes)) => match std::str::from_utf8(&bytes) {
            Ok(text) if !text.contains('\0') => CurrentText::Text(text.to_owned()),
            _ => CurrentText::Unreadable,
        },
        Ok(None) => CurrentText::Unreadable,
        Err(e) if missing(&e) => CurrentText::Absent,
        Err(_) => CurrentText::Unreadable,
    }
}

#[async_trait]
impl ReviewDisk for LaneDisk {
    async fn read(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>> {
        let path = path.to_owned();
        self.interactive(move |_| match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if missing(&e) => Ok(None),
            Err(e) => Err(e),
        })
        .await?
    }

    async fn stat(&self, path: &Path) -> std::io::Result<Option<FileStamp>> {
        let path = path.to_owned();
        self.interactive(move |_| match std::fs::metadata(&path) {
            Ok(meta) => Ok(Some(stamp(&meta))),
            Err(e) if missing(&e) => Ok(None),
            Err(e) => Err(e),
        })
        .await?
    }

    async fn write_atomic(&self, path: &Path, bytes: Vec<u8>) -> std::io::Result<()> {
        let path = path.to_owned();
        self.durable(move |lane| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            mixdog_statefile::write_file(lane, &path, &bytes, &Opts::default()).map(|_| ()).map_err(|e| std::io::Error::other(e.to_string()))
        })
        .await?
    }

    async fn remove(&self, path: &Path) -> std::io::Result<()> {
        let path = path.to_owned();
        self.durable(move |_| match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if missing(&e) => Ok(()),
            Err(e) => Err(e),
        })
        .await?
    }

    async fn list(&self, dir: &Path) -> std::io::Result<Vec<(String, FileStamp)>> {
        let dir = dir.to_owned();
        self.interactive(move |_| {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                if let Ok(meta) = entry.metadata() {
                    out.push((entry.file_name().to_string_lossy().into_owned(), stamp(&meta)));
                }
            }
            Ok(out)
        })
        .await?
    }

    async fn create_dir_all(&self, dir: &Path) -> std::io::Result<()> {
        let dir = dir.to_owned();
        self.durable(move |_| std::fs::create_dir_all(&dir)).await?
    }

    async fn lstat(&self, path: &Path) -> std::io::Result<Option<LinkStat>> {
        let path = path.to_owned();
        self.interactive(move |_| match std::fs::symlink_metadata(&path) {
            Ok(meta) => Ok(Some(LinkStat {
                is_file: meta.is_file(),
                is_symlink: meta.file_type().is_symlink(),
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                change_ms: change_ms(&meta),
            })),
            Err(e) if missing(&e) => Ok(None),
            Err(e) => Err(e),
        })
        .await?
    }

    async fn blocking_read(&self, job: ReadJob) -> std::io::Result<()> {
        self.interactive(move |_| job(&ReadOnlyFs)).await
    }

    async fn blocking(&self, lock: Option<&Path>, job: BlockingJob) -> std::io::Result<()> {
        let lock = lock.map(Path::to_owned);
        self.durable(move |lane| {
            let fs = LaneFs { lane };
            match lock {
                None => {
                    job(&fs);
                    Ok(())
                }
                Some(path) => {
                    let opts = mixdog_statefile::LockOpts { timeout: Some(std::time::Duration::from_secs(10)), ..Default::default() };
                    mixdog_statefile::with_lock(lane, &path, &opts, || job(&fs)).map_err(|e| std::io::Error::other(e.to_string()))
                }
            }
        })
        .await?
    }

    async fn current_file(&self, root: &str, path: &str) -> CurrentFile {
        let (root, path) = (root.to_owned(), path.to_owned());
        self.interactive(move |_| {
            let file = match safe_current_file(&root, &path) {
                Ok(Some(file)) => file,
                Ok(None) => return CurrentFile::Absent,
                Err(()) => return CurrentFile::Unsafe,
            };
            match std::fs::metadata(&file) {
                Ok(meta) if meta.is_file() => {
                    let sig = format!("{}:{}:{}", meta.len(), mtime_ms(&meta), change_ms(&meta));
                    CurrentFile::Present { file, size: meta.len(), sig }
                }
                Ok(_) => CurrentFile::Unsafe,
                Err(e) if missing(&e) => CurrentFile::Absent,
                Err(_) => CurrentFile::Unsafe,
            }
        })
        .await
        .unwrap_or(CurrentFile::Unsafe)
    }

    async fn read_bounded(&self, file: &Path, max_bytes: u64) -> Option<Vec<u8>> {
        let file = file.to_owned();
        self.interactive(move |_| bounded_read(&file, max_bytes).ok().flatten()).await.ok().flatten()
    }

    async fn file_digest(&self, file: &Path, max_bytes: u64) -> Option<String> {
        use sha2::Digest;
        let file = file.to_owned();
        self.interactive(move |_| {
            let mut handle = std::fs::File::open(&file).ok()?;
            let meta = handle.metadata().ok()?;
            if !meta.is_file() || meta.len() > max_bytes {
                return None;
            }
            let mut hash = sha2::Sha256::new();
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let read = handle.read(&mut buffer).ok()?;
                if read == 0 {
                    break;
                }
                hash.update(&buffer[..read]);
            }
            Some(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
        })
        .await
        .ok()
        .flatten()
    }

    async fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        let (from, to) = (from.to_owned(), to.to_owned());
        self.durable(move |_| std::fs::rename(&from, &to)).await?
    }

    async fn copy_file(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        let (from, to) = (from.to_owned(), to.to_owned());
        self.durable(move |_| std::fs::copy(&from, &to).map(|_| ())).await?
    }

    async fn remove_tree(&self, dir: &Path) -> std::io::Result<()> {
        let dir = dir.to_owned();
        // maxRetries: 5, retryDelay: 100.
        self.durable(move |_| {
            for attempt in 0..6 {
                match std::fs::remove_dir_all(&dir) {
                    Ok(()) => return Ok(()),
                    Err(e) if missing(&e) => return Ok(()),
                    Err(e) if attempt == 5 => return Err(e),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                }
            }
            Ok(())
        })
        .await?
    }

    async fn is_dir(&self, path: &Path) -> bool {
        let path = path.to_owned();
        self.interactive(move |_| std::fs::metadata(&path).is_ok_and(|m| m.is_dir())).await.unwrap_or(false)
    }

    async fn current_text(&self, root: &str, path: &str) -> CurrentText {
        let (root, path) = (root.to_owned(), path.to_owned());
        self.interactive(move |_| fs_current_text(&root, &path)).await.unwrap_or(CurrentText::Unreadable)
    }

    fn now_ms(&self) -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }
}
