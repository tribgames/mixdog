#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! A folder as a ZIP32 archive of its work files (port of `zip-folder.ts`).
//! Inside a git work tree the file list is git's own verdict (`ls-files -co
//! --exclude-standard`, asked of the SCM engine; untracked files stay, ignored ones
//! go); outside git it leaves out well-known generated folders. Every nested
//! repository, submodule and linked folder is judged by its own rules. A link is
//! packed under its own name when its real location is inside the folder and not a
//! folder the walk is already inside. Directory reads run as maintenance-lane jobs;
//! the entries are Node's (`zipListedFiles`): each file read whole (the caps bound it),
//! deflated only when that is smaller, else stored, sizes in the local header; names
//! are UTF-8 and the timestamp is fixed so the same folder zips identically.

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
use crate::nodeerr::AtPath;
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
    WsError::new(Reason::FolderTooLarge { files, bytes }, format!("The folder is too large to zip. ({files} files, {bytes} bytes)"))
}

/// Node's `writeUInt16LE` / `writeUInt32LE` of a value past the field: the `RangeError` (`ERR_OUT_OF_RANGE`) they throw, so the archive
/// fails instead of carrying a cut header field.
fn out_of_range(value: u64, max: u64) -> WsError {
    // `addNumericalSeparator`: an integer past 2^32 is written in groups of three with `_`.
    let digits = value.to_string();
    let received = if value > 1 << 32 {
        let mut grouped = String::new();
        for (at, digit) in digits.chars().enumerate() {
            if at > 0 && (digits.len() - at) % 3 == 0 {
                grouped.push('_');
            }
            grouped.push(digit);
        }
        grouped
    } else {
        digits
    };
    WsError::coded("ERR_OUT_OF_RANGE", format!("The value of \"value\" is out of range. It must be >= 0 and <= {max}. Received {received}"))
}

fn u16_field(value: u64) -> WsResult<u16> {
    u16::try_from(value).map_err(|_| out_of_range(value, u64::from(u16::MAX)))
}

fn u32_field(value: u64) -> WsResult<u32> {
    u32::try_from(value).map_err(|_| out_of_range(value, u64::from(u32::MAX)))
}

/// Node's `open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`: off Windows a final component swapped to a link is `ELOOP` and a swapped-in
/// FIFO does not block; on Windows neither flag exists, and the identity check after opening covers both.
fn open_listed(path: &Path) -> std::io::Result<File> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options.open(path)
}

fn is_loop(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    return error.raw_os_error() == Some(libc::ELOOP);
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
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
    /// Off Windows the file's identity from that same `lstat` (Node's `entryLocation`: dev and ino, nothing opened); on Windows an
    /// `lstat` gives none, so the walk takes it from the opened file.
    id: Option<FileId>,
}

/// Node's `entryLocation`: the entry's own `lstat` failing fails the walk; a link whose target cannot be resolved or read is left out.
fn entry_location(root: &Path, child: &Path) -> WsResult<Option<Location>> {
    let meta = std::fs::symlink_metadata(child).at("lstat", child)?;
    let (at, meta) = if meta.file_type().is_symlink() {
        let Ok(target) = canonical(child) else { return Ok(None) };
        if !is_within(root, &target) {
            return Ok(None);
        }
        let Ok(target_meta) = std::fs::symlink_metadata(&target) else { return Ok(None) };
        if target_meta.file_type().is_symlink() {
            return Ok(None);
        }
        (target, target_meta)
    } else {
        (child.to_path_buf(), meta)
    };
    #[cfg(unix)]
    let id = {
        use std::os::unix::fs::MetadataExt;
        Some(FileId { volume: meta.dev(), index: u128::from(meta.ino()) })
    };
    #[cfg(not(unix))]
    let id = None;
    Ok(Some(Location { at, is_dir: meta.is_dir(), is_file: meta.is_file(), size: meta.len(), id }))
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

/// Node's `readdir(absolute, { withFileTypes: true })`: a listing that fails fails the walk.
fn sorted_entries(dir: &Path) -> WsResult<Vec<(String, bool)>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir).at("scandir", dir)? {
        let entry = entry.at("scandir", dir)?;
        let is_dir = entry.file_type().at("scandir", dir)?.is_dir();
        entries.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
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
                let Some(location) = run(w.lanes.maintenance, w.cancel, move || entry_location(&root, &probe)).await?? else {
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
                    let id = match location.id {
                        Some(id) => id,
                        None => {
                            let at = location.at.clone();
                            run(w.lanes.maintenance, w.cancel, move || open_listed(&at).and_then(|f| file_id(&f)).at("open", &at)).await??
                        }
                    };
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
    name_len: u16,
    crc: u32,
    compressed: u32,
    size: u32,
    method: u16,
    offset: u32,
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
/// `between` is called before each file is opened (`zip.open`: where something else may happen to the folder after the walk listed it).
pub fn write_archive<W: Write + Seek>(out: &mut W, files: &[FolderFile], max_bytes: u64, between: &dyn Fn(&str)) -> WsResult<()> {
    let mut offset: u64 = 0;
    let mut central = Vec::with_capacity(files.len());
    let mut read_total = 0u64;
    for file in files {
        // Node's `readListedFile`: a failed open fails the archive, but for a final component swapped to a link (`ELOOP`), which is left
        // out; a handle that is not the regular file the walk saw, or not at its path, is left out too.
        between("zip.open");
        let handle = match open_listed(&file.absolute) {
            Ok(handle) => handle,
            Err(error) if is_loop(&error) => continue,
            Err(error) => return Err(crate::nodeerr::io_error(&error, "open", &file.absolute)),
        };
        let meta = handle.metadata().at("fstat", &file.absolute)?;
        if !meta.is_file() || file_id(&handle).at("fstat", &file.absolute)? != file.id || !is_canonical(&file.absolute) {
            continue;
        }
        let name = file.rel.as_bytes().to_vec();
        let start = offset;
        // The file whole, as Node's `readListedFile` reads it (the caps bound what is held).
        let mut raw = Vec::new();
        let mut reader = BufReader::new(handle);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            read_total += n as u64;
            if read_total > max_bytes {
                return Err(too_large(files.len() as u64, read_total));
            }
            raw.extend_from_slice(&buf[..n]);
        }
        let mut crc = Crc::new();
        crc.update(&raw);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw)?;
        let deflated = encoder.finish()?;
        // Node's `zipListedFiles`: deflated only when that is smaller, else stored; the sizes are in the local header (no descriptor).
        let (method, data) = if deflated.len() < raw.len() { (8u16, deflated) } else { (0u16, raw.clone()) };
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend(0x0403_4b50u32.to_le_bytes());
        header.extend(20u16.to_le_bytes());
        header.extend(0x0800u16.to_le_bytes());
        header.extend(method.to_le_bytes());
        header.extend(DOS_TIME.to_le_bytes());
        header.extend(DOS_DATE.to_le_bytes());
        header.extend(crc.sum().to_le_bytes());
        let (compressed, size) = (u32_field(data.len() as u64)?, u32_field(raw.len() as u64)?);
        let (name_len, at) = (u16_field(name.len() as u64)?, u32_field(start)?);
        header.extend(compressed.to_le_bytes());
        header.extend(size.to_le_bytes());
        header.extend(name_len.to_le_bytes());
        header.extend(0u16.to_le_bytes());
        header.extend(&name);
        out.write_all(&header)?;
        out.write_all(&data)?;
        offset += header.len() as u64 + data.len() as u64;
        central.push(Central { name, name_len, crc: crc.sum(), compressed, size, method, offset: at });
    }
    let directory_start = offset;
    for entry in &central {
        let mut h = Vec::with_capacity(46 + entry.name.len());
        h.extend(0x0201_4b50u32.to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(20u16.to_le_bytes());
        h.extend(0x0800u16.to_le_bytes());
        h.extend(entry.method.to_le_bytes());
        h.extend(DOS_TIME.to_le_bytes());
        h.extend(DOS_DATE.to_le_bytes());
        h.extend(entry.crc.to_le_bytes());
        h.extend(entry.compressed.to_le_bytes());
        h.extend(entry.size.to_le_bytes());
        h.extend(entry.name_len.to_le_bytes());
        h.extend([0u8; 12]);
        h.extend(entry.offset.to_le_bytes());
        h.extend(&entry.name);
        out.write_all(&h)?;
        offset += h.len() as u64;
    }
    let mut end = Vec::with_capacity(22);
    end.extend(0x0605_4b50u32.to_le_bytes());
    end.extend([0u8; 4]);
    let entries = u16_field(central.len() as u64)?;
    end.extend(entries.to_le_bytes());
    end.extend(entries.to_le_bytes());
    end.extend(u32_field(offset - directory_start)?.to_le_bytes());
    end.extend(u32_field(directory_start)?.to_le_bytes());
    end.extend(0u16.to_le_bytes());
    out.write_all(&end)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's walk takes a file's identity from its `lstat` and opens nothing (`entryLocation`), so the walk lists a file it could not
    /// open, and a final path part swapped for a link after the walk is left out by the archive's `O_NOFOLLOW` open (`readListedFile`'s
    /// `ELOOP`), never failing the walk.
    #[cfg(unix)]
    #[test]
    fn the_walk_takes_identity_without_opening_and_a_link_swapped_in_after_it_is_left_out() {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let (a, b, other) = (root.join("a.txt"), root.join("b.txt"), root.join("other.txt"));
        std::fs::write(&a, "alpha").unwrap();
        std::fs::write(&b, "bravo").unwrap();
        std::fs::write(&other, "other").unwrap();
        std::fs::set_permissions(&a, std::fs::Permissions::from_mode(0o000)).unwrap();
        let location = entry_location(&root, &a).unwrap().expect("a listed file");
        let meta = std::fs::symlink_metadata(&a).unwrap();
        assert_eq!(location.id, Some(FileId { volume: meta.dev(), index: u128::from(meta.ino()) }));
        let listed = |rel: &str, at: &Path| {
            let location = entry_location(&root, at).unwrap().unwrap();
            FolderFile { rel: rel.into(), absolute: location.at, size: location.size, id: location.id.unwrap() }
        };
        let files = vec![listed("a.txt", &a), listed("b.txt", &b)];
        std::fs::remove_file(&a).unwrap();
        std::os::unix::fs::symlink(&other, &a).unwrap();
        let mut out = std::io::Cursor::new(Vec::new());
        write_archive(&mut out, &files, u64::MAX, &|_: &str| {}).unwrap();
        let archive = out.into_inner();
        let named = |name: &str| archive.windows(name.len()).any(|w| w == name.as_bytes());
        assert!(!named("a.txt") && named("b.txt"), "only b.txt is archived");
    }

    /// A field past its width fails the archive with the `RangeError` Node's `writeUInt16LE` / `writeUInt32LE` throw (texts taken from
    /// Node 22's own throw), never a cut value.
    #[test]
    fn a_header_field_past_its_width_fails_as_nodes_write_throws() {
        assert_eq!(u16_field(65_535).unwrap(), u16::MAX);
        let name = u16_field(70_000).unwrap_err();
        assert_eq!((name.reason.code(), name.message.as_str()), ("ERR_OUT_OF_RANGE", "The value of \"value\" is out of range. It must be >= 0 and <= 65535. Received 70000"));
        let size = u32_field((1 << 32) + 5).unwrap_err();
        assert_eq!(size.message, "The value of \"value\" is out of range. It must be >= 0 and <= 4294967295. Received 4_294_967_301");
    }
}
