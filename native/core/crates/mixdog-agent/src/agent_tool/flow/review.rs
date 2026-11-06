//! Collects the latest diff a worker turn produced and hands it to the owner's turn review when
//! the turn completes (Node `agent-tool/turn-review.mjs`).

use std::sync::Mutex;

use super::seams::ReviewHandle;
use super::seams::ToolResultMessage;
use super::seams::TurnReviews;
use crate::agent_tool::scope::clean_str;

pub struct TurnReview {
    handle: Box<dyn ReviewHandle>,
    latest: Mutex<Option<String>>,
}

impl TurnReview {
    /// The owner is the first of `owners` that is set, in Node's order: the caller's session, the
    /// worker's parent, the notify context's owner, the worker's own owner.
    pub fn begin(reviews: &dyn TurnReviews, owners: [Option<&str>; 4], session_id: &str, tag: &str, agent: &str) -> Self {
        // `clean(a || b || c || d)`: the first set value wins, blank or not.
        let owner = owners
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .map(clean_str)
            .unwrap_or_default();
        Self { handle: reviews.begin(&owner, session_id, tag, agent), latest: Mutex::new(None) }
    }

    pub fn on_tool_result(&self, message: &ToolResultMessage) {
        if let Some(diff) = &message.ui_diff {
            *self.latest.lock().unwrap_or_else(|e| e.into_inner()) = Some(diff.clone());
        }
    }

    pub fn complete(&self) {
        let latest = self.latest.lock().unwrap_or_else(|e| e.into_inner()).clone();
        self.handle.complete(latest.into_iter().collect());
    }
}
