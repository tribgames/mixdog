//! What the turn review answers (Node `turn-snapshot.mjs`, `turn-review-reply.mjs`): the latest
//! turn's review, one file's whole patch, the historical per-turn changes, and the reply's tag.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use indexmap::IndexMap;
use indexmap::IndexSet;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::Reply;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_js::json_stringify;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::line_diff::LineDiffBudget;
use super::named::named_change_patch;
use super::nodepath;
use super::patch::change_display_patch;
use super::patch::change_path_key;
use super::patch::clean;
use super::patch::count_of;
use super::patch::file_state;
use super::patch::find_change_file;
use super::patch::is_unmeasured_file;
use super::patch::obj_str;
use super::patch::patch_of;
use super::patch::split_patch_sections;
use super::patch::turn_changes_reply;
use super::patch::unknown_state_change_file;
use super::review_diff::Obj;
use super::review_diff::REVIEW_FILE_PATCH_SHOW_MAX_BYTES;
use super::review_diff::ReviewPatchBudget;
use super::review_diff::file_patch_reply;
use super::review_diff::patch_omitted_file;
use super::review_diff::review_diff_too_large;
use super::review_diff::review_section_truncated;
use super::service::Inner;
use super::service::Tracker;
use super::service::pending_key;
use super::store::Record;
use super::tracker::chain_edit;
use super::tracker::path_key;
use super::tracker::render_step;
use super::tracker::tracker_view;
use super::tracker::view_path;
use crate::turn_review::ports::CurrentText;

// A turn review kind whose summary leaves the patch text out: every kind carries its files with
// their counts (summed own-write deltas), so a collapsed bar never needs the patch text.
const SUMMARY_KINDS: [&str; 3] = ["worktree", "scoped", "tool"];

const IGNORED_CHANGE_CACHE_LIMIT: usize = 200;

pub(super) type IgnoredCache = std::sync::Mutex<IndexMap<String, IndexSet<String>>>;

/// A review reply's files and patch under the per-file caps: a file whose sections were cut for
/// display, or pass the per-file cap or the total left, is listed with its counts but without its
/// patch. `diffTooLarge` once nothing fit.
pub(super) fn per_file_review(files: Vec<Obj>, patch: &str) -> (Vec<Obj>, String, bool) {
    struct Entry {
        parts: Vec<(usize, usize)>,
        bytes: usize,
        cut: bool,
    }
    let bytes = patch.as_bytes();
    let mut sections: IndexMap<String, Entry> = IndexMap::new();
    for section in split_patch_sections(bytes) {
        let key = path_key(section.new_path.as_deref().or(section.old_path.as_deref()).unwrap_or(""));
        let entry = sections.entry(key).or_insert(Entry { parts: Vec::new(), bytes: 0, cut: false });
        entry.parts.push((section.start, section.end));
        entry.bytes += section.end - section.start;
        entry.cut = entry.cut || review_section_truncated(&String::from_utf8_lossy(&bytes[section.start..section.end]));
    }
    let mut budget = ReviewPatchBudget::default();
    let mut omitted: IndexSet<String> = IndexSet::new();
    let mut kept: Vec<u8> = Vec::new();
    for (key, entry) in &sections {
        if !entry.cut && budget.admit(entry.bytes) {
            for (start, end) in &entry.parts {
                kept.extend_from_slice(&bytes[*start..*end]);
            }
        } else {
            omitted.insert(key.clone());
        }
    }
    let shaped: Vec<Obj> = files
        .into_iter()
        .map(|file| if omitted.contains(&path_key(obj_str(&file, "path"))) { patch_omitted_file(file) } else { file })
        .collect();
    let text = String::from_utf8_lossy(&kept).into_owned();
    let too_large = review_diff_too_large(&shaped, &text);
    (shaped, text, too_large)
}

fn files_value(files: Vec<Obj>) -> Value {
    Value::Array(files.into_iter().map(Value::Object).collect())
}

fn record_patch_omitted(file: &Obj, patch: &str) -> bool {
    file.get("patchOmitted") == Some(&Value::Bool(true)) && patch.is_empty()
}

/// `value` as `findChangeFile` reads it: relative to the record's root.
fn relative_record_path(record: &Obj, value: &str) -> String {
    let target = clean(value).replace('\\', "/");
    let root = obj_str(record, "root");
    if nodepath::is_absolute_host(&target) && !root.is_empty() {
        return nodepath::relative_host(root, &nodepath::resolve_host(&[&target])).replace('\\', "/");
    }
    target
}

impl Inner {
    pub(super) fn public_agent_reviews(&self, owner: &str) -> Value {
        let reg = self.reg();
        let Some(turn) = reg.turns.get(clean(owner)) else { return Value::Array(Vec::new()) };
        Value::Array(
            turn.agents
                .values()
                .map(|row| {
                    let mut o = Obj::new();
                    o.insert("sessionId".into(), Value::String(row.session_id.clone()));
                    o.insert("agent".into(), row.agent.clone().map_or(Value::Null, Value::String));
                    o.insert("tag".into(), row.tag.clone().map_or(Value::Null, Value::String));
                    o.insert("patch".into(), Value::String(row.patch.clone()));
                    Value::Object(o)
                })
                .collect(),
        )
    }

    fn mark_unknown_states(files: &[Value], keys: &IndexSet<String>) -> Vec<Value> {
        files
            .iter()
            .map(|entry| match entry.as_object() {
                Some(file) if keys.contains(&change_path_key(obj_str(file, "path"))) => Value::Object(unknown_state_change_file(file)),
                _ => entry.clone(),
            })
            .collect()
    }

    pub(super) fn with_unknown_change_states(&self, owner: &str, record: Option<Record>) -> Option<Record> {
        let mut record = record?;
        let keys = self.reg().unknown_states.get(&pending_key(owner, obj_str(&record, "checkpointId"))).cloned();
        if let Some(keys) = keys {
            let files = record.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
            record.insert("files".into(), Value::Array(Self::mark_unknown_states(&files, &keys)));
        }
        Some(record)
    }

    /// The latest turn on record: the stored Git review's, else the newest change record's.
    pub(super) async fn latest_recorded_checkpoint(&self, owner: &str) -> String {
        if let Some(snapshot) = self.store.load_turn_snapshot_record(owner).await {
            let id = clean(obj_str(&snapshot, "checkpointId"));
            if !id.is_empty() {
                return id.to_owned();
            }
        }
        let records = self.store.load_turn_change_records(owner).await;
        records.last().map(|r| clean(obj_str(r, "checkpointId")).to_owned()).unwrap_or_default()
    }

    /// The latest turn's change record, its unrecordable file states applied.
    pub(super) async fn latest_turn_record(&self, owner: &str) -> Option<Record> {
        let checkpoint = self.latest_recorded_checkpoint(owner).await;
        let stored = if checkpoint.is_empty() { None } else { self.store.load_turn_change_record(owner, &checkpoint).await };
        self.with_unknown_change_states(owner, stored)
    }

    /// The latest turn's review once its tracker is gone (the next turn replaced it, the cache
    /// evicted it, the runtime restarted): its change record's files still applied, with their own
    /// counts and recorded patches, never a worktree diff.
    async fn recorded_turn_review(&self, owner: &str, omit_patch: bool) -> Option<Obj> {
        let record = self.latest_turn_record(owner).await?;
        let files: Vec<Obj> = record
            .get("files")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_object).filter(|f| file_state(f) == "applied").cloned().collect())
            .unwrap_or_default();
        let patches: Vec<String> = files.iter().map(change_display_patch).collect();
        let rows: Vec<Obj> = files
            .iter()
            .zip(&patches)
            .map(|(file, patch)| {
                let mut row = Obj::new();
                row.insert("path".into(), file.get("path").cloned().unwrap_or(Value::Null));
                if !obj_str(file, "oldPath").is_empty() {
                    row.insert("oldPath".into(), file.get("oldPath").cloned().unwrap_or(Value::Null));
                }
                row.insert("status".into(), file.get("status").cloned().unwrap_or(Value::Null));
                row.insert("additions".into(), count_of(file, "additions"));
                row.insert("deletions".into(), count_of(file, "deletions"));
                if super::patch::obj_true(file, "binary") {
                    row.insert("binary".into(), Value::Bool(true));
                }
                // The record dropped its patch for size: still listed too large.
                if record_patch_omitted(file, patch) { patch_omitted_file(row) } else { row }
            })
            .collect();
        let (files, patch, too_large) = if omit_patch { (rows, String::new(), false) } else { per_file_review(rows, &patches.concat()) };
        let mut reply = Obj::new();
        reply.insert("supported".into(), Value::Bool(true));
        reply.insert("files".into(), files_value(files));
        reply.insert("patch".into(), Value::String(patch));
        if omit_patch {
            reply.insert("patchOmitted".into(), Value::Bool(true));
        }
        if too_large {
            reply.insert("diffTooLarge".into(), Value::Bool(true));
        }
        reply.insert("snapshotKind".into(), Value::String("scoped".into()));
        reply.insert("revertMode".into(), Value::String("scoped".into()));
        reply.insert("checkpointId".into(), Value::String(clean(obj_str(&record, "checkpointId")).to_owned()));
        reply.insert("patchTruncated".into(), Value::Bool(false));
        reply.insert("authoritative".into(), Value::Bool(true));
        reply.insert("agents".into(), self.public_agent_reviews(owner));
        reply.insert("reason".into(), Value::String("recorded".into()));
        Some(reply)
    }

    /// One listed file's whole display patch in the tracker's view, rendered on its own instead of
    /// within the reply's caps; `""` when the view lists no such file.
    fn tracker_file_patch(&self, tracker: &Tracker, path: &str) -> String {
        let root = tracker.patch_root("");
        let key = path_key(path);
        let mut budget = LineDiffBudget::default();
        let state = tracker.lock();
        for chain in state.chains.values() {
            let Some(edit) = chain_edit(chain, &root.root) else { continue };
            if (root.git && !edit.inside) || path_key(&view_path(&root.root, &edit.end)) != key {
                continue;
            }
            return edit.steps.iter().map(|step| render_step(&self.differ, step, &root.root, &mut budget).text).collect();
        }
        String::new()
    }

    /// One file of the latest turn's review with its whole patch, up to the file-patch read's cap:
    /// the file a reply listed `patchOmitted`.
    pub(super) async fn turn_review_file_patch(&self, session_id: &str, file: &str) -> Obj {
        let path = clean(file).replace('\\', "/");
        if self.cfg.disabled {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(false));
            o.insert("path".into(), Value::String(path));
            o.insert("patch".into(), Value::String(String::new()));
            return o;
        }
        let owner = clean(session_id).to_owned();
        if owner.is_empty() || path.is_empty() {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(true));
            o.insert("path".into(), Value::String(path));
            o.insert("patch".into(), Value::String(String::new()));
            return o;
        }
        if let Some(tracker) = self.tracker_of(&owner) {
            let patch = self.tracker_file_patch(&tracker, &path);
            return file_patch_reply(&path, &patch, REVIEW_FILE_PATCH_SHOW_MAX_BYTES);
        }
        // Only a file the recorded review lists, by its own path.
        let record = self.latest_turn_record(&owner).await;
        let matched = record.as_ref().and_then(|r| find_change_file(r, &path));
        let Some((record, matched)) = record.as_ref().zip(matched) else { return file_patch_reply(&path, "", REVIEW_FILE_PATCH_SHOW_MAX_BYTES) };
        if file_state(matched) != "applied" || change_path_key(obj_str(matched, "path")) != change_path_key(&relative_record_path(record, &path)) {
            return file_patch_reply(&path, "", REVIEW_FILE_PATCH_SHOW_MAX_BYTES);
        }
        let patch = change_display_patch(matched);
        if record_patch_omitted(matched, &patch) {
            return patch_omitted_file(file_patch_reply(&path, "", REVIEW_FILE_PATCH_SHOW_MAX_BYTES));
        }
        file_patch_reply(&path, &patch, REVIEW_FILE_PATCH_SHOW_MAX_BYTES)
    }

    /// The Lead turn's own-file diff plus attributed child reviews, and `historyTurns`.
    pub(super) async fn turn_review_diff(&self, session_id: &str, summary: bool) -> Obj {
        if self.cfg.disabled {
            let mut o = Obj::new();
            o.insert("supported".into(), Value::Bool(false));
            o.insert("files".into(), Value::Array(Vec::new()));
            o.insert("patch".into(), Value::String(String::new()));
            o.insert("agents".into(), Value::Array(Vec::new()));
            o.insert("historyTurns".into(), Value::from(0));
            return o;
        }
        let owner = clean(session_id).to_owned();
        let mut review = self.read_turn_review(&owner, summary).await;
        let records = self.store.load_turn_change_records(&owner).await;
        review.insert("historyTurns".into(), Value::from(records.len()));
        review
    }

    async fn read_turn_review(&self, owner: &str, summary: bool) -> Obj {
        let tracker = self.tracker_of(owner);
        if tracker.is_none() {
            if let Some(recorded) = self.recorded_turn_review(owner, summary).await {
                return recorded;
            }
        }
        let (turn_generation, turn_checkpoint) = {
            let reg = self.reg();
            match reg.turns.get(owner) {
                Some(turn) => (Some(turn.generation), Some(turn.checkpoint_id.clone())),
                None => (None, None),
            }
        };
        let view = tracker.as_ref().map(|t| {
            let root = t.patch_root("");
            let mut state = t.lock();
            tracker_view(&self.differ, &mut state, &root, &mut LineDiffBudget::default())
        });
        let worktree = tracker.as_ref().is_some_and(|t| !t.contended() && t.snapshot().is_some());
        let mut revert_mode = "";
        if worktree {
            revert_mode = "worktree";
        } else if tracker.as_ref().is_some_and(|t| t.lock().valid) && view.as_ref().is_some_and(|v| !v.files.is_empty()) {
            revert_mode = "tracked";
        }
        let (files, patch, too_large) = per_file_review(view.as_ref().map(|v| v.files.clone()).unwrap_or_default(), view.as_ref().map_or("", |v| v.patch.as_str()));
        let checkpoint = match turn_checkpoint.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => clean(c).to_owned(),
            None => tracker.as_ref().map(|t| clean(&t.meta.checkpoint_id).to_owned()).unwrap_or_default(),
        };
        let mut reply = Obj::new();
        reply.insert("supported".into(), Value::Bool(true));
        reply.insert("files".into(), files_value(files));
        reply.insert("patch".into(), Value::String(patch));
        if too_large {
            reply.insert("diffTooLarge".into(), Value::Bool(true));
        }
        reply.insert("snapshotKind".into(), Value::String(if worktree { "worktree" } else { "tool" }.into()));
        reply.insert("revertMode".into(), Value::String(revert_mode.into()));
        reply.insert("checkpointId".into(), Value::String(checkpoint));
        reply.insert("patchTruncated".into(), Value::Bool(false));
        reply.insert("authoritative".into(), Value::Bool(turn_generation.is_some() && tracker.is_some()));
        reply.insert("agents".into(), self.public_agent_reviews(owner));
        match turn_generation {
            Some(generation) => reply.insert("generation".into(), Value::from(generation)),
            None => reply.insert("reason".into(), Value::String("no-turn".into())),
        };
        reply
    }

    /// The review bar's wire reply: a summary leaves the patch text out, and an unchanged review
    /// answers with its tag instead of being sent again.
    pub(super) async fn turn_review_reply(&self, session_id: &str, read: &ReviewRead) -> Reply {
        let mut review = Value::Object(self.turn_review_diff(session_id, read.summary).await);
        // A collapsed bar shows files and line counts only, so the patch text is left out until
        // the bar is opened.
        let kind = review.get("snapshotKind").and_then(Value::as_str).unwrap_or("").to_owned();
        let has_patch = review.get("patch").and_then(Value::as_str).is_some_and(|p| !p.is_empty());
        if read.summary && SUMMARY_KINDS.contains(&kind.as_str()) && has_patch {
            if let Some(map) = review.as_object_mut() {
                map.insert("patch".into(), Value::String(String::new()));
                map.insert("patchOmitted".into(), Value::Bool(true));
            }
        }
        // The tag covers everything sent (`historyTurns` included), so a summary and a full review
        // never share one.
        let digest = Sha256::digest(json_stringify(&review).as_bytes());
        let etag: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
        let mut map = review.as_object().cloned().unwrap_or_default();
        if read.known.as_deref() == Some(etag.as_str()) {
            let mut reply = Reply::new();
            reply.insert("unchanged".into(), Value::Bool(true));
            reply.insert("etag".into(), Value::String(etag));
            return reply;
        }
        map.insert("etag".into(), Value::String(etag));
        map
    }

    // ── Historical turn changes ─────────────────────────────────────────────

    /// A legacy record kept no counts or diff for a new file it could not replay (outside the
    /// root): measure the file as it is on disk now.
    pub(super) async fn measure_legacy_change_file(&self, file: Obj, root: &str, budget: &mut LineDiffBudget) -> Obj {
        if !is_unmeasured_file(&file) {
            return file;
        }
        let CurrentText::Text(text) = self.disk.current_text(root, obj_str(&file, "path")).await else { return file };
        if text.is_empty() {
            return file;
        }
        let name = clean(obj_str(&file, "path")).replace('\\', "/");
        let after = mixdog_core_api::turn_review::ReviewContent::bytes(text.into_bytes());
        let named = named_change_patch(&self.differ, &mixdog_core_api::turn_review::ReviewContent::Absent, &after, &name, &name, budget);
        if named.patch.is_empty() {
            return file;
        }
        let mut next = file;
        next.insert("additions".into(), Value::from(named.additions));
        next.insert("deletions".into(), Value::from(named.deletions));
        next.insert("viewPatch".into(), Value::String(named.patch));
        next
    }

    fn turn_changes_pending(&self, owner: &str, checkpoint_id: &str) -> bool {
        let reg = self.reg();
        if reg.pending_freezes.contains_key(&pending_key(owner, checkpoint_id)) {
            return true;
        }
        reg.trackers.get(owner).is_some_and(|t| t.meta.owner_generation > 0 && !t.sealed() && t.meta.checkpoint_id == checkpoint_id)
    }

    /// One turn's frozen changes by exact checkpoint id (TurnChangesReply). An unknown checkpoint
    /// is `missing`; it never resolves to the latest turn.
    pub(super) async fn turn_changes(&self, session_id: &str, read: &ChangesRead) -> Result<Reply, ReviewError> {
        let owner = clean(session_id).to_owned();
        let checkpoint_id = self.required_checkpoint_id(&read.checkpoint_id)?;
        // Settled only when no seal of this checkpoint was in flight at any point of the record
        // read: one in flight before or after it (a completion wake reopened the turn meanwhile),
        // or one that landed during it, answers pending instead of the record from before that
        // seal.
        let in_flight = || !owner.is_empty() && self.turn_changes_pending(&owner, &checkpoint_id);
        let key = pending_key(&owner, &checkpoint_id);
        let seal_landed = Arc::new(AtomicBool::new(false));
        self.reg().change_reads.entry(key.clone()).or_default().push(seal_landed.clone());
        let mut pending = in_flight();
        let record = if owner.is_empty() {
            None
        } else {
            let loaded = self.store.load_turn_change_record(&owner, &checkpoint_id).await;
            self.with_unknown_change_states(&owner, loaded)
        };
        {
            let mut reg = self.reg();
            if let Some(reads) = reg.change_reads.get_mut(&key) {
                reads.retain(|r| !Arc::ptr_eq(r, &seal_landed));
                if reads.is_empty() {
                    reg.change_reads.remove(&key);
                }
            }
        }
        pending = pending || seal_landed.load(Ordering::SeqCst) || in_flight();
        // An old record's outside-root file kept no counts: measure it so the card agrees with the
        // session review and the island.
        let mut record = record;
        if let Some(rec) = record.as_mut() {
            let has_files = rec.get("files").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
            if has_files {
                let mut budget = LineDiffBudget::default();
                let root = obj_str(rec, "root").to_owned();
                let files: Vec<Obj> = rec.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).cloned().collect()).unwrap_or_default();
                let mut measured = Vec::with_capacity(files.len());
                for file in files {
                    measured.push(Value::Object(self.measure_legacy_change_file(file, &root, &mut budget).await));
                }
                rec.insert("files".into(), Value::Array(measured));
            }
        }
        let status = if pending {
            "pending"
        } else if let Some(rec) = &record {
            let n = |key: &str| rec.get(key).and_then(Value::as_array).is_some_and(|a| !a.is_empty());
            if n("files") || n("outside") { "ready" } else { "none" }
        } else {
            "missing"
        };
        let file = read.file.as_deref().map(clean).filter(|f| !f.is_empty());
        let reply = turn_changes_reply(status, &checkpoint_id, record.as_ref(), read.patch, file)?;
        if status == "ready" { Ok(self.with_ignored_change_files(&owner, reply).await) } else { Ok(reply) }
    }

    pub(super) fn required_checkpoint_id(&self, value: &str) -> Result<String, ReviewError> {
        let id = clean(value);
        if id.is_empty() {
            return Err(ReviewError::type_error("checkpointId is required"));
        }
        Ok(id.to_owned())
    }

    /// The gitignored files of each answered record revision (build output a file tool wrote),
    /// flagged `ignored` so a viewer can leave them out of its turn previews. Asked of Git once
    /// per revision; bounded.
    async fn ignored_change_paths(&self, key: &str, root: &str, paths: &[String]) -> IndexSet<String> {
        if let Some(hit) = self.ignored.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
            return hit.clone();
        }
        let mut ignored = IndexSet::new();
        let args: Vec<String> = ["check-ignore", "-z", "--stdin"].map(String::from).to_vec();
        let mut input = paths.join("\0").into_bytes();
        input.push(0);
        // 0: some are ignored, 1: none; anything else (no repository) flags none.
        if let Ok(result) = self.git.run(root, &args, input).await {
            if result.code == 0 {
                ignored = String::from_utf8_lossy(&result.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect();
            }
        }
        let mut cache = self.ignored.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(key.to_owned(), ignored.clone());
        while cache.len() > IGNORED_CHANGE_CACHE_LIMIT {
            cache.shift_remove_index(0);
        }
        ignored
    }

    pub(super) async fn with_ignored_change_files(&self, owner: &str, mut reply: Obj) -> Obj {
        let files: Vec<Obj> = reply.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).cloned().collect()).unwrap_or_default();
        let paths: Vec<String> = files
            .iter()
            .map(|f| obj_str(f, "path").to_owned())
            .filter(|p| !p.is_empty() && !nodepath::is_absolute_host(p))
            .collect();
        let root = obj_str(&reply, "root").to_owned();
        if root.is_empty() || paths.is_empty() {
            return reply;
        }
        let revision = reply.get("revision").map_or_else(String::new, mixdog_js::value_to_string);
        let key = format!("{owner}\0{}\0{revision}\0{root}", obj_str(&reply, "checkpointId"));
        let ignored = self.ignored_change_paths(&key, &root, &paths).await;
        if ignored.is_empty() {
            return reply;
        }
        let flagged: Vec<Value> = files
            .into_iter()
            .map(|mut file| {
                if ignored.contains(obj_str(&file, "path")) {
                    file.insert("ignored".into(), Value::Bool(true));
                }
                Value::Object(file)
            })
            .collect();
        reply.insert("files".into(), Value::Array(flagged));
        reply
    }
}
