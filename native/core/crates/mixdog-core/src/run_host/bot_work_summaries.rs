//! `BotWork`'s change signal: which bots own a session's work changed, so the session's catalog
//! row (`handedBy`) goes out again.
//!
//! Node: `noteBotWork` / `endBotWork` call `emitSessionBotWorkChange(sessionId)`
//! (`runtime/shared/bot-owned-work.mjs:46,55`); the stored-session catalog listens
//! (`onSessionBotWorkChange(() => notifyCatalogListeners('bot-work'))`,
//! `store-summary-reader.mjs:205-209`) and the catalog consumers re-list. Here the change
//! publishes the one session's row on the app feed as `thread/list` shows it now
//! (`thread/summary/updated`, as `RoomSummaries` does for a room), so a client sees `handedBy`
//! move without re-listing.
//!
//! The list service reads the overlay, which holds the `BotWork` whose signal this is, so the
//! cell is bound once after the list service exists; the composition verifies it before the
//! listener accepts.

use std::sync::{Arc, OnceLock};

use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::state::SectionFeedState;
use mixdog_core_session::session::thread_list::ThreadListService;

use super::late::Bound;

pub struct BotWorkSummaries {
    target: OnceLock<(Arc<ThreadListService>, Arc<SectionFeedState>)>,
}

impl BotWorkSummaries {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { target: OnceLock::new() })
    }

    /// Binds the list service and the app feed once; the second bind is refused.
    pub fn bind(&self, list: Arc<ThreadListService>, app: Arc<SectionFeedState>) -> Result<(), &'static str> {
        self.target.set((list, app)).map_err(|_| "the bot work summaries are already bound")
    }

    /// `BotWork::new`'s `on_change`: `emitSessionBotWorkChange(session)`. The row is read and
    /// published off the caller. The cell is verified bound before any send can note work.
    pub fn changed(&self, session: &str) {
        let (list, app) = self.target.get().expect("the bot work summaries are verified bound before sends run").clone();
        let id = ThreadId::from(session);
        drop(mixdog_rt::spawn("bot-work-summary", mixdog_rt::TaskClass::Work, async move {
            match list.summary(&id).await {
                Ok(Some(thread)) => list.announce(&app, thread, false),
                // A session with no listed row has nothing to show.
                Ok(None) => {}
                Err(error) => tracing::warn!(?error, thread = id.as_str(), "bot work: the row could not be read"),
            }
        }));
    }
}

impl Bound for BotWorkSummaries {
    fn cell(&self) -> &'static str {
        "bot work summaries"
    }

    fn is_bound(&self) -> bool {
        self.target.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unbound_cell_is_reported_by_name() {
        let cell = BotWorkSummaries::new();
        assert_eq!(crate::run_host::late::require(&[&*cell]).unwrap_err().cell, "bot work summaries");
    }
}
