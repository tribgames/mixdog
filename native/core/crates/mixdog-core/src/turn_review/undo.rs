//! Undo and Reapply (Node `turn-snapshot.mjs`): the composer's undo of the latest turn's review, and
//! the per-turn Undo/Reapply of a recorded turn's changes. Every mutation runs on the session's
//! change lock and is all-or-nothing: `git apply` checks every hunk before it writes, so a foreign
//! edit overlapping the turn's hunks fails the call instead of being overwritten, and one outside
//! them survives.

use std::sync::Arc;

use indexmap::IndexSet;
use mixdog_core_api::turn_review::Reply;
use mixdog_core_api::turn_review::ReviewError;
use serde_json::Value;

use super::apply::ReplayRoot;
use super::apply::apply_turn_change_files;
use super::apply::record_files;
use super::freeze::edit_change_file;
use super::line_diff::LineDiffBudget;
use super::nodepath;
use super::patch::change_path_key;
use super::patch::clean;
use super::patch::file_state;
use super::patch::find_change_file;
use super::patch::obj_str;
use super::patch::stored_change_file;
use super::patch::turn_changes_reply;
use super::review_diff::Obj;
use super::service::Inner;
use super::service::Tracker;
use super::service::pending_key;
use super::store::Record;
use super::tracker::chain_matches_path;
use super::tracker::redo_tracked_chains;
use super::tracker::undo_tracked_chains;

const UNATTRIBUTED_FILE: &str = "turn review revert cannot attribute this file to the session";

/// What an undo touched: the turn's checkpoint, the absolute paths and whether the record already
/// carries the new state.
struct Restored {
    checkpoint_id: String,
    paths: Vec<String>,
    recorded: bool,
}

fn record_file_paths(root: &str, files: &[Obj]) -> Vec<String> {
    files
        .iter()
        .flat_map(|entry| [obj_str(entry, "path"), obj_str(entry, "oldPath")])
        .filter(|p| !p.is_empty())
        .map(|p| nodepath::resolve_host(&[root, p]))
        .collect()
}

fn assert_checkpoint_matches(expected: &str, actual: &str) -> Result<(), ReviewError> {
    let expected = clean(expected);
    if expected.is_empty() {
        return Ok(());
    }
    let actual = clean(actual);
    if actual.is_empty() {
        return Err(ReviewError::new("turn review checkpoint is unavailable"));
    }
    if actual != expected {
        return Err(ReviewError::new("turn review checkpoint changed; refresh the review"));
    }
    Ok(())
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn mark_unknown(files: &[Value], keys: &IndexSet<String>) -> Vec<Obj> {
    files
        .iter()
        .filter_map(Value::as_object)
        .map(|entry| if keys.contains(&change_path_key(obj_str(entry, "path"))) { super::patch::unknown_state_change_file(entry) } else { entry.clone() })
        .collect()
}

impl Inner {
    /// A Lead turn of this session is running or still sealing. Only a tracker `begin_turn` opened
    /// counts: an orphan tool tracker is no turn.
    fn session_turn_busy(&self, owner: &str) -> bool {
        let reg = self.reg();
        if let Some(tracker) = reg.trackers.get(owner)
            && tracker.meta.owner_generation > 0 && (!tracker.sealed() || tracker.freezing().is_some()) {
                return true;
            }
        let prefix = format!("{owner}\0");
        reg.pending_freezes.keys().any(|key| key.starts_with(&prefix))
    }

    /// Persist `state` for the record files under `keys`, bumping the revision when anything
    /// changed: the one state write of composer and historical Undo.
    async fn write_turn_change_state(&self, owner: &str, checkpoint_id: &str, keys: &IndexSet<String>, state: &'static str) -> std::io::Result<Option<Record>> {
        self.store
            .update_turn_change_record(owner, checkpoint_id, |current| {
                let mut changed = false;
                let files: Vec<Obj> = current
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_object).cloned().collect::<Vec<_>>())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|mut entry| {
                        if !keys.contains(&change_path_key(obj_str(&entry, "path"))) || file_state(&entry) == state {
                            return entry;
                        }
                        changed = true;
                        entry.insert("state".into(), Value::String(state.into()));
                        entry
                    })
                    .collect();
                changed.then_some(files)
            })
            .await
    }

    /// A state write failed after the worktree changed and could not be undone: mark those files
    /// unknown in the record, or, when the store refuses that write too, for the rest of this
    /// runtime, so no reply reads them as cleanly applied or reverted.
    async fn mark_turn_change_state_unknown(&self, owner: &str, checkpoint_id: &str, keys: &IndexSet<String>) {
        let marked = self
            .store
            .update_turn_change_record(owner, checkpoint_id, |current| {
                let files = current.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
                Some(mark_unknown(&files, keys))
            })
            .await;
        if marked.is_ok() {
            return;
        }
        // The store refused the write: fall back to the in-memory marker.
        let key = pending_key(owner, checkpoint_id);
        let mut reg = self.reg();
        let entry = reg.unknown_states.entry(key).or_default();
        for k in keys {
            entry.insert(k.clone());
        }
    }

    /// Bring the latest-turn review (composer bar, session Diff) in line with an Undo/Reapply that
    /// just landed. Best-effort: the mutation itself already landed.
    async fn refresh_latest_turn_review(&self, owner: &str, record: &Record, targets: &[Obj], reverse: bool) {
        let root = obj_str(record, "root").to_owned();
        self.worktrees.note_change(Some(&record_file_paths(&root, targets)));
        let Some(tracker) = self.tracker_of(owner) else { return };
        {
            let mut state = tracker.lock();
            if state.valid && clean(&tracker.meta.checkpoint_id) == clean(obj_str(record, "checkpointId")) {
                let resolved = nodepath::resolve_host(&[&root]);
                if reverse {
                    let keys: Vec<String> = state
                        .chains
                        .iter()
                        .filter(|(_, chain)| {
                            targets.iter().any(|file| [obj_str(file, "path"), obj_str(file, "oldPath")].iter().any(|p| !p.is_empty() && chain_matches_path(chain, &resolved, p)))
                        })
                        .map(|(key, _)| key.clone())
                        .collect();
                    undo_tracked_chains(&mut state, &keys);
                } else {
                    let files: Vec<(String, Option<String>)> = targets
                        .iter()
                        .map(|f| (obj_str(f, "path").to_owned(), Some(obj_str(f, "oldPath").to_owned()).filter(|p| !p.is_empty())))
                        .collect();
                    redo_tracked_chains(&mut state, &resolved, &files);
                }
            }
        }
        let Some(snapshot) = tracker.snapshot() else { return };
        // Best-effort refresh: persist the last captured state.
        snapshot.refresh(true).await;
        if tracker.sealed() {
            self.persist_turn_snapshot_record(owner, &tracker).await;
        }
    }

    /// Reverse-apply (`reverse`) or forward-apply the record files `targets` against the current
    /// disk, all-or-nothing. Then their state is recorded. Resolves to the updated record.
    async fn mutate_record_files(&self, owner: &str, record: &Record, targets: &[Obj], reverse: bool) -> Result<Option<Record>, ReviewError> {
        let verb = if reverse { "undone" } else { "reapplied" };
        let checkpoint_id = clean(obj_str(record, "checkpointId")).to_owned();
        if let Some(blocked) = targets.iter().find(|entry| entry.get("revertable") != Some(&Value::Bool(true))) {
            let reason = match blocked.get("reason") {
                Some(r) if super::patch::is_truthy(r) => r.as_str().unwrap_or("").to_owned(),
                _ => "no replayable patch was recorded".to_owned(),
            };
            return Err(ReviewError::new(format!("{} cannot be {verb}: {reason}", obj_str(blocked, "path"))));
        }
        let scope = ReplayRoot { root: obj_str(record, "root"), kind: obj_str(record, "kind"), counts: obj_str(record, "counts") };
        apply_turn_change_files(self.disk.as_ref(), self.git.as_ref(), &scope, targets, reverse).await?;
        // State lands only after git applied every target; a state that cannot land takes the
        // worktree change back with it.
        let keys: IndexSet<String> = targets.iter().map(|entry| change_path_key(obj_str(entry, "path"))).collect();
        let updated = match self.write_turn_change_state(owner, &checkpoint_id, &keys, if reverse { "reverted" } else { "applied" }).await {
            Ok(updated) => updated,
            Err(error) => {
                if let Err(rollback) = apply_turn_change_files(self.disk.as_ref(), self.git.as_ref(), &scope, targets, !reverse).await {
                    self.mark_turn_change_state_unknown(owner, &checkpoint_id, &keys).await;
                    self.refresh_latest_turn_review(owner, record, targets, reverse).await;
                    return Err(ReviewError::new(format!(
                        "turn changes were {verb} but could not be recorded ({error}), and restoring the worktree failed ({}); Undo/Reapply of those files is disabled",
                        rollback.message
                    )));
                }
                return Err(ReviewError::new(error.to_string()));
            }
        };
        self.refresh_latest_turn_review(owner, record, targets, reverse).await;
        Ok(updated)
    }

    /// Undo a sealed turn's applied record files (all, or the one named).
    async fn revert_recorded_turn(&self, owner: &str, record: Record, file: Option<&str>) -> Result<Restored, ReviewError> {
        let targets: Vec<Obj> = if let Some(file) = file {
            let matched = find_change_file(&record, file).ok_or_else(|| ReviewError::new(UNATTRIBUTED_FILE))?;
            if file_state(matched) != "applied" {
                return Err(ReviewError::new(format!("{} is already undone", obj_str(matched, "path"))));
            }
            vec![matched.clone()]
        } else {
            record_files(&record).into_iter().filter(|entry| file_state(entry) == "applied").collect()
        };
        if !targets.is_empty() {
            self.mutate_record_files(owner, &record, &targets, true).await?;
        }
        Ok(Restored {
            checkpoint_id: clean(obj_str(&record, "checkpointId")).to_owned(),
            paths: record_file_paths(obj_str(&record, "root"), &targets),
            recorded: true,
        })
    }

    /// Undo a running turn's own segments (every file, or the one matching `file`), newest first.
    async fn revert_tracked_turn(&self, tracker: &Arc<Tracker>, worktree: &str, file: Option<&str>) -> Result<Vec<String>, ReviewError> {
        let fallback = nodepath::resolve_host(&[if clean(worktree).is_empty() { "." } else { clean(worktree) }]);
        let root = tracker.patch_root(&fallback);
        let (mut targets, valid) = {
            let state = tracker.lock();
            let keyed: Vec<(String, super::tracker::Edit)> = state
                .chains
                .iter()
                .filter_map(|(key, chain)| super::tracker::chain_edit(chain, &root.root).map(|edit| (key.clone(), edit)))
                // Beside a Git root, an edit outside it is view-only, never undone.
                .filter(|(_, edit)| !root.git || edit.inside)
                .collect();
            (keyed, state.valid)
        };
        if !valid {
            return Err(ReviewError::new("turn review tracked file snapshot is unavailable"));
        }
        if let Some(file) = file {
            let matching = {
                let state = tracker.lock();
                targets.iter().position(|(key, _)| state.chains.get(key).is_some_and(|chain| chain_matches_path(chain, &root.root, file)))
            };
            let Some(index) = matching else { return Err(ReviewError::new(UNATTRIBUTED_FILE)) };
            targets = vec![targets.swap_remove(index)];
        }
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        for (_, edit) in &targets {
            if let Some(mixdog_core_api::turn_review::ReviewContent::Omitted { size, .. }) = edit.omitted_marker() {
                return Err(ReviewError::new(format!(
                    "turn review revert is unavailable for {}: binary/large file content was not captured ({size} bytes)",
                    edit.start.display_path
                )));
            }
        }
        let edits: Vec<super::tracker::Edit> = targets.iter().map(|(_, edit)| edit.clone()).collect();
        let object_format = self.edits_object_format(&edits, &root).await;
        let mut budget = LineDiffBudget::default();
        let files: Vec<Obj> = edits
            .iter()
            .map(|edit| stored_change_file(edit_change_file(&self.differ, edit, &root.root, object_format, &mut budget)))
            .collect();
        if let Some(blocked) = files.iter().find(|entry| entry.get("revertable") != Some(&Value::Bool(true))) {
            let reason = match blocked.get("reason") {
                Some(r) if super::patch::is_truthy(r) => mixdog_js::value_to_string(r),
                _ => "undefined".to_owned(),
            };
            return Err(ReviewError::new(format!("turn review revert is unavailable for {}: {reason}", obj_str(blocked, "path"))));
        }
        let scope = ReplayRoot { root: &root.root, kind: if root.git { "git" } else { "tracked" }, counts: "own" };
        apply_turn_change_files(self.disk.as_ref(), self.git.as_ref(), &scope, &files, true).await?;
        {
            let mut state = tracker.lock();
            let keys: Vec<String> = targets.iter().map(|(key, _)| key.clone()).collect();
            undo_tracked_chains(&mut state, &keys);
        }
        let paths = record_file_paths(&root.root, &files);
        self.worktrees.note_change(Some(&paths));
        if let Some(snapshot) = tracker.snapshot() {
            // Best-effort refresh: the next review read captures afresh.
            snapshot.refresh(true).await;
        }
        Ok(paths)
    }

    /// Reverse-apply the latest turn's own changes: every file its own tools wrote or the own file
    /// the user picked. A sealed turn undoes its change record (state included); a running one its
    /// tracker's own segments.
    async fn revert_latest_turn_unlocked(&self, worktree: &str, owner: &str, file: Option<&str>, expected: &str) -> Result<Restored, ReviewError> {
        let tracker = self.tracker_of(owner);
        if let Some(t) = &tracker {
            assert_checkpoint_matches(expected, &t.meta.checkpoint_id)?;
        }
        if tracker.as_ref().is_none_or(|t| t.sealed()) {
            let own = tracker.as_ref().map(|t| clean(&t.meta.checkpoint_id).to_owned()).filter(|c| !c.is_empty());
            let checkpoint_id = match own {
                Some(id) => id,
                None => self.latest_recorded_checkpoint(owner).await,
            };
            if tracker.is_none() {
                assert_checkpoint_matches(expected, &checkpoint_id)?;
            }
            let record = if checkpoint_id.is_empty() { None } else { self.store.load_turn_change_record(owner, &checkpoint_id).await };
            if let Some(record) = record {
                let record = self.with_unknown_change_states(owner, Some(record)).expect("record");
                return self.revert_recorded_turn(owner, record, file).await;
            }
            if tracker.is_none() {
                return Err(ReviewError::new("turn worktree snapshot is unavailable"));
            }
        }
        let tracker = tracker.expect("tracker");
        let paths = self.revert_tracked_turn(&tracker, worktree, file).await?;
        Ok(Restored { checkpoint_id: clean(&tracker.meta.checkpoint_id).to_owned(), paths, recorded: false })
    }

    /// Record a running turn's composer Undo in the record an earlier seal of the same turn left (a
    /// completion wake reopened it): a record file whose every side (a rename's old path too) was
    /// undone is `reverted`; every other file keeps its state.
    async fn record_composer_revert(&self, owner: &str, restored: &Restored) -> Result<(), ReviewError> {
        if owner.is_empty() || restored.checkpoint_id.is_empty() {
            return Ok(());
        }
        let Some(record) = self.store.load_turn_change_record(owner, &restored.checkpoint_id).await else { return Ok(()) };
        let root = obj_str(&record, "root").to_owned();
        let done: IndexSet<String> = restored.paths.iter().map(|p| change_path_key(&nodepath::relative_host(&root, p))).collect();
        let keys: IndexSet<String> = record_files(&record)
            .iter()
            .filter(|entry| [obj_str(entry, "path"), obj_str(entry, "oldPath")].iter().filter(|s| !s.is_empty()).all(|side| done.contains(&change_path_key(side))))
            .map(|entry| change_path_key(obj_str(entry, "path")))
            .collect();
        if keys.is_empty() {
            return Ok(());
        }
        if let Err(error) = self.write_turn_change_state(owner, &restored.checkpoint_id, &keys, "reverted").await {
            self.mark_turn_change_state_unknown(owner, &restored.checkpoint_id, &keys).await;
            return Err(ReviewError::new(format!(
                "the turn's files were restored, but its change record could not be updated ({error}); Undo/Reapply of those files is disabled"
            )));
        }
        Ok(())
    }

    /// Composer Undo of the latest turn, on the per-session change lock shared with historical
    /// Undo/Reapply, recorded in the turn's change record so the historical view offers Reapply
    /// rather than a second Undo.
    pub(super) async fn revert_latest_turn(self: &Arc<Self>, worktree: &str, session_id: &str, file: Option<&str>, expected: &str) -> Result<Obj, ReviewError> {
        let owner = clean(session_id).to_owned();
        let inner = self.clone();
        let (worktree_owned, file_owned, expected_owned) = (worktree.to_owned(), file.map(str::to_owned), expected.to_owned());
        let owner_for_task = owner.clone();
        self.serialize_mutation(&owner, async move {
            // A seal still freezing would record the pre-restore state after this.
            let freezing = inner.tracker_of(&owner_for_task).and_then(|t| t.freezing());
            if let Some(freezing) = freezing {
                super::service::wait_done(freezing.done).await;
            }
            let restored = inner.revert_latest_turn_unlocked(&worktree_owned, &owner_for_task, file_owned.as_deref(), &expected_owned).await?;
            if !restored.recorded {
                inner.record_composer_revert(&owner_for_task, &restored).await?;
            }
            Ok(inner.turn_review_diff(&owner_for_task, false).await)
        })
        .await
    }

    /// Undo (`reverse`) or Reapply one file or the whole turn, all-or-nothing.
    pub(super) async fn mutate_turn_changes(
        self: &Arc<Self>,
        session_id: &str,
        checkpoint_id: &str,
        file: Option<&str>,
        revision: f64,
        reverse: bool,
    ) -> Result<Reply, ReviewError> {
        let owner = clean(session_id).to_owned();
        if owner.is_empty() {
            return Err(ReviewError::new("turn changes are unavailable without a session"));
        }
        let checkpoint_id = self.required_checkpoint_id(checkpoint_id)?;
        if !is_safe_integer(revision) {
            return Err(ReviewError::type_error("revision must be an integer"));
        }
        let file = file.map(|f| clean(f).to_owned());
        let verb = if reverse { "undone" } else { "reapplied" };
        let inner = self.clone();
        let owner2 = owner.clone();
        self.serialize_mutation(&owner, async move {
            if inner.session_turn_busy(&owner2) {
                return Err(ReviewError::new("turn changes cannot change while this session is running a turn"));
            }
            let loaded = inner.store.load_turn_change_record(&owner2, &checkpoint_id).await;
            let Some(record) = inner.with_unknown_change_states(&owner2, loaded) else {
                return Err(ReviewError::new("turn changes are unavailable: no record for this turn"));
            };
            let current = super::patch::obj_f64(&record, "revision");
            if current != revision && !(current.is_nan() && revision.is_nan()) {
                return Err(ReviewError::new("turn changes changed; refresh"));
            }
            let from = if reverse { "applied" } else { "reverted" };
            let targets: Vec<Obj> = match file.as_deref().filter(|f| !f.is_empty()) {
                Some(file) => {
                    let matched = find_change_file(&record, file).ok_or_else(|| ReviewError::new(format!("{file} is not part of this turn's changes")))?;
                    if file_state(matched) != from {
                        return Err(ReviewError::new(format!("{} is already {verb}", obj_str(matched, "path"))));
                    }
                    vec![matched.clone()]
                }
                None => {
                    let all: Vec<Obj> = record_files(&record).into_iter().filter(|entry| file_state(entry) == from).collect();
                    if all.is_empty() {
                        return Err(ReviewError::new(format!("this turn has no changes to be {verb}")));
                    }
                    all
                }
            };
            let updated = inner.mutate_record_files(&owner2, &record, &targets, reverse).await?;
            let updated = inner.with_unknown_change_states(&owner2, updated);
            let status = if updated.is_some() { "ready" } else { "missing" };
            let reply = turn_changes_reply(status, &checkpoint_id, updated.as_ref(), false, None)?;
            // The viewer caches this reply as it caches a read: the same `ignored` flags.
            Ok(if updated.is_some() { inner.with_ignored_change_files(&owner2, reply).await } else { reply })
        })
        .await
    }

    /// Permanently delete this session's retained change history: every turn's change record, its
    /// stored Git baselines, and the live and latest-turn trackers that would resurface them.
    /// Refused while a turn runs or seals; on the per-session lock, behind any Undo/Reapply.
    pub(super) async fn clear_session_change_history(self: &Arc<Self>, session_id: &str) -> Result<Reply, ReviewError> {
        let owner = clean(session_id).to_owned();
        if owner.is_empty() {
            return Err(ReviewError::new("change history is unavailable without a session"));
        }
        let inner = self.clone();
        let owner2 = owner.clone();
        self.serialize_mutation(&owner, async move {
            if inner.session_turn_busy(&owner2) {
                return Err(ReviewError::new("change history cannot be deleted while this session is running a turn"));
            }
            // Invalidate every producer of the old history BEFORE the awaited deletion, so nothing
            // begun before the delete can write it back.
            inner.discard_session_change_state(&owner2);
            // The session's first-seen baselines go too: later edits start fresh ones.
            let (turns, ()) = tokio::join!(inner.store.clear_session_change_history(&owner2), inner.baselines.clear(&owner2));
            let turns = turns.map_err(|e| ReviewError::new(e.to_string()))?;
            let mut reply = Reply::new();
            reply.insert("turns".into(), Value::from(turns));
            Ok(reply)
        })
        .await
    }
}
