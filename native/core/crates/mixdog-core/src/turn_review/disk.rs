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
use super::ports::FileStamp;
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

fn is_outside_path(path: &str) -> bool {
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
