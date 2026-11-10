//! The thread reads: `thread/items/list`, `thread/items/read`, `thread/turns/list`,
//! `thread/attachment/list`, `thread/modelMessages/list` and `thread/finalAnswer/read`.
//!
//! One path for every thread, loaded or not: the directory answers each from the session's
//! stored history (`ThreadStore::history_rows` flushes the projector first, so a loaded
//! thread's acked rows are all there), as Node's `readSessionHistory` / `readSessionFinalAnswer`
//! read stored sessions without loading them. A loaded thread adds only what is live (is a
//! turn running, and which).
//!
//! The rules are Node's where Node has them, over the display row a history item stands for
//! ([`display_row`], Node's transcript row), compared against recorded Node output
//! (`fixtures/session-reads/golden.json`):
//! - the page around a row is `storedHistorySlice({cursor})` (`historyCursorSlice`, `budgetedEdge`);
//! - the final answer is `sessionFinalAnswer` (`session-final-answer.ts`);
//! - the attachment rows are `attachmentHistoryRows`;
//! - the model messages are `readModelMessages` (`session-ops.mjs`).
//!
//! What only the v2 protocol names (`thread/turns/list`, the no-anchor and opaque forms of
//! `thread/items/list`, the attachment and model-message cursors) is decided in
//! `decisions.md` (D-reads-*).

use mixdog_app_protocol::v2::thread::ItemsCursor;
use mixdog_app_protocol::v2::thread::SortDirection;
use mixdog_app_protocol::v2::thread::ThreadFinalAnswerReadParams;
use mixdog_app_protocol::v2::thread::ThreadItemsListParams;
use mixdog_app_protocol::v2::thread::ThreadItemsListResponse;
use mixdog_app_protocol::v2::thread::ThreadItemsReadParams;
use mixdog_app_protocol::v2::thread::ThreadItemsReadResponse;
use mixdog_app_protocol::v2::thread::ThreadModelMessagesListParams;
use mixdog_app_protocol::v2::thread::ThreadPageParams;
use mixdog_app_protocol::v2::thread::ThreadTurnsListParams;
use mixdog_app_protocol::v2::thread::ThreadTurnsListResponse;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ItemStatus;
use mixdog_protocol::RoomRowKind;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::Turn;
use mixdog_protocol::TurnEndStatus;
use mixdog_protocol::TurnError;
use mixdog_protocol::TurnStatus;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;

use super::SessionDeps;
use super::directory::DirInner;
use super::transcript::position_of_id;
use super::view::meta;

/// `PAGE_MIN_ROWS` (`store-transcript-projection.mjs`): a byte budget never cuts a page below
/// this many rows.
const MIN_ROWS: usize = 8;
/// `CURSOR_PAGE_MAX_ROWS`: the most rows one page carries.
const MAX_ROWS: usize = 512;
/// A turns page without a `limit` (the store's turn query pages by 50).
const TURNS_PAGE: usize = 50;
/// `Number.isSafeInteger`'s top.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// Whether `method` is one of the reads this module answers.
pub(super) fn serves(method: &str) -> bool {
    matches!(
        method,
        "thread/items/list"
            | "thread/items/read"
            | "thread/turns/list"
            | "thread/attachment/list"
            | "thread/modelMessages/list"
            | "thread/finalAnswer/read"
    )
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

fn params<T: DeserializeOwned>(req: &CoreRequest, expected: &str) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|_| invalid("params", expected))
}

/// A thread's whole stored history as the transcript shows it, oldest first
/// (`readSessionHistory`); the thread need not be loaded.
pub(super) async fn history_items(deps: &SessionDeps, id: &ThreadId) -> Result<Vec<ThreadItem>, CoreError> {
    Ok(history(deps, id).await?.rows.into_iter().map(|(item, _)| item).collect())
}

/// The stored history: each item with the byte length of its display row, at the history
/// revision it was read at.
pub(super) struct History {
    pub rev: u64,
    pub rows: Vec<(ThreadItem, usize)>,
}

pub(super) async fn history(deps: &SessionDeps, id: &ThreadId) -> Result<History, CoreError> {
    let token = CancellationToken::new();
    let dropped = || CoreError::Internal { incident_id: "session-history-job-dropped".into() };
    let (store, thread) = (deps.store.clone(), id.clone());
    let (rev, records) = deps.lanes.io.submit(&token, move |lane| store.history_rows(lane, &thread))?.await.map_err(|_| dropped())??;
    let transcript = deps.transcript.clone();
    let rows = deps.lanes.cpu.submit(&token, move |lane| records.iter().flat_map(|record| transcript.rows(lane, record)).collect())?;
    Ok(History { rev, rows: rows.await.map_err(|_| dropped())? })
}

impl DirInner {
    /// Answers one of the reads for the thread its params name, loaded or not.
    pub(super) async fn serve_read(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let id = req
            .params
            .get("threadId")
            .and_then(Value::as_str)
            .map(ThreadId::from)
            .ok_or_else(|| invalid("threadId", "a thread id"))?;
        let History { rev, rows } = history(&self.deps, &id).await?;
        let items: Vec<ThreadItem> = rows.iter().map(|(item, _)| item.clone()).collect();
        match req.method.as_str() {
            "thread/items/list" => items_list(&id, rev, &rows, params(req, "ThreadItemsListParams")?),
            "thread/items/read" => items_read(&id, &items, params(req, "ThreadItemsReadParams")?),
            "thread/turns/list" => turns_list(&items, params(req, "ThreadTurnsListParams")?, self.active_turn(&id)),
            "thread/attachment/list" => attachment_list(&items, params(req, "ThreadPageParams")?),
            "thread/modelMessages/list" => self.model_messages_list(&id, params(req, "ThreadModelMessagesListParams")?).await,
            "thread/finalAnswer/read" => {
                let p: ThreadFinalAnswerReadParams = params(req, "ThreadFinalAnswerReadParams")?;
                let rows: Vec<Value> = items.iter().map(display_row).collect();
                Ok(Reply::Value(final_answer(&rows, self.busy(&id), p.started_at).unwrap_or(Value::Null)))
            }
            _ => unreachable!("`serves` admits only these methods"),
        }
    }

    /// Whether the loaded thread is running a turn (`snapshot.busy`); an unloaded one is not.
    fn busy(&self, id: &ThreadId) -> bool {
        self.loaded(id).is_some_and(|handle| handle.cell.view.load_full().state.runtime.as_ref().is_some_and(|runtime| runtime.busy))
    }

    /// The turn the loaded thread's run is in.
    fn active_turn(&self, id: &ThreadId) -> Option<String> {
        self.loaded(id).and_then(|handle| handle.cell.run.load_full().map(|run| run.turn.as_str().to_owned()))
    }

    async fn model_messages_list(&self, id: &ThreadId, p: ThreadModelMessagesListParams) -> Result<Reply, CoreError> {
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            lanes: self.deps.lanes,
            thread: id.clone(),
            input: ItemId::from(String::new()),
        };
        let messages: Vec<Value> = context.read().await?.into_iter().map(|(_, message)| message).collect();
        let start = usize::try_from(p.start).unwrap_or(usize::MAX);
        let rest = messages.get(start..).unwrap_or_default();
        let take = p.limit.map_or(rest.len(), |n| (n as usize).min(rest.len()));
        Ok(Reply::Value(json!({ "messageCount": messages.len(), "messages": rest[..take] })))
    }
}

/// `thread/items/list`: the page around the cursor's row. The cursor names a row by its id, so a
/// row a rewind or a clear removed answers `cursorInvalidated` (protocol §5.5, retracting
/// D-reads-1's `itemNotFound`): the client restarts from its snapshot. The page's byte budget
/// counts `rows`' display-row lengths, as Node's `budgetedEdge` counts the transcript rows.
fn items_list(id: &ThreadId, rev: u64, rows: &[(ThreadItem, usize)], p: ThreadItemsListParams) -> Result<Reply, CoreError> {
    let limit = match p.limit {
        None => MAX_ROWS,
        Some(n) if (1..=MAX_ROWS as u32).contains(&n) => n as usize,
        Some(_) => return Err(invalid("limit", "an integer from 1 to 512")),
    };
    let budget = match p.byte_budget {
        None => None,
        Some(b) if (1..=MAX_SAFE).contains(&b) => Some(b),
        Some(_) => return Err(invalid("byteBudget", "a positive safe integer")),
    };
    let anchor = match &p.cursor {
        None => None,
        Some(ItemsCursor::Opaque(item)) => Some(item.as_str()),
        Some(ItemsCursor::Item { kind, item_id }) if kind == "item" => Some(item_id.as_str()),
        Some(ItemsCursor::Item { .. }) => return Err(invalid("cursor.type", "item")),
    };
    let turn: Vec<&(ThreadItem, usize)> = rows
        .iter()
        .filter(|(item, _)| p.turn_id.as_ref().is_none_or(|turn| meta(item).turn_id.as_ref().is_some_and(|t| t.as_str() == turn.as_str())))
        .collect();
    let at = match anchor {
        None => None,
        Some(item) => Some(
            position_of_id(turn.iter().map(|(row, _)| row), item)
                .ok_or_else(|| CoreError::CursorInvalidated { thread_id: id.clone(), history_rev: rev })?,
        ),
    };
    let older = !matches!(p.sort_direction, Some(SortDirection::Asc));
    let sizes: Vec<usize> = turn.iter().map(|(_, bytes)| *bytes).collect();
    let page = page_of(&sizes, at, older, limit, budget).expect("the anchor is a position of the rows");
    let data: Vec<ThreadItem> = turn[page.start..page.end].iter().map(|(item, _)| item.clone()).collect();
    let edge = |row: Option<&ThreadItem>, wanted: bool| row.filter(|_| wanted).map(|item| item.id().as_str().to_owned());
    // The cursor onward in the page's own direction, and the one back.
    let (next, back) = if older {
        (edge(data.first(), page.has_older), edge(data.last(), page.has_newer))
    } else {
        (edge(data.last(), page.has_newer), edge(data.first(), page.has_older))
    };
    let response = ThreadItemsListResponse { data, has_older: page.has_older, has_newer: page.has_newer, next_cursor: next, backwards_cursor: back };
    Ok(Reply::Value(serde_json::to_value(response).expect("protocol types serialize")))
}

fn items_read(id: &ThreadId, items: &[ThreadItem], p: ThreadItemsReadParams) -> Result<Reply, CoreError> {
    let mut found = Vec::with_capacity(p.item_ids.len());
    for wanted in &p.item_ids {
        let in_turn = items.iter().filter(|item| p.turn_id.as_ref().is_none_or(|turn| meta(item).turn_id.as_ref().is_some_and(|t| t.as_str() == turn.as_str())));
        let item = position_of_id(in_turn.clone(), wanted.as_str())
            .and_then(|at| in_turn.clone().nth(at))
            .ok_or_else(|| CoreError::ItemNotFound { thread_id: id.clone(), item_id: wanted.clone() })?;
        found.push(item.clone());
    }
    Ok(Reply::Value(serde_json::to_value(ThreadItemsReadResponse { items: found }).expect("protocol types serialize")))
}

fn turns_list(items: &[ThreadItem], p: ThreadTurnsListParams, active: Option<String>) -> Result<Reply, CoreError> {
    let limit = match p.limit {
        None => TURNS_PAGE,
        Some(n) if n >= 1 => n as usize,
        Some(_) => return Err(invalid("limit", "a positive integer")),
    };
    let mut turns = turns_of(items, active.as_deref());
    if !matches!(p.sort_direction, Some(SortDirection::Asc)) {
        turns.reverse();
    }
    let from = match &p.cursor {
        None => 0,
        Some(cursor) => turns.iter().position(|t| t.id.as_str() == cursor).map(|at| at + 1).ok_or_else(|| invalid("cursor", "a turn id of this thread"))?,
    };
    let mut data: Vec<Turn> = turns.into_iter().skip(from).collect();
    let more = data.len() > limit;
    data.truncate(limit);
    let next_cursor = data.last().filter(|_| more).map(|t| t.id.as_str().to_owned());
    if p.items_view != Some(true) {
        for turn in &mut data {
            turn.items = None;
        }
    }
    Ok(Reply::Value(serde_json::to_value(ThreadTurnsListResponse { data, next_cursor }).expect("protocol types serialize")))
}

fn attachment_list(items: &[ThreadItem], p: ThreadPageParams) -> Result<Reply, CoreError> {
    let display: Vec<Value> = items.iter().map(display_row).collect();
    let rows = attachment_rows(&display);
    let from = match &p.cursor {
        None => 0,
        Some(cursor) => cursor.parse::<usize>().map_err(|_| invalid("cursor", "an offset from a previous page"))?,
    };
    let rest = rows.get(from..).unwrap_or_default();
    let take = p.limit.map_or(rest.len(), |n| (n as usize).min(rest.len()));
    let mut reply = json!({ "items": rest[..take] });
    if take < rest.len() {
        reply["nextCursor"] = json!((from + take).to_string());
    }
    Ok(Reply::Value(reply))
}

/// One page of a history: `[start, end)` and whether rows exist either side.
#[derive(Debug, PartialEq)]
pub(super) struct Page {
    pub start: usize,
    pub end: usize,
    pub has_older: bool,
    pub has_newer: bool,
}

/// `budgetedEdge` older: the first index of at most `rows` rows ending before `from`, within
/// `budget` bytes past the `MIN_ROWS` floor.
fn edge_before(sizes: &[usize], from: usize, rows: usize, budget: Option<u64>) -> usize {
    let (mut edge, mut taken, mut bytes) = (from, 0usize, 0u64);
    while taken < rows && edge > 0 {
        let next = sizes[edge - 1] as u64;
        if budget.is_some_and(|b| taken >= rows.min(MIN_ROWS) && bytes + next > b) {
            break;
        }
        bytes += next;
        taken += 1;
        edge -= 1;
    }
    edge
}

/// `budgetedEdge` newer: the end (exclusive) of at most `rows` rows starting at `from`.
fn edge_after(sizes: &[usize], from: usize, rows: usize, budget: Option<u64>) -> usize {
    let (mut edge, mut taken, mut bytes) = (from, 0usize, 0u64);
    while taken < rows && edge < sizes.len() {
        let next = sizes[edge] as u64;
        if budget.is_some_and(|b| taken >= rows.min(MIN_ROWS) && bytes + next > b) {
            break;
        }
        bytes += next;
        taken += 1;
        edge += 1;
    }
    edge
}

/// `historyCursorSlice`: the rows directly older (`older`) or newer than the row at `at`, at
/// most `rows` within `budget`; `None` when `at` is no row (Node's `cursorMissing`). With no
/// anchor (v2 only, D-reads-1) the newest page (older) or the oldest (newer). `sizes` are the
/// rows' serialized byte lengths.
pub(super) fn page_of(sizes: &[usize], at: Option<usize>, older: bool, rows: usize, budget: Option<u64>) -> Option<Page> {
    let rows = rows.clamp(1, MAX_ROWS);
    Some(match (at, older) {
        (None, true) => {
            let start = edge_before(sizes, sizes.len(), rows, budget);
            Page { start, end: sizes.len(), has_older: start > 0, has_newer: false }
        }
        (None, false) => {
            let end = edge_after(sizes, 0, rows, budget);
            Page { start: 0, end, has_older: false, has_newer: end < sizes.len() }
        }
        (Some(at), _) if at >= sizes.len() => return None,
        (Some(at), true) => {
            let start = edge_before(sizes, at, rows, budget);
            Page { start, end: at, has_older: start > 0, has_newer: true }
        }
        (Some(at), false) => {
            let end = edge_after(sizes, at + 1, rows, budget);
            Page { start: at + 1, end, has_older: true, has_newer: end < sizes.len() }
        }
    })
}

/// The user-written sources: every other source is runtime text shown as a notice.
fn is_user_row(details: &mixdog_protocol::UserRowDetails) -> bool {
    use mixdog_protocol::MessageSource::*;
    matches!(details.source, None | Some(Import | RoutineTrigger | Steering))
}

/// The kind of the Node transcript row an item stands for.
fn row_kind(item: &ThreadItem) -> &str {
    match item {
        ThreadItem::UserMessage { details, .. } if is_user_row(details) => "user",
        ThreadItem::UserMessage { .. } => "notice",
        ThreadItem::AgentMessage { .. } => "assistant",
        ThreadItem::ToolCall { .. } => "tool",
        ThreadItem::TurnEnd { .. } => "turndone",
        ThreadItem::RoomRow { room, .. } if matches!(room.kind, RoomRowKind::User) => "user",
        ThreadItem::RoomRow { .. } => "notice",
        ThreadItem::StatusRow { kind, .. } => kind,
        _ => "other",
    }
}

/// The Node transcript row (`kind`, `id`, `at`, ...) an item stands for, with the fields the
/// reads here consult: the attachments of a user or room row, an assistant row's text and
/// `streaming`, a turn end's `status`, `finalAssistantId` and `reacted`.
pub(super) fn display_row(item: &ThreadItem) -> Value {
    let m = meta(item);
    let mut row = json!({ "kind": row_kind(item), "id": item.id().as_str() });
    if let Some(at) = m.at {
        row["at"] = json!(at);
    }
    match item {
        ThreadItem::UserMessage { details, .. } => {
            row["attachments"] = json!(details.attachments);
            row["images"] = json!(details.images);
            row["imageRefs"] = json!(details.image_refs);
            if let Some(routine) = &details.routine_trigger {
                row["routine"] = json!({ "kind": routine.kind });
            }
        }
        ThreadItem::RoomRow { room, attachments, images, .. } => {
            row["attachments"] = json!(attachments);
            row["images"] = json!(images);
            row["room"] = json!({ "kind": room.kind });
        }
        ThreadItem::AgentMessage { text, meta, .. } => {
            if let mixdog_protocol::MaybeBlob::Inline(text) = text {
                row["text"] = json!(text);
            }
            row["streaming"] = json!(meta.status == Some(ItemStatus::InProgress));
        }
        ThreadItem::TurnEnd { status, final_assistant_id, meta, .. } => {
            row["status"] = json!(match status {
                TurnEndStatus::Done => "done",
                TurnEndStatus::Failed => "failed",
                TurnEndStatus::Cancelled => "cancelled",
            });
            if let Some(id) = final_assistant_id {
                row["finalAssistantId"] = json!(id.as_str());
            }
            row["reacted"] = json!(meta.ext.get("reacted") == Some(&Value::Bool(true)));
        }
        ThreadItem::StatusRow { kind, meta, .. } if kind == "turndone" => {
            for key in ["status", "finalAssistantId", "reacted"] {
                if let Some(value) = meta.ext.get(key) {
                    row[key] = value.clone();
                }
            }
        }
        _ => {}
    }
    row
}

fn str_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `sessionFinalAnswer(snapshot, startedAt)` over display rows: the answer of the turn that
/// ended at or after `started_at`, by id; `None` while it is pending (a busy thread, a newer
/// prompt, a streaming or blank answer).
pub(super) fn final_answer(rows: &[Value], busy: bool, started_at: i64) -> Option<Value> {
    if busy {
        return None;
    }
    let done_at = rows.iter().rposition(|row| row.get("kind") == Some(&json!("turndone")))?;
    let done = &rows[done_at];
    let id = done.get("id").filter(|id| !id.is_null())?;
    let at = done.get("at").and_then(Value::as_i64).filter(|at| *at >= started_at)?;
    if rows[done_at + 1..].iter().any(|row| matches!(row.get("kind").and_then(Value::as_str), Some("user" | "assistant"))) {
        return None;
    }
    let status = str_of(done, "status");
    let answer = |status: &str, text: &str, reacted: bool| {
        let mut out = json!({ "id": id, "at": at, "status": status, "text": text });
        if reacted {
            out["reacted"] = json!(true);
        }
        Some(out)
    };
    if matches!(status.as_deref(), Some("failed" | "cancelled")) {
        return answer(status.as_deref().unwrap_or_default(), "", false);
    }
    let final_id = done.get("finalAssistantId").filter(|id| !id.is_null());
    if status.as_deref() == Some("done") && final_id.is_none() && done.get("reacted") == Some(&json!(true)) {
        return answer("done", "", true);
    }
    let final_id = final_id.filter(|_| status.as_deref() == Some("done"))?;
    let answer_at = rows[..done_at].iter().rposition(|row| row.get("id") == Some(final_id) && row.get("kind") == Some(&json!("assistant")))?;
    if rows[answer_at + 1..done_at].iter().any(|row| row.get("kind") == Some(&json!("turndone"))) {
        return None;
    }
    let reply = &rows[answer_at];
    let text = reply.get("text").and_then(Value::as_str)?;
    if reply.get("streaming") == Some(&json!(true)) || mixdog_js::js_trim(text).is_empty() {
        return None;
    }
    answer("done", text, false)
}

/// The turns of a history, oldest first, as its items group them: a turn is the items that
/// name it, its status the end it carries (D-reads-2: a turn with none is in progress while it
/// is the thread's active run, else it was cut short: interrupted).
pub(super) fn turns_of(items: &[ThreadItem], active: Option<&str>) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    for item in items {
        let Some(id) = meta(item).turn_id.as_ref() else { continue };
        let at = match turns.iter().position(|t| t.id.as_str() == id.as_str()) {
            Some(at) => at,
            None => {
                turns.push(Turn {
                    id: id.clone(),
                    status: if active == Some(id.as_str()) { TurnStatus::InProgress } else { TurnStatus::Interrupted },
                    started_at: meta(item).at,
                    completed_at: None,
                    error: None,
                    stop_reason: None,
                    termination_reason: None,
                    items: Some(Vec::new()),
                });
                turns.len() - 1
            }
        };
        let turn = &mut turns[at];
        turn.items.get_or_insert_with(Vec::new).push(item.clone());
        if let ThreadItem::TurnEnd { status, detail, error_details, error_kind, meta, .. } = item {
            turn.completed_at = meta.at;
            turn.status = match status {
                TurnEndStatus::Done => TurnStatus::Completed,
                TurnEndStatus::Failed => TurnStatus::Failed,
                TurnEndStatus::Cancelled => TurnStatus::Interrupted,
            };
            if *status == TurnEndStatus::Failed {
                let message = detail.clone().or_else(|| error_details.clone()).unwrap_or_default();
                let data = error_kind.clone().map_or_else(|| json!({}), Value::Object);
                turn.error = Some(TurnError { message, data, provider_error: None });
            }
        }
    }
    turns
}

/// JS truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

/// `attachmentHistoryRows(items)` over display rows: the rows that name attachments, reduced
/// to the row kind (and a notice's routine / room kind) and each attachment's id, name, type
/// and size.
pub(super) fn attachment_rows(rows: &[Value]) -> Vec<Value> {
    let picked = |list: Option<&Value>, keys: &[&str]| -> Vec<Value> {
        list.and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|entry| Value::Object(keys.iter().filter_map(|key| entry.get(*key).filter(|v| !v.is_null()).map(|v| ((*key).to_owned(), v.clone()))).collect()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut out = Vec::new();
    for row in rows {
        let attachments = picked(row.get("attachments"), &["id", "name", "mimeType", "kind", "size"]);
        let images = picked(row.get("images"), &["attachmentRef", "name", "mimeType", "bytes"]);
        let image_refs = picked(row.get("imageRefs"), &["ref"]);
        if attachments.is_empty() && images.is_empty() && image_refs.is_empty() {
            continue;
        }
        let mut reduced = serde_json::Map::new();
        if let Some(kind) = row.get("kind") {
            reduced.insert("kind".into(), kind.clone());
        }
        for key in ["routine", "room"] {
            if let Some(kind) = row.get(key).and_then(|v| v.get("kind")).filter(|k| truthy(Some(k))) {
                reduced.insert(key.into(), json!({ "kind": kind }));
            }
        }
        for (key, list) in [("attachments", attachments), ("images", images), ("imageRefs", image_refs)] {
            if !list.is_empty() {
                reduced.insert(key.into(), Value::Array(list));
            }
        }
        out.push(Value::Object(reduced));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/session-reads/golden.json");
        let bytes = mixdog_statefile::read_content(&path).expect("read golden.json").expect("golden.json exists");
        serde_json::from_slice(&bytes).expect("golden.json parses")
    }

    /// `sessionFinalAnswer` of the recorded snapshots; `None` for Node's `null`.
    #[test]
    fn the_final_answer_equals_nodes() {
        let golden = golden();
        let cases = golden["finalAnswers"].as_array().expect("cases");
        assert!(cases.len() > 20);
        for case in cases {
            let snapshot = &case["snapshot"];
            let rows = snapshot["items"].as_array().expect("items");
            let busy = snapshot["busy"] == json!(true) || snapshot.get("streamingTail").is_some_and(|tail| !tail.is_null());
            let got = final_answer(rows, busy, case["startedAt"].as_i64().expect("startedAt"));
            let want = (!case["expected"].is_null()).then(|| case["expected"].clone());
            assert_eq!(got, want, "{}", case["name"]);
        }
    }

    fn items(rows: Value) -> Vec<ThreadItem> {
        serde_json::from_value(rows).expect("thread items")
    }

    /// `thread/turns/list`'s grouping (v2 only, `decisions.md` D-reads-2): a turn's status is its
    /// end row's; one with none is in progress while it is the active run, else interrupted.
    #[test]
    fn turns_group_by_turn_id_and_take_their_status_from_the_end_row() {
        let history = items(json!([
            { "type": "userMessage", "id": "u1", "displayText": "a", "content": [], "countsForPromptHistory": true, "meta": { "turnId": "t1", "at": 10 } },
            { "type": "turnEnd", "id": "e1", "status": "done", "elapsedMs": 5, "meta": { "turnId": "t1", "at": 20 } },
            { "type": "userMessage", "id": "u2", "displayText": "b", "content": [], "countsForPromptHistory": true, "meta": { "turnId": "t2", "at": 30 } },
            { "type": "turnEnd", "id": "e2", "status": "failed", "elapsedMs": 5, "detail": "boom", "meta": { "turnId": "t2", "at": 40 } },
            { "type": "userMessage", "id": "u3", "displayText": "c", "content": [], "countsForPromptHistory": true, "meta": { "turnId": "t3", "at": 50 } },
            { "type": "userMessage", "id": "u4", "displayText": "d", "content": [], "countsForPromptHistory": true, "meta": { "turnId": "t4", "at": 60 } },
            { "type": "turnEnd", "id": "e5", "status": "cancelled", "elapsedMs": 1, "meta": { "turnId": "t5", "at": 70 } },
        ]));
        let turns = turns_of(&history, Some("t4"));
        let seen: Vec<(String, TurnStatus, Option<i64>, Option<i64>, usize)> = turns
            .iter()
            .map(|t| (t.id.as_str().to_owned(), t.status.clone(), t.started_at, t.completed_at, t.items.as_ref().map_or(0, Vec::len)))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("t1".into(), TurnStatus::Completed, Some(10), Some(20), 2),
                ("t2".into(), TurnStatus::Failed, Some(30), Some(40), 2),
                ("t3".into(), TurnStatus::Interrupted, Some(50), None, 1),
                ("t4".into(), TurnStatus::InProgress, Some(60), None, 1),
                ("t5".into(), TurnStatus::Interrupted, Some(70), Some(70), 1),
            ]
        );
        assert_eq!(turns[1].error.as_ref().map(|e| e.message.as_str()), Some("boom"));
        assert!(turns[0].error.is_none());
    }

    #[test]
    fn the_turns_page_walks_newest_first_with_a_turn_cursor() {
        let history = items(json!([
            { "type": "turnEnd", "id": "e1", "status": "done", "elapsedMs": 1, "meta": { "turnId": "t1" } },
            { "type": "turnEnd", "id": "e2", "status": "done", "elapsedMs": 1, "meta": { "turnId": "t2" } },
            { "type": "turnEnd", "id": "e3", "status": "done", "elapsedMs": 1, "meta": { "turnId": "t3" } },
        ]));
        let page = |params: Value| match turns_list(&history, serde_json::from_value(params).expect("params"), None).expect("page") {
            Reply::Value(v) => v,
            _ => panic!("a value"),
        };
        let first = page(json!({ "threadId": "x", "limit": 2 }));
        let ids = |v: &Value| v["data"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(ids(&first), ["t3", "t2"]);
        assert_eq!(first["nextCursor"], json!("t2"));
        assert!(first["data"][0].get("items").is_none());
        let second = page(json!({ "threadId": "x", "limit": 2, "cursor": "t2", "itemsView": true }));
        assert_eq!(ids(&second), ["t1"]);
        assert!(second.get("nextCursor").is_none());
        assert_eq!(second["data"][0]["items"].as_array().map(Vec::len), Some(1));
        assert!(turns_list(&history, serde_json::from_value(json!({ "threadId": "x", "cursor": "nope" })).unwrap(), None).is_err());
    }

    #[test]
    fn the_attachment_rows_equal_nodes() {
        let golden = golden();
        for case in golden["attachmentRows"].as_array().expect("cases") {
            let items = case["items"].as_array().expect("items");
            assert_eq!(Value::Array(attachment_rows(items)), case["expected"], "{}", case["items"]);
        }
    }

    fn history_of(sizes: &[usize]) -> Vec<(ThreadItem, usize)> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, bytes)| (serde_json::from_value(json!({ "type": "agentMessage", "id": format!("r{i}"), "text": "x" })).expect("an agent message"), *bytes))
            .collect()
    }

    fn page(id: &ThreadId, rev: u64, rows: &[(ThreadItem, usize)], params: Value) -> Result<Value, CoreError> {
        match items_list(id, rev, rows, serde_json::from_value(params).expect("params"))? {
            Reply::Value(v) => Ok(v),
            _ => panic!("a value"),
        }
    }

    /// `storedHistorySlice({cursor})`: the recorded Node pages replayed through `thread/items/list`
    /// (cursor, `limit`, `byteBudget`, `sortDirection`), edges and `cursorMissing` included. Node's
    /// own row sizes feed the rows here; that production measures a row as Node does is the
    /// `display_rows_measure_as_nodes_do` test of `transcript_convert`.
    #[test]
    fn the_page_around_a_row_equals_nodes() {
        let golden = golden();
        let sizes: Vec<usize> = golden["pages"]["sizes"].as_array().expect("sizes").iter().map(|n| n.as_u64().expect("size") as usize).collect();
        let rows = history_of(&sizes);
        let id = ThreadId::from("t");
        let requests = golden["pages"]["requests"].as_array().expect("requests");
        assert!(requests.len() > 200);
        let mut replayed = 0;
        for case in requests {
            let request = &case["request"];
            let max_rows = request["maxRows"].as_u64().expect("maxRows");
            // The protocol's `limit` is 1..=512; Node clamps the others, and `thread/items/list` refuses them.
            if !(1..=512).contains(&max_rows) {
                continue;
            }
            let older = !request["before"].is_null();
            let anchor = request[if older { "before" } else { "after" }].as_str().expect("anchor");
            let mut params = json!({ "threadId": "t", "limit": max_rows, "cursor": anchor, "sortDirection": if older { "desc" } else { "asc" } });
            if let Some(budget) = request["byteBudget"].as_u64() {
                params["byteBudget"] = json!(budget);
            }
            replayed += 1;
            let want = &case["expected"];
            let got = page(&id, 0, &rows, params);
            if want["cursorMissing"] == json!(true) {
                assert!(matches!(got, Err(CoreError::CursorInvalidated { .. })), "{request}");
                continue;
            }
            let got = got.unwrap_or_else(|e| panic!("{request}: {e:?}"));
            let ids: Vec<usize> = got["data"].as_array().expect("data").iter().map(|item| item["id"].as_str().expect("id")[1..].parse().expect("index")).collect();
            let anchor_at: usize = anchor[1..].parse().expect("anchor index");
            let start = ids.first().copied().unwrap_or(if older { anchor_at } else { anchor_at + 1 });
            let end = ids.last().map_or(start, |last| last + 1);
            assert_eq!(
                json!({ "start": start, "end": end, "hasOlder": got["hasOlder"], "hasNewer": got["hasNewer"] }),
                *want,
                "{request}"
            );
        }
        assert!(replayed > 200, "{replayed}");
    }

    /// Protocol §5.5: a cursor into history a rewind or a clear removed is `cursorInvalidated`,
    /// at the history revision the read found; the page before it was valid.
    #[test]
    fn a_cursor_into_removed_history_is_invalidated() {
        let id = ThreadId::from("t");
        let before = history_of(&[10, 10, 10, 10]);
        let first = page(&id, 0, &before, json!({ "threadId": "t", "limit": 2 })).expect("page");
        let cursor = first["nextCursor"].as_str().expect("more rows").to_owned();
        assert_eq!(cursor, "r2");
        // A rewind to r2 removes r2 and r3 and moves the revision; the cursor named r2.
        let rewound = history_of(&[10, 10]);
        match page(&id, 1, &rewound, json!({ "threadId": "t", "limit": 2, "cursor": cursor })) {
            Err(CoreError::CursorInvalidated { thread_id, history_rev }) => assert_eq!((thread_id, history_rev), (id.clone(), 1)),
            other => panic!("{other:?}"),
        }
        // A clear removes every row; the `{type:"item"}` form is the same cursor.
        match page(&id, 2, &[], json!({ "threadId": "t", "cursor": { "type": "item", "itemId": "r0" } })) {
            Err(CoreError::CursorInvalidated { history_rev, .. }) => assert_eq!(history_rev, 2),
            other => panic!("{other:?}"),
        }
        // A cursor that survived keeps paging.
        assert!(page(&id, 1, &rewound, json!({ "threadId": "t", "cursor": "r1" })).is_ok());
    }
}