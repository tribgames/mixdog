//! Replaying a record's patches: the `git apply` that undoes (reverse) or reapplies (forward) a
//! turn's own writes, all-or-nothing (Node `turn-changes.mjs`, `applyTurnChangeFiles`).

use mixdog_core_api::turn_review::ReviewError;
use serde_json::Value;

use super::nodepath;
use super::patch::Section;
use super::patch::change_patch_buffer;
use super::patch::change_path_key;
use super::patch::clean;
use super::patch::obj_str;
use super::patch::safe_change_path;
use super::patch::split_patch_sections;
use super::ports::APPLY_TIMEOUT;
use super::ports::GitOptions;
use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::review_diff::Obj;

/// The scope of a replay: the directory the patches were taken against and how they were taken.
pub struct ReplayRoot<'a> {
    pub root: &'a str,
    pub kind: &'a str,
    pub counts: &'a str,
}

/// The object format (`sha1`/`sha256`) `git apply` hashes blobs with in `root`: the repository's
/// own, or sha1 outside any repository.
pub async fn repository_object_format(git: &dyn ReviewGit, root: &str) -> &'static str {
    let args = vec!["rev-parse".to_owned(), "--show-object-format".to_owned()];
    match git.run_with(root, &args, Vec::new(), &GitOptions::timeout(APPLY_TIMEOUT)).await {
        Ok(result) if result.code == 0 && clean(&String::from_utf8_lossy(&result.stdout)) == "sha256" => "sha256",
        _ => "sha1",
    }
}

fn mismatch(path: &str) -> ReviewError {
    ReviewError::new(format!("{path} has a recorded patch for a different path"))
}

/// Every path a stored patch touches must be exactly the recorded file's. Several sections are the
/// file's own segments in write order: each starts where the one before ended (a foreign edit in
/// between stays out of both), from the recorded old path to its current one.
fn assert_patch_matches_file(file: &Obj, buffer: &[u8]) -> Result<Vec<Section>, ReviewError> {
    let path = obj_str(file, "path");
    let sections = split_patch_sections(buffer);
    if sections.is_empty() {
        return Err(ReviewError::new(format!("{path} has a malformed recorded patch")));
    }
    let old_path = obj_str(file, "oldPath");
    if sections.len() > 1 {
        let mut at: String = if old_path.is_empty() { path.to_owned() } else { old_path.to_owned() };
        for section in &sections {
            for side in [&section.old_path, &section.new_path].into_iter().flatten() {
                if safe_change_path(side).is_none() {
                    return Err(mismatch(path));
                }
            }
            let start = section.old_path.as_ref().or(section.new_path.as_ref());
            if start.map(String::as_str) != Some(at.as_str()) {
                return Err(mismatch(path));
            }
            at = section.new_path.clone().or_else(|| section.old_path.clone()).unwrap_or_default();
        }
        if at != path {
            return Err(mismatch(path));
        }
        return Ok(sections);
    }
    let section = &sections[0];
    let status = obj_str(file, "status");
    let expected_old = if status == "A" { None } else { Some(if old_path.is_empty() { path } else { old_path }) };
    let expected_new = if status == "D" { None } else { Some(path) };
    for (actual, expected) in [(section.old_path.as_deref(), expected_old), (section.new_path.as_deref(), expected_new)] {
        let ok = match expected {
            None => actual.is_none(),
            Some(expected) => actual == Some(expected) && safe_change_path(actual.unwrap_or("")).is_some(),
        };
        if !ok {
            return Err(mismatch(path));
        }
    }
    Ok(sections)
}

/// The recorded root must still be the directory (and, for a Git record, the repository top level)
/// the patches were taken against.
async fn assert_recorded_root(disk: &dyn ReviewDisk, git: &dyn ReviewGit, record: &ReplayRoot<'_>) -> Result<String, ReviewError> {
    let root = clean(record.root);
    if root.is_empty() || !nodepath::is_absolute_host(root) {
        return Err(ReviewError::new("turn changes have no recorded root"));
    }
    if !disk.is_dir(std::path::Path::new(root)).await {
        return Err(ReviewError::new(format!("recorded root {root} is unavailable")));
    }
    if record.kind != "git" {
        return Ok(root.to_owned());
    }
    let args = vec!["rev-parse".to_owned(), "--show-toplevel".to_owned()];
    let result = git.run_with(root, &args, Vec::new(), &GitOptions::timeout(APPLY_TIMEOUT)).await.map_err(ReviewError::new)?;
    let top = clean(&String::from_utf8_lossy(&result.stdout)).to_owned();
    if result.code != 0 || top.is_empty() || change_path_key(&nodepath::resolve_host(&[&top])) != change_path_key(&nodepath::resolve_host(&[root])) {
        return Err(ReviewError::new(format!("recorded root {root} is no longer the repository top level")));
    }
    Ok(root.to_owned())
}

/// Apply (forward) or reverse-apply the given record files atomically in the recorded root: git
/// checks every hunk of every file before it writes any, so a conflict leaves the worktree
/// untouched. No `--reject`, no `--unsafe-paths`.
pub async fn apply_turn_change_files(
    disk: &dyn ReviewDisk,
    git: &dyn ReviewGit,
    record: &ReplayRoot<'_>,
    files: &[Obj],
    reverse: bool,
) -> Result<String, ReviewError> {
    let root = assert_recorded_root(disk, git, record).await?;
    let mut input: Vec<u8> = Vec::new();
    for file in files {
        let path = obj_str(file, "path");
        let old = obj_str(file, "oldPath");
        if safe_change_path(path).is_none() || (!old.is_empty() && safe_change_path(old).is_none()) {
            return Err(ReviewError::new(format!("{path} is not a safe recorded path")));
        }
        let buffer = match change_patch_buffer(file) {
            Some(b) if !b.is_empty() => b,
            _ => return Err(ReviewError::new(format!("{path} has no recorded patch"))),
        };
        let sections = assert_patch_matches_file(file, &buffer)?;
        // `git apply` takes a file's sections in input order, each on the result of the one before:
        // oldest first forward, newest first for an Undo.
        let ordered: Vec<&Section> = if reverse { sections.iter().rev().collect() } else { sections.iter().collect() };
        for section in ordered {
            let patch = &buffer[section.start..section.end];
            input.extend_from_slice(patch);
            if patch.last() != Some(&0x0a) {
                input.push(b'\n');
            }
        }
    }
    // An older Git record (worktree diff) replays with the repository's own line-ending
    // conversion, the semantics the shadow snapshot hashed with. A record of the session's own tool
    // bytes (`counts: 'own'`, any kind) holds raw bytes, so nothing may convert them.
    let raw_bytes = record.kind != "git" || record.counts == "own";
    let mut args: Vec<String> = Vec::new();
    if raw_bytes {
        args.extend(["-c", "core.autocrlf=false", "-c", "core.eol=lf"].map(String::from));
    }
    args.extend(["-c", "core.quotepath=false", "apply"].map(String::from));
    if reverse {
        args.push("-R".into());
    }
    args.extend(["--whitespace=nowarn", "-"].map(String::from));
    let result = git.run_with(&root, &args, input, &GitOptions::timeout(APPLY_TIMEOUT)).await.map_err(ReviewError::new)?;
    if result.code != 0 {
        let stderr = String::from_utf8_lossy(&result.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
        let detail = if !clean(&stderr).is_empty() {
            clean(&stderr).to_owned()
        } else if !clean(&stdout).is_empty() {
            clean(&stdout).to_owned()
        } else {
            format!("exit {}", result.code)
        };
        return Err(ReviewError::new(format!("{} failed; the worktree was not changed: {detail}", if reverse { "undo" } else { "reapply" })));
    }
    Ok(root)
}

/// The `record.files` of a record as owned objects.
pub fn record_files(record: &Obj) -> Vec<Obj> {
    record.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_object().cloned()).collect()).unwrap_or_default()
}
