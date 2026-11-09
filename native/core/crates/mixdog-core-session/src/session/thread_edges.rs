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

/// The list row of a stored row when it is listed.
fn listed(row: &StoredRow) -> Option<LeadRow> {
    if row.deleted {
        return None;
    }
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&row.summary) else { return None };
    is_lead_visible_row(&map).then_some(LeadRow { row: map, archived: row.archived })
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
        let before = edge.before.as_ref().and_then(listed);
        match (before, listed(&edge.after)) {
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
