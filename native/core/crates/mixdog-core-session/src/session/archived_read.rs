//! `thread/read` of a reaped agent child: no session of its own, read through the parents whose header carries its
//! archived result (`readVanishedSessionTranscript` → `readArchivedAgentResult`): one assistant row headed
//! "# Archived agent result" and the child's route, answered as a snapshot of no thread a client can resume.

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::Reply;
use mixdog_protocol::ThreadId;
use serde_json::Map;
use serde_json::Value;

use super::directory::DirInner;
use super::state::SessionState;
use super::state::WindowItem;
use super::transcript::RowCtx as Ctx;
use super::transcript::row_item as item_of;
use super::view::SnapshotParams;

/// The header keys of Node's archived view the route and list row read.
const ROUTE_KEYS: [&str; 5] = ["provider", "model", "effort", "cwd", "desktopSession"];

impl DirInner {
    /// The archived view of `child` as Node's reader builds it; `None` when no parent carries one.
    pub(super) async fn archived_agent_view(&self, child: &ThreadId) -> Result<Option<Value>, CoreError> {
        let mut entries = Vec::new();
        for parent in self.deps.store.archived_agent_parents(child).await? {
            if let Some(entry) = self.stored_header(&parent).await.and_then(|h| mixdog_store::archived_agent::entry(&h, child.as_str()).cloned()) {
                entries.push(entry);
            }
        }
        Ok(mixdog_store::archived_agent::view(child.as_str(), &entries.iter().collect::<Vec<_>>()))
    }

    /// `thread/read` of a child [`archived_agent_view`](Self::archived_agent_view) finds; `threadNotFound` otherwise.
    pub(super) async fn read_archived(&self, child: &ThreadId) -> Result<Reply, CoreError> {
        let Some(view) = self.archived_agent_view(child).await? else {
            return Err(CoreError::ThreadNotFound { thread_id: child.clone() });
        };
        let mut header = Map::new();
        for key in ROUTE_KEYS {
            header.insert(key.to_owned(), view[key].clone());
        }
        let mut state = SessionState::new(1);
        state.header = header;
        state.sections.route = Some(ThreadRoute { fast: view["fast"].as_bool(), ..Default::default() });
        let ctx = Ctx { turn: None, message: None, counts_prompt: false, source: None };
        for row in view["items"].as_array().into_iter().flatten().filter_map(Value::as_object) {
            state.window.push_back(WindowItem { ordinal: None, item: Arc::new(item_of(row.clone(), &ctx)), prompt: None, messages: 0 });
        }
        let summary = self.deps.transcript.summary(child, &state.header);
        let thread_state = state.thread_state(StorageState::Ok);
        let params = SnapshotParams { thread: &summary, state: &thread_state, items: state.window.iter().map(|row| row.item.as_ref()).collect(), has_older: false };
        Ok(Reply::Value(serde_json::to_value(&params).map_err(|_| CoreError::Internal { incident_id: "archived-agent-read".into() })?))
    }
}
