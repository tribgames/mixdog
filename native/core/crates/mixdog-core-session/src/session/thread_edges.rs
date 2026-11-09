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

use super::TaskWorkspace;
use super::thread_list::ThreadListService;
use super::transcript::summary_of_list_row;

const STARTED: &str = "thread/started";
const SUMMARY_UPDATED: &str = "thread/summary/updated";
const DELETED: &str = "thread/deleted";

/// The list row of a stored row when it is listed: the catalog's lead gate, then the roster's own (Node's second gate).
fn listed(row: &StoredRow, task_workspace: &str) -> Option<LeadRow> {
    if row.deleted {
        return None;
    }
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&row.summary) else { return None };
    (is_lead_visible_row(&map) && roster_row(&map, row.user_name.as_deref(), task_workspace)).then_some(LeadRow { row: map, archived: row.archived })
}

/// `isTaskWorkspaceFolder` (`shared/task-workspace.ts`): slash style, a trailing slash and letter case do not matter; an unknown
/// task workspace (`""`) matches nothing.
fn is_task_workspace_folder(folder: &str, task_workspace: &str) -> bool {
    let comparable = |value: &str| {
        let mut out = String::with_capacity(value.len());
        for c in value.chars() {
            if !(matches!(c, '\\' | '/') && out.ends_with('/')) {
                out.push(if c == '\\' { '/' } else { c });
            }
        }
        if out.ends_with('/') {
            out.pop();
        }
        out.to_lowercase()
    };
    !task_workspace.is_empty() && comparable(folder) == comparable(task_workspace)
}

/// Whether the row is a project (`desktop-state.ts:164-167`): the stored classification, else a legacy row with a folder outside the
/// host's task workspace.
fn is_project(meta: Option<&serde_json::Map<String, Value>>, cwd: &str, task_workspace: &str) -> bool {
    match meta.and_then(|meta| meta.get("classification")).and_then(Value::as_str) {
        Some(stored) => stored == "project",
        None => !cwd.is_empty() && !is_task_workspace_folder(cwd, task_workspace),
    }
}

/// Whether `desktopSessionSummaries` (`desktop-state.ts:144-246`) keeps the row. `name` is the name the user gave the session
/// (Node's `names[id]`, which `renameSession` writes beside the runtime title, `session-host-lifecycle.ts:225-230`): here the
/// header title when `titleSource` is `user` (`thread/name/set`), kept in the index with every session's row. `task_workspace` is
/// the host's task workspace (its `taskWorkspace` input): a legacy row running there is a task and needs no project path.
pub(super) fn roster_row(row: &serde_json::Map<String, Value>, name: Option<&str>, task_workspace: &str) -> bool {
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
    if is_project(meta, &cwd, task_workspace) {
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
    !mixdog_store::title::roster_preview_title(&text("preview")).is_empty() || manual || !title(&text("title"), 32).is_empty() || had_conversation || (agent_home && message_count > 0)
}

/// The fields of the row `desktopSessionSummaries` (`desktop-state.ts:180-208, 244`) derives, which the list row leaves as the index
/// stored them: the classification (stored, else a legacy row with a folder outside the host's task workspace is a project), the
/// project path (workspace record, then folder, then stored path; none for a task), the activity time (`lastUsedAt`, else
/// `updatedAt`) and the creation time when positive.
fn on_roster(mut thread: mixdog_protocol::ThreadSummary, row: &serde_json::Map<String, Value>, task_workspace: &str) -> mixdog_protocol::ThreadSummary {
    let number = |key: &str| row.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n != 0.0);
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
    let meta = row.get("desktopSession").and_then(Value::as_object);
    let cwd = text(row.get("cwd"));
    let project = is_project(meta, &cwd, task_workspace);
    let valid = |value: Option<&Value>| Some(text(value)).filter(|s| !s.is_empty() && !s.contains('\0'));
    let workspace = row.get("workspace").and_then(Value::as_object).filter(|w| valid(w.get("projectPath")).is_some() && valid(w.get("cwd")).is_some());
    thread.classification = Value::String(if project { "project" } else { "task" }.into());
    thread.project_path = project.then(|| {
        workspace.and_then(|w| valid(w.get("projectPath"))).unwrap_or_else(|| if cwd.is_empty() { text(meta.and_then(|meta| meta.get("projectPath"))) } else { cwd })
    });
    thread.activity_at = number("lastUsedAt").or_else(|| number("updatedAt")).map(|at| at as i64);
    let word = |key: &str| text(row.get(key));
    let kind = word("sourceType").to_lowercase();
    if kind == "schedule" || kind == "webhook" {
        thread.source_name = Some(word("sourceName")).filter(|name| !name.is_empty());
        thread.source_type = Some(kind);
    }
    thread.provider = Some(word("provider")).filter(|s| !s.is_empty());
    thread.model = Some(word("model")).filter(|s| !s.is_empty());
    thread.agent_session = (word("visibility") == "agent-only" || (word("owner") == "agent" && word("agent") != "lead")).then_some(true);
    thread.created_at = number("createdAt").filter(|at| *at > 0.0).map(|at| at as i64);
    thread
}

/// Decides and publishes what one row write means to the app feed.
pub struct ThreadEdgePublisher {
    list: Arc<ThreadListService>,
    app: Arc<SectionFeedState>,
    task_workspace: Arc<dyn TaskWorkspace>,
    /// The writes of refreshes whose task workspace lookup failed, one per session (the first `before`, the last `after`): the
    /// next refresh that can look the workspace up publishes what changed since the last roster it published.
    held: std::sync::Mutex<Vec<RowEdge>>,
}

impl ThreadEdgePublisher {
    pub fn new(list: Arc<ThreadListService>, app: Arc<SectionFeedState>, task_workspace: Arc<dyn TaskWorkspace>) -> Self {
        Self { list, app, task_workspace, held: std::sync::Mutex::new(Vec::new()) }
    }

    /// One catalog refresh (`publishCatalogs`, `session-host-catalog.ts:217-244`): it asks the host for the task workspace first
    /// (`listSessions`, `session-host.ts:793`), and a lookup that fails rejects the listing, so the refresh publishes nothing and
    /// the next store event tries again. The roster that refresh publishes is then the whole change since the last one.
    pub async fn publish(&self, edge: RowEdge) {
        let looked_up = self.task_workspace.path().await;
        let batch = {
            let mut held = self.held.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(at) = held.iter().position(|earlier| earlier.id == edge.id) {
                held[at].after = edge.after;
            } else {
                held.push(edge);
            }
            if looked_up.is_err() {
                return;
            }
            std::mem::take(&mut *held)
        };
        let Ok(workspace) = looked_up else { return };
        for edge in batch {
            self.publish_change(edge, &workspace).await;
        }
    }

    async fn publish_change(&self, edge: RowEdge, workspace: &str) {
        let id = ThreadId::from(edge.id.clone());        // Each side is judged with the name the user had given at its own write (the index keeps it with the row), as Node's
        // summaries read `names` as of each roster: a rename that makes a meaningless title count is a start.
        match (edge.before.as_ref().and_then(|row| listed(row, workspace)), listed(&edge.after, workspace)) {
            (None, Some(now)) => self.send(&id, &now, workspace, |thread| (STARTED, ThreadStartedParams { thread })).await,
            (Some(was), Some(now)) => {
                let (was, shown) = (on_roster(summary_of_list_row(&id, &Value::Object(was.row.clone()), now.archived), &was.row, workspace), on_roster(summary_of_list_row(&id, &Value::Object(now.row.clone()), now.archived), &now.row, workspace));
                if was != shown {
                    self.send(&id, &now, workspace, |thread| (SUMMARY_UPDATED, ThreadSummaryUpdatedParams { thread })).await;
                }
            }
            // A delete is announced by the delete (`purge.rs`); a row that stopped being listed otherwise is gone from the roster.
            (Some(_), None) if !edge.after.deleted => self.app.notify(DELETED, &ThreadIdParams { thread_id: id }),
            (Some(_), None) | (None, None) => {}
        }
    }

    /// The row `thread/list` shows for the written row, under `method`; none when the rooms leave it out.
    async fn send<P: serde::Serialize>(&self, id: &ThreadId, now: &LeadRow, workspace: &str, params: impl FnOnce(mixdog_protocol::ThreadSummary) -> (&'static str, P)) {
        match self.list.summary_of(id, now).await {
            Ok(Some(thread)) => {
                let (method, params) = params(on_roster(thread, &now.row, workspace));
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
