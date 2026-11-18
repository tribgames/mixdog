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

/// The bot's home and its durable watches; a home built with `refusing` makes the watch store refuse every watch.
#[derive(Default)]
#[cfg(node_twin)]
pub(super) struct HomeRecords {
    refuse: Option<mixdog_services::bots::delivery::queue::WatchError>,
}

#[cfg(node_twin)]
impl HomeRecords {
    /// A home whose watch store refuses every watch with `error`.
    #[cfg(node_twin)]
    pub(super) fn refusing(error: mixdog_services::bots::delivery::queue::WatchError) -> Self {
        Self { refuse: Some(error) }
    }
}

#[async_trait]
#[cfg(node_twin)]
impl mixdog_services::task_reports::host::HomeQueue for HomeRecords {
    async fn enqueue_task(&self, _: &str, _: &mixdog_services::bots::delivery::home::TaskReport) -> Result<(), String> {
        Ok(())
    }
    async fn disown(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn watches(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn owned(&self) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn watch(&self, _: Value) -> Result<(), mixdog_services::bots::delivery::queue::WatchError> {
        match &self.refuse {
            Some(refused) => Err(refused.clone()),
            None => Ok(()),
        }
    }
    async fn unwatch(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn own(&self, _: Value) -> Result<(), String> {
        Ok(())
    }
    async fn disown_all(&self, _: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    async fn follow(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Agent display names by id; an unknown id is its own name.
#[cfg(node_twin)]
pub(super) struct Named(pub(super) Vec<Value>);

#[async_trait]
#[cfg(node_twin)]
impl mixdog_core::run_host::tool_pool::session_send::AgentNames for Named {
    async fn name(&self, agent_id: &str) -> String {
        self.0.iter().find(|bot| bot["id"] == agent_id).and_then(|bot| bot["name"].as_str()).unwrap_or(agent_id).to_owned()
    }
}

#[cfg(node_twin)]
pub(super) struct NoRebind;

#[async_trait]
#[cfg(node_twin)]
impl mixdog_core::run_host::tool_pool::session_send::Rebind for NoRebind {
    async fn rebind(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
}
