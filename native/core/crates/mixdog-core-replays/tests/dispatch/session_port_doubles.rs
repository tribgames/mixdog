//! Doubles the session port's tests stand on: a catalog that lists nothing, a home that refuses (or accepts) the durable
//! watches it is given, the agent names, and a rebind that never fails.

use mixdog_core::run_host::tool_pool::session_control::ListedRow;
use mixdog_core::run_host::tool_pool::session_control::ListingPage;
use mixdog_core::run_host::tool_pool::session_control::LiveSources;
use mixdog_core::run_host::tool_pool::session_control::SessionListing;

use super::*;

/// The catalog the session tool lists, in the order given; empty by default.
#[derive(Default)]
pub(super) struct Fixture {
    pub(super) rows: Vec<ListedRow>,
    pub(super) live: LiveSources,
}

#[async_trait]
impl SessionListing for Fixture {
    async fn page(&self, limit: usize, _cursor: Option<&str>) -> Result<ListingPage, String> {
        let rows: Vec<ListedRow> = self.rows.iter().take(limit).cloned().collect();
        Ok(ListingPage { rows, next_cursor: None })
    }

    async fn row(&self, id: &str) -> Result<Option<ListedRow>, String> {
        Ok(self.rows.iter().find(|listed| listed.row["id"] == id).cloned())
    }

    async fn live_sources(&self) -> Result<LiveSources, String> {
        Ok(self.live.clone())
    }
}







