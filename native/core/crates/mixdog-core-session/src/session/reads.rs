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
use mixdog_core_api::ids::TurnId;
use mixdog_core_base::support::on_lane_wait;
use mixdog_protocol::ItemStatus;
use mixdog_protocol::RoomRowKind;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::Turn;
use mixdog_protocol::TurnEndStatus;
use mixdog_protocol::TurnError;
use mixdog_protocol::TurnStatus;
use mixdog_rt::CancellationToken;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;

use std::sync::Arc;

use super::SessionDeps;
use super::SessionLanes;
use super::ThreadStore;
use super::Transcript;
use super::directory::DirInner;
use super::seams::check_turn_read_cancel;
use super::seams::turn_read_cancelled;
use super::transcript::displayed_id;
use super::transcript::position_of_id;
use super::view::meta;

pub(super) const HISTORY_POSITION: &str = "historyPosition";
const HISTORY_CURSOR_PREFIX: &str = "h1:";

pub(super) fn mark_history_position(item: &mut ThreadItem, iid: &str, row: usize) {
    super::view::meta_mut(item).ext.insert(HISTORY_POSITION.into(), json!(format!("{HISTORY_CURSOR_PREFIX}{row}:{iid}")));
}

pub(super) fn history_cursor_iid(cursor: &str) -> Option<&str> {
    let (row, iid) = cursor.strip_prefix(HISTORY_CURSOR_PREFIX)?.split_once(':')?;
    row.parse::<usize>().ok().and_then(|_| (!iid.is_empty()).then_some(iid))
}

fn history_position(item: &ThreadItem) -> Option<&str> {
    meta(item).ext.get(HISTORY_POSITION)?.as_str()
}

fn exact_cursor(cursor: &Option<ItemsCursor>) -> bool {
    matches!(cursor, Some(ItemsCursor::Opaque(value)) if value.starts_with(HISTORY_CURSOR_PREFIX))
}

fn anchor_position<'a>(mut items: impl Iterator<Item = &'a ThreadItem> + Clone, anchor: &str, exact: bool) -> Option<usize> {
    if exact { items.position(|item| history_position(item) == Some(anchor)) } else { position_of_id(items, anchor) }
}

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
        "thread/items/list" | "thread/items/read" | "thread/turns/list" | "thread/attachment/list" | "thread/modelMessages/list" | "thread/finalAnswer/read"
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
    deps.store.unheld().await;
    let (store, thread) = (deps.store.clone(), id.clone());
    // The whole history is its newest rows without a bound, marked as every page of it is.
    let (rev, records, decor, _) = on_lane_wait(deps.lanes.io, &token, move |lane| store.history_tail_decor(lane, &thread, usize::MAX)).await??;
    Ok(History { rev, rows: display_rows(deps, records, decor).await? })
}

async fn display_rows(
    deps: &SessionDeps,
    records: Vec<mixdog_store::schema::record::ItemRecord>,
    decor: Vec<super::seams::RowDecor>,
) -> Result<Vec<(ThreadItem, usize)>, CoreError> {
    let token = CancellationToken::new();
    let transcript = deps.transcript.clone();
    on_lane_wait(deps.lanes.cpu, &token, move |lane| {
        records.iter().enumerate().flat_map(|(at, record)| decorated(transcript.rows(lane, record), decor.get(at))).collect()
    })
    .await
}

/// The rows from a cursor's row back (`ThreadStore::history_before`): the cursor's record's rows are `rows[from..]`.
pub(super) struct Before {
    pub rev: u64,
    pub rows: Vec<(ThreadItem, usize)>,
    pub from: usize,
    pub complete: bool,
    pub named: u64,
}

/// [`ThreadStore::history_before`] with its records shown as rows.
pub(super) async fn history_before(
    store: &Arc<dyn ThreadStore>,
    transcript: &Arc<dyn Transcript>,
    lanes: SessionLanes,
    id: &ThreadId,
    anchor: String,
    records: usize,
) -> Result<Option<Before>, CoreError> {
    let token = CancellationToken::new();
    store.unheld().await;
    let (store, thread) = (store.clone(), id.clone());
    let Some(read) = on_lane_wait(lanes.io, &token, move |lane| store.history_before(lane, &thread, &anchor, records)).await?? else {
        return Ok(None);
    };
    let transcript = transcript.clone();
    let shown = on_lane_wait(lanes.cpu, &token, move |lane| {
        let mut rows: Vec<(ThreadItem, usize)> = Vec::new();
        let mut from = 0;
        for (at, record) in read.records.iter().enumerate() {
            from = rows.len();
            rows.extend(decorated(transcript.rows(lane, record), read.decor.get(at)));
        }
        Before { rev: read.rev, rows, from, complete: read.complete, named: read.named }
    });
    Ok(Some(shown.await?))
}

/// The `ext` member a row carries the compaction dividers shown after it under: the items of each divider (its row, then
/// its model-switch rows), as the restored window shows them between its rows. A page's rows are the records' own, so a
/// divider is no row of a page (a cursor names a stored row) and rides the row it follows.
pub(super) const DIVIDERS_AFTER: &str = "dividersAfter";

/// A record's rows with what its page shows beyond them: `archived` on each row a compaction took out of the context,
/// and the dividers that follow the record on its last row.
pub(super) fn decorated(mut rows: Vec<(ThreadItem, usize)>, decor: Option<&super::seams::RowDecor>) -> Vec<(ThreadItem, usize)> {
    let Some(decor) = decor else { return rows };
    if decor.archived {
        for (item, _) in &mut rows {
            super::view::meta_mut(item).ext.insert("archived".into(), Value::Bool(true));
        }
    }
    if let Some((last, _)) = rows.last_mut().filter(|_| !decor.dividers_after.is_empty()) {
        let mut items = Vec::new();
        for divider in &decor.dividers_after {
            items.push(super::transcript::divider_item(&divider.cid, divider.at));
            items.extend(super::transcript::divider_model_switches(&divider.cid, &divider.model_switches));
        }
        super::view::meta_mut(last).ext.insert(DIVIDERS_AFTER.into(), serde_json::to_value(items).expect("thread items serialize"));
    }
    rows
}

/// [`history`] of the newest `rows` stored rows only, and whether that is all of it.
pub(super) async fn history_tail(
    store: &Arc<dyn ThreadStore>,
    transcript: &Arc<dyn Transcript>,
    lanes: SessionLanes,
    id: &ThreadId,
    rows: usize,
) -> Result<(History, bool), CoreError> {
    let token = CancellationToken::new();
    store.unheld().await;
    let (store, thread) = (store.clone(), id.clone());
    let (rev, records, decor, complete) = on_lane_wait(lanes.io, &token, move |lane| store.history_tail_decor(lane, &thread, rows)).await??;
    let transcript = transcript.clone();
    let rows = on_lane_wait(lanes.cpu, &token, move |lane| {
        records.iter().enumerate().flat_map(|(at, record)| decorated(transcript.rows(lane, record), decor.get(at))).collect()
    })
    .await?;
    Ok((History { rev, rows }, complete))
}

/// `thread/items/list`: the page around the cursor's row. The cursor names a row by its id, so a
/// row a rewind or a clear removed answers `cursorInvalidated` (protocol §5.5, retracting
/// D-reads-1's `itemNotFound`): the client restarts from its snapshot. The page's byte budget
/// counts `rows`' display-row lengths, as Node's `budgetedEdge` counts the transcript rows.
///
/// `rows` are the newest rows of the history, or all of it when `complete`. The page is one only the newest rows can decide
/// (no cursor, and an older page that ends before the rows run out), or `None`: more rows are needed.
pub(super) fn items_window(
    id: &ThreadId,
    rev: u64,
    rows: &[(ThreadItem, usize)],
    complete: bool,
    p: &ThreadItemsListParams,
) -> Result<Option<Reply>, CoreError> {
    items_window_in(id, rev, rows, complete, false, p)
}

/// The validated row limit, byte budget and anchor row id of a `thread/items/list` request.
fn window_request(p: &ThreadItemsListParams) -> Result<(usize, Option<u64>, Option<&str>), CoreError> {
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
    Ok((limit, budget, anchor))
}

/// [`items_window`]; with `anchored`,`rows` end with the cursor's row and run back from it, which is all an older page reads.
fn items_window_in(
    id: &ThreadId,
    rev: u64,
    rows: &[(ThreadItem, usize)],
    complete: bool,
    anchored: bool,
    p: &ThreadItemsListParams,
) -> Result<Option<Reply>, CoreError> {
    let (limit, budget, anchor) = window_request(p)?;
    let turn: Vec<&(ThreadItem, usize)> = rows
        .iter()
        .filter(|(item, _)| p.turn_id.as_ref().is_none_or(|turn| meta(item).turn_id.as_ref().is_some_and(|t| t.as_str() == turn.as_str())))
        .collect();
    let at = match anchor {
        None => None,
        // A legacy cursor can match an older display alias; an exact cursor outside the tail also needs an indexed or full read.
        Some(_) if !complete && !anchored => return Ok(None),
        Some(item) => match anchor_position(turn.iter().map(|(row, _)| row), item, exact_cursor(&p.cursor)) {
            Some(at) => Some(at),
            None => return Err(CoreError::CursorInvalidated { thread_id: id.clone(), history_rev: rev }),
        },
    };
    let older = !matches!(p.sort_direction, Some(SortDirection::Asc));
    // The oldest page is the one thing the newest rows cannot give.
    if !complete && anchor.is_none() && !older {
        return Ok(None);
    }
    let sizes: Vec<usize> = turn.iter().map(|(_, bytes)| *bytes).collect();
    let page = page_of(&sizes, at, older, limit, budget).expect("the anchor is a position of the rows");
    if !complete && older && page.start == 0 {
        return Ok(None);
    }
    let data: Vec<ThreadItem> = turn[page.start..page.end].iter().map(|(item, _)| item.clone()).collect();
    let edge =
        |row: Option<&ThreadItem>, wanted: bool| row.filter(|_| wanted).map(|item| history_position(item).unwrap_or_else(|| item.id().as_str()).to_owned());
    // The cursor onward in the page's own direction, and the one back.
    let (next, back) = if older {
        (edge(data.first(), page.has_older), edge(data.last(), page.has_newer))
    } else {
        (edge(data.last(), page.has_newer), edge(data.first(), page.has_older))
    };
    let response = ThreadItemsListResponse { data, has_older: page.has_older, has_newer: page.has_newer, next_cursor: next, backwards_cursor: back };
    Ok(Some(Reply::Value(serde_json::to_value(response).expect("protocol types serialize"))))
}

/// Rows read at first for a page; each short read asks for twice as many, so a page deep in the history costs
/// at most twice the rows before it and a page at the end only these.
const FIRST_TAIL_ROWS: usize = 128;

/// `thread/items/list` from the newest rows of the history only: `fetch(n)` answers the newest `n` stored rows
/// (their items, with the history revision, and whether that is all of the history).
///
/// A page older than a cursor is read from the cursor's row back (`before(id, n)`: that row and the `n` records older), when
/// the store places the id; any other cursor reads the whole history.
pub(super) async fn list_from_tail<F, Fut, B, BFut>(id: &ThreadId, p: &ThreadItemsListParams, mut fetch: F, mut before: B) -> Result<Reply, CoreError>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<(u64, Vec<(ThreadItem, usize)>, bool), CoreError>>,
    B: FnMut(&str, usize) -> BFut,
    BFut: std::future::Future<Output = Result<Option<Before>, CoreError>>,
{
    let older = !matches!(p.sort_direction, Some(SortDirection::Asc));
    let anchor = match &p.cursor {
        Some(ItemsCursor::Opaque(item)) => Some(item.as_str()),
        Some(ItemsCursor::Item { kind, item_id }) if kind == "item" => Some(item_id.as_str()),
        _ => None,
    };
    let exact = exact_cursor(&p.cursor);
    // A turn's rows are counted among that turn's only, which the rows around the cursor do not show.
    if let Some(anchor) = anchor.filter(|_| older && p.turn_id.is_none()) {
        let mut want = FIRST_TAIL_ROWS;
        while let Some(b) = before(anchor, want).await? {
            // The index names candidates; the rows decide. A row older than the cursor's own that shows its id, or none
            // that does, is a history the index did not describe whole: the whole history answers.
            let Some(at) = anchor_position(b.rows.iter().map(|(item, _)| item), anchor, exact).filter(|at| *at >= b.from) else {
                break;
            };
            // With several rows the id can name, a row's submission id takes it before another row's item id does.
            if b.named > 1 && (exact || displayed_id(&b.rows[at].0) != anchor) {
                break;
            }
            if let Some(reply) = items_window_in(id, b.rev, &b.rows, b.complete, true, p)? {
                return Ok(reply);
            }
            want = want.saturating_mul(2);
        }
    }
    // A cursor's row is otherwise only known from the whole history; the page of the newest rows reads as few as it needs.
    let mut want = if p.cursor.is_some() { usize::MAX } else { FIRST_TAIL_ROWS };
    loop {
        let (rev, rows, complete) = fetch(want).await?;
        if let Some(reply) = items_window(id, rev, &rows, complete, p)? {
            return Ok(reply);
        }
        want = want.saturating_mul(2);
    }
}

fn items_read(id: &ThreadId, items: &[ThreadItem], p: ThreadItemsReadParams) -> Result<Reply, CoreError> {
    let mut found = Vec::with_capacity(p.item_ids.len());
    for wanted in &p.item_ids {
        let in_turn =
            items.iter().filter(|item| p.turn_id.as_ref().is_none_or(|turn| meta(item).turn_id.as_ref().is_some_and(|t| t.as_str() == turn.as_str())));
        let item = position_of_id(in_turn.clone(), wanted.as_str())
            .and_then(|at| in_turn.clone().nth(at))
            .ok_or_else(|| CoreError::ItemNotFound { thread_id: id.clone(), item_id: wanted.clone() })?;
        found.push(item.clone());
    }
    Ok(Reply::Value(serde_json::to_value(ThreadItemsReadResponse { items: found }).expect("protocol types serialize")))
}

fn turns_list(items: &[ThreadItem], p: ThreadTurnsListParams, active: Option<String>) -> Result<Reply, CoreError> {
    turns_page(turns_of(items, active.as_deref()), p)
}

fn turns_page(mut turns: Vec<Turn>, p: ThreadTurnsListParams) -> Result<Reply, CoreError> {
    let limit = match p.limit {
        None => TURNS_PAGE,
        Some(n) if n >= 1 => n as usize,
        Some(_) => return Err(invalid("limit", "a positive integer")),
    };
    if !matches!(p.sort_direction, Some(SortDirection::Asc)) {
        turns.reverse();
    }
    let from = match &p.cursor {
        None => 0,
        Some(cursor) => turns.iter().position(|t| t.id.as_str() == cursor).map(|at| at + 1).ok_or_else(|| invalid("cursor", "a turn id of this thread"))?,
    };
    let mut data: Vec<Turn> = turns.into_iter().skip(from).take(limit.saturating_add(1)).collect();
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

fn turn_end_status_name(status: &TurnEndStatus) -> &'static str {
    match status {
        TurnEndStatus::Done => "done",
        TurnEndStatus::Failed => "failed",
        TurnEndStatus::Cancelled => "cancelled",
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
            row["status"] = json!(turn_end_status_name(status));
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

/// The Node transcript row an item stands for, with every field the `session` tool's read
/// consults (`conversationItem`, `session-tool-output.mjs`): `kind`, the id the client holds,
/// `name`, `status`, `isError`, `text` / `detail` / `label`, a tool's `args`, `rawResult` and
/// `result`, and the attachment lists a row carries.
pub fn transcript_row(item: &ThreadItem) -> Value {
    let m = meta(item);
    let mut row = serde_json::Map::new();
    row.insert("kind".into(), json!(row_kind(item)));
    row.insert("id".into(), json!(super::transcript::displayed_id(item)));
    for (key, value) in &m.ext {
        row.entry(key.clone()).or_insert_with(|| value.clone());
    }
    if let Some(label) = &m.label {
        row.insert("label".into(), json!(label));
    }
    if let Some(detail) = &m.detail {
        row.insert("detail".into(), json!(detail));
    }
    let inline = |text: &mixdog_protocol::MaybeBlob<String>| match text {
        mixdog_protocol::MaybeBlob::Inline(text) => Some(text.clone()),
        mixdog_protocol::MaybeBlob::Blob(_) => None,
    };
    let lists = |row: &mut serde_json::Map<String, Value>, key: &str, list: Value| {
        if list.as_array().is_some_and(|l| !l.is_empty()) {
            row.insert(key.into(), list);
        }
    };
    match item {
        ThreadItem::UserMessage { display_text, details, .. } => {
            row.insert("text".into(), json!(display_text));
            lists(&mut row, "attachments", json!(details.attachments));
            lists(&mut row, "images", json!(details.images));
            lists(&mut row, "imageRefs", json!(details.image_refs));
        }
        ThreadItem::AgentMessage { text, .. } => {
            if let Some(text) = inline(text) {
                row.insert("text".into(), json!(text));
            }
        }
        ThreadItem::ToolCall { name, input, run, .. } => {
            row.insert("name".into(), json!(name));
            if !input.is_null() {
                row.insert("args".into(), input.clone());
            }
            if let Some(raw) = run.raw_result.as_ref().and_then(inline) {
                row.insert("rawResult".into(), json!(raw));
            }
            if let Some(result) = run.result.as_ref().and_then(inline) {
                row.insert("result".into(), json!(result));
            }
            if let Some(is_error) = run.is_error {
                row.insert("isError".into(), json!(is_error));
            }
        }
        ThreadItem::TurnEnd { status, detail, .. } => {
            row.insert("status".into(), json!(turn_end_status_name(status)));
            if let Some(detail) = detail {
                row.insert("detail".into(), json!(detail));
            }
        }
        ThreadItem::ContextCompaction { .. } => {
            row.insert("kind".into(), json!("statusdone"));
            row.insert("status".into(), json!("compacted"));
        }
        ThreadItem::RoomRow { text, attachments, images, .. } => {
            if let Some(text) = inline(text) {
                row.insert("text".into(), json!(text));
            }
            lists(&mut row, "attachments", json!(attachments));
            lists(&mut row, "images", json!(images));
        }
        _ => {}
    }
    Value::Object(row)
}

fn str_of(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Whether `rows`, the newest rows of a history, hold everything [`final_answer`] reads of the whole history: the
/// newest `turndone` and the one before it. The answer is looked for between those two (an answer row found before
/// the older one is no answer of the newest turn), so the rows older than both change nothing.
pub(super) fn holds_final_turn(rows: &[Value]) -> bool {
    rows.iter().filter(|row| row.get("kind") == Some(&json!("turndone"))).take(2).count() == 2
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
                turns.push(turn_shell(id, meta(item).at, active));
                turns.len() - 1
            }
        };
        let turn = &mut turns[at];
        turn.items.get_or_insert_with(Vec::new).push(item.clone());
        fold_turn_end(turn, item, false, false);
    }
    turns
}

fn turn_shell(id: &TurnId, started_at: Option<i64>, active: Option<&str>) -> Turn {
    Turn {
        id: id.clone(),
        status: if active == Some(id.as_str()) { TurnStatus::InProgress } else { TurnStatus::Interrupted },
        started_at,
        completed_at: None,
        error: None,
        stop_reason: None,
        termination_reason: None,
        items: None,
    }
}

fn fold_turn_end(turn: &mut Turn, item: &ThreadItem, keep_end: bool, keep_error: bool) -> bool {
    let ThreadItem::TurnEnd { status, detail, error_details, error_kind, meta, .. } = item else { return false };
    if !keep_end {
        turn.completed_at = meta.at;
        turn.status = match status {
            TurnEndStatus::Done => TurnStatus::Completed,
            TurnEndStatus::Failed => TurnStatus::Failed,
            TurnEndStatus::Cancelled => TurnStatus::Interrupted,
        };
    }
    if !keep_error && *status == TurnEndStatus::Failed {
        let message = detail.clone().or_else(|| error_details.clone()).unwrap_or_default();
        let data = error_kind.clone().map_or_else(|| json!({}), Value::Object);
        turn.error = Some(TurnError { message, data, provider_error: None });
    }
    true
}

#[derive(Default)]
struct TurnMetadata {
    seen: usize,
    turns: std::collections::HashMap<TurnId, SeenTurn>,
}

struct SeenTurn {
    first: usize,
    ended: bool,
    turn: Turn,
}

impl TurnMetadata {
    fn push(&mut self, item: &ThreadItem) {
        let Some(id) = meta(item).turn_id.as_ref() else { return };
        self.seen += 1;
        let at = meta(item).at;
        let entry = self.turns.entry(id.clone()).or_insert_with(|| SeenTurn { first: 0, ended: false, turn: turn_shell(id, at, None) });
        // Walking backwards: every encounter revises the first occurrence, but not the latest end or failure.
        entry.first = self.seen;
        entry.turn.started_at = at;
        let keep_error = entry.turn.error.is_some();
        entry.ended |= fold_turn_end(&mut entry.turn, item, entry.ended, keep_error);
    }

    fn finish(self, active: Option<&str>) -> Vec<Turn> {
        let mut seen: Vec<_> = self.turns.into_values().collect();
        seen.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.first));
        seen.into_iter()
            .map(|mut entry| {
                if !entry.ended && active == Some(entry.turn.id.as_str()) {
                    entry.turn.status = TurnStatus::InProgress;
                }
                entry.turn
            })
            .collect()
    }
}

async fn read_turn_metadata(deps: &SessionDeps, id: &ThreadId, cancel: &CancellationToken) -> Result<Option<TurnMetadata>, CoreError> {
    let mut scan = TurnMetadata::default();
    let mut after = None;
    loop {
        let (store, thread) = (deps.store.clone(), id.clone());
        let io_cancel = cancel.clone();
        let chunk = on_lane_wait(deps.lanes.io, cancel, move |lane| store.turn_history_chunk(lane, &thread, after, &io_cancel)).await??;
        let Some(super::seams::TurnHistoryChunk { records, next }) = chunk else { return Ok(None) };
        let transcript = deps.transcript.clone();
        let cpu_cancel = cancel.clone();
        scan = on_lane_wait(deps.lanes.cpu, cancel, move |lane| {
            for record in records {
                check_turn_read_cancel(&cpu_cancel)?;
                // Page decoration changes only ext fields, not membership, timestamps, or terminal state.
                for (item, _) in transcript.rows(lane, &record).into_iter().rev() {
                    scan.push(&item);
                }
            }
            Ok::<_, CoreError>(scan)
        })
        .await??;
        match next {
            Some(next) => after = Some(next),
            None => return Ok(Some(scan)),
        }
    }
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
                    .map(|entry| {
                        Value::Object(keys.iter().filter_map(|key| entry.get(*key).filter(|v| !v.is_null()).map(|v| ((*key).to_owned(), v.clone()))).collect())
                    })
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

    #[test]
    fn the_newest_turn_is_held_once_two_turn_ends_are_in_the_rows() {
        let done = |id: &str| json!({ "kind": "turndone", "id": id });
        let text = json!({ "kind": "assistant", "id": "a" });
        assert!(!holds_final_turn(&[]));
        assert!(!holds_final_turn(&[text.clone(), done("t2")]), "the answer may be older than these rows");
        assert!(holds_final_turn(&[done("t1"), text, done("t2")]));
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
        let seen: Vec<(String, TurnStatus, Option<i64>, Option<i64>, usize)> =
            turns.iter().map(|t| (t.id.as_str().to_owned(), t.status.clone(), t.started_at, t.completed_at, t.items.as_ref().map_or(0, Vec::len))).collect();
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
        let mut scan = TurnMetadata::default();
        for item in history.iter().rev() {
            scan.push(item);
        }
        let mut metadata = turns;
        for turn in &mut metadata {
            turn.items = None;
        }
        assert_eq!(serde_json::to_value(scan.finish(Some("t4"))).unwrap(), serde_json::to_value(metadata).unwrap());
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

    fn history_of(sizes: &[usize]) -> Vec<(ThreadItem, usize)> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, bytes)| {
                (serde_json::from_value(json!({ "type": "agentMessage", "id": format!("r{i}"), "text": "x" })).expect("an agent message"), *bytes)
            })
            .collect()
    }

    fn page(id: &ThreadId, rev: u64, rows: &[(ThreadItem, usize)], params: Value) -> Result<Value, CoreError> {
        match items_window(id, rev, rows, true, &serde_json::from_value(params).expect("params"))?.expect("a whole history decides every page") {
            Reply::Value(v) => Ok(v),
            _ => panic!("a value"),
        }
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

    #[test]
    fn continuation_names_the_exact_occurrence_of_a_repeated_display_id() {
        let id = ThreadId::from("t");
        let mut rows: Vec<(ThreadItem, usize)> = ["earlier", "between", "later", "newest"]
            .into_iter()
            .enumerate()
            .map(|(at, text)| {
                let shown = if at == 0 || at == 2 { "repeat" } else { text };
                let mut item = items(json!([{ "type": "agentMessage", "id": shown, "text": text }])).remove(0);
                mark_history_position(&mut item, &format!("record-{at}"), 0);
                (item, 10)
            })
            .collect();
        let first = page(&id, 0, &rows, json!({ "threadId": "t", "limit": 2 })).expect("newest page");
        let cursor = first["nextCursor"].as_str().expect("older page");
        let older = page(&id, 0, &rows, json!({ "threadId": "t", "cursor": cursor, "limit": 2 })).expect("older page");
        assert_eq!(older["data"][0]["text"], "earlier");
        assert_eq!(older["data"][1]["text"], "between");
        let newer = page(
            &id,
            0,
            &rows,
            json!({
                "threadId": "t", "cursor": older["backwardsCursor"], "sortDirection": "asc", "limit": 2
            }),
        )
        .expect("newer page");
        assert_eq!(newer["data"][0]["text"], "later");
        rows.truncate(2);
        assert!(
            matches!(page(&id, 1, &rows, json!({ "threadId": "t", "cursor": cursor })), Err(CoreError::CursorInvalidated { .. })),
            "the earlier row with the same display id is not the cursor"
        );
    }

    #[test]
    fn a_page_row_carries_archived_and_the_dividers_that_follow_its_record() {
        use crate::session::seams::{RowDecor, WindowDivider};
        let rows = |n: usize| -> Vec<(ThreadItem, usize)> {
            (0..n).map(|i| (items(json!([{ "type": "agentMessage", "id": format!("a{i}"), "text": "x", "meta": {} }])).remove(0), 1)).collect()
        };
        let ext = |item: &ThreadItem| meta(item).ext.clone();
        // No decoration: the rows as they are.
        assert!(decorated(rows(1), None).iter().all(|(item, _)| ext(item).is_empty()));
        let divider = WindowDivider { before: 1, ordinal: 9, cid: "k1".into(), at: Some(5), model_switches: Vec::new() };
        let decor = RowDecor { archived: true, dividers_after: vec![divider] };
        let shown = decorated(rows(2), Some(&decor));
        // Every row of the record is archived; the divider rides the last one, as the item the window would show.
        assert!(shown.iter().all(|(item, _)| ext(item).get("archived") == Some(&json!(true))));
        assert!(ext(&shown[0].0).get(DIVIDERS_AFTER).is_none());
        let after = ext(&shown[1].0).get(DIVIDERS_AFTER).cloned().expect("the dividers after the record");
        assert_eq!(after, json!([crate::session::transcript::divider_item("k1", Some(5))]));
        // A record that shows no row has none to carry them.
        assert!(decorated(Vec::new(), Some(&decor)).is_empty());
    }
}

impl DirInner {
    /// Answers one of the reads for the thread its params name, loaded or not. A cancelled request drops its read where
    /// it waits: a lane admission still pending is withdrawn with it.
    pub(super) async fn serve_read(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let id = req.params.get("threadId").and_then(Value::as_str).map(ThreadId::from).ok_or_else(|| invalid("threadId", "a thread id"))?;
        let cancel = &req.ctx.cancel;
        let result = mixdog_rt::Scope::new().cancel(cancel).run(self.read_of(req, &id)).await.done().ok_or_else(turn_read_cancelled)?;
        // A read can finish in a single poll after cancellation.
        check_turn_read_cancel(cancel)?;
        result
    }

    async fn read_of(&self, req: &CoreRequest, id: &ThreadId) -> Result<Reply, CoreError> {
        if req.method.as_str() == "thread/items/list" {
            let p: ThreadItemsListParams = params(req, "ThreadItemsListParams")?;
            let deps = &self.deps;
            let thread = id;
            return list_from_tail(
                id,
                &p,
                |rows| async move {
                    let (History { rev, rows }, complete) = history_tail(&deps.store, &deps.transcript, deps.lanes, thread, rows).await?;
                    Ok((rev, rows, complete))
                },
                |anchor, records| history_before(&deps.store, &deps.transcript, deps.lanes, thread, anchor.to_owned(), records),
            )
            .await;
        }
        if req.method.as_str() == "thread/finalAnswer/read" {
            return self.read_final_answer(id, params(req, "ThreadFinalAnswerReadParams")?).await;
        }
        if req.method.as_str() == "thread/turns/list" {
            return self.read_turns(id, params(req, "ThreadTurnsListParams")?, &req.ctx.cancel).await;
        }
        let History { rev: _, rows } = history(&self.deps, id).await?;
        let items: Vec<ThreadItem> = rows.iter().map(|(item, _)| item.clone()).collect();
        match req.method.as_str() {
            "thread/items/read" => items_read(id, &items, params(req, "ThreadItemsReadParams")?),
            "thread/attachment/list" => attachment_list(&items, params(req, "ThreadPageParams")?),
            "thread/modelMessages/list" => self.model_messages_list(id, params(req, "ThreadModelMessagesListParams")?).await,
            _ => unreachable!("`serves` admits only these methods"),
        }
    }

    /// The desktop asks after every turn and again while the answer is pending: the answer is in the rows of
    /// the newest turn, so only as much of the history as shows them is read (a busy thread has none to read).
    async fn read_final_answer(&self, id: &ThreadId, p: ThreadFinalAnswerReadParams) -> Result<Reply, CoreError> {
        let mut want = FIRST_TAIL_ROWS;
        loop {
            if self.busy(id) {
                // Still the thread's existence is the history's to say.
                history_tail(&self.deps.store, &self.deps.transcript, self.deps.lanes, id, 1).await?;
                return Ok(Reply::Value(Value::Null));
            }
            let (History { rev: _, rows }, complete) = history_tail(&self.deps.store, &self.deps.transcript, self.deps.lanes, id, want).await?;
            let shown: Vec<Value> = rows.iter().map(|(item, _)| display_row(item)).collect();
            if complete || holds_final_turn(&shown) {
                return Ok(Reply::Value(final_answer(&shown, self.busy(id), p.started_at).unwrap_or(Value::Null)));
            }
            want = want.saturating_mul(2);
        }
    }

    async fn read_turns(&self, id: &ThreadId, p: ThreadTurnsListParams, cancel: &CancellationToken) -> Result<Reply, CoreError> {
        self.deps.store.unheld().await;
        if p.items_view != Some(true)
            && let Some(scan) = read_turn_metadata(&self.deps, id, cancel).await?
        {
            check_turn_read_cancel(cancel)?;
            return turns_page(scan.finish(self.active_turn(id).as_deref()), p);
        }
        check_turn_read_cancel(cancel)?;
        let (store, thread, io_cancel) = (self.deps.store.clone(), id.clone(), cancel.clone());
        let (records, decor) = on_lane_wait(self.deps.lanes.io, cancel, move |lane| store.turn_history_full(lane, &thread, &io_cancel)).await??;
        let (transcript, cpu_cancel) = (self.deps.transcript.clone(), cancel.clone());
        let items = on_lane_wait(self.deps.lanes.cpu, cancel, move |lane| {
            let mut items = Vec::new();
            for (at, record) in records.into_iter().enumerate() {
                check_turn_read_cancel(&cpu_cancel)?;
                items.extend(decorated(transcript.rows(lane, &record), decor.get(at)).into_iter().map(|(item, _)| item));
            }
            Ok::<_, CoreError>(items)
        })
        .await??;
        check_turn_read_cancel(cancel)?;
        turns_list(&items, p, self.active_turn(id))
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
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: id.clone(),
            input: ItemId::from(String::new()),
        };
        let messages: Vec<Value> = context
            .read()
            .await?
            .into_iter()
            .map(|(_, mut message)| {
                mixdog_agent::interrupt::without_recovery_mark(&mut message);
                message
            })
            .collect();
        let start = usize::try_from(p.start).unwrap_or(usize::MAX);
        let rest = messages.get(start..).unwrap_or_default();
        let take = p.limit.map_or(rest.len(), |n| (n as usize).min(rest.len()));
        Ok(Reply::Value(json!({ "messageCount": messages.len(), "messages": rest[..take] })))
    }
}
