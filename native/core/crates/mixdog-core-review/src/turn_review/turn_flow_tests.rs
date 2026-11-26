#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories")]

use std::path::PathBuf;

use mixdog_core_api::turn_review::{CallChange, ChangesRead, ReviewContent, ReviewRead, TurnOpen, TurnReviewApi};
use serde_json::{Value, json};

use super::service::TurnReview;
use super::testing::review_at;
use super::tests::plain;

struct Rig {
    _dir: tempfile::TempDir,
    ws: PathBuf,
    data: PathBuf,
    ws_text: String,
    review: TurnReview,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
        let (ws, data) = (base.join("ws"), base.join("data"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let ws_text = plain(&ws);
        let review = review_at(&data);
        Self { _dir: dir, ws, data, ws_text, review }
    }

    fn write(&self, path: &str, text: &str) {
        std::fs::write(self.ws.join(path), text).unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.ws.join(path)).ok()
    }

    async fn begin(&self, checkpoint: &str) {
        let token = self.review.begin_turn(&self.ws_text, "s1", TurnOpen { checkpoint_id: checkpoint.to_owned() }).await;
        assert_eq!(token.map(|t| t.checkpoint_id).as_deref(), Some(checkpoint));
    }

    /// Seals the turn begun as `checkpoint`, the `generation`-th of the session.
    async fn seal(&self, generation: u64, checkpoint: &str) {
        let token = mixdog_core_api::turn_review::TurnToken { generation, checkpoint_id: checkpoint.to_owned() };
        assert!(self.review.complete_turn("s1", Some(&token)).await);
    }

    /// A tool edit by `session`: the disk takes `after` (`None` deletes the file) and the review is told `before` → `after`.
    async fn edit(&self, session: &str, path: &str, after: Option<&str>) {
        let before = self.read(path).map_or(ReviewContent::Absent, |text| ReviewContent::bytes(text.into_bytes()));
        match after {
            Some(text) => self.write(path, text),
            None => std::fs::remove_file(self.ws.join(path)).unwrap(),
        }
        let after = after.map_or(ReviewContent::Absent, |text| ReviewContent::bytes(text.as_bytes().to_vec()));
        let change = CallChange { path: plain(&self.ws.join(path)), new_path: None, before, after };
        self.review.record_tool_changes(session, &self.ws_text, vec![change]).await;
    }

    async fn review(&self) -> serde_json::Map<String, Value> {
        self.review.turn_review_diff(&self.ws_text, "s1", ReviewRead::default()).await
    }

    async fn changes(&self, checkpoint: &str) -> serde_json::Map<String, Value> {
        self.review.turn_changes("s1", ChangesRead { checkpoint_id: checkpoint.to_owned(), patch: false, file: None }).await.unwrap()
    }

    /// The process is gone and the files stay: queued baseline writes land first.
    async fn restart(&mut self) {
        self.review.inner.baselines.settle().await;
        self.review = review_at(&self.data);
    }
}

fn files(reply: &serde_json::Map<String, Value>) -> Vec<(String, String, Value)> {
    reply["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().to_owned(), f["status"].as_str().unwrap().to_owned(), json!([f["additions"], f["deletions"]])))
        .collect()
}

fn states(reply: &serde_json::Map<String, Value>) -> Vec<(String, String)> {
    reply["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_owned(), f["state"].as_str().unwrap().to_owned())).collect()
}

const A_PATCH: &str = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n";

/// Begins `cp1` over `a.txt`, `c.txt` and `d.txt` and makes an edit (call `call-1`), a created, a deleted and a renamed file.
async fn begin_edited_turn(rig: &Rig) {
    rig.write("a.txt", "one\ntwo\nthree\n");
    rig.write("c.txt", "gone\n");
    rig.write("d.txt", "moves\n");
    rig.begin("cp1").await;
    let call = CallChange {
        path: plain(&rig.ws.join("a.txt")),
        new_path: None,
        before: ReviewContent::bytes(b"one\ntwo\nthree\n".to_vec()),
        after: ReviewContent::bytes(b"one\n2\nthree\nfour\n".to_vec()),
    };
    rig.write("a.txt", "one\n2\nthree\nfour\n");
    rig.review.record_call("call-1", "s1", &rig.ws_text, vec![call]).await;
    rig.edit("s1", "b.txt", Some("fresh\n")).await;
    rig.edit("s1", "c.txt", None).await;
    let moved = CallChange {
        path: plain(&rig.ws.join("d.txt")),
        new_path: Some(plain(&rig.ws.join("e.txt"))),
        before: ReviewContent::bytes(b"moves\n".to_vec()),
        after: ReviewContent::bytes(b"moves\n".to_vec()),
    };
    std::fs::rename(rig.ws.join("d.txt"), rig.ws.join("e.txt")).unwrap();
    rig.review.record_tool_changes("s1", &rig.ws_text, vec![moved]).await;
}

/// The review of an edit, a created, a deleted and a renamed file while the turn runs: one review with its line counts and patch,
/// from the tool edits; the summary read leaves the patch out, a file patch is that file's, an unchanged read says so by etag,
/// and the card diff of a call is handed out once.
#[tokio::test(flavor = "multi_thread")]
async fn a_running_turns_edits_are_one_review_with_counts_and_patch() {
    let rig = Rig::new();
    begin_edited_turn(&rig).await;

    assert_eq!(rig.review.take_call_diff("call-1").as_deref(), Some(A_PATCH));
    assert_eq!(rig.review.take_call_diff("call-1"), None, "a card's diff is handed out once");

    let live = rig.review().await;
    assert_eq!(
        files(&live),
        [
            ("a.txt".to_owned(), "M".to_owned(), json!([2, 1])),
            ("b.txt".to_owned(), "A".to_owned(), json!([1, 0])),
            ("c.txt".to_owned(), "D".to_owned(), json!([0, 1])),
            ("e.txt".to_owned(), "R".to_owned(), json!([0, 0])),
        ]
    );
    assert_eq!(live["files"][3]["oldPath"], "d.txt");
    let patch = live["patch"].as_str().unwrap();
    assert!(patch.starts_with(A_PATCH), "{patch}");
    assert!(patch.contains("diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,1 @@\n+fresh\n"), "{patch}");
    assert!(patch.contains("diff --git a/c.txt b/c.txt\ndeleted file mode 100644\n"), "{patch}");
    assert_eq!((live["snapshotKind"].as_str(), live["revertMode"].as_str(), live["checkpointId"].as_str()), (Some("tool"), Some("tracked"), Some("cp1")));
    assert_eq!((live["authoritative"].as_bool(), live["historyTurns"].as_u64()), (Some(true), Some(0)));

    let etag = live["etag"].as_str().unwrap().to_owned();
    let again = rig.review.turn_review_diff(&rig.ws_text, "s1", ReviewRead { known: Some(etag.clone()), summary: false }).await;
    assert_eq!(again["unchanged"], true);
    assert_eq!(again["etag"], etag.as_str());
    let summary = rig.review.turn_review_diff(&rig.ws_text, "s1", ReviewRead { known: None, summary: true }).await;
    assert_eq!((summary["patch"].as_str(), summary["patchOmitted"].as_bool()), (Some(""), Some(true)));
    assert_eq!(files(&summary), files(&live));

    assert_eq!(rig.review.turn_review_file_patch(&rig.ws_text, "s1", "a.txt").await["patch"], A_PATCH);
    assert_eq!(rig.review.turn_review_file_patch(&rig.ws_text, "s1", "zzz.txt").await["patch"], "", "a file the turn did not touch has no patch");
}

/// Once sealed the review survives a restart as a recorded one (`snapshotKind: "scoped"`), and its changes are listed with their
/// state, as a file's patch or refused for a file the turn did not touch.
#[tokio::test(flavor = "multi_thread")]
async fn a_sealed_turns_review_is_recorded_and_survives_a_restart() {
    let mut rig = Rig::new();
    begin_edited_turn(&rig).await;
    let live = rig.review().await;

    rig.seal(1, "cp1").await;
    let listed = rig.changes("cp1").await;
    assert_eq!(
        (listed["status"].as_str(), listed["revision"].as_u64(), listed["canUndo"].as_bool(), listed["canReapply"].as_bool()),
        (Some("ready"), Some(1), Some(true), Some(false))
    );
    assert_eq!(
        states(&listed),
        [("a.txt", "applied"), ("b.txt", "applied"), ("c.txt", "applied"), ("e.txt", "applied")].map(|(p, s)| (p.to_owned(), s.to_owned()))
    );
    let with_patch = rig.review.turn_changes("s1", ChangesRead { checkpoint_id: "cp1".into(), patch: true, file: Some("a.txt".into()) }).await.unwrap();
    assert_eq!(with_patch["patch"], A_PATCH);
    let refused = rig.review.turn_changes("s1", ChangesRead { checkpoint_id: "cp1".into(), patch: true, file: Some("nope.txt".into()) }).await.unwrap_err();
    assert_eq!(refused.message, "nope.txt is not part of this turn's changes");
    let unknown = rig.changes("unknown").await;
    assert_eq!((unknown["status"].as_str(), unknown["revision"].as_u64(), unknown["canUndo"].as_bool()), (Some("missing"), Some(0), Some(false)));

    rig.restart().await;
    let recorded = rig.review().await;
    assert_eq!(files(&recorded), files(&live));
    assert_eq!(
        (recorded["snapshotKind"].as_str(), recorded["revertMode"].as_str(), recorded["reason"].as_str(), recorded["historyTurns"].as_u64()),
        (Some("scoped"), Some("scoped"), Some("recorded"), Some(1))
    );
    assert_eq!(rig.review.turn_review_file_patch(&rig.ws_text, "s1", "a.txt").await["patch"], A_PATCH);
    assert_eq!(rig.changes("cp1").await["status"], "ready");
}

/// While the turn runs, one file's undo restores it and leaves the others in the review; a file the session never changed or another
/// checkpoint is refused; the whole undo restores everything and leaves an empty review and no recorded changes.
#[tokio::test(flavor = "multi_thread")]
async fn a_running_turns_undo_restores_one_file_or_all_of_them() {
    let rig = Rig::new();
    rig.write("a.txt", "x\ny\n");
    rig.begin("cp1").await;
    rig.edit("s1", "a.txt", Some("x\nY\n")).await;
    rig.edit("s1", "n.txt", Some("new\n")).await;
    let after_file = rig.review.revert_turn_review_file(&rig.ws_text, "s1", "a.txt", "").await.unwrap();
    assert_eq!(files(&after_file), [("n.txt".to_owned(), "A".to_owned(), json!([1, 0]))]);
    assert_eq!(rig.read("a.txt").as_deref(), Some("x\ny\n"));
    let missing = rig.review.revert_turn_review_file(&rig.ws_text, "s1", "missing.txt", "").await.unwrap_err();
    assert_eq!(missing.message, "turn review revert cannot attribute this file to the session");
    let other = rig.review.revert_turn_review(&rig.ws_text, "s1", "other").await.unwrap_err();
    assert_eq!(other.message, "turn review checkpoint changed; refresh the review");
    let all = rig.review.revert_turn_review(&rig.ws_text, "s1", "").await.unwrap();
    assert!(all["files"].as_array().unwrap().is_empty());
    assert_eq!(all["revertMode"], "");
    assert_eq!(rig.read("n.txt"), None, "a created file is removed by the undo");
    assert!(rig.review().await["files"].as_array().unwrap().is_empty());
    rig.seal(1, "cp1").await;
    assert_eq!(rig.changes("cp1").await["status"], "none", "a turn whose changes were all undone records none");
}

/// A sealed turn's changes are undone and reapplied through its record: stale revisions, a file already undone, non-integer
/// revisions and an unknown checkpoint are refused with the product's messages; the revision grows with each change.
#[tokio::test(flavor = "multi_thread")]
async fn a_sealed_turns_changes_are_undone_and_reapplied_by_revision() {
    let mut rig = Rig::new();
    rig.write("a.txt", "1\n2\n3\n");
    rig.begin("cp1").await;
    rig.edit("s1", "a.txt", Some("1\ntwo\n3\n")).await;
    rig.edit("s1", "b.txt", Some("b\n")).await;
    rig.seal(1, "cp1").await;
    rig.restart().await;

    let composer = rig.review.revert_turn_review_file(&rig.ws_text, "s1", "a.txt", "cp1").await.unwrap();
    assert_eq!(files(&composer), [("b.txt".to_owned(), "A".to_owned(), json!([1, 0]))]);
    assert_eq!(rig.read("a.txt").as_deref(), Some("1\n2\n3\n"));
    let listed = rig.changes("cp1").await;
    assert_eq!(listed["revision"], 2);
    assert_eq!(states(&listed), [("a.txt".to_owned(), "reverted".to_owned()), ("b.txt".to_owned(), "applied".to_owned())]);

    let stale = rig.review.revert_turn_changes("s1", "cp1", None, 99.0).await.unwrap_err();
    assert_eq!(stale.message, "turn changes changed; refresh");
    let done = rig.review.revert_turn_changes("s1", "cp1", Some("a.txt"), 2.0).await.unwrap_err();
    assert_eq!(done.message, "a.txt is already undone");
    let redone = rig.review.reapply_turn_changes("s1", "cp1", Some("a.txt"), 2.0).await.unwrap();
    assert_eq!((redone["revision"].as_u64(), redone["canReapply"].as_bool()), (Some(3), Some(false)));
    assert_eq!(rig.read("a.txt").as_deref(), Some("1\ntwo\n3\n"));
    let undone = rig.review.revert_turn_changes("s1", "cp1", None, 3.0).await.unwrap();
    assert_eq!((undone["revision"].as_u64(), undone["canUndo"].as_bool(), undone["canReapply"].as_bool()), (Some(4), Some(false), Some(true)));
    assert_eq!(undone["reason"], "all changes in this turn are already undone");
    assert_eq!(rig.read("b.txt"), None);
    assert_eq!(rig.read("a.txt").as_deref(), Some("1\n2\n3\n"));
    let nothing = rig.review.revert_turn_changes("s1", "cp1", None, 4.0).await.unwrap_err();
    assert_eq!(nothing.message, "this turn has no changes to be undone");
    let back = rig.review.reapply_turn_changes("s1", "cp1", None, 4.0).await.unwrap();
    assert_eq!(back["revision"], 5);
    assert_eq!(rig.read("b.txt").as_deref(), Some("b\n"));

    assert_eq!(rig.review.revert_turn_changes("s1", "nope", None, 1.0).await.unwrap_err().message, "turn changes are unavailable: no record for this turn");
    let fractional = rig.review.revert_turn_changes("s1", "cp1", None, 1.5).await.unwrap_err();
    assert_eq!((fractional.type_error, fractional.message.as_str()), (true, "revision must be an integer"));
    let unnamed = rig.review.revert_turn_changes("s1", "", None, 1.0).await.unwrap_err();
    assert_eq!((unnamed.type_error, unnamed.message.as_str()), (true, "checkpointId is required"));
}

/// An undo that cannot apply cleanly — another edit changed the same region — is refused and leaves the worktree as it was;
/// the turn's changes stay applied and cannot be reapplied.
#[tokio::test(flavor = "multi_thread")]
async fn an_undo_over_other_edits_to_the_same_lines_is_refused_and_changes_nothing() {
    let rig = Rig::new();
    rig.write("a.txt", "top\nmid\nbottom\n");
    rig.begin("cp1").await;
    rig.edit("s1", "a.txt", Some("top\nMID\nbottom\n")).await;
    rig.seal(1, "cp1").await;
    rig.write("a.txt", "TOP\nMID\nbottom\n");
    let revision = rig.changes("cp1").await["revision"].as_f64().unwrap();
    let refused = rig.review.revert_turn_changes("s1", "cp1", None, revision).await.unwrap_err();
    assert!(refused.message.starts_with("undo failed; the worktree was not changed:"), "{}", refused.message);
    assert_eq!(rig.read("a.txt").as_deref(), Some("TOP\nMID\nbottom\n"));
    let nothing_to_reapply = rig.review.reapply_turn_changes("s1", "cp1", None, revision).await.unwrap_err();
    assert_eq!(nothing_to_reapply.message, "this turn has no changes to be reapplied");
    let listed = rig.changes("cp1").await;
    assert_eq!((listed["status"].as_str(), listed["canUndo"].as_bool(), listed["canReapply"].as_bool()), (Some("ready"), Some(true), Some(false)));
}

/// A worker's edits join its lead's running turn once, when the worker completes; one that completes after the turn is sealed
/// is parked for the next turn with the patches it handed over.
#[tokio::test(flavor = "multi_thread")]
async fn a_workers_edits_join_the_leads_running_turn_or_wait_for_the_next_one() {
    let rig = Rig::new();
    rig.write("lead.txt", "l\n");
    rig.write("w.txt", "w\n");
    rig.begin("cp1").await;
    let worker = rig.review.begin_agent_review("s1", "worker-1", "worker", "task").expect("a running turn takes the worker");
    rig.edit("worker-1", "w.txt", Some("w2\n")).await;
    rig.edit("s1", "lead.txt", Some("l2\n")).await;
    assert!(worker.complete(Vec::new()), "the first completion joins");
    assert!(!worker.complete(Vec::new()), "a second one does not");
    let joined = rig.review().await;
    assert_eq!(files(&joined), [("lead.txt".to_owned(), "M".to_owned(), json!([1, 1])), ("w.txt".to_owned(), "M".to_owned(), json!([1, 1]))]);
    rig.seal(1, "cp1").await;

    let late = rig.review.begin_agent_review("s1", "worker-2", "worker", "late").expect("the owner is known");
    rig.edit("worker-2", "w2.txt", Some("late\n")).await;
    assert!(late.complete(vec!["diff --git a/x b/x\n".to_owned()]));
    rig.begin("cp2").await;
    let next = rig.review().await;
    assert_eq!(files(&next), [("w2.txt".to_owned(), "A".to_owned(), json!([1, 0]))]);
    let agents = next["agents"].as_array().unwrap();
    assert_eq!((agents[0]["sessionId"].as_str(), agents[0]["agent"].as_str(), agents[0]["tag"].as_str()), (Some("worker-2"), Some("worker"), Some("late")));
}

/// Change history cannot be deleted while a turn runs; once sealed it can, taking the turn's record with it, so the review
/// shows no turn and the checkpoint is unknown; a later turn's changes are recorded again.
#[tokio::test(flavor = "multi_thread")]
async fn change_history_is_cleared_only_between_turns_and_the_next_turn_is_recorded_again() {
    let rig = Rig::new();
    rig.write("a.txt", "a\n");
    rig.begin("cp1").await;
    rig.edit("s1", "a.txt", Some("b\n")).await;
    let running = rig.review.clear_change_history("s1").await.unwrap_err();
    assert_eq!(running.message, "change history cannot be deleted while this session is running a turn");
    rig.seal(1, "cp1").await;
    assert_eq!(rig.review.clear_change_history("s1").await.unwrap()["turns"], 1);
    assert!(rig.review.store().session_change_history_cleared("s1").await);
    let empty = rig.review().await;
    assert!(empty["files"].as_array().unwrap().is_empty());
    assert_eq!((empty["reason"].as_str(), empty["historyTurns"].as_u64(), empty["authoritative"].as_bool()), (Some("no-turn"), Some(0), Some(false)));
    assert_eq!(rig.changes("cp1").await["status"], "missing");

    let token = rig.review.begin_turn(&rig.ws_text, "s1", TurnOpen { checkpoint_id: "cp2".into() }).await;
    rig.edit("s1", "a.txt", Some("c\n")).await;
    assert!(rig.review.complete_turn("s1", token.as_ref()).await);
    TurnReviewApi::forget_session(&rig.review, "s1");
    let recorded = rig.review().await;
    assert_eq!(files(&recorded), [("a.txt".to_owned(), "M".to_owned(), json!([1, 1]))]);
    assert_eq!((recorded["checkpointId"].as_str(), recorded["reason"].as_str()), (Some("cp2"), Some("recorded")));
    assert_eq!(rig.changes("cp2").await["status"], "ready");
}

/// Turn 1 (`cp1`) seals its own edits; a subsequent turn (`cp2`, such as a completion wake) takes a
/// fresh baseline and records only subsequent edits (and late workers adopted into it), leaving
/// `cp1` immutable and independently undoable/reapplicable.
#[tokio::test(flavor = "multi_thread")]
async fn each_sealed_turn_keeps_its_own_checkpoint_changes_isolated_from_later_turns() {
    let rig = Rig::new();
    rig.write("a.txt", "one\n");
    rig.begin("cp1").await;
    let late_worker = rig.review.begin_agent_review("s1", "worker-late", "worker", "bg").expect("worker bound");
    rig.edit("s1", "a.txt", Some("two\n")).await;
    rig.seal(1, "cp1").await;

    let cp1_before = rig.changes("cp1").await;
    assert_eq!(states(&cp1_before), [("a.txt".to_owned(), "applied".to_owned())]);

    // Worker completes after Turn 1 sealed: parked for Turn 2, never mutating cp1.
    rig.edit("worker-late", "w.txt", Some("from worker\n")).await;
    assert!(late_worker.complete(Vec::new()));

    // Wake Turn 2 opens with its own distinct checkpoint and edits b.txt.
    rig.begin("cp2").await;
    rig.edit("s1", "b.txt", Some("second\n")).await;
    let live2 = rig.review().await;
    assert_eq!(live2["checkpointId"], "cp2");
    assert_eq!(live2["agents"].as_array().unwrap().len(), 1);
    assert_eq!(live2["agents"][0]["sessionId"], "worker-late");
    rig.seal(2, "cp2").await;

    let cp1_after = rig.changes("cp1").await;
    assert_eq!(states(&cp1_after), [("a.txt".to_owned(), "applied".to_owned())]);

    let cp2 = rig.changes("cp2").await;
    assert_eq!(states(&cp2), [("b.txt".to_owned(), "applied".to_owned()), ("w.txt".to_owned(), "applied".to_owned())]);

    // Undo and reapply work independently on each checkpoint.
    let rev2 = cp2["revision"].as_f64().unwrap();
    let undone2 = rig.review.revert_turn_changes("s1", "cp2", None, rev2).await.unwrap();
    assert_eq!(undone2["canUndo"], false);
    assert_eq!(rig.read("b.txt"), None);
    assert_eq!(rig.read("w.txt"), None);
    assert_eq!(rig.read("a.txt").as_deref(), Some("two\n"), "undoing cp2 leaves cp1's edit intact");

    let rev1 = cp1_after["revision"].as_f64().unwrap();
    let undone1 = rig.review.revert_turn_changes("s1", "cp1", None, rev1).await.unwrap();
    assert_eq!(undone1["canUndo"], false);
    assert_eq!(rig.read("a.txt").as_deref(), Some("one\n"));

    let reapplied2 = rig.review.reapply_turn_changes("s1", "cp2", None, undone2["revision"].as_f64().unwrap()).await.unwrap();
    assert_eq!(reapplied2["canUndo"], true);
    assert_eq!(rig.read("b.txt").as_deref(), Some("second\n"));
    assert_eq!(rig.read("w.txt").as_deref(), Some("from worker\n"));
    assert_eq!(rig.read("a.txt").as_deref(), Some("one\n"), "reapplying cp2 does not alter cp1");
}

struct GatedWorktrees {
    inner: std::sync::Arc<dyn super::ports::ReviewWorktrees>,
    gate_call: usize,
    calls: std::sync::atomic::AtomicUsize,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl super::ports::ReviewWorktrees for GatedWorktrees {
    async fn resume(&self, worktree: &str, baseline_tree: &str, scope: &super::ports::ResumeScope) -> Option<std::sync::Arc<dyn super::ports::WorktreeBase>> {
        self.inner.resume(worktree, baseline_tree, scope).await
    }
    async fn resume_file_patch(
        &self,
        worktree: &str,
        baseline_tree: &str,
        scope: &super::ports::ResumeScope,
        path: &str,
        old_path: &str,
        max_bytes: usize,
    ) -> Option<super::review_diff::Obj> {
        self.inner.resume_file_patch(worktree, baseline_tree, scope, path, old_path, max_bytes).await
    }
    async fn forget_root(&self, root: &str) -> (Vec<PathBuf>, Vec<PathBuf>) {
        self.inner.forget_root(root).await
    }
    async fn create(&self, worktree: &str) -> Option<std::sync::Arc<dyn super::ports::WorktreeBase>> {
        let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if n == self.gate_call {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.inner.create(worktree).await
    }
    fn note_change(&self, paths: Option<&[String]>) {
        self.inner.note_change(paths);
    }
    fn on_review_changed(&self, listener: std::sync::Arc<dyn Fn() + Send + Sync>) -> std::sync::Arc<dyn Fn() -> bool + Send + Sync> {
        self.inner.on_review_changed(listener)
    }
    fn canonical_path(&self, path: &str) -> String {
        self.inner.canonical_path(path)
    }
}

fn gated_git_rig(gate_call: usize) -> (Rig, std::sync::Arc<GatedWorktrees>, std::sync::Arc<mixdog_scm::worktree::review_bases::CapturedBases>) {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "maintenance.auto=false"])
            .args(args)
            .current_dir(&ws)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "init"]);

    let tokens = mixdog_rt::testing::tokens();
    let processes = std::sync::Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    let bases = std::sync::Arc::new(mixdog_scm::worktree::review_bases::CapturedBases::new());
    let base_review = TurnReview::over_scm(scm, tokens, &data, |_| None, bases.clone());
    let gated = std::sync::Arc::new(GatedWorktrees {
        inner: base_review.inner.worktrees.clone(),
        gate_call,
        calls: std::sync::atomic::AtomicUsize::new(0),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let review = TurnReview::new(
        super::service::Config::default(),
        tokens.cpu_interactive,
        &data,
        base_review.inner.disk.clone(),
        base_review.inner.git.clone(),
        gated.clone(),
        bases.clone(),
    );
    let ws_text = plain(&ws);
    (Rig { _dir: dir, ws, data, ws_text, review }, gated, bases)
}

/// If a next turn (`cp3`) opens while a cancelled/prior turn (`cp2`) still has its Git baseline
/// capture in flight, `cp2` still receives its baseline before sealing instead of discarding it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaced_turn_with_in_flight_git_baseline_keeps_its_baseline_when_next_turn_opens() {
    use mixdog_app_protocol::v2::domain::ReviewScope;
    use mixdog_scm::service::ReviewBases;

    let (rig, gated, bases) = gated_git_rig(0);
    let review_cp2 = rig.review.clone();
    let ws_cp2 = rig.ws_text.clone();
    let cp2_begin = tokio::spawn(async move { review_cp2.begin_turn(&ws_cp2, "s1", TurnOpen { checkpoint_id: "cp2".into() }).await });
    gated.entered.notified().await;

    // Record an edit on cp2 before cp3 opens while cp2's Git baseline capture is still in flight.
    rig.edit("s1", "a.txt", Some("two\n")).await;

    // Opening cp3 replaces reg.trackers["s1"] and queues cp2's seal.
    rig.begin("cp3").await;
    assert_eq!(rig.changes("cp2").await["status"], "pending", "cp2 must stay pending until its in-flight baseline arrives and seals");

    // Now let cp2's Git baseline capture finish.
    gated.release.notify_one();
    assert!(cp2_begin.await.unwrap().is_some());

    // Wait for cp2's queued seal to complete.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let cp2 = loop {
        let reply = rig.changes("cp2").await;
        if reply["status"] != "pending" {
            break reply;
        }
        assert!(tokio::time::Instant::now() < deadline, "cp2 never finished sealing");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert_eq!(cp2["status"], "ready", "{cp2:?}");
    assert_eq!(states(&cp2), [("a.txt".to_owned(), "applied".to_owned())]);

    let stored = rig.review.store().load_turn_change_record("s1", "cp2").await.expect("stored cp2 change record");
    assert_eq!(stored["kind"], "git", "cp2 must seal with its Git baseline, not fall back to tracked: {stored:?}");

    let thread = mixdog_protocol::ThreadId::from("s1");
    assert!(bases.base(&thread, ReviewScope::Turn, Some("cp2")).await.is_some(), "cp2 turn base recorded");
    assert!(bases.base(&thread, ReviewScope::Turn, Some("cp3")).await.is_some(), "cp3 turn base recorded");
}

/// A worker completing after a turn was synchronously closed (e.g. cancelled while its baseline
/// is still pending and before the next turn opens) parks for the next turn and does NOT join
/// the ended turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_completing_after_closed_turn_with_pending_baseline_parks_for_next_turn() {
    let (rig, gated, _bases) = gated_git_rig(0);
    let review_cp2 = rig.review.clone();
    let ws_cp2 = rig.ws_text.clone();
    let cp2_begin = tokio::spawn(async move { review_cp2.begin_turn(&ws_cp2, "s1", TurnOpen { checkpoint_id: "cp2".into() }).await });
    gated.entered.notified().await;

    let worker = rig.review.begin_agent_review("s1", "worker-late", "worker", "bg").expect("worker bound");
    // Synchronously mark cp2 closing (as TurnSnapshot::finish does on cancel before returning).
    rig.review.close_turn("s1", "cp2");

    // Worker completes after cp2 ended, while cp2's baseline is still pending and before cp3 opens.
    rig.edit("worker-late", "w.txt", Some("late worker\n")).await;
    assert!(worker.complete(Vec::new()));

    // Release cp2's baseline and seal cp2.
    gated.release.notify_one();
    let token2 = cp2_begin.await.unwrap().expect("cp2 token");
    assert!(rig.review.complete_turn("s1", Some(&token2)).await);

    assert_eq!(rig.changes("cp2").await["status"], "none", "ended cp2 must not absorb worker edit completed after close");

    // Next turn cp3 adopts the parked worker edit.
    rig.begin("cp3").await;
    let live3 = rig.review().await;
    assert_eq!(files(&live3), [("w.txt".to_owned(), "A".to_owned(), json!([1, 0]))]);
    let agents = live3["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["sessionId"], "worker-late");
    rig.seal(2, "cp3").await;
    assert_eq!(states(&rig.changes("cp3").await), [("w.txt".to_owned(), "applied".to_owned())]);
}

/// Two cancelled turn starts (`cp2`, `cp3`) queued behind the same per-session mutation lock
/// preserve both close markers independently; neither adopts parked worker reviews, and the next
/// uncancelled turn (`cp4`) adopts them instead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_cancelled_starts_behind_mutation_lock_keep_both_close_markers_and_skip_parked_workers() {
    let rig = Rig::new();
    rig.begin("cp1").await;
    let worker = rig.review.begin_agent_review("s1", "worker-parked", "worker", "bg").expect("worker bound");
    rig.seal(1, "cp1").await;

    // Worker finishes while idle and parks for the next live turn.
    rig.edit("worker-parked", "w.txt", Some("parked\n")).await;
    assert!(worker.complete(Vec::new()));

    // Hold the per-session mutation lock (as Undo/Reapply does) while cp2 and cp3 both queue and cancel.
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let lock_holder = {
        let inner = rig.review.inner.clone();
        let entered = entered.clone();
        let release = release.clone();
        tokio::spawn(async move {
            inner
                .serialize_mutation("s1", async move {
                    entered.notify_one();
                    release.notified().await;
                })
                .await;
        })
    };
    entered.notified().await;

    let r2 = rig.review.clone();
    let ws2 = rig.ws_text.clone();
    let cp2_begin = tokio::spawn(async move { r2.begin_turn(&ws2, "s1", TurnOpen { checkpoint_id: "cp2".into() }).await });

    let r3 = rig.review.clone();
    let ws3 = rig.ws_text.clone();
    let cp3_begin = tokio::spawn(async move { r3.begin_turn(&ws3, "s1", TurnOpen { checkpoint_id: "cp3".into() }).await });

    // Both cancelled before their open_turn_snapshot runs under the mutation lock.
    rig.review.close_turn("s1", "cp2");
    rig.review.close_turn("s1", "cp3");
    {
        let reg = rig.review.inner.reg();
        let closed = reg.closed_before_open.get("s1").expect("both close markers recorded");
        assert!(closed.contains("cp2") && closed.contains("cp3"), "{closed:?}");
    }

    release.notify_one();
    lock_holder.await.unwrap();
    let t2 = cp2_begin.await.unwrap().expect("cp2 token");
    let t3 = cp3_begin.await.unwrap().expect("cp3 token");
    let _ = rig.review.complete_turn("s1", Some(&t2)).await;
    let _ = rig.review.complete_turn("s1", Some(&t3)).await;

    assert!(rig.review.inner.reg().closed_before_open.is_empty(), "all consumed close markers cleared");
    assert!(matches!(rig.changes("cp2").await["status"].as_str(), Some("none" | "missing")));
    assert!(matches!(rig.changes("cp3").await["status"].as_str(), Some("none" | "missing")));

    // Next real turn adopts the parked worker review.
    rig.begin("cp4").await;
    let live4 = rig.review().await;
    assert_eq!(files(&live4), [("w.txt".to_owned(), "A".to_owned(), json!([1, 0]))]);
    let agents = live4["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["sessionId"], "worker-parked");
}

/// When `MIXDOG_TURN_SNAPSHOT=off` disables reviews, `begin_turn` + `close_turn` never retains
/// stale entries in `closed_before_open`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_review_close_turn_leaves_closed_before_open_empty() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let processes = std::sync::Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    let bases = std::sync::Arc::new(mixdog_scm::worktree::review_bases::CapturedBases::new());
    let review = TurnReview::over_scm(scm, tokens, &data, |key| (key == "MIXDOG_TURN_SNAPSHOT").then(|| "off".to_owned()), bases);

    assert!(review.begin_turn(&plain(&ws), "s1", TurnOpen { checkpoint_id: "cp1".into() }).await.is_none());
    review.close_turn("s1", "cp1");
    assert!(review.inner.reg().closed_before_open.is_empty());
}

/// Deleting a session (`forget_session`) after `cp3` replaced `cp2` while `cp2`'s Git baseline
/// capture is still in flight stops `cp2`'s delayed baseline from recreating `bases` and stops
/// `cp2`'s detached seal task from persisting records.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forget_session_after_replaced_turn_stops_delayed_baseline_and_detached_seal() {
    use mixdog_app_protocol::v2::domain::ReviewScope;
    use mixdog_scm::service::ReviewBases;

    let (rig, gated, bases) = gated_git_rig(0);
    let review_cp2 = rig.review.clone();
    let ws_cp2 = rig.ws_text.clone();
    let cp2_begin = tokio::spawn(async move { review_cp2.begin_turn(&ws_cp2, "s1", TurnOpen { checkpoint_id: "cp2".into() }).await });
    gated.entered.notified().await;

    rig.edit("s1", "a.txt", Some("two\n")).await;
    // cp3 replaces cp2 in reg.trackers and spawns cp2's detached seal awaiting cp2's baseline.
    rig.begin("cp3").await;

    // Session is deleted while cp2's baseline capture and detached seal are still in flight.
    TurnReviewApi::forget_session(&rig.review, "s1");

    // Let cp2's delayed baseline capture complete and unblock its detached seal task.
    gated.release.notify_one();
    assert!(cp2_begin.await.unwrap().is_some());

    // Wait for cp2's detached seal to unwind its pending_freezes entry.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let pending = rig.review.inner.reg().pending_freezes.contains_key("s1\0cp2");
        if !pending {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "cp2 seal never released pending_freezes");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let thread = mixdog_protocol::ThreadId::from("s1");
    assert!(bases.base(&thread, ReviewScope::Turn, Some("cp2")).await.is_none(), "deleted session must not regain cp2 turn base");
    assert!(bases.base(&thread, ReviewScope::Session, None).await.is_none(), "deleted session must not regain session base");
    assert!(rig.review.store().load_turn_change_record("s1", "cp2").await.is_none(), "deleted session must not persist cp2 change record");
    assert!(rig.review.store().load_turn_snapshot_record("s1").await.is_none(), "deleted session must not persist snapshot record");
}
