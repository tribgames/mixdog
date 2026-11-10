//! A turn review over the real lane disk and Git, for the tests of the layers that serve it.

use std::path::Path;
use std::sync::Arc;

use mixdog_scm::worktree::review_bases::CapturedBases;

use super::service::TurnReview;

/// A component over the real lane disk and Git.
pub fn test_review(data: &Path) -> TurnReview {
    review_at(data)
}

pub fn review_at(data: &Path) -> TurnReview {
    review_with_bases(data).0
}

/// Returns once every deleted session's marker and baseline removal started so far has landed.
pub async fn forgotten(review: &TurnReview) {
    let tasks = std::mem::take(&mut *review.inner.forgets.lock().unwrap_or_else(|e| e.into_inner()));
    for task in tasks {
        task.await.expect("a session's review removal");
    }
}

/// A turn review over the real lane disk and Git, with the `CapturedBases` it records into.
pub fn review_with_bases(data: &Path) -> (TurnReview, Arc<CapturedBases>) {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    let bases = Arc::new(CapturedBases::new());
    (TurnReview::over_scm(scm, tokens, data, |_| None, bases.clone()), bases)
}
