//! `mixdog-relay renderer-delta --action=manifest|create|apply`: the renderer tree manifest, a delta between two trees and
//! the rebuild of a tree from a base and a delta. The manifest bytes are those `deploy/renderer-delta.mjs` wrote, because
//! the workstation creates deltas and the relay host checks them across releases: schemaVersion 1, files sorted the way
//! `String.prototype.localeCompare` sorts the full paths, and a tree hash over path, size and sha256 with NUL separators.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mixdog_fsio::Unlaned;
use mixdog_js::locale_compare;
use mixdog_js::nodepath::resolve_host;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js;

const SEP: char = std::path::MAIN_SEPARATOR;

/// Why a subcommand failed: a message the operator reads, or the file system's own error.
#[derive(Debug, thiserror::Error)]
pub enum DeltaError {
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

type Result<T> = std::result::Result<T, DeltaError>;

fn fail<T>(message: String) -> Result<T> {
    Err(DeltaError::Message(message))
}

/// One file of a manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// The manifest of a tree on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub tree_hash: String,
    pub files: Vec<FileEntry>,
}

/// A manifest read from a file and validated: `base` is the tree hash the delta was computed against, empty for a plain
/// manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidManifest {
    pub tree_hash: String,
    pub base: String,
    pub files: Vec<FileEntry>,
}

/// What `create` reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateResult {
    pub total_files: usize,
    pub total_bytes: u64,
    pub changed_files: usize,
    pub changed_bytes: u64,
    pub removed_files: usize,
    pub tree_hash: String,
}

/// What `apply` reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyResult {
    pub files: usize,
    pub bytes: u64,
    pub tree_hash: String,
}

impl Manifest {
    /// `JSON.stringify(manifest)`: the line `--action=manifest` prints.
    pub fn compact_json(&self) -> String {
        manifest_text(&self.tree_hash, &self.files, None, false)
    }

    /// `JSON.stringify({ ...manifest, base }, null, 2)` and a newline: the file `create` writes.
    pub fn manifest_file_text(&self, base: &str) -> String {
        let mut text = manifest_text(&self.tree_hash, &self.files, Some(base), true);
        text.push('\n');
        text
    }
}

impl CreateResult {
    pub fn json(&self) -> String {
        format!(
            "{{\"totalFiles\":{},\"totalBytes\":{},\"changedFiles\":{},\"changedBytes\":{},\"removedFiles\":{},\"treeHash\":\"{}\"}}",
            self.total_files, self.total_bytes, self.changed_files, self.changed_bytes, self.removed_files, self.tree_hash
        )
    }
}

impl ApplyResult {
    pub fn json(&self) -> String {
        format!("{{\"files\":{},\"bytes\":{},\"treeHash\":\"{}\"}}", self.files, self.bytes, self.tree_hash)
    }
}

fn manifest_text(tree_hash: &str, files: &[FileEntry], base: Option<&str>, pretty: bool) -> String {
    let (nl, sp) = if pretty { ("\n", " ") } else { ("", "") };
    let pad = |level: usize| if pretty { "  ".repeat(level) } else { String::new() };
    let mut out = String::from("{");
    out.push_str(&format!("{nl}{}\"schemaVersion\":{sp}1,", pad(1)));
    out.push_str(&format!("{nl}{}\"treeHash\":{sp}\"{tree_hash}\",", pad(1)));
    out.push_str(&format!("{nl}{}\"files\":{sp}", pad(1)));
    if files.is_empty() {
        out.push_str("[]");
    } else {
        out.push('[');
        for (index, file) in files.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&format!("{nl}{}{{{nl}{}\"path\":{sp}", pad(2), pad(3)));
            mixdog_js::json_quote(&file.path, &mut out);
            out.push_str(&format!(",{nl}{}\"size\":{sp}{},", pad(3), file.size));
            out.push_str(&format!("{nl}{}\"sha256\":{sp}\"{}\"{nl}{}}}", pad(3), file.sha256, pad(2)));
        }
        out.push_str(&format!("{nl}{}]", pad(1)));
    }
    if let Some(base) = base {
        out.push_str(&format!(",{nl}{}\"base\":{sp}\"{base}\"", pad(1)));
    }
    out.push_str(&format!("{nl}}}"));
    out
}

fn tree_hash(files: &[FileEntry]) -> String {
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.path.as_bytes());
        hash.update(b"\0");
        hash.update(file.size.to_string().as_bytes());
        hash.update(b"\0");
        hash.update(file.sha256.as_bytes());
        hash.update(b"\0");
    }
    hex(&hash.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// `safeRelativePath`: a slash-separated path with no empty, `.` or `..` part, not absolute and with no backslash.
fn is_safe_relative(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('/') && !value.contains('\\') && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn safe_relative(value: &str) -> Result<&str> {
    if is_safe_relative(value) {
        return Ok(value);
    }
    fail(format!("Unsafe renderer manifest path: {}", js::wire(&Value::String(value.to_owned()))))
}

/// `path.resolve(path)`.
fn resolve(path: &Path) -> String {
    resolve_host(&[&path.to_string_lossy()])
}

fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    path.extend(rel.split('/'));
    path
}

#[derive(PartialEq, Eq)]
enum PathType {
    Directory,
    File,
    Other,
    Missing,
}

fn path_type(path: &Path) -> Result<PathType> {
    match mixdog_fsio::metadata(&Unlaned, path) {
        Ok(metadata) if metadata.is_dir() => Ok(PathType::Directory),
        Ok(metadata) if metadata.is_file() => Ok(PathType::File),
        Ok(_) => Ok(PathType::Other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PathType::Missing),
        Err(error) => Err(error.into()),
    }
}

/// A file of a tree: its slash-separated path under the root and where it is.
struct Walked {
    rel: String,
    path: PathBuf,
}

/// Every file under `root` (none when it is missing). A symbolic link or anything but a file and a directory is an error.
fn walk(root: &Path) -> Result<Vec<Walked>> {
    let mut files = Vec::new();
    if path_type(root)? == PathType::Missing {
        return Ok(files);
    }
    walk_dir(root, "", &mut files)?;
    Ok(files)
}

fn walk_dir(dir: &Path, prefix: &str, files: &mut Vec<Walked>) -> Result<()> {
    let mut entries = Vec::new();
    for entry in mixdog_fsio::read_dir(&Unlaned, dir)? {
        let entry = entry?;
        let file_type = entry.file_type(&Unlaned)?;
        entries.push((entry.file_name().to_string_lossy().into_owned(), entry.path(), file_type));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    for (name, path, file_type) in entries {
        if file_type.is_symlink() {
            return fail(format!("Renderer tree contains a symbolic link: {}", path.display()));
        }
        let rel = format!("{prefix}{name}");
        if file_type.is_dir() {
            walk_dir(&path, &format!("{rel}/"), files)?;
        } else if file_type.is_file() {
            safe_relative(&rel)?;
            files.push(Walked { rel, path });
        } else {
            return fail(format!("Renderer tree contains an unsupported entry: {}", path.display()));
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = mixdog_fsio::File::open(&Unlaned, path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex(&hash.finalize()));
        }
        hash.update(&buffer[..read]);
    }
}

/// `buildRendererManifest`: the files of `root` sorted by `localeCompare` of their full paths, as Node sorts them.
pub fn build_manifest(root: &Path) -> Result<Manifest> {
    let resolved = resolve(root);
    let root = PathBuf::from(&resolved);
    let mut walked: Vec<(String, Walked)> = walk(&root)?
        .into_iter()
        .map(|file| {
            let native = file.rel.replace('/', &SEP.to_string());
            let key = if resolved.ends_with(SEP) { format!("{resolved}{native}") } else { format!("{resolved}{SEP}{native}") };
            (key, file)
        })
        .collect();
    walked.sort_by(|left, right| locale_compare(&left.0, &right.0));
    let mut files = Vec::with_capacity(walked.len());
    for (_, file) in walked {
        let size = mixdog_fsio::metadata(&Unlaned, &file.path)?.len();
        files.push(FileEntry { path: file.rel, size, sha256: hash_file(&file.path)? });
    }
    Ok(Manifest { tree_hash: tree_hash(&files), files })
}

fn is_safe_integer(number: f64) -> bool {
    number >= 0.0 && number.fract() == 0.0 && number <= 9_007_199_254_740_991.0
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `validateRendererManifest`.
pub fn validate_manifest(value: &Value) -> Result<ValidManifest> {
    let files = match (value.get("schemaVersion").and_then(Value::as_f64), value.get("files").and_then(Value::as_array)) {
        (Some(version), Some(files)) if version == 1.0 => files,
        _ => return fail("Renderer manifest is missing or incompatible.".to_owned()),
    };
    let mut seen = HashSet::new();
    let mut entries = Vec::with_capacity(files.len());
    for entry in files {
        let path = match entry.get("path") {
            Some(Value::String(path)) => safe_relative(path)?.to_owned(),
            other => {
                let shown = other.map_or_else(|| "undefined".to_owned(), js::wire);
                return fail(format!("Unsafe renderer manifest path: {shown}"));
            }
        };
        if !seen.insert(path.clone()) {
            return fail(format!("Duplicate renderer manifest path: {path}"));
        }
        let size = match entry.get("size").and_then(Value::as_f64) {
            Some(size) if is_safe_integer(size) => size as u64,
            _ => return fail(format!("Invalid renderer manifest size: {path}")),
        };
        let sha256 = match entry.get("sha256").and_then(Value::as_str) {
            Some(hash) if is_sha256(hash) => hash.to_owned(),
            _ => return fail(format!("Invalid renderer manifest hash: {path}")),
        };
        entries.push(FileEntry { path, size, sha256 });
    }
    entries.sort_by(|left, right| locale_compare(&left.path, &right.path));
    let expected = tree_hash(&entries);
    if value.get("treeHash").and_then(Value::as_str) != Some(expected.as_str()) {
        return fail("Renderer manifest tree hash does not match its file list.".to_owned());
    }
    let base = match value.get("base") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(base)) if base.is_empty() => String::new(),
        Some(Value::String(base)) if is_sha256(base) => base.clone(),
        Some(_) => return fail("Renderer manifest base hash is invalid.".to_owned()),
    };
    Ok(ValidManifest { tree_hash: expected, base, files: entries })
}

/// `readManifest`: a manifest file, parsed and validated.
pub fn read_manifest(path: &Path) -> Result<ValidManifest> {
    let bytes = mixdog_fsio::read(&Unlaned, path)?;
    match js::parse_bytes(&bytes) {
        Ok(value) => validate_manifest(&value),
        Err(error) => fail(error.to_string()),
    }
}

/// `rm(path, { recursive: true, force: true })`.
fn remove_all(path: &Path) -> Result<()> {
    let metadata = match mixdog_fsio::symlink_metadata(&Unlaned, path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let removed = if metadata.is_dir() {
        mixdog_fsio::remove_dir_all(&Unlaned, path)
    } else {
        mixdog_fsio::remove_file(&Unlaned, path).or_else(|error| mixdog_fsio::remove_dir(&Unlaned, path).map_err(|_| error))
    };
    match removed {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn create_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        mixdog_fsio::create_dir_all(&Unlaned, parent)?;
    }
    Ok(())
}

/// `writeJsonAtomic`: through a temporary file beside the target so a reader never sees half a manifest.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
    create_parent(path)?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    mixdog_fsio::write(&Unlaned, &temporary, text)?;
    mixdog_fsio::rename(&Unlaned, &temporary, path)?;
    Ok(())
}

/// `createRendererDelta`: copies the files of `root` that differ from the base manifest (all of them without one) into
/// `delta_dir` and writes the manifest of `root` with the base tree hash recorded.
pub fn create_delta(root: &Path, base_manifest: Option<&ValidManifest>, delta_dir: &Path, manifest_path: &Path) -> Result<CreateResult> {
    let root = PathBuf::from(resolve(root));
    let delta_dir = PathBuf::from(resolve(delta_dir));
    let current = build_manifest(&root)?;
    let empty_hash = tree_hash(&[]);
    let no_files: Vec<FileEntry> = Vec::new();
    let (base_hash, base_files) = match base_manifest {
        Some(base) => (base.tree_hash.as_str(), base.files.as_slice()),
        None => (empty_hash.as_str(), no_files.as_slice()),
    };
    let mut remaining: HashMap<&str, &FileEntry> = base_files.iter().map(|file| (file.path.as_str(), file)).collect();
    remove_all(&delta_dir)?;
    mixdog_fsio::create_dir_all(&Unlaned, &delta_dir)?;
    let (mut changed_bytes, mut changed_files) = (0u64, 0usize);
    for file in &current.files {
        let previous = remaining.remove(file.path.as_str());
        if previous.is_some_and(|previous| previous.size == file.size && previous.sha256 == file.sha256) {
            continue;
        }
        let destination = join_rel(&delta_dir, &file.path);
        create_parent(&destination)?;
        mixdog_fsio::copy(&Unlaned, join_rel(&root, &file.path), &destination)?;
        changed_bytes += file.size;
        changed_files += 1;
    }
    // A delta is only valid against the exact tree it was computed from, and `apply` refuses anything else.
    write_atomic(manifest_path, &current.manifest_file_text(base_hash))?;
    Ok(CreateResult {
        total_files: current.files.len(),
        total_bytes: current.files.iter().map(|file| file.size).sum(),
        changed_files,
        changed_bytes,
        removed_files: remaining.len(),
        tree_hash: current.tree_hash,
    })
}

fn clone_with_hardlinks(source: &Path, output: &Path) -> Result<()> {
    mixdog_fsio::create_dir_all(&Unlaned, output)?;
    for file in walk(source)? {
        let destination = join_rel(output, &file.rel);
        create_parent(&destination)?;
        mixdog_fsio::hard_link(&Unlaned, &file.path, &destination)?;
    }
    Ok(())
}

/// `cp(source, output, { recursive: true })` of a tree with no symbolic link in it; empty directories are kept.
fn copy_tree(source: &Path, output: &Path) -> Result<()> {
    mixdog_fsio::create_dir_all(&Unlaned, output)?;
    for entry in mixdog_fsio::read_dir(&Unlaned, source)? {
        let entry = entry?;
        let file_type = entry.file_type(&Unlaned)?;
        let (path, destination) = (entry.path(), output.join(entry.file_name()));
        if file_type.is_symlink() {
            return fail(format!("Renderer tree contains a symbolic link: {}", path.display()));
        } else if file_type.is_dir() {
            copy_tree(&path, &destination)?;
        } else if file_type.is_file() {
            mixdog_fsio::copy(&Unlaned, &path, &destination)?;
        } else {
            return fail(format!("Renderer tree contains an unsupported entry: {}", path.display()));
        }
    }
    Ok(())
}

/// `replaceHardlinkedFile`: replacing through a temporary file breaks the hardlink instead of truncating the installed
/// base file that a rollback still depends on.
fn replace_hardlinked_file(source: &Path, destination: &Path) -> Result<()> {
    create_parent(destination)?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", destination.display(), std::process::id()));
    remove_all(&temporary)?;
    let replaced = copy_then_rename(source, &temporary, destination);
    remove_all(&temporary)?;
    replaced
}

fn copy_then_rename(source: &Path, temporary: &Path, destination: &Path) -> Result<()> {
    mixdog_fsio::copy(&Unlaned, source, temporary)?;
    remove_all(destination)?;
    mixdog_fsio::rename(&Unlaned, temporary, destination)?;
    Ok(())
}

/// `applyRendererDelta`: rebuilds the manifest's tree in `output_dir` from `base_dir` and the delta, and only on top of the
/// exact base the manifest names.
pub fn apply_delta(base_dir: &Path, delta_dir: &Path, manifest: &ValidManifest, output_dir: &Path, hardlink_base: bool) -> Result<ApplyResult> {
    let base_dir = PathBuf::from(resolve(base_dir));
    let delta_dir = PathBuf::from(resolve(delta_dir));
    let output_dir = PathBuf::from(resolve(output_dir));
    // Without this gate a cached delta of an older release rebuilds that older renderer, and every later hash check,
    // computed from the same rebuild, would confirm it.
    if !manifest.base.is_empty() {
        let state = build_manifest(&base_dir)?;
        if state.tree_hash != manifest.base {
            return fail(format!("Renderer delta base failed verification: expected {}, found {}", manifest.base, state.tree_hash));
        }
    }
    let target: HashMap<&str, &FileEntry> = manifest.files.iter().map(|file| (file.path.as_str(), file)).collect();
    remove_all(&output_dir)?;
    if path_type(&base_dir)? == PathType::Directory {
        if hardlink_base {
            clone_with_hardlinks(&base_dir, &output_dir)?;
        } else {
            copy_tree(&base_dir, &output_dir)?;
        }
    } else {
        mixdog_fsio::create_dir_all(&Unlaned, &output_dir)?;
    }
    for file in walk(&output_dir)? {
        if !target.contains_key(file.rel.as_str()) {
            remove_all(&file.path)?;
        }
    }
    for file in walk(&delta_dir)? {
        let Some(expected) = target.get(file.rel.as_str()) else {
            return fail(format!("Renderer delta contains an unlisted file: {}", file.rel));
        };
        let size = mixdog_fsio::metadata(&Unlaned, &file.path)?.len();
        if size != expected.size || hash_file(&file.path)? != expected.sha256 {
            return fail(format!("Renderer delta file failed verification: {}", file.rel));
        }
        let destination = join_rel(&output_dir, &file.rel);
        if hardlink_base {
            replace_hardlinked_file(&file.path, &destination)?;
        } else {
            create_parent(&destination)?;
            mixdog_fsio::copy(&Unlaned, &file.path, &destination)?;
        }
    }
    let applied = build_manifest(&output_dir)?;
    if applied.tree_hash != manifest.tree_hash {
        return fail(format!("Renderer reconstruction failed verification: expected {}, got {}", manifest.tree_hash, applied.tree_hash));
    }
    Ok(ApplyResult { files: applied.files.len(), bytes: applied.files.iter().map(|file| file.size).sum(), tree_hash: applied.tree_hash })
}

enum Arg {
    Flag,
    Text(String),
}

/// `parseArgs`: `--key=value` is text, anything else is the entry without its leading `--` as a flag; the last wins.
fn parse_args(argv: &[String]) -> HashMap<String, Arg> {
    argv.iter()
        .map(|entry| {
            let stripped = entry.strip_prefix("--");
            match stripped.and_then(|rest| rest.find('=').filter(|at| *at >= 1).map(|at| (&rest[..at], &rest[at + 1..]))) {
                Some((key, value)) => (key.to_owned(), Arg::Text(value.to_owned())),
                None => (stripped.unwrap_or(entry.as_str()).to_owned(), Arg::Flag),
            }
        })
        .collect()
}

/// `resolve(args[name])`: a missing or valueless option is the type error Node's `resolve` throws.
fn path_arg(args: &HashMap<String, Arg>, name: &str) -> Result<PathBuf> {
    match args.get(name) {
        Some(Arg::Text(text)) => Ok(PathBuf::from(resolve_host(&[text]))),
        other => {
            let received = if other.is_some() { "true" } else { "undefined" };
            fail(format!("The \"path\" argument must be of type string. Received {received} (--{name})"))
        }
    }
}

fn run(args: &HashMap<String, Arg>) -> Result<String> {
    match args.get("action") {
        Some(Arg::Text(action)) if action == "manifest" => Ok(build_manifest(&path_arg(args, "root")?)?.compact_json()),
        Some(Arg::Text(action)) if action == "create" => {
            let base = match args.get("base") {
                Some(Arg::Text(text)) if text.is_empty() => None,
                Some(_) => Some(read_manifest(&path_arg(args, "base")?)?),
                None => None,
            };
            let result = create_delta(&path_arg(args, "root")?, base.as_ref(), &path_arg(args, "delta")?, &path_arg(args, "manifest")?)?;
            Ok(result.json())
        }
        Some(Arg::Text(action)) if action == "apply" => {
            let manifest = read_manifest(&path_arg(args, "manifest")?)?;
            let hardlink_base = match args.get("hardlink-base") {
                Some(Arg::Flag) => true,
                Some(Arg::Text(text)) => text.eq_ignore_ascii_case("true"),
                None => false,
            };
            let result = apply_delta(&path_arg(args, "base")?, &path_arg(args, "delta")?, &manifest, &path_arg(args, "output")?, hardlink_base)?;
            Ok(result.json())
        }
        Some(Arg::Text(action)) if !action.is_empty() => fail(format!("Unknown renderer-delta action: {action}")),
        Some(Arg::Flag) => fail("Unknown renderer-delta action: true".to_owned()),
        _ => fail("Unknown renderer-delta action: (missing)".to_owned()),
    }
}

/// The subcommand: prints one JSON line on stdout, or the reason on stderr and exit code 1.
pub fn main(args: &[String]) -> ExitCode {
    match run(&parse_args(args)) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("renderer-delta: {error}");
            ExitCode::FAILURE
        }
    }
}
