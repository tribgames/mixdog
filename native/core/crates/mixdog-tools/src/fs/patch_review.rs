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
pub(super) async fn committed_patch(ctx: &ToolContext, before: &[Snapshot], paths: &[AbsPath], renames: &[(AbsPath, AbsPath)]) {
    if ctx.review.is_none() || before.is_empty() {
        return;
    }
    let Ok(Ok(after)) = capture(ctx, paths, &std::collections::HashSet::new()).await else { return };
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