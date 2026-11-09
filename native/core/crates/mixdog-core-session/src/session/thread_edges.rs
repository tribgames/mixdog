//! The catalog row writes as app-feed notifications: `thread/started` when a session's row becomes listed,
//! `thread/summary/updated` when a listed row changes, `thread/deleted` when it stops being listed.
//!
//! Node pushed the whole roster to the phone whenever the stored-session catalog changed
//! (`onSessionCatalogDbChange` -> `scheduleCatalogRefresh` -> `publishCatalogs`, `session-host-catalog.ts:170-247`),
//! and `CatalogChannel.publish` (`session-host-publication.ts:109-146`) skipped a roster canonically equal to the last
//! one. A row the previous roster lacked was a new session, a row in both that differed was an update, a row only the
//! previous roster held was a removal. The index writer reports each row write that changed a row
//! ([`mixdog_store::sqlite::RowSink`]), and the same three cases are decided on it, after the row is durable:
//! - listed is the lead gate (`is_lead_visible_row`, Node's `leadSessionRow`) on a row that is not deleted;
//! - an unchanged row, in the fields the summary carries, publishes nothing. The archived flag is the one field left
//!   out of that comparison: `thread/archived` and `thread/unarchived` (`thread_settings.rs`) announce it;
//! - a deleted row is announced by the delete itself (`purge.rs`, `thread/deleted`), so the write that marks it deleted
//!   adds nothing.

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadIdParams;
use mixdog_app_protocol::v2::thread::ThreadStartedParams;
use mixdog_app_protocol::v2::thread::ThreadSummaryUpdatedParams;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::state::SectionFeedState;
use mixdog_store::sqlite::RowEdge;
use mixdog_store::sqlite::RowSink;
use mixdog_store::sqlite::StoredRow;
use mixdog_store::sqlite::lead::LeadRow;
use mixdog_store::sqlite::lead::is_lead_visible_row;
use serde_json::Value;

use super::thread_list::ThreadListService;
use super::transcript::summary_of_list_row;

const STARTED: &str = "thread/started";
const SUMMARY_UPDATED: &str = "thread/summary/updated";
const DELETED: &str = "thread/deleted";

/// The list row of a stored row when it is listed: the catalog's lead gate, then the roster's own (Node's second gate).
fn listed(row: &StoredRow, name: Option<&str>) -> Option<LeadRow> {
    if row.deleted {
        return None;
    }
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&row.summary) else { return None };
    (is_lead_visible_row(&map) && roster_row(&map, name)).then_some(LeadRow { row: map, archived: row.archived })
}

/// Whether `desktopSessionSummaries` (`desktop-state.ts:144-246`) keeps the row. `name` is the name the user gave the session
/// (Node's `names[id]`, which `renameSession` writes beside the runtime title, `session-host-lifecycle.ts:225-230`): here the
/// loaded session's header title when `titleSource` is `user` (`name_set`). The host's task workspace, its other input, decides a
/// legacy row's classification only, and a legacy row with a folder has a project path whichever it is, so it never changes
/// whether the row is kept (recorded cases `g_legacy_in_task_workspace*`).
pub(super) fn roster_row(row: &serde_json::Map<String, Value>, name: Option<&str>) -> bool {
    let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned();
    // Valid workspace paths (`workspaceText`): trimmed, non-empty, no NUL.
    let path = |value: Option<&Value>| value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && !s.contains('\0')).map(str::to_owned);
    let meta = match row.get("desktopSession") {
        None | Some(Value::Null) => None,
        Some(Value::Object(meta)) => Some(meta),
        Some(_) => return false, // :156
    };
    if meta.is_some_and(|meta| !matches!(meta.get("classification").and_then(Value::as_str), Some("project" | "task"))) {
        return false; // :158
    }
    let cwd = text("cwd");
    if cwd.contains('\0') {
        return false; // :160
    }
    let project = match meta.and_then(|meta| meta.get("classification")).and_then(Value::as_str) {
        Some(stored) => stored == "project",
        None => !cwd.is_empty(), // :167: a legacy row with a folder is a project (the task workspace is a host fact)
    };
    if project {
        // :168-174: the workspace record, then the folder, then the stored project path.
        let workspace = row.get("workspace").and_then(Value::as_object).filter(|w| path(w.get("projectPath")).is_some() && path(w.get("cwd")).is_some());
        let stored = meta.and_then(|meta| meta.get("projectPath")).and_then(Value::as_str).unwrap_or_default().trim();
        let project_path = workspace.and_then(|w| path(w.get("projectPath"))).unwrap_or_else(|| if cwd.is_empty() { stored.to_owned() } else { cwd.clone() });
        if project_path.is_empty() || project_path.contains('\0') {
            return false;
        }
    }
    // :175-241: a row needs a title or a real conversation.
    let title = |value: &str, max| mixdog_store::title::generated_session_title(value, "", max);
    let message_count = row.get("messageCount").and_then(Value::as_f64).filter(|n| n.is_finite()).map_or(0, |n| n.max(0.0).floor() as u64);
    let real_turns = row.get("realTurnCount").and_then(Value::as_f64);
    let had_conversation = message_count >= 2 && row.get("detachedReason").and_then(Value::as_str) != Some("cli-resume") && real_turns.is_none_or(|n| n >= 1.0);
    let agent_home = !mixdog_store::agent_mode::agent_id_of_home_session(&text("id")).is_empty();
    let manual = name.is_some_and(|name| !mixdog_store::title::normalize_session_title(name, "", 100).is_empty());
    !title(&text("preview"), 32).is_empty() || manual || !title(&text("title"), 32).is_empty() || had_conversation || (agent_home && message_count > 0)
}

/// Decides and publishes what one row write means to the app feed.
pub struct ThreadEdgePublisher {
    list: Arc<ThreadListService>,
    app: Arc<SectionFeedState>,
}

impl ThreadEdgePublisher {
    pub fn new(list: Arc<ThreadListService>, app: Arc<SectionFeedState>) -> Self {
        Self { list, app }
    }

    pub async fn publish(&self, edge: RowEdge) {
        let id = ThreadId::from(edge.id.clone());
        // The name the user gave is known for a loaded session, which is where a rename happens; the row before the write is
        // judged without it, so a rename that makes a meaningless title count is a start.
        let name = self.list.user_name(&id);
        let before = edge.before.as_ref().and_then(|row| listed(row, None));
        match (before, listed(&edge.after, name.as_deref())) {
            (None, Some(now)) => self.send(&id, &now, |thread| (STARTED, ThreadStartedParams { thread })).await,
            (Some(was), Some(now)) => {
                let (was, shown) = (summary_of_list_row(&id, &Value::Object(was.row), now.archived), summary_of_list_row(&id, &Value::Object(now.row.clone()), now.archived));
                if was != shown {
                    self.send(&id, &now, |thread| (SUMMARY_UPDATED, ThreadSummaryUpdatedParams { thread })).await;
                }
            }
            // A delete is announced by the delete (`purge.rs`); a row that stopped being listed otherwise is gone from the roster.
            (Some(_), None) if !edge.after.deleted => self.app.notify(DELETED, &ThreadIdParams { thread_id: id }),
            (Some(_), None) | (None, None) => {}
        }
    }

    /// The row `thread/list` shows for the written row, under `method`; none when the rooms leave it out.
    async fn send<P: serde::Serialize>(&self, id: &ThreadId, now: &LeadRow, params: impl FnOnce(mixdog_protocol::ThreadSummary) -> (&'static str, P)) {
        match self.list.summary_of(id, now).await {
            Ok(Some(thread)) => {
                let (method, params) = params(thread);
                self.app.notify(method, &params);
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(?error, thread = id.as_str(), "the row of a written session could not be read"),
        }
    }
}

/// The sink the index writer calls: the edges go to one task, in write order, so the notifications keep it.
pub struct ThreadEdges {
    queue: tokio::sync::mpsc::UnboundedSender<RowEdge>,
}

impl ThreadEdges {
    /// Starts the task that publishes the edges it is sent.
    pub fn start(publisher: ThreadEdgePublisher) -> Arc<Self> {
        let (queue, mut edges) = tokio::sync::mpsc::unbounded_channel();
        drop(mixdog_rt::spawn("thread-edges", mixdog_rt::TaskClass::Work, async move {
            while let Some(edge) = edges.recv().await {
                publisher.publish(edge).await;
            }
        }));
        Arc::new(Self { queue })
    }
}

impl RowSink for ThreadEdges {
    fn written(&self, edge: RowEdge) {
        let _ = self.queue.send(edge);
    }
}
