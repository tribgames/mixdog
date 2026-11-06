//! A tracker's chains as record files (Node `turn-snapshot.mjs`, `editChangeFile` and the record
//! freeze): one replayable patch section per own segment, oldest first, or a view-only entry when
//! the edit lies outside the root or its bytes were never captured.

use serde_json::Value;

use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::named::named_change_patch;
use super::patch::RawFile;
use super::patch::TrackedFileInput;
use super::patch::tracked_change_file;
use super::review_diff::Obj;
use super::tracker::Edit;
use super::tracker::OwnStat;
use super::tracker::TrackerState;
use super::tracker::chain_edit;
use super::tracker::owned_paths_under;
use super::tracker::tracked_relative_path;
use super::tracker::view_path;

/// A record file for an edit the worktree root cannot replay: outside it, or too large/binary to
/// capture. Display-only (`viewPatch`), never undone.
fn untrackable_record_file(differ: &LineDiffer, edit: &Edit, root: &str, budget: &mut LineDiffBudget) -> RawFile {
    let path = view_path(root, &edit.end);
    let old_path = view_path(root, &edit.start);
    let named: Vec<_> = if edit.omitted {
        Vec::new()
    } else {
        edit.steps.iter().map(|step| named_change_patch(differ, &step.before.content, &step.after.content, &path, &path, budget)).collect()
    };
    let view_patch: String = named.iter().map(|n| n.patch.as_str()).collect();
    let mut meta = Obj::new();
    meta.insert("path".into(), Value::String(path.clone()));
    if old_path != path {
        meta.insert("oldPath".into(), Value::String(old_path));
    }
    meta.insert("status".into(), Value::String(edit.status.to_string()));
    meta.insert("additions".into(), Value::from(named.iter().map(|n| n.additions).sum::<u64>()));
    meta.insert("deletions".into(), Value::from(named.iter().map(|n| n.deletions).sum::<u64>()));
    if !view_patch.is_empty() {
        meta.insert("viewPatch".into(), Value::String(view_patch));
    }
    if edit.omitted {
        meta.insert("binary".into(), Value::Bool(true));
    }
    meta.insert("revertable".into(), Value::Bool(false));
    meta.insert(
        "reason".into(),
        Value::String(if edit.omitted { "binary/large file content was not captured" } else { "file is outside the recorded root" }.into()),
    );
    RawFile { meta, patch: None }
}

/// One chain's edit as a record file: one replayable patch section per own segment, oldest first,
/// or a view-only entry when it lies outside the root or its bytes were never captured.
pub fn edit_change_file(differ: &LineDiffer, edit: &Edit, root: &str, object_format: &str, budget: &mut LineDiffBudget) -> RawFile {
    if edit.omitted || !edit.inside {
        return untrackable_record_file(differ, edit, root, budget);
    }
    let mut sections: Vec<RawFile> = edit
        .steps
        .iter()
        .map(|step| {
            tracked_change_file(
                differ,
                &TrackedFileInput { old_path: &step.old_path, new_path: &step.new_path, before: &step.before.content, after: &step.after.content, object_format },
                budget,
            )
        })
        .collect();
    if sections.len() == 1 {
        return sections.remove(0);
    }
    let path = tracked_relative_path(root, &edit.end);
    let old_path = tracked_relative_path(root, &edit.start);
    let count = |sections: &[RawFile], key: &str| sections.iter().map(|s| s.meta.get(key).and_then(Value::as_u64).unwrap_or(0)).sum::<u64>();
    let mut meta = Obj::new();
    meta.insert("path".into(), Value::String(path.clone()));
    if old_path != path {
        meta.insert("oldPath".into(), Value::String(old_path));
    }
    meta.insert("status".into(), Value::String(edit.status.to_string()));
    meta.insert("additions".into(), Value::from(count(&sections, "additions")));
    meta.insert("deletions".into(), Value::from(count(&sections, "deletions")));
    if let Some(blocked) = sections.iter().find(|s| s.meta.get("revertable") != Some(&Value::Bool(true))) {
        meta.insert("revertable".into(), Value::Bool(false));
        meta.insert("reason".into(), blocked.meta.get("reason").cloned().unwrap_or(Value::Null));
        return RawFile { meta, patch: None };
    }
    meta.insert("revertable".into(), Value::Bool(true));
    let patch: Vec<u8> = sections.into_iter().flat_map(|s| s.patch.unwrap_or_default()).collect();
    RawFile { meta, patch: Some(patch) }
}

/// Files counted by the summed per-call deltas of their own writes.
pub fn with_own_counts_raw(files: Vec<RawFile>, find: impl Fn(&str) -> Option<OwnStat>) -> Vec<RawFile> {
    files
        .into_iter()
        .map(|mut file| {
            let path = file.meta.get("path").and_then(Value::as_str).unwrap_or("").to_owned();
            let old = file.meta.get("oldPath").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned);
            let hits: Vec<OwnStat> = [find(&path), old.and_then(|p| find(&p))].into_iter().flatten().collect();
            if !hits.is_empty() {
                file.meta.insert("additions".into(), Value::from(hits.iter().map(|h| h.additions).sum::<u64>()));
                file.meta.insert("deletions".into(), Value::from(hits.iter().map(|h| h.deletions).sum::<u64>()));
            }
            file
        })
        .collect()
}

/// The edits of a tracker's chains under `root` (those that change something).
pub fn tracker_edits(state: &TrackerState, root: &str) -> Vec<Edit> {
    state.chains.values().filter_map(|chain| chain_edit(chain, root)).collect()
}

/// A tracker whose content is gone: the files it owns, listed unrevertable.
pub fn invalid_tracker_files(state: &TrackerState, root: &str) -> Vec<RawFile> {
    owned_paths_under(root, &state.owned_paths)
        .into_iter()
        .map(|path| {
            let mut meta = Obj::new();
            meta.insert("path".into(), Value::String(path));
            meta.insert("status".into(), Value::String("M".into()));
            meta.insert("additions".into(), Value::from(0));
            meta.insert("deletions".into(), Value::from(0));
            meta.insert("revertable".into(), Value::Bool(false));
            meta.insert("reason".into(), Value::String("file content exceeded the undo tracking limit".into()));
            RawFile { meta, patch: None }
        })
        .collect()
}

/// Does any of `edits` replay binary content (so the repository's object format is needed)?
pub fn needs_object_format(edits: &[Edit]) -> bool {
    edits.iter().any(|edit| edit.binary && edit.inside && !edit.omitted)
}

