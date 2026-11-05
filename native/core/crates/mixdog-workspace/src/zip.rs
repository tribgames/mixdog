#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! A folder as a ZIP32 archive of its work files (port of `zip-folder.ts`).
//! Inside a git work tree the file list is git's own verdict (`ls-files -co
//! --exclude-standard`, asked of the SCM engine; untracked files stay, ignored ones
//! go); outside git it leaves out well-known generated folders. Every nested
//! repository, submodule and linked folder is judged by its own rules. A link is
//! packed under its own name when its real location is inside the folder and not a
//! folder the walk is already inside. Directory reads run as maintenance-lane jobs;
//! entries stream through a data descriptor so memory stays bounded; names are
//! UTF-8 and the timestamp is fixed so the same folder zips identically.

use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;
use std::io::Read;
use std::io::Seek;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use flate2::Compression;
use flate2::Crc;
use flate2::write::DeflateEncoder;
use tokio_util::sync::CancellationToken;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::FileId;
use crate::ident::file_id;
use crate::lanes::Lanes;
use crate::lanes::run;
use crate::pathguard::canonical;
use crate::pathguard::comparable;
use crate::pathguard::is_within;

/// The work-tree file list of a git repository, asked of the SCM engine (WP-SCM implements
/// it with gix; the composition root injects it). Both calls run on a lane inside the engine.
#[async_trait::async_trait]
pub trait TrackedFiles: Send + Sync {
    /// `git ls-files -co --exclude-standard` for the work tree holding `root`: tracked and
    /// untracked-not-ignored paths, a nested repository as `name/`; `None` outside git.
    async fn files(&self, root: &Path, cancel: &CancellationToken) -> Option<Vec<String>>;
    /// How many untracked, ignored files that work tree has (`ls-files -o -i --exclude-standard`).
    async fn ignored(&self, root: &Path, cancel: &CancellationToken) -> Option<u64>;
}
const GENERATED_FOLDERS: &[&str] =
    &["node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build", ".next", "target"];
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = ((2020 - 1980) << 9) | (1 << 5) | 1;

#[derive(Clone, Debug)]
pub struct FolderFile {
    pub rel: String,
    pub absolute: PathBuf,
    pub size: u64,
    pub id: FileId,
}

/// What a scan found: the files, and how many ignored files it left out.
#[derive(Debug)]
pub struct Scan {
    pub files: Vec<FolderFile>,
    pub ignored: u64,
}

fn too_large(files: u64, bytes: u64) -> WsError {
    WsError::new(Reason::FolderTooLarge, format!("The folder is too large to zip. ({files} files, {bytes} bytes)"))
}

fn comparable_str(text: &str) -> String {
    if cfg!(windows) { text.to_lowercase() } else { text.to_owned() }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Walk,
    Whole,
    Out,
}

/// What a folder walk leaves out. `None` (no rule) takes everything.
enum Exclusion {
    Git { files: HashSet<String>, parents: HashSet<String>, ignored: u64 },
    Generated,
}

impl Exclusion {
    fn file(&self, rel: &str) -> bool {
        match self {
            Self::Git { files, .. } => files.contains(&comparable_str(rel)),
            Self::Generated => true,
        }
    }

    fn directory(&self, rel: &str, name: &str) -> Verdict {
        match self {
            Self::Git { files, parents, .. } => {
                let key = comparable_str(rel);
                if files.contains(&key) {
                    Verdict::Whole
                } else if parents.contains(&key) {
                    Verdict::Walk
                } else {
                    Verdict::Out
                }
            }
            Self::Generated => {
                if GENERATED_FOLDERS.contains(&name) { Verdict::Out } else { Verdict::Walk }
            }
        }
    }

    fn ignored(&self) -> u64 {
        match self {
            Self::Git { ignored, .. } => *ignored,
            Self::Generated => 0,
        }
    }
}

/// Git's verdict for the work tree `root` is in; `None` outside one (or when git cannot answer).
async fn git_exclusion(git: &dyn TrackedFiles, cancel: &CancellationToken, root: &Path) -> Option<Exclusion> {
    let listed = git.files(root, cancel).await?;
    let mut files = HashSet::new();
    let mut parents = HashSet::new();
    for record in listed.iter().filter(|r| !r.is_empty()) {
        // A nested repository is listed as `name/`.
        let rel = comparable_str(record.strip_suffix('/').unwrap_or(record));
        let mut end = rel.len();
        while let Some(slash) = rel[..end].rfind('/') {
            if slash == 0 || !parents.insert(rel[..slash].to_owned()) {
                break;
            }
            end = slash;
        }
        files.insert(rel);
    }
    let ignored = git.ignored(root, cancel).await?;
    Some(Exclusion::Git { files, parents, ignored })
}
/// The exclusion for the canonical folder `root`, by the rules of the repository it is in.
/// `None` takes everything: outside git, a folder that is itself a generated name.
async fn exclusion_for(git: &dyn TrackedFiles, cancel: &CancellationToken, root: &Path) -> Option<Exclusion> {
    if let Some(found) = git_exclusion(git, cancel, root).await {
        return Some(found);
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if GENERATED_FOLDERS.contains(&name.as_str()) { None } else { Some(Exclusion::Generated) }
}

/// Where a folder entry really is: itself, or, for a link, its canonical target when that
/// lies inside `root`. `None` when the entry is left out.
struct Location {
    at: PathBuf,
    is_dir: bool,
    is_file: bool,
    size: u64,
}

fn entry_location(root: &Path, child: &Path) -> Option<Location> {
    let meta = std::fs::symlink_metadata(child).ok()?;
    let (at, meta) = if meta.file_type().is_symlink() {
        let target = canonical(child).ok()?;
        if !is_within(root, &target) {
            return None;
        }
        let target_meta = std::fs::symlink_metadata(&target).ok()?;
        if target_meta.file_type().is_symlink() {
            return None;
        }
        (target, target_meta)
    } else {
        (child.to_path_buf(), meta)
    };
    Some(Location { at, is_dir: meta.is_dir(), is_file: meta.is_file(), size: meta.len() })
}

fn is_canonical(path: &Path) -> bool {
    canonical(path).is_ok_and(|real| comparable(&real) == comparable(path))
}

fn count_files(dir: &Path) -> u64 {
    let Ok(read) = std::fs::read_dir(dir) else { return 0 };
    read.filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(k) if k.is_dir() => count_files(&e.path()),
            _ => 1,
        })
        .sum()
}

fn sorted_entries(dir: &Path) -> std::io::Result<Vec<(String, bool)>> {
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.file_type().ok()?.is_dir())))
        .collect();
    entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    Ok(entries)
}

struct Walk<'a> {
    git: &'a dyn TrackedFiles,
    lanes: Lanes,
    cancel: &'a CancellationToken,
    root: PathBuf,
    count: u64,
    bytes: u64,
    ignored: u64,
    max_bytes: u64,
    max_files: usize,
    files: Vec<FolderFile>,
    /// Test seam: runs after a directory entry was seen as a plain directory, before the walk descends.
    before_descend: Option<&'a (dyn Fn(&Path) + Send + Sync)>,
}

type BoxFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = WsResult<()>> + Send + 'a>>;

fn walk<'b, 'a: 'b>(w: &'b mut Walk<'a>, absolute: PathBuf, rel: String, ancestors: HashSet<String>, exclusion: Option<Arc<Exclusion>>, excl_rel: String) -> BoxFuture<'b> {
        Box::pin(async move {
            let dir = absolute.clone();
            let entries = run(w.lanes.maintenance, w.cancel, move || sorted_entries(&dir)).await??;
            // Checked after the listing: entries read through a redirected directory are never kept.
            let check = absolute.clone();
            if !run(w.lanes.maintenance, w.cancel, move || is_canonical(&check)).await? {
                return Ok(());
            }
            for (name, is_dir) in entries {
                let child = absolute.join(&name);
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let child_excl = if excl_rel.is_empty() { name.clone() } else { format!("{excl_rel}/{name}") };
                let mut inside = exclusion.clone();
                let mut fresh = false;
                if let Some(rule) = &exclusion {
                    if is_dir {
                        match rule.directory(&child_excl, &name) {
                            Verdict::Out => {
                                if matches!(**rule, Exclusion::Generated) {
                                    let counted = child.clone();
                                    w.ignored += run(w.lanes.maintenance, w.cancel, move || count_files(&counted)).await?;
                                }
                                continue;
                            }
                            Verdict::Whole => fresh = true,
                            Verdict::Walk => {}
                        }
                    } else {
                        if !rule.file(&child_excl) {
                            continue;
                        }
                        fresh = true;
                    }
                }
                let (root, probe) = (w.root.clone(), child.clone());
                let Some(location) = run(w.lanes.maintenance, w.cancel, move || entry_location(&root, &probe)).await? else {
                    continue;
                };
                if location.is_dir {
                    if ancestors.contains(&comparable_str(&location.at.to_string_lossy())) {
                        continue;
                    }
                    if let Some(hook) = w.before_descend {
                        hook(&location.at);
                    }
                    let mut inside_rel = child_excl;
                    if fresh {
                        inside = exclusion_for(w.git, w.cancel, &location.at).await.map(Arc::new);
                        inside_rel = String::new();
                        w.ignored += inside.as_ref().map_or(0, |i| i.ignored());
                    }
                    let mut deeper = ancestors.clone();
                    deeper.insert(comparable_str(&location.at.to_string_lossy()));
                    let at = location.at.clone();
                    // The recursion borrows `self` for its whole run: a fresh reborrow per entry.
                    walk(w, at, child_rel, deeper, inside, inside_rel).await?;
                } else if location.is_file {
                    let at = location.at.clone();
                    let id = run(w.lanes.maintenance, w.cancel, move || File::open(&at).and_then(|f| file_id(&f))).await??;
                    w.count += 1;
                    w.bytes += location.size;
                    // Past a cap the walk only counts, so the refusal can say how far over.
                    if w.count <= w.max_files as u64 && w.bytes <= w.max_bytes {
                        w.files.push(FolderFile { rel: child_rel, absolute: location.at, size: location.size, id });
                    }
                }
            }
            Ok(())
        })
}

struct Central {
    name: Vec<u8>,
    crc: u32,
    compressed: u32,
    size: u32,
    method: u16,
    offset: u32,
}

struct Counting<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}


/// The regular files under `root` (a canonical path) that make up the folder, as relative
/// `/`-separated paths in a stable order. Fails with `FolderTooLarge` once what is left
/// passes either cap, and `Changed` when `root` is not canonical.
pub async fn scan_folder(
    git: &dyn TrackedFiles,
    lanes: Lanes,
    cancel: &CancellationToken,
    root: &Path,
    max_bytes: u64,
    max_files: usize,
    before_descend: Option<&(dyn Fn(&Path) + Send + Sync)>,
) -> WsResult<Scan> {
    let probe = root.to_path_buf();
    if !run(lanes.maintenance, cancel, move || is_canonical(&probe)).await? {
        return Err(WsError::new(Reason::Changed, "The folder moved while it was being zipped."));
    }
    let rule = exclusion_for(git, cancel, root).await.map(Arc::new);
    let mut state = Walk {
        git,
        lanes,
        cancel,
        root: root.to_path_buf(),
        count: 0,
        bytes: 0,
        ignored: rule.as_ref().map_or(0, |r| r.ignored()),
        max_bytes,
        max_files,
        files: Vec::new(),
        before_descend,
    };
    let ancestors = HashSet::from([comparable_str(&root.to_string_lossy())]);
    walk(&mut state, root.to_path_buf(), String::new(), ancestors, rule, String::new()).await?;
    if state.count > max_files as u64 || state.bytes > max_bytes {
        return Err(too_large(state.count, state.bytes));
    }
    Ok(Scan { files: state.files, ignored: state.ignored })
}

/// Writes the archive; each file is read through a handle that proves it is still the
/// regular file the walk saw (a replaced file is left out). The caps hold for what is
/// actually read, not only for the sizes the walk saw.
pub fn write_archive<W: Write + Seek>(out: &mut W, files: &[FolderFile], max_bytes: u64) -> WsResult<()> {
    let mut offset: u64 = 0;
    let mut central = Vec::with_capacity(files.len());
    let mut read_total = 0u64;
    for file in files {
        let Ok(handle) = File::open(&file.absolute) else { continue };
        if !handle.metadata().is_ok_and(|m| m.is_file()) || file_id(&handle).ok() != Some(file.id) || !is_canonical(&file.absolute) {
            continue;
        }
        let name = file.rel.as_bytes().to_vec();
        let start = offset;
        // Local header with a data descriptor (flag bit 3): sizes follow the data.
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend(0x0403_4b50u32.to_le_bytes());
        header.extend(20u16.to_le_bytes());
        header.extend(0x0808u16.to_le_bytes());
        header.extend(8u16.to_le_bytes());
        header.extend(DOS_TIME.to_le_bytes());
        header.extend(DOS_DATE.to_le_bytes());
        header.extend([0u8; 12]);
        header.extend((name.len() as u16).to_le_bytes());
        header.extend(0u16.to_le_bytes());
        header.extend(&name);
        out.write_all(&header)?;
        let mut crc = Crc::new();
        let mut encoder = DeflateEncoder::new(Counting { inner: &mut *out, written: 0 }, Compression::default());
        let mut reader = BufReader::new(handle);
        let mut buf = vec![0u8; 64 * 1024];
        let mut size = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            read_total += n as u64;
            if read_total > max_bytes {
                return Err(too_large(files.len() as u64, read_total));
            }
            crc.update(&buf[..n]);
            size += n as u64;
            encoder.write_all(&buf[..n])?;
        }
        let counted = encoder.finish()?;
        let compressed = counted.written;
        let mut descriptor = Vec::with_capacity(16);
        descriptor.extend(0x0807_4b50u32.to_le_bytes());
        descriptor.extend(crc.sum().to_le_bytes());
        descriptor.extend((compressed as u32).to_le_bytes());
        descriptor.extend((size as u32).to_le_bytes());
        out.write_all(&descriptor)?;
        offset += header.len() as u64 + compressed + descriptor.len() as u64;
        central.push(Central { name, crc: crc.sum(), compressed: compressed as u32, size: size as u32, method: 8, offset: start as u32 });
    }
    let directory_start = offset;
    for entry in &central {
        let mut h = Vec::with_capacity(46 + entry.name.len());
        h.extend(0x0201_4b50u32.to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(0x0808u16.to_le_bytes());
        h.extend(entry.method.to_le_bytes());
        h.extend(DOS_TIME.to_le_bytes());
        h.extend(DOS_DATE.to_le_bytes());
        h.extend(entry.crc.to_le_bytes());
        h.extend(entry.compressed.to_le_bytes());
        h.extend(entry.size.to_le_bytes());
        h.extend((entry.name.len() as u16).to_le_bytes());
        h.extend([0u8; 12]);
        h.extend(entry.offset.to_le_bytes());
        h.extend(&entry.name);
        out.write_all(&h)?;
        offset += h.len() as u64;
    }
    let mut end = Vec::with_capacity(22);
    end.extend(0x0605_4b50u32.to_le_bytes());
    end.extend([0u8; 4]);
    end.extend((central.len() as u16).to_le_bytes());
    end.extend((central.len() as u16).to_le_bytes());
    end.extend(((offset - directory_start) as u32).to_le_bytes());
    end.extend((directory_start as u32).to_le_bytes());
    end.extend(0u16.to_le_bytes());
    out.write_all(&end)?;
    Ok(())
}
