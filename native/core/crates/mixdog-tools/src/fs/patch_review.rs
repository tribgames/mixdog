//! The turn-review side channel of the edit tools, as Node's `registerEditToolUiDiff` and
//! `registerCommittedPatchUiDiff` run it: after a committed write the call's changes join the
//! session's turn review and the call's own card diff comes back as the result's `uiDiff`. Display
//! only: nothing here fails or alters the call.

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;

use super::patch_guard::Snapshot;
use super::patch_guard::capture;
use super::read::content_hash_of;
use super::read_state::FileVersion;
use super::read_state::ReadState;
use super::read_state::SnapshotMeta;
use super::read_state::covers_full_file;
use super::read_state::hash_text;

fn text_of(path: &AbsPath) -> String {
    path.as_path().to_string_lossy().into_owned()
}

/// Records `changes` for this call; `false` when there is no review or no call to attach them to.
async fn record(ctx: &ToolContext, changes: Vec<CallChange>) -> bool {
    let Some(review) = &ctx.review else { return false };
    let (call, session) = (ctx.call_id.as_str(), ctx.thread_id.as_str());
    if call.is_empty() || session.is_empty() || changes.is_empty() {
        return false;
    }
    review.record_call(call, session, &text_of(&ctx.cwd), changes).await;
    true
}

/// The call's card diff as the result's `uiDiff`, once.
pub(super) fn with_card_diff(ctx: &ToolContext, mut output: ToolOutput) -> ToolOutput {
    if let Some(diff) = ctx.review.as_ref().and_then(|r| r.take_call_diff(ctx.call_id.as_str())) {
        output.meta = Some(serde_json::json!({ "uiDiff": diff }));
    }
    output
}

/// A committed `edit`: one file, `before` absent for a created file.
pub(super) async fn committed_edit(ctx: &ToolContext, abs: &AbsPath, before: Option<Vec<u8>>, after: Vec<u8>, output: ToolOutput) -> ToolOutput {
    let change = CallChange {
        path: text_of(abs),
        new_path: None,
        before: before.map_or(ReviewContent::Absent, ReviewContent::bytes),
        after: ReviewContent::bytes(after),
    };
    record(ctx, vec![change]).await;
    with_card_diff(ctx, output)
}

fn find<'a>(snapshots: &'a [Snapshot], path: &AbsPath) -> Option<&'a Snapshot> {
    let key = mixdog_scm::locks::path_key(path.as_path());
    snapshots.iter().find(|s| mixdog_scm::locks::path_key(s.path.as_path()) == key)
}

fn content(snapshot: Option<&Snapshot>) -> ReviewContent {
    snapshot.map_or(ReviewContent::Absent, Snapshot::review_content)
}

/// A committed `apply_patch`: `before` are the pre-patch snapshots, `paths` only the targets the
/// apply actually mutated, `renames` the (source, destination) pairs of V4A moves.
///
/// `announce`: the read state's invalidation (which the review follows) happens here, as Node's native apply does it once for
/// the batch. A sequence announces each unit as it commits ([`unit_committed`]), so its end does not announce again.
pub(super) async fn committed_patch(ctx: &ToolContext, state: Option<&ReadState>, before: &[Snapshot], paths: &[AbsPath], renames: &[(AbsPath, AbsPath)], announce: bool) {
    if (ctx.review.is_none() && state.is_none()) || before.is_empty() {
        return;
    }
    let Ok(Ok(after)) = capture(ctx, paths, &std::collections::HashSet::new()).await else { return };
    if let Some(state) = state {
        note_patch(ctx, state, before, &after, announce);
    }
    if ctx.review.is_none() {
        return;
    }
    let key = |p: &AbsPath| mixdog_scm::locks::path_key(p.as_path());
    let mut changes = Vec::new();
    let mut renamed = std::collections::HashSet::new();
    for (src, dest) in renames {
        changes.push(CallChange {
            path: text_of(src),
            new_path: Some(text_of(dest)),
            before: content(find(before, src)),
            after: content(find(&after, dest)),
        });
        renamed.insert(key(src));
        renamed.insert(key(dest));
    }
    for path in paths.iter().filter(|p| !renamed.contains(&key(p))) {
        changes.push(CallChange { path: text_of(path), new_path: None, before: content(find(before, path)), after: content(find(&after, path)) });
    }
    record(ctx, changes).await;
}
fn state_key(path: &AbsPath) -> String {
    super::common::fwd(path.as_path())
}

/// One sequence unit reached disk: its paths' cached answers are dropped at once (Node's `invalidateNativeCaches` after each
/// native unit), which is a boundary for the review of their worktrees.
///
/// Node's next `await` lets the delivery queued by that signal run before the next unit signals; an await that is ready does
/// not yield in Rust, so the yield is explicit.
pub(super) async fn unit_committed(state: Option<&ReadState>, paths: &[&AbsPath]) {
    let Some(state) = state else { return };
    let keys: Vec<String> = paths.iter().map(|p| state_key(p)).collect();
    state.invalidate(&keys.iter().map(String::as_str).collect::<Vec<_>>());
    tokio::task::yield_now().await;
}

/// What the read state learns from a committed patch (`recordNativeSnapshots`): a deleted file is
/// forgotten; a written one is recorded as patched. The patch inherits "the session holds the body"
/// only when the session had read exactly the bytes the patch started from.
fn note_patch(ctx: &ToolContext, state: &ReadState, before: &[Snapshot], after: &[Snapshot], announce: bool) {
    let scope = ctx.thread_id.to_string();
    for snap in after {
        let key = state_key(&snap.path);
        if snap.bytes().is_none() && snap.version().is_none() {
            if announce {
                state.forget_path(&key);
            } else {
                state.sweep_path(&key);
            }
            continue;
        }
        if announce {
            state.invalidate(&[key.as_str()]);
        } else {
            state.drop_cached(&[key.as_str()]);
        }
        let Some(version) = snap.version() else { continue };
        let prior = state.snapshot(Some(&scope), &key);
        let started = find(before, &snap.path);
        let proven = match (prior, started.and_then(Snapshot::bytes)) {
            (Some(prior), Some(bytes)) => {
                prior.content_hash.is_some()
                    && (prior.body_delivered == Some(true) || covers_full_file(&prior))
                    && content_hash_of(bytes) == prior.content_hash
            }
            _ => false,
        };
        let meta = SnapshotMeta {
            pre_mutation: if proven { started.and_then(Snapshot::version) } else { None },
            content_hash: snap.bytes().and_then(content_hash_of),
            ..SnapshotMeta::new("apply_patch_native")
        };
        state.record(Some(&scope), &key, Some(version), meta);
    }
}

/// What the read state learns from a committed `edit` (`recordEditSnapshot`): cached answers about
/// the file are dropped and the session's snapshot becomes the edit, which keeps "the body was
/// delivered" only when the edit started from the file as the session last saw it.
pub(super) async fn note_edit(ctx: &ToolContext, state: &ReadState, abs: &AbsPath, pre: Option<FileVersion>, written: &[u8]) {
    let key = state_key(abs);
    state.invalidate(&[key.as_str()]);
    let Ok(stat) = ctx.files.stat(ctx.io.interactive, abs.clone()).await else { return };
    let meta = SnapshotMeta {
        replace_existing: true,
        pre_mutation: pre,
        content_hash: content_hash_of(written).or_else(|| Some(hash_text(""))),
        ..SnapshotMeta::new("edit")
    };
    state.record(Some(&ctx.thread_id.to_string()), &key, FileVersion::of(&stat), meta);
}