//! A turn review over the real lane disk and Git, for the tests of the layers that serve it.

use std::path::Path;
use std::sync::Arc;

use super::service::TurnReview;

/// A component over the real lane disk and Git.
pub fn test_review(data: &Path) -> TurnReview {
    review_at(data)
}

pub fn review_at(data: &Path) -> TurnReview {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    TurnReview::over_scm(scm, tokens, data, |_| None)
}
