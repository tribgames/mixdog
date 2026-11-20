//! The thread reducer: `thread/snapshot` and the thread feed notifications folded into the session state (the fold of
//! `packages/protocol-client/src/session-state.ts`, protocol.md §2.5 and §5.1).
//!
//! The fold keeps the transcript rows, the fields the section notifications own and the live assistant text of one thread feed.
//! Its state is one JSON record the client library carries from notification to notification (`ThreadFold::state`); the
//! projection the UI reads is [`crate::state::desktop_session_state`]:
//!
//! | member | what |
//! | --- | --- |
//! | `sessionId` | the thread |
//! | `items` | one row per item, in feed order |
//! | `liveRows`, `stoppedRows` | the positions in `items` of the rows a live turn built, and of those whose card the Stop ended |
//! | `transcript` | `items` merged into aggregate cards (what the TypeScript memoizes on the identity of the row array) |
//! | `fields` | the fields owned by section notifications and by `thread/snapshot.state`; an absent field is absent here |
//! | `live` | the assistant text being streamed: `{ id, identity, text }` or `null` |
//! | `structureRevision` | how many times the rows changed structure (an item entered, was replaced, or the log was cut back) |
//! | `partialShown` | a live row has shown an unfinished line since the fold began: from then on `streamingPartial` is held |
//! | `frames`, `framedRevision` | the core's `thread/frame` announcements since the fold began, and `structureRevision` as Node's frames commit it |

use mixdog_app_protocol::JsonRpcNotification;
use mixdog_app_server_client::Json;
use mixdog_app_server_client::ThreadReducer;
use mixdog_js::js_trim;
use mixdog_js::js_words;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::rows::ITEMS_PER_STEP;
use crate::rows::Opt;
use crate::rows::Row;
use crate::rows::RowRef;
use crate::rows::coalesce;
use crate::rows::fld;
use crate::rows::item_rows;
use crate::rows::js_string;
use crate::rows::merge_tool_rows_steps;
use crate::rows::row_of;
use crate::rows::rows_of;
use crate::rows::text;
use crate::rows::truthy;

/// An object section that owns several fields, replaced as a whole (a field the value omits is removed), or a section that owns
/// one field (JSON `null` removes it).
enum Section {
    Fields { key: &'static str, fields: &'static [&'static str] },
    Field { key: &'static str, field: &'static str },
}

const SECTIONS: &[(&str, Section)] = &[
    (
        "thread/runtime/updated",
        Section::Fields {
            key: "runtime",
            fields: &[
                "busy",
                "commandBusy",
                "thinking",
                "spinner",
                "commandStatus",
                "progressHint",
                "activeTools",
                "clientHostPid",
                "toasts",
                "activeToolSummary",
                "toolMode",
                "setupChanged",
            ],
        },
    ),
    (
        "thread/route/updated",
        Section::Fields {
            key: "route",
            fields: &[
                "sessionProvider",
                "sessionModel",
                "fast",
                "fastCapable",
                "autoEffort",
                "modelParameters",
                "selectedContextWindow",
                "effort",
                "provider",
                "model",
                "turnEffort",
                "effortOptions",
                "cwd",
                "sessionForkedFrom",
                "systemShell",
                "webSearchRoute",
                "autoClear",
            ],
        },
    ),
    (
        "thread/context/updated",
        Section::Fields {
            key: "context",
            fields: &[
                "contextPercent",
                "contextTokens",
                "contextDefaultPercent",
                "contextWindow",
                "displayContextWindow",
                "autoCompactTokenLimit",
                "stats",
                "rawContextWindow",
                "effectiveContextWindowPercent",
                "compactBoundaryTokens",
            ],
        },
    ),
    ("thread/agents/updated", Section::Fields { key: "agents", fields: &["agentWorkers", "agentJobs", "agentScope"] }),
    (
        "thread/workflow/updated",
        Section::Fields { key: "workflow", fields: &["workflow", "orchestrationMode", "pendingWorkflowSwitch", "pendingOrchestrationModeSwitch"] },
    ),
    ("thread/approvals/updated", Section::Fields { key: "approvals", fields: &["toolApprovalResult", "handoffQuestions"] }),
    ("thread/todo/updated", Section::Field { key: "todo", field: "todo" }),
    ("thread/goal/updated", Section::Field { key: "goal", field: "goal" }),
    ("thread/quotaResume/updated", Section::Field { key: "quotaResume", field: "quotaResume" }),
    ("thread/shellJobs/updated", Section::Field { key: "shellJobs", field: "shellJobs" }),
    ("thread/workspace/updated", Section::Field { key: "workspace", field: "workspace" }),
    ("thread/promptRestore", Section::Field { key: "promptRestore", field: "promptRestore" }),
    ("thread/providerAccount/changed", Section::Field { key: "providerAccountChange", field: "providerAccountChange" }),
    ("thread/remote/updated", Section::Field { key: "remoteEnabled", field: "remoteEnabled" }),
    // The setup tool's desktop request (`{ id, at }`, Node's session store `setupUiRequest`), held by the thread until a window
    // claims it or its claim window ends; a snapshot carries it as a replay does.
    ("thread/setupUiRequest/updated", Section::Field { key: "setupUiRequest", field: "setupUiRequest" }),
    // A group room log's view while the room runs (`{ busy, toolApproval?, typing?, handoffQuestions? }`, Node's
    // `decorateRoomSnapshot`): not a field of its own, laid over the log's fields by the projection.
    ("thread/roomView/updated", Section::Field { key: "roomView", field: "roomView" }),
];

/// Up-arrow recall holds at most this many prompts (`PROMPT_HISTORY_LIMIT`).
const PROMPT_HISTORY_LIMIT: usize = 50;

/// `text.replace(/\s+/g, ' ').trim()`.
fn collapse(prompt: &str) -> String {
    js_words(prompt).collect::<Vec<_>>().join(" ")
}

/// `thread/promptHistory/updated`: `added` puts the prompt first, replacing an entry of the same whitespace-collapsed text, and
/// keeps the newest 50; `replaced` is the whole list. The list is the core's, over the whole transcript, never derived from the
/// resumed rows (a window shorter than the transcript).
fn prompt_history_of(held: Opt, change: Opt) -> Vec<Value> {
    let held_list = || match held {
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    let kind = text(fld(change, "kind"));
    if kind == "replaced" {
        return match fld(change, "prompts") {
            Some(Value::Array(prompts)) => prompts.clone(),
            _ => Vec::new(),
        };
    }
    let Some(Value::String(prompt)) = fld(change, "prompt") else { return held_list() };
    if kind != "added" {
        return held_list();
    }
    let key = collapse(prompt);
    let mut list = vec![Value::String(prompt.clone())];
    list.extend(held_list().into_iter().filter(|entry| entry.as_str().is_none_or(|entry| collapse(entry) != key)));
    list.truncate(PROMPT_HISTORY_LIMIT);
    list
}

/// Applies one section value to the field record.
fn with_section(fields: &mut Map<String, Value>, section: &Section, value: Opt) {
    match section {
        Section::Field { field, .. } => match value {
            None | Some(Value::Null) => {
                fields.shift_remove(*field);
            }
            Some(value) => {
                fields.insert((*field).to_owned(), value.clone());
            }
        },
        Section::Fields { fields: names, .. } => {
            for name in *names {
                match fld(value, name) {
                    None => {
                        fields.shift_remove(*name);
                    }
                    Some(member) => {
                        fields.insert((*name).to_owned(), member.clone());
                    }
                }
            }
        }
    }
}

fn section_key(section: &Section) -> &'static str {
    match section {
        Section::Fields { key, .. } | Section::Field { key, .. } => key,
    }
}

/// The queue as clients hold it, Node's projection of a queue entry (`session-state-projection.mjs:33-49`): `id`, `submittedAt`,
/// `text` and `displayText` (the same shown text), `mode`, `priority`, the sender's source fields and the images. A queued entry is
/// named by the submission it answers (Node's `makeQueueEntry` id), which the core carries as `clientSubmissionId` beside its own
/// queue id; its `submittedAt` is the core's `enqueuedAt`.
fn queue_of(queued: Opt) -> Vec<Value> {
    let Some(Value::Array(rows)) = queued else { return Vec::new() };
    rows.iter()
        .map(|row| {
            // Only the core's queue rows (they carry `enqueuedAt`) are projected; a row already in the projected shape stays as it is.
            let Some(entry) = row.as_object().filter(|entry| entry.contains_key("enqueuedAt")) else { return row.clone() };
            let mut source = entry.clone();
            let submission = source.shift_remove("clientSubmissionId");
            let enqueued_at = source.shift_remove("enqueuedAt");
            let id = source.shift_remove("id");
            let shown = match source.shift_remove("text") {
                Some(Value::String(own)) => own,
                _ => String::new(),
            };
            let mode = source.shift_remove("mode");
            let priority = source.shift_remove("priority");
            let images = source.shift_remove("images");
            let mut out = Map::new();
            let named = match submission {
                Some(Value::String(own)) if !own.is_empty() => Some(Value::String(own)),
                _ => id,
            };
            if let Some(named) = named {
                out.insert("id".to_owned(), named);
            }
            if let Some(at) = enqueued_at {
                out.insert("submittedAt".to_owned(), at);
            }
            out.insert("text".to_owned(), json!(shown));
            out.insert("displayText".to_owned(), json!(shown));
            out.insert("mode".to_owned(), mode.filter(|mode| truthy(Some(mode))).unwrap_or_else(|| json!("prompt")));
            out.insert("priority".to_owned(), priority.filter(|priority| truthy(Some(priority))).unwrap_or_else(|| json!("next")));
            out.extend(source);
            if let Some(images) = images
                && images.as_array().is_some_and(|list| !list.is_empty())
            {
                out.insert("images".to_owned(), images);
            }
            Value::Object(out)
        })
        .collect()
}

fn fields_of_state(state: Opt, has_older: bool) -> Map<String, Value> {
    let mut fields = Map::new();
    for (_, section) in SECTIONS {
        with_section(&mut fields, section, fld(state, section_key(section)));
    }
    if let Some(title @ Value::String(_)) = fld(state, "title") {
        fields.insert("desktopSessionTitle".to_owned(), title.clone());
    }
    if has_older {
        fields.insert("transcriptHasOlder".to_owned(), json!(true));
    }
    if let Some(list @ Value::Array(_)) = fld(state, "promptHistoryList") {
        fields.insert("promptHistoryList".to_owned(), list.clone());
    }
    fields.insert("queued".to_owned(), Value::Array(queue_of(fld(state, "queued"))));
    fields
}

/// The live row as `streamingTail` (what the terminal shows, gated to completed lines) and `streamingPartial` (the unfinished
/// line beyond it), as the engine publishes them today (turn-stream.mjs `partialNow`). `live` is the fold's `{ id, identity, text }`;
/// `from` is a position in UTF-16 units, as JavaScript counts.
pub(crate) fn live_fields(live: &Value) -> Map<String, Value> {
    let live = Some(live);
    let body = text(fld(live, "text"));
    let id = fld(live, "id").cloned().unwrap_or(Value::Null);
    let identity = fld(live, "identity").cloned().unwrap_or_else(|| json!({}));
    let cut_at = body.rfind('\n').map_or(0, |at| at + 1);
    let (head, rest) = body.split_at(cut_at);
    let cut = head.encode_utf16().count();
    let mut out = Map::new();
    if cut > 0 {
        let mut tail = identity.as_object().cloned().unwrap_or_default();
        tail.insert("text".to_owned(), json!(head));
        out.insert("streamingTail".to_owned(), Value::Object(tail));
        if !rest.is_empty() {
            out.insert("streamingPartial".to_owned(), json!({ "id": id, "from": cut, "text": rest }));
        }
    } else if !js_trim(body).is_empty() {
        out.insert("streamingPartial".to_owned(), json!({ "id": id, "from": 0, "text": body, "tail": identity }));
    }
    out
}

/// The assistant text being streamed.
struct Live {
    id: String,
    identity: Map<String, Value>,
    text: String,
}

impl Live {
    fn to_value(&self) -> Value {
        json!({ "id": self.id, "identity": self.identity, "text": self.text })
    }

    fn of(value: Opt) -> Option<Self> {
        let value = value.filter(|value| value.is_object())?;
        Some(Self {
            id: text(fld(Some(value), "id")).to_owned(),
            identity: fld(Some(value), "identity").and_then(Value::as_object).cloned().unwrap_or_default(),
            text: text(fld(Some(value), "text")).to_owned(),
        })
    }
}

/// The reducer state of one thread feed, as the members of the record in the module's table.
struct Fold {
    session_id: String,
    items: Vec<Value>,
    live_rows: Vec<bool>,
    stopped_rows: Vec<bool>,
    transcript: Vec<Value>,
    fields: Map<String, Value>,
    live: Option<Live>,
    structure_revision: u64,
    partial_shown: bool,
    frames: u64,
    framed_revision: u64,
}

fn count(value: Opt) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn positions(flags: &[bool]) -> Value {
    Value::Array(flags.iter().enumerate().filter(|(_, flag)| **flag).map(|(at, _)| json!(at)).collect())
}

impl Fold {
    fn from_state(state: &Value) -> Self {
        let state = Some(state);
        let items: Vec<Value> = match fld(state, "items") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let flags = |key: &str| {
            let mut flags = vec![false; items.len()];
            if let Some(Value::Array(list)) = fld(state, key) {
                for at in list.iter().filter_map(Value::as_u64) {
                    if let Some(flag) = usize::try_from(at).ok().and_then(|at| flags.get_mut(at)) {
                        *flag = true;
                    }
                }
            }
            flags
        };
        Self {
            session_id: text(fld(state, "sessionId")).to_owned(),
            live_rows: flags("liveRows"),
            stopped_rows: flags("stoppedRows"),
            transcript: match fld(state, "transcript") {
                Some(Value::Array(rows)) => rows.clone(),
                _ => Vec::new(),
            },
            fields: fld(state, "fields").and_then(Value::as_object).cloned().unwrap_or_default(),
            live: Live::of(fld(state, "live")),
            structure_revision: count(fld(state, "structureRevision")),
            partial_shown: fld(state, "partialShown") == Some(&Value::Bool(true)),
            frames: count(fld(state, "frames")),
            framed_revision: count(fld(state, "framedRevision")),
            items,
        }
    }

    fn into_state(self) -> Value {
        json!({
            "sessionId": self.session_id,
            "items": self.items,
            "liveRows": positions(&self.live_rows),
            "stoppedRows": positions(&self.stopped_rows),
            "transcript": self.transcript,
            "fields": self.fields,
            "live": self.live.as_ref().map_or(Value::Null, Live::to_value),
            "structureRevision": self.structure_revision,
            "partialShown": self.partial_shown,
            "frames": self.frames,
            "framedRevision": self.framed_revision,
        })
    }

    /// The transcript the UI reads: the rows merged into aggregate cards.
    fn merge(&mut self, yield_point: impl FnMut()) {
        let rows: Vec<RowRef<'_>> = self
            .items
            .iter()
            .zip(self.live_rows.iter().zip(&self.stopped_rows))
            .map(|(value, (live, stopped))| RowRef { value, live: *live, stopped: *stopped })
            .collect();
        self.transcript = merge_tool_rows_steps(&rows, yield_point);
    }

    /// `withLive`: `partialShown` is set once a live row has shown an unfinished line.
    fn set_live(&mut self, live: Option<Live>) {
        if !self.partial_shown
            && let Some(live) = &live
            && live_fields(&live.to_value()).contains_key("streamingPartial")
        {
            self.partial_shown = true;
        }
        self.live = live;
    }

    fn set_field(&mut self, key: &str, value: Option<Value>) {
        match value {
            Some(value) => {
                self.fields.insert(key.to_owned(), value);
            }
            None => {
                self.fields.shift_remove(key);
            }
        }
    }

    /// The row replaces the one of its id (the last such), or enters after the last.
    fn upsert(&mut self, row: Row) {
        let id = fld(Some(&row.value), "id");
        let at = self.items.iter().rposition(|held| strict_eq(fld(Some(held), "id"), id));
        match at {
            Some(at) => {
                self.live_rows[at] = row.live;
                self.stopped_rows[at] = row.stopped;
                self.items[at] = row.value;
            }
            None => {
                self.live_rows.push(row.live);
                self.stopped_rows.push(row.stopped);
                self.items.push(row.value);
            }
        }
    }
}

/// `a === b` of two values that may be absent: objects are never equal (identity), numbers compare as numbers.
fn strict_eq(a: Opt, b: Opt) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// The initial state of a `thread/snapshot`, `yield_point` called every `ITEMS_PER_STEP` rows and every `ROWS_PER_STEP` rows
/// merged, so a long transcript folds in budgeted turns. The merged transcript is built before the state is returned, so the
/// first read does not pay for it.
pub fn initial_steps(snapshot: &Json, mut yield_point: impl FnMut()) -> Json {
    let snapshot = Some(snapshot);
    let source: &[Value] = match fld(snapshot, "items") {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let mut rows: Vec<Row> = Vec::new();
    let mut live: Option<Live> = None;
    for (at, item) in source.iter().enumerate() {
        // The reply the turn is streaming (the core's in-progress item, its text so far) is the live row `item/started` and its
        // deltas made, not a settled row: the next delta extends it.
        let streaming = text(fld(Some(item), "type")) == "agentMessage" && text(fld(fld(Some(item), "meta"), "status")) == "inProgress";
        match streaming.then(|| row_of(item)).flatten() {
            Some(row) => live = Some(live_of(Some(item), &row)),
            None => rows.extend(rows_of(item)),
        }
        if at % ITEMS_PER_STEP == ITEMS_PER_STEP - 1 {
            yield_point();
        }
    }
    // Node's store begins at 0 (initial-state.mjs:18) and a snapshot's rows enter it as one structure change (transcript-store.mjs:74,
    // a restore's `replaceItems`; a new task's first row is a push, frame-batched-store.mjs:37): a snapshot with rows is revision 1.
    let revision = u64::from(!rows.is_empty());
    let mut fold = Fold {
        session_id: js_string(coalesce(fld(fld(snapshot, "thread"), "id"), Some(&json!("")))),
        live_rows: rows.iter().map(|row| row.live).collect(),
        stopped_rows: rows.iter().map(|row| row.stopped).collect(),
        items: rows.into_iter().map(|row| row.value).collect(),
        transcript: Vec::new(),
        fields: fields_of_state(fld(snapshot, "state"), fld(snapshot, "hasOlder") == Some(&Value::Bool(true))),
        live: None,
        structure_revision: revision,
        partial_shown: false,
        frames: 0,
        framed_revision: revision,
    };
    fold.set_live(live);
    fold.merge(yield_point);
    fold.into_state()
}

/// The fold of the thread feed: `initial` for a `thread/snapshot`, `apply` for each notification after it.
#[derive(Debug, Default, Clone, Copy)]
pub struct SessionReducer;

impl ThreadReducer for SessionReducer {
    fn initial(&self, snapshot: &Json) -> Json {
        initial_steps(snapshot, || {})
    }

    fn apply(&self, state: &Json, notification: &JsonRpcNotification) -> Json {
        let params = notification.params.as_ref();
        let method = notification.method.as_str();
        if let Some((_, section)) = SECTIONS.iter().find(|(name, _)| *name == method) {
            let mut fold = Fold::from_state(state);
            with_section(&mut fold.fields, section, fld(params, "value"));
            return fold.into_state();
        }
        match method {
            "thread/promptHistory/updated" => {
                let mut fold = Fold::from_state(state);
                let history = prompt_history_of(fold.fields.get("promptHistoryList"), fld(params, "value"));
                fold.set_field("promptHistoryList", Some(Value::Array(history)));
                fold.into_state()
            }
            "thread/queue/changed" => {
                let mut fold = Fold::from_state(state);
                fold.set_field("queued", Some(Value::Array(queue_of(fld(params, "queued")))));
                fold.into_state()
            }
            "thread/name/updated" => {
                let mut fold = Fold::from_state(state);
                fold.set_field("desktopSessionTitle", fld(params, "title").filter(|title| title.is_string()).cloned());
                fold.into_state()
            }
            "thread/goal/cleared" => {
                let mut fold = Fold::from_state(state);
                fold.set_field("goal", None);
                fold.into_state()
            }
            "thread/frame" => {
                let mut fold = Fold::from_state(state);
                fold.frames += 1;
                fold.framed_revision += u64::from(fld(params, "structureChanged") == Some(&Value::Bool(true)));
                fold.into_state()
            }
            "turn/started" | "turn/completed" => {
                let mut fold = Fold::from_state(state);
                fold.set_live(None);
                fold.into_state()
            }
            "item/started" | "item/completed" => apply_item(state, method == "item/completed", params),
            "item/agentMessage/delta" => {
                let mut fold = Fold::from_state(state);
                let id = js_string(fld(params, "itemId"));
                let delta = text(fld(params, "delta"));
                let live = match fold.live.take() {
                    Some(mut live) if live.id == id => {
                        live.text.push_str(delta);
                        live
                    }
                    _ => Live { identity: identity_of(&id), id, text: delta.to_owned() },
                };
                fold.set_live(Some(live));
                fold.into_state()
            }
            "thread/historyReset" => apply_history_reset(state, params),
            _ => state.clone(),
        }
    }
}

/// `{ id, kind: 'assistant', streaming: true }`: the identity of a row whose text is being streamed.
fn identity_of(id: &str) -> Map<String, Value> {
    let mut identity = Map::new();
    identity.insert("id".to_owned(), json!(id));
    identity.insert("kind".to_owned(), json!("assistant"));
    identity.insert("streaming".to_owned(), json!(true));
    identity
}

/// The live text of an `agentMessage` item: the row it settles as, without its text (`item/started` and a snapshot's in-progress
/// reply make the same live row).
fn live_of(item: Opt, row: &Row) -> Live {
    let mut identity = row.value.as_object().cloned().unwrap_or_default();
    let shown = identity.shift_remove("text");
    identity.insert("kind".to_owned(), json!("assistant"));
    identity.insert("streaming".to_owned(), json!(true));
    Live { id: js_string(fld(item, "id")), identity, text: shown.as_ref().and_then(Value::as_str).unwrap_or("").to_owned() }
}

fn apply_item(state: &Json, completed: bool, params: Opt) -> Json {
    let item = fld(params, "item");
    let mut batched = item_rows(item.unwrap_or(&Value::Null)).into_iter();
    let Some(row) = batched.next() else { return state.clone() };
    let mut fold = Fold::from_state(state);
    // Archiving updates the held window; rows outside it are read by history,
    // never appended below the compaction boundary.
    if row.value.get("archived") == Some(&Value::Bool(true)) && !fold.items.iter().any(|held| strict_eq(held.get("id"), row.value.get("id"))) {
        return state.clone();
    }
    if text(fld(item, "type")) == "agentMessage" && !completed {
        fold.set_live(Some(live_of(item, &row)));
        return fold.into_state();
    }
    let id = fld(item, "id");
    if completed && fold.live.as_ref().is_some_and(|live| strict_eq(Some(&Value::String(live.id.clone())), id)) {
        fold.live = None;
    }
    fold.upsert(row);
    for card in batched {
        fold.upsert(card);
    }
    fold.structure_revision += 1;
    // A room log's row and the view that landed with it are one revision: the view rides on the row's notification.
    if let Some(view) = fld(params, "roomView") {
        with_section(&mut fold.fields, &Section::Field { key: "roomView", field: "roomView" }, Some(view));
    }
    fold.merge(|| {});
    fold.into_state()
}

fn apply_history_reset(state: &Json, params: Opt) -> Json {
    let mut fold = Fold::from_state(state);
    let from = fld(params, "fromItemId");
    let at = from.and_then(|from| fold.items.iter().position(|row| strict_eq(fld(Some(row), "id"), Some(from))));
    // `hasOlder` is the transcript's flag after the reset; an absent flag reads false, as in a snapshot.
    fold.set_field("transcriptHasOlder", (fld(params, "hasOlder") == Some(&Value::Bool(true))).then(|| json!(true)));
    if from.is_some() && at.is_none() {
        fold.set_live(None);
        return fold.into_state();
    }
    let keep = at.map_or(0, |at| at + 1);
    fold.items.truncate(keep);
    fold.live_rows.truncate(keep);
    fold.stopped_rows.truncate(keep);
    fold.live = None;
    fold.structure_revision += 1;
    fold.merge(|| {});
    fold.into_state()
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::JsonRpcNotification;

    use super::*;

    fn note(method: &str, params: Value) -> JsonRpcNotification {
        serde_json::from_value(json!({ "method": method, "params": params })).expect("a notification")
    }

    fn snapshot(state: Value, has_older: bool) -> Json {
        json!({ "thread": { "id": "t" }, "items": [], "state": state, "hasOlder": has_older })
    }

    fn fields(state: &Json) -> &Value {
        &state["fields"]
    }

    #[test]
    fn prompt_history_adds_replaces_and_keeps_the_newest_fifty() {
        let reducer = SessionReducer;
        let mut state = reducer.initial(&snapshot(json!({ "promptHistoryList": ["b  c", "a"] }), true));
        assert_eq!(fields(&state)["promptHistoryList"], json!(["b  c", "a"]));
        for prompt in ["a", "b\n c"] {
            state = reducer.apply(&state, &note("thread/promptHistory/updated", json!({ "threadId": "t", "value": { "kind": "added", "prompt": prompt } })));
        }
        assert_eq!(fields(&state)["promptHistoryList"], json!(["b\n c", "a"]));
        let full: Vec<String> = (0..50).map(|i| format!("p{i}")).collect();
        state = reducer.apply(&state, &note("thread/promptHistory/updated", json!({ "value": { "kind": "replaced", "prompts": full } })));
        state = reducer.apply(&state, &note("thread/promptHistory/updated", json!({ "value": { "kind": "added", "prompt": "new" } })));
        let list = fields(&state)["promptHistoryList"].as_array().unwrap().clone();
        assert_eq!((list.len(), list[0].clone(), list[49].clone()), (50, json!("new"), json!("p48")));
    }

    #[test]
    fn a_history_reset_cuts_the_rows_back_and_sets_the_older_flag_from_the_notification() {
        let reducer = SessionReducer;
        let snap = json!({
            "thread": { "id": "t" }, "hasOlder": true, "state": {},
            "items": [
                { "type": "agentMessage", "id": "a", "text": "one", "meta": {} },
                { "type": "agentMessage", "id": "b", "text": "two", "meta": {} }
            ]
        });
        let state = reducer.initial(&snap);
        assert_eq!((state["structureRevision"].clone(), fields(&state)["transcriptHasOlder"].clone()), (json!(1), json!(true)));
        let cut = reducer.apply(&state, &note("thread/historyReset", json!({ "reason": "rewind", "fromItemId": "a", "hasOlder": false })));
        assert_eq!((cut["items"].as_array().unwrap().len(), cut["structureRevision"].clone()), (1, json!(2)));
        assert!(fields(&cut).get("transcriptHasOlder").is_none());
        let unknown = reducer.apply(&state, &note("thread/historyReset", json!({ "fromItemId": "gone", "hasOlder": true })));
        assert_eq!((unknown["items"].as_array().unwrap().len(), unknown["structureRevision"].clone()), (2, json!(1)));
        let cleared = reducer.apply(&state, &note("thread/historyReset", json!({ "reason": "clear" })));
        assert!(cleared["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_section_replaces_its_fields_as_a_whole_and_null_removes_a_one_field_section() {
        let reducer = SessionReducer;
        let mut state = reducer.initial(&snapshot(json!({ "runtime": { "busy": true, "spinner": "x" }, "goal": { "o": 1 } }), false));
        assert_eq!(fields(&state)["spinner"], "x");
        state = reducer.apply(&state, &note("thread/runtime/updated", json!({ "value": { "busy": false } })));
        assert_eq!(fields(&state)["busy"], false);
        assert!(fields(&state).get("spinner").is_none());
        state = reducer.apply(&state, &note("thread/goal/updated", json!({ "value": null })));
        assert!(fields(&state).get("goal").is_none());
    }

    #[test]
    fn compaction_history_and_live_updates_keep_the_same_boundary_and_archived_cards() {
        let reducer = SessionReducer;
        let call = |id: &str, archived: bool| {
            json!({
                "type": "toolCall", "id": id, "name": "read", "input": { "path": "src" },
                "run": { "callId": id, "result": "ok" },
                "meta": { "status": "completed", "ext": { "archived": archived } }
            })
        };
        let summary = json!({ "type": "agentMessage", "id": "summary", "text": "Investigation summary", "meta": {} });
        let divider = json!({ "type": "contextCompaction", "id": "divider:c1", "meta": {} });
        let prompt = json!({ "type": "userMessage", "id": "prompt", "content": [{ "type": "text", "text": "Continue" }], "meta": {} });
        let mut archived_summary = summary.clone();
        archived_summary["meta"]["ext"] = json!({ "archived": true });
        let mut history_summary = archived_summary.clone();
        history_summary["meta"]["ext"]["dividersAfter"] = json!([divider]);
        let initial = reducer.initial(&json!({
            "thread": { "id": "t" }, "state": {},
            "items": [call("read-1", true), call("read-2", true), history_summary, prompt]
        }));
        let mut live = reducer.initial(&json!({
            "thread": { "id": "t" }, "state": {},
            "items": [call("read-1", false), call("read-2", false), summary]
        }));
        for item in [divider, call("outside-window", true), call("read-1", true), call("read-2", true), archived_summary, prompt] {
            live = reducer.apply(&live, &note("item/completed", json!({ "item": item })));
        }
        assert_eq!(live["transcript"], initial["transcript"]);
        let rows = live["transcript"].as_array().unwrap();
        assert_eq!(rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), ["read-1", "summary", "divider:c1", "prompt"]);
        assert_eq!(rows[0]["archived"], true);
        assert!(rows[2].get("archived").is_none());
        live = reducer.apply(&live, &note("item/completed", json!({ "item": call("read-2", false) })));
        assert_ne!(live["transcript"][0]["archived"], true, "a card with a retained member stays live");
    }

    /// A room log's row and the view that landed with it are folded as one step: the state after the row's notification already
    /// holds the view, so nobody is told of the row without it.
    #[test]
    fn a_row_carries_the_room_view_it_landed_with() {
        let reducer = SessionReducer;
        let mut state = reducer.initial(&snapshot(json!({ "roomView": { "busy": true, "typing": { "id": "t1" } } }), false));
        let deciding = json!({ "busy": true, "deciding": true, "typing": { "id": "room-deciding" } });
        let words = json!({ "type": "agentMessage", "id": "m1", "text": "hi", "meta": {} });
        state = reducer.apply(&state, &note("item/completed", json!({ "threadId": "t", "item": words, "roomView": deciding.clone() })));
        assert_eq!((state["items"][0]["id"].clone(), fields(&state)["roomView"].clone()), (json!("m1"), deciding.clone()));
        // A row without a view leaves the view as it stands.
        let more = json!({ "type": "agentMessage", "id": "m2", "text": "again", "meta": {} });
        state = reducer.apply(&state, &note("item/completed", json!({ "threadId": "t", "item": more })));
        assert_eq!(fields(&state)["roomView"], deciding);
        // `roomView: null` is the clear, riding with its row; an absent one (above) changed nothing.
        let last = json!({ "type": "agentMessage", "id": "m3", "text": "bye", "meta": {} });
        state = reducer.apply(&state, &note("item/completed", json!({ "threadId": "t", "item": last, "roomView": null })));
        assert!(fields(&state).get("roomView").is_none_or(Value::is_null));
        assert_eq!(state["items"][2]["id"], "m3");
    }

    #[test]
    fn live_text_takes_the_rows_identity_and_completes_into_the_row() {
        let reducer = SessionReducer;
        let mut state = reducer.initial(&snapshot(json!({}), false));
        let started = json!({ "threadId": "t", "item": { "type": "agentMessage", "id": "m", "text": "He", "meta": { "model": "x" } } });
        state = reducer.apply(&state, &note("item/started", started));
        assert_eq!(state["live"]["identity"], json!({ "id": "m", "kind": "assistant", "model": "x", "streaming": true }));
        state = reducer.apply(&state, &note("item/agentMessage/delta", json!({ "itemId": "m", "delta": "llo\nwor" })));
        assert_eq!(state["live"]["text"], "Hello\nwor");
        assert_eq!(state["partialShown"], true);
        let done = json!({ "threadId": "t", "item": { "type": "agentMessage", "id": "m", "text": "Hello\nworld", "meta": {} } });
        state = reducer.apply(&state, &note("item/completed", done));
        assert!(state["live"].is_null());
        assert_eq!((state["items"][0]["text"].clone(), state["structureRevision"].clone()), (json!("Hello\nworld"), json!(1)));
    }

    #[test]
    fn a_live_line_is_split_at_its_last_newline_in_utf16_units() {
        let live = json!({ "id": "m", "identity": { "id": "m" }, "text": "😀\nab" });
        let out = live_fields(&live);
        assert_eq!(out["streamingTail"], json!({ "id": "m", "text": "😀\n" }));
        assert_eq!(out["streamingPartial"], json!({ "id": "m", "from": 3, "text": "ab" }));
        let first = live_fields(&json!({ "id": "m", "identity": { "id": "m" }, "text": "abc" }));
        assert_eq!(first["streamingPartial"], json!({ "id": "m", "from": 0, "text": "abc", "tail": { "id": "m" } }));
        assert!(live_fields(&json!({ "id": "m", "identity": {}, "text": " \n" })).get("streamingPartial").is_none());
    }

    #[test]
    fn a_queued_entry_is_the_projection_of_the_cores_queue_row() {
        let reducer = SessionReducer;
        let state = reducer.initial(&snapshot(
            json!({ "queued": [
                { "id": "q1", "clientSubmissionId": "sub", "enqueuedAt": 5, "text": "go", "images": [], "source": "bot" },
                { "id": "already", "text": "kept" }
            ] }),
            false,
        ));
        let queued = fields(&state)["queued"].as_array().unwrap().clone();
        assert_eq!(
            queued[0],
            json!({ "id": "sub", "submittedAt": 5, "text": "go", "displayText": "go", "mode": "prompt", "priority": "next", "source": "bot" })
        );
        assert_eq!(queued[1], json!({ "id": "already", "text": "kept" }));
    }

    #[test]
    fn frames_count_and_the_framed_revision_follows_the_cores_announcements() {
        let reducer = SessionReducer;
        let mut state = reducer.initial(&snapshot(json!({}), false));
        state = reducer.apply(&state, &note("thread/frame", json!({ "structureChanged": true })));
        state = reducer.apply(&state, &note("thread/frame", json!({})));
        assert_eq!((state["frames"].clone(), state["framedRevision"].clone()), (json!(2), json!(1)));
    }

    #[test]
    fn a_tool_rows_flags_follow_its_position_through_a_replace_and_a_cut() {
        let reducer = SessionReducer;
        let call = |status: &str| json!({ "threadId": "t", "item": { "type": "toolCall", "id": "c", "name": "read", "input": { "path": "p" }, "output": "x", "run": { "live": true, "callId": "k" }, "meta": { "status": status, "at": 1 } } });
        let mut state = reducer.initial(&snapshot(json!({}), false));
        state = reducer.apply(&state, &note("item/started", call("inProgress")));
        assert_eq!(state["liveRows"], json!([0]));
        state = reducer.apply(&state, &note("item/completed", call("completed")));
        assert_eq!((state["items"].as_array().unwrap().len(), state["liveRows"].clone()), (1, json!([0])));
        assert_eq!(state["transcript"][0]["name"], "__aggregate__");
        state = reducer.apply(&state, &note("thread/historyReset", json!({})));
        assert_eq!((state["liveRows"].clone(), state["transcript"].clone()), (json!([]), json!([])));
    }
}
