//! The boot-time retirement of a user's untouched copies of shipped definitions
//! (`session-runtime/services/seeds.mjs` `ensureStandaloneEnvironment`, `retireSeededSkillCopies`,
//! `retireSeededPackCopies`, with `runtime/shared/shipped-definitions.mjs` and `defaults/shipped-history.json`).
//!
//! The data dir should hold only copies the user changed. A copy equal to the current shipped version, or (once per
//! history stamp) to any past one, is moved, never deleted, into `<data>/backups/defaults-separation-<time>/`, so the
//! shipped version applies again. The pass logs nothing and swallows every failure of a move; the stamp marker is
//! written only when nothing failed.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on io lanes")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;

use super::ids::truthy;
use super::pack::Backup;
use super::pack::WorkflowPaths;
use super::pack::digest_bytes;
use super::pack::is_stray;
use super::pack::normalize_text;
use super::pack::pack_hash_from_dir;
use mixdog_core_base::support::write_atomic;

/// `HISTORY_MARKER_FILE`.
pub const HISTORY_MARKER_FILE: &str = ".shipped-history-retired";
/// `SEPARATION_VERSION`: bump to re-run the history-based retirement for every install.
const SEPARATION_VERSION: u32 = 1;
/// The sections of `EMPTY_HISTORY`, in its key order.
const HISTORY_SECTIONS: [&str; 5] = ["agents", "workflows", "outputStyles", "orchestration", "skills"];

type History = Map<String, Value>;

/// `sha256(text)` as `digest` takes it: the first 32 hex digits.
fn digest32(bytes: &[u8]) -> String {
    digest_bytes(bytes)[..32].to_owned()
}

/// `hashText(text)`.
fn hash_text(text: &str) -> String {
    digest32(normalize_text(text).as_bytes())
}

/// `fileHash(file)`: `None` when unreadable.
fn file_hash(file: &Path) -> Option<String> {
    std::fs::read(file).ok().map(|bytes| hash_text(&String::from_utf8_lossy(&bytes)))
}

/// `readTreeFiles(dir)`: every regular file below, with its `/` path; any unreadable entry fails the whole read.
fn read_tree_files(dir: &Path, prefix: &str) -> std::io::Result<Vec<(String, Vec<u8>)>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files.extend(read_tree_files(&entry.path(), &rel)?);
        } else if kind.is_file() {
            files.push((rel, std::fs::read(entry.path())?));
        }
    }
    Ok(files)
}

/// `hashTree(files)`: text files are normalised, anything that is not valid UTF-8 text hashes byte for byte, strays are ignored.
fn hash_tree(files: &[(String, Vec<u8>)]) -> String {
    let mut lines: Vec<String> = files
        .iter()
        .filter(|(rel, _)| !is_stray(rel.rsplit('/').next().unwrap_or(rel)))
        .map(|(rel, content)| match std::str::from_utf8(content) {
            Ok(text) if !content.contains(&0) => format!("{rel}\0{}", hash_text(text)),
            _ => format!("{rel}\0b{}", digest32(content)),
        })
        .collect();
    lines.sort_by_key(|line| line.encode_utf16().collect::<Vec<u16>>());
    digest32(lines.join("\n").as_bytes())
}

/// `treeHashFromDir(dir)`.
fn tree_hash_from_dir(dir: &Path) -> Option<String> {
    read_tree_files(dir, "").ok().map(|files| hash_tree(&files))
}

/// `loadShippedHistory(rootDir)`: `{ ...EMPTY_HISTORY, ...parsed }`; a missing or unparsable file is the empty history.
fn load_history(root: &Path) -> History {
    let mut history: History = HISTORY_SECTIONS.iter().map(|section| ((*section).to_owned(), Value::Object(Map::new()))).collect();
    let parsed = std::fs::read(root.join("defaults").join("shipped-history.json")).ok().and_then(|bytes| mixdog_js::json_parse(&String::from_utf8_lossy(&bytes)).ok());
    match parsed {
        Some(Value::Object(map)) => history.extend(map),
        Some(Value::Array(items)) => history.extend(items.into_iter().enumerate().map(|(at, item)| (at.to_string(), item))),
        Some(Value::String(text)) => {
            let units: Vec<u16> = text.encode_utf16().collect();
            history.extend(units.iter().enumerate().filter_map(|(at, unit)| Some((at.to_string(), Value::String(String::from_utf16(&[*unit]).ok()?)))));
        }
        _ => {}
    }
    history
}

/// `historyStamp(rootDir)`: the separation version and the digest of the history's text.
fn history_stamp(history: &History) -> String {
    format!("{SEPARATION_VERSION}:{}", digest32(mixdog_js::json_stringify(&Value::Object(history.clone())).as_bytes()))
}

/// `history[section][name]` spread into the list of known hashes: `...(history[section][name] || [])`. A `null` section throws
/// `TypeError` as reading a property of it does, and so does a value that is truthy but not iterable.
fn past_hashes(section: Option<&Value>, name: &str, site: &str) -> Result<Vec<String>, String> {
    let entry = match section {
        Some(Value::Null) => return Err(format!("Cannot read properties of null (reading '{name}')")),
        Some(Value::Object(map)) => map.get(name),
        _ => None,
    };
    match entry {
        Some(Value::Array(items)) => Ok(items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()),
        value if !truthy(value) => Ok(Vec::new()),
        // A string spreads into its characters, none of which is a hash.
        Some(Value::String(_)) => Ok(Vec::new()),
        _ => Err(format!("({site} || []) is not iterable")),
    }
}

/// `childNames(root, kind)`: the folders, or the `.md` files, below `root`.
fn child_names(root: &Path, folders: bool) -> Vec<std::ffi::OsString> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let Ok(kind) = entry.file_type() else { return false };
            if folders { kind.is_dir() } else { kind.is_file() && entry.file_name().to_string_lossy().to_lowercase().ends_with(".md") }
        })
        .map(|entry| entry.file_name())
        .collect()
}

/// `holdsOnlyEditorFiles(dir, allowed, entry)`: the copy holds the entry file and nothing but editor files and strays.
fn holds_only_editor_files(dir: &Path, allowed: &[&str], entry: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let Ok(entries) = entries.collect::<Result<Vec<_>, _>>() else { return false };
    let named = |item: &std::fs::DirEntry| item.file_name().to_string_lossy().into_owned();
    let is_file = |item: &std::fs::DirEntry| item.file_type().is_ok_and(|kind| kind.is_file());
    entries.iter().any(|item| is_file(item) && named(item) == entry) && entries.iter().all(|item| is_file(item) && (allowed.contains(&named(item).as_str()) || is_stray(&named(item))))
}

/// `retireSeededSkillCopies`: built-in skills (`<root>/defaults/skills/<name>/`) compared as a whole tree. Returns the names retired.
fn retire_skill_copies(lane: &InLane<MaintenanceIo>, paths: &WorkflowPaths, backup: &mut Backup<'_>, history: &History) -> Result<Vec<String>, String> {
    let target_root = paths.data.join("skills");
    if !target_root.exists() {
        return Ok(Vec::new());
    }
    let section = history.get("skills");
    let mut retired = Vec::new();
    // The bundle is a plugin root; walk the same skill roots the collector reads.
    for bundled_dir in mixdog_mcp::plugins::skills_roots(lane, &paths.root.join("defaults")) {
        for name in child_names(&bundled_dir, true) {
            let copy = target_root.join(&name);
            if !copy.exists() {
                continue;
            }
            let Some(copy_hash) = tree_hash_from_dir(&copy) else { continue };
            let text = name.to_string_lossy();
            let mut known = vec![tree_hash_from_dir(&bundled_dir.join(&name))];
            known.extend(past_hashes(section, &text, "history[entry.name]")?.into_iter().map(Some));
            if !known.contains(&Some(copy_hash)) {
                continue;
            }
            if backup.move_target(&copy) {
                retired.push(text.into_owned());
            }
        }
    }
    Ok(retired)
}

/// The kinds of pack: the folder under the install and data roots, the history section, the entry file and the editor's files.
const PACK_KINDS: [(&str, &str, &[&str]); 2] = [("workflows", "WORKFLOW.md", &["WORKFLOW.md"]), ("agents", "AGENT.md", &["AGENT.md", "agent.json"])];

/// `retireSeededPackCopies`: workflows, agents, output styles and orchestration modes. Returns what was retired as `<folder>/<name>`.
///
/// "Unchanged" for a pack means every loader-visible field matches (name, description, body, all other front matter and
/// manifest fields); only normalisation is ignored. A copy holding any file beyond the editor's own (added references, a
/// `.deleted` tombstone) is the user's and is never touched.
fn retire_pack_copies(paths: &WorkflowPaths, backup: &mut Backup<'_>, history: &History) -> Result<Vec<String>, String> {
    let mut retired = Vec::new();
    for (dir, entry, files) in PACK_KINDS {
        for name in child_names(&paths.data.join(dir), true) {
            let text = name.to_string_lossy().into_owned();
            let copy = paths.data.join(dir).join(&name);
            let Some(current) = pack_hash_from_dir(&paths.root.join(dir).join(&name), entry, &text) else { continue };
            if !holds_only_editor_files(&copy, files, entry) {
                continue;
            }
            let copy_hash = pack_hash_from_dir(&copy, entry, &text);
            let mut known = vec![current];
            known.extend(past_hashes(history.get(dir), &text, "history[kind.historyKey][name]")?);
            if !copy_hash.is_some_and(|hash| known.contains(&hash)) {
                continue;
            }
            if backup.move_target(&copy) {
                retired.push(format!("{dir}/{text}"));
            }
        }
    }
    for (dir, section) in [("output-styles", "outputStyles"), ("orchestration", "orchestration")] {
        for name in child_names(&paths.data.join(dir), false) {
            let text = name.to_string_lossy().into_owned();
            let Some(bundled) = file_hash(&paths.root.join(dir).join(&name)) else { continue };
            let copy = paths.data.join(dir).join(&name);
            let mut known = vec![bundled];
            known.extend(past_hashes(history.get(section), &text, &format!("history.{section}[name]"))?);
            if !file_hash(&copy).is_some_and(|hash| known.contains(&hash)) {
                continue;
            }
            if backup.move_target(&copy) {
                retired.push(format!("{dir}/{text}"));
            }
        }
    }
    Ok(retired)
}

/// `ensureStandaloneEnvironment({ rootDir, dataDir })` without the process environment it sets: the data dir is made, then copies
/// equal to the CURRENT shipped version are retired on every start, and the (larger) historical comparison runs once per stamp
/// (separation version + history content), the stamp being written to the marker file when no move failed.
pub fn retire_seeded_copies(lane: &InLane<MaintenanceIo>, paths: &WorkflowPaths, now: &dyn Fn() -> String) -> Result<(), String> {
    std::fs::create_dir_all(&paths.data).map_err(|error| error.to_string())?;
    let mut backup = Backup::new(&paths.data, now);
    let marker: PathBuf = paths.data.join(HISTORY_MARKER_FILE);
    let history = load_history(&paths.root);
    let stamp = history_stamp(&history);
    let recorded = std::fs::read(&marker).map(|bytes| js_trim(&String::from_utf8_lossy(&bytes)).to_owned()).unwrap_or_default();
    let include_history = recorded != stamp;
    // `EMPTY_HISTORY` when the historical comparison is not due.
    let used = if include_history { history } else { HISTORY_SECTIONS.iter().map(|section| ((*section).to_owned(), Value::Object(Map::new()))).collect() };
    retire_skill_copies(lane, paths, &mut backup, &used)?;
    retire_pack_copies(paths, &mut backup, &used)?;
    if include_history && backup.failures == 0 {
        // The marker only saves repeating the sweep; a failed write is not an error.
        let _ = write_atomic(lane, &marker, format!("{stamp}\n").as_bytes(), false);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
