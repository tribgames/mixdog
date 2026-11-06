//! Node-shaped rows as the protocol's typed thread items. Each row attribute with a typed home
//! (`mixdog_protocol::ThreadItem`) goes there; the rest of the row stays in `ItemMeta.ext`, the
//! core's exact row attributes (P §14.12). The same conversion serves a stored message's
//! restored rows ([`super::transcript_rows`]) and a display record's verbatim row (an imported
//! compaction-archive item), so both show the same item for the same row.

use mixdog_protocol::HeldRequest;
use mixdog_protocol::ImageRef;
use mixdog_protocol::ImportedToolRun;
use mixdog_protocol::ItemId;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::ItemStatus;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::MessageAttachment;
use mixdog_protocol::MessageReaction;
use mixdog_protocol::MessageSource;
use mixdog_protocol::RoomLine;
use mixdog_protocol::RoomRowKind;
use mixdog_protocol::RoutineTrigger;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ToolMeta;
use mixdog_protocol::ToolRun;
use mixdog_protocol::TurnEndStatus;
use mixdog_protocol::TurnId;
use mixdog_protocol::UserInput;
use mixdog_protocol::UserRowDetails;
use mixdog_store::schema::record::ItemRecord;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;

use crate::session::seams::Shown;
use super::transcript_rows::ResultFact;
use super::transcript_rows::Restored;
use super::transcript_rows::Row;
use super::transcript_rows::call_item_id;
use super::transcript_rows::metadata;
use super::transcript_rows::normalize_attachments;
use super::transcript_rows::normalize_reactions;
use super::transcript_rows::text_field;

/// What a row's conversion needs beyond the row.
pub(super) struct Ctx<'a> {
    pub turn: Option<&'a str>,
    /// The stored message, for the facts its row does not carry (sender chain, held request).
    pub message: Option<&'a Value>,
    /// The record counts for prompt history.
    pub counts_prompt: bool,
    /// The message's `meta.source`.
    pub source: Option<&'a str>,
}

fn take_str(row: &mut Row, key: &str) -> Option<String> {
    match row.shift_remove(key) {
        Some(Value::String(text)) => Some(text),
        Some(other) => {
            row.insert(key.to_owned(), other);
            None
        }
        None => None,
    }
}

fn take_bool(row: &mut Row, key: &str) -> Option<bool> {
    match row.shift_remove(key) {
        Some(Value::Bool(b)) => Some(b),
        Some(other) => {
            row.insert(key.to_owned(), other);
            None
        }
        None => None,
    }
}

fn take_int(row: &mut Row, key: &str) -> Option<i64> {
    let value = row.get(key)?.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0)?;
    row.shift_remove(key);
    Some(value as i64)
}

/// Moves `key` out of the row as `T`; a value of another shape stays in the row.
fn take_as<T: DeserializeOwned>(row: &mut Row, key: &str) -> Option<T> {
    let value = row.shift_remove(key)?;
    match serde_json::from_value::<T>(value.clone()) {
        Ok(typed) => Some(typed),
        Err(_) => {
            row.insert(key.to_owned(), value);
            None
        }
    }
}

fn item_id(id: &str) -> ItemId {
    ItemId::from(id)
}

/// The meta every row shares: time, route, message id and posted mark; `ext` is filled last
/// with whatever the row still holds.
fn meta_of(row: &mut Row, ctx: &Ctx<'_>) -> ItemMeta {
    ItemMeta {
        turn_id: ctx.turn.map(TurnId::from),
        at: take_int(row, "at"),
        status: None,
        label: None,
        detail: None,
        model: take_str(row, "model"),
        model_id: take_str(row, "modelId"),
        provider: take_str(row, "provider"),
        agent: take_str(row, "agent"),
        message_id: take_str(row, "messageId"),
        posted: take_bool(row, "posted"),
        ext: Default::default(),
    }
}

fn finish(mut meta: ItemMeta, mut row: Row) -> ItemMeta {
    row.shift_remove("kind");
    row.shift_remove("id");
    meta.ext = row;
    meta
}

fn id_of(row: &mut Row) -> String {
    take_str(row, "id").unwrap_or_default()
}

/// A stored message's own facts for the user row's details (`persistedUserTranscriptMetadata`).
fn stored_details(message: &Value) -> (Vec<String>, Vec<Option<String>>, Option<u32>, Vec<String>, Option<String>) {
    let stored = message.pointer("/meta/transcript").unwrap_or(&Value::Null);
    let strings = |key: &str| -> Vec<String> {
        stored
            .get(key)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    let consumed = stored
        .get("consumedExecutionIds")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|id| id.as_str().filter(|s| !s.is_empty()).map(str::to_owned)).collect())
        .unwrap_or_default();
    let hop = stored.get("hop").and_then(Value::as_u64).filter(|h| *h > 0).and_then(|h| u32::try_from(h).ok());
    let room_row = Some(text_field(stored, "roomRow")).filter(|s| !s.is_empty()).map(str::to_owned);
    (strings("submissionIds"), consumed, hop, strings("botChain"), room_row)
}

fn user_item(mut row: Row, ctx: &Ctx<'_>) -> ThreadItem {
    let id = id_of(&mut row);
    let text = take_str(&mut row, "text").unwrap_or_default();
    let mut meta = meta_of(&mut row, ctx);
    let mut details = UserRowDetails {
        source: ctx.source.and_then(|s| serde_json::from_value::<MessageSource>(json!(s)).ok()),
        routine_trigger: take_as::<RoutineTrigger>(&mut row, "routineTrigger"),
        sender: take_str(&mut row, "sender"),
        from_agent: take_str(&mut row, "fromAgent"),
        steered: take_bool(&mut row, "steered"),
        attachments: take_as::<Vec<MessageAttachment>>(&mut row, "attachments").unwrap_or_default(),
        image_refs: take_as::<Vec<ImageRef>>(&mut row, "imageRefs").unwrap_or_default(),
        reactions: take_as::<Vec<MessageReaction>>(&mut row, "reactions").unwrap_or_default(),
        ..Default::default()
    };
    if let Some(message) = ctx.message {
        let (submission_ids, consumed, hop, bot_chain, room_row) = stored_details(message);
        details.submission_ids = submission_ids;
        details.consumed_execution_ids = consumed;
        details.hop = hop;
        details.bot_chain = bot_chain;
        details.room_row = room_row;
        if details.source == Some(MessageSource::HeldRequest) {
            details.held_request = message
                .pointer("/meta/heldRequest")
                .and_then(|held| serde_json::from_value::<HeldRequest>(held.clone()).ok());
        }
    }
    let device = take_str(&mut row, "device");
    let checkpoint_id = take_str(&mut row, "checkpointId");
    let applied_skills = row.shift_remove("appliedSkills").and_then(|skills| serde_json::from_value::<Vec<String>>(skills).ok());
    row.shift_remove("expanded");
    meta = finish(meta, row);
    ThreadItem::UserMessage {
        id: item_id(&id),
        content: vec![UserInput::Text { text: text.clone() }],
        device,
        client_submission_id: None,
        checkpoint_id,
        applied_skills,
        display_text: text,
        counts_for_prompt_history: ctx.counts_prompt,
        details: Box::new(details),
        meta,
    }
}

fn assistant_item(mut row: Row, ctx: &Ctx<'_>) -> ThreadItem {
    let id = id_of(&mut row);
    let text = take_str(&mut row, "text").unwrap_or_default();
    let imported_tool_runs = take_as::<Vec<ImportedToolRun>>(&mut row, "importedToolRuns").unwrap_or_default();
    let meta = meta_of(&mut row, ctx);
    ThreadItem::AgentMessage {
        id: item_id(&id),
        text: MaybeBlob::Inline(text),
        imported_tool_runs,
        meta: finish(meta, row),
    }
}

fn blob_text(row: &mut Row, key: &str) -> Option<MaybeBlob<String>> {
    take_str(row, key).map(MaybeBlob::Inline)
}

fn tool_item(mut row: Row, ctx: &Ctx<'_>) -> ThreadItem {
    let row_id = id_of(&mut row);
    let name = take_str(&mut row, "name").unwrap_or_default();
    let input = row.shift_remove("args").unwrap_or(Value::Null);
    let call_id = take_str(&mut row, "callId");
    let id = call_id.as_deref().map_or(row_id, call_item_id);
    let result = blob_text(&mut row, "result");
    let is_error = take_bool(&mut row, "isError");
    let completed_count = take_int(&mut row, "completedCount").and_then(|n| u32::try_from(n).ok());
    let run = ToolRun {
        call_id,
        result: result.clone(),
        raw_result: blob_text(&mut row, "rawResult"),
        is_error,
        started_at: take_int(&mut row, "startedAt"),
        completed_at: take_int(&mut row, "completedAt"),
        ui_diff: blob_text(&mut row, "uiDiff"),
        tool_meta: take_as::<ToolMeta>(&mut row, "toolMeta"),
        count: take_int(&mut row, "count").and_then(|n| u32::try_from(n).ok()),
        completed_count,
        aggregate: None,
    };
    row.shift_remove("expanded");
    let mut meta = meta_of(&mut row, ctx);
    meta.status = if is_error == Some(true) {
        Some(ItemStatus::Failed)
    } else if completed_count.unwrap_or(0) > 0 {
        Some(ItemStatus::Completed)
    } else {
        None
    };
    ThreadItem::ToolCall {
        id: item_id(&id),
        name,
        input,
        output: result.map(|text| match text {
            MaybeBlob::Inline(text) => MaybeBlob::Inline(Value::String(text)),
            MaybeBlob::Blob(blob) => MaybeBlob::Blob(blob),
        }),
        run: Box::new(run),
        meta: finish(meta, row),
    }
}

fn turn_end_status(status: &str) -> Option<TurnEndStatus> {
    match status {
        "done" => Some(TurnEndStatus::Done),
        "failed" => Some(TurnEndStatus::Failed),
        "cancelled" => Some(TurnEndStatus::Cancelled),
        _ => None,
    }
}

/// `None` for a turn end the typed variant cannot state exactly (another status, a fractional
/// elapsed time): the caller keeps the row whole as a status row.
fn turn_end_item(row: &Row, ctx: &Ctx<'_>) -> Option<ThreadItem> {
    let status = turn_end_status(text_field_of(row, "status"))?;
    let elapsed = row.get("elapsedMs").and_then(Value::as_f64).filter(|f| f.is_finite() && f.fract() == 0.0 && *f >= 0.0)?;
    let mut row = row.clone();
    let id = id_of(&mut row);
    row.shift_remove("status");
    row.shift_remove("elapsedMs");
    let verb = take_str(&mut row, "verb");
    let checkpoint_id = take_str(&mut row, "checkpointId");
    let final_assistant_id = take_str(&mut row, "finalAssistantId").map(|id| item_id(&id));
    let detail = take_str(&mut row, "detail");
    let error_details = take_str(&mut row, "errorDetails");
    let error_kind = take_as::<serde_json::Map<String, Value>>(&mut row, "errorKind");
    let quota = take_as::<serde_json::Map<String, Value>>(&mut row, "quota");
    let meta = meta_of(&mut row, ctx);
    Some(ThreadItem::TurnEnd {
        id: item_id(&id),
        status,
        elapsed_ms: elapsed as u64,
        verb,
        checkpoint_id,
        final_assistant_id,
        detail,
        error_details,
        error_kind,
        quota,
        meta: finish(meta, row),
    })
}

fn text_field_of<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Every other row (`statusdone`, `notice`, an unknown display kind): the row's own kind with
/// its label, detail, route and time typed and the rest in `ext`.
fn status_item(mut row: Row, ctx: &Ctx<'_>) -> ThreadItem {
    let id = id_of(&mut row);
    let kind = take_str(&mut row, "kind").unwrap_or_default();
    let label = take_str(&mut row, "label");
    let detail = take_str(&mut row, "detail");
    let mut meta = meta_of(&mut row, ctx);
    if kind == "statusdone" && text_field_of(&row, "status") == "compacted" {
        row.shift_remove("status");
        meta.label = label;
        meta.detail = detail;
        return ThreadItem::ContextCompaction {
            id: item_id(&id),
            summary: None,
            status: Some(mixdog_protocol::CompactionStatus::Compacted),
            meta: finish(meta, row),
        };
    }
    meta.label = label;
    meta.detail = detail;
    ThreadItem::StatusRow { id: item_id(&id), kind, meta: finish(meta, row) }
}

/// The item of one row.
pub(super) fn item_of(row: Row, ctx: &Ctx<'_>) -> ThreadItem {
    match text_field_of(&row, "kind") {
        "user" => user_item(row, ctx),
        "notice" if ctx.source.is_some() && ctx.message.is_some() => user_item(row, ctx),
        "assistant" => assistant_item(row, ctx),
        "tool" => tool_item(row, ctx),
        "turndone" => {
            let end = turn_end_item(&row, ctx);
            end.unwrap_or_else(|| status_item(row, ctx))
        }
        _ => status_item(row, ctx),
    }
}

/// The update a tool result gives the item of its call.
fn result_update(fact: ResultFact, ctx: &Ctx<'_>) -> ThreadItem {
    let text = fact.text;
    let status = if fact.is_error == Some(true) { ItemStatus::Failed } else { ItemStatus::Completed };
    ThreadItem::ToolCall {
        id: item_id(&call_item_id(&fact.call_id)),
        name: String::new(),
        input: Value::Null,
        output: Some(MaybeBlob::Inline(Value::String(text.clone()))),
        run: Box::new(ToolRun {
            call_id: Some(fact.call_id),
            result: Some(MaybeBlob::Inline(text)),
            is_error: fact.is_error,
            ui_diff: fact.ui_diff.map(MaybeBlob::Inline),
            tool_meta: fact.tool_meta.and_then(|m| serde_json::from_value::<ToolMeta>(m).ok()),
            ..Default::default()
        }),
        meta: ItemMeta { turn_id: ctx.turn.map(TurnId::from), status: Some(status), ..Default::default() },
    }
}

/// `roomRowTargets`: a row's addressees as ids and names, from lists or the single strings
/// older rows were stored with.
fn room_targets(room: &Value) -> Vec<(String, String)> {
    let listed = |key: &str| -> Vec<Value> {
        match room.get(key) {
            Some(Value::Array(list)) => list.clone(),
            Some(other) => vec![other.clone()],
            None => vec![Value::Null],
        }
    };
    let names = listed("toName");
    listed("to")
        .iter()
        .enumerate()
        .filter_map(|(index, id)| {
            let id = id.as_str().filter(|s| !s.is_empty())?;
            let name = names.get(index).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(id);
            Some((id.to_owned(), name.to_owned()))
        })
        .collect()
}

/// The group-room line a stored room message shows (`roomRowItem`).
fn room_item(id: &str, message: &Value, ctx: &Ctx<'_>) -> Option<ThreadItem> {
    let stored = message.pointer("/meta/room")?;
    let mut room = stored.as_object()?.clone();
    let images = room.shift_remove("images");
    let targets = room_targets(stored);
    room.shift_remove("to");
    room.shift_remove("toName");
    if !targets.is_empty() {
        room.insert("to".into(), json!(targets.iter().map(|t| &t.0).collect::<Vec<_>>()));
        room.insert("toName".into(), json!(targets.iter().map(|t| &t.1).collect::<Vec<_>>()));
    }
    room.shift_remove("id");
    room.shift_remove("text");
    let transcript = metadata(message).fields;
    let at = transcript.get("at").and_then(Value::as_f64).filter(|f| f.is_finite());
    if let Some(at) = at {
        room.insert("at".into(), json!(at as i64));
    }
    let line = serde_json::from_value::<RoomLine>(Value::Object(room)).ok()?;
    let carries_text = matches!(line.kind, RoomRowKind::User | RoomRowKind::Speech);
    let text = if carries_text { message.get("content").and_then(Value::as_str).unwrap_or_default().to_owned() } else { String::new() };
    let files = carries_text.then(|| normalize_attachments(message.pointer("/meta/transcript/attachments")));
    let user = line.kind == RoomRowKind::User;
    let mut meta = ItemMeta { turn_id: ctx.turn.map(TurnId::from), at: at.map(|a| a as i64), ..Default::default() };
    meta.message_id = transcript.get("messageId").and_then(Value::as_str).map(str::to_owned);
    Some(ThreadItem::RoomRow {
        id: item_id(id),
        room: Box::new(line),
        text: MaybeBlob::Inline(text),
        attachments: files.and_then(|f| serde_json::from_value(Value::Array(f)).ok()).unwrap_or_default(),
        images: if user { images.and_then(|i| serde_json::from_value(i).ok()).unwrap_or_default() } else { Vec::new() },
        reactions: if user {
            serde_json::from_value(Value::Array(normalize_reactions(message.pointer("/meta/transcript/reactions"))))
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        meta,
    })
}

/// The items a stored message record shows, in order.
pub fn message_items(record: &ItemRecord, message: &Value) -> Vec<Shown> {
    let mut shown = Vec::new();
    for restored in super::transcript_rows::restore(record, message) {
        let turn = record.turn.as_ref().map(|t| t.as_str());
        match restored {
            Restored::Row { row, source } => {
                let ctx = Ctx {
                    turn,
                    message: Some(message),
                    counts_prompt: record.prompt.is_some() && text_field_of(&row, "kind") == "user",
                    source: source.as_deref(),
                };
                shown.push(Shown::Item(item_of(row, &ctx)));
            }
            Restored::Result(fact) => {
                let ctx = Ctx { turn, message: Some(message), counts_prompt: false, source: None };
                shown.push(Shown::Update(result_update(fact, &ctx)));
            }
            Restored::Room { id } => {
                let ctx = Ctx { turn, message: Some(message), counts_prompt: false, source: None };
                shown.extend(room_item(&id, message, &ctx).map(Shown::Item));
            }
        }
    }
    shown
}

/// The item of an imported display record: its body is the row Node showed, verbatim.
pub fn display_item(record: &ItemRecord, body: &Value) -> Option<ThreadItem> {
    let mut row = body.as_object()?.clone();
    if !row.get("id").is_some_and(Value::is_string) {
        row.insert("id".into(), json!(record.iid.as_str()));
    }
    let ctx = Ctx {
        turn: record.turn.as_ref().map(|t| t.as_str()),
        message: None,
        counts_prompt: record.prompt.is_some(),
        source: None,
    };
    Some(item_of(row, &ctx))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;

    use super::*;
    use crate::session::state::Change;
    use crate::session::state::Display;
    use crate::session::state::SessionState;

    fn commit(state: &mut SessionState, iid: &str, body: Value) -> Vec<Shown> {
        let mut record: ItemRecord = serde_json::from_value(json!({
            "iid": iid, "form": "message", "model": true, "visible": true,
            "refs": [], "body": { "inline": {} },
        }))
        .expect("record shape");
        record.body = Slot::Inline(body.clone());
        let shown = message_items(&record, &body);
        let change = Change::Record { record: Arc::new(Record::Item(record)), display: Display::Items(shown.clone()) };
        state.apply(&change, Some(1));
        shown
    }

    fn call(id: &str, name: &str, arguments: Value) -> Value {
        json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": id, "name": name, "arguments": arguments }] })
    }

    fn result(id: &str, text: &str) -> Value {
        json!({ "role": "tool", "content": text, "toolCallId": id })
    }

    /// Node's `pendingToolCalls` has no entry for a skipped wait call, so its result attaches
    /// to nothing; here the stateless projection still names the call, and the view ignores it.
    #[test]
    fn a_result_whose_call_shows_no_card_changes_nothing() {
        let mut state = SessionState::new(16);
        let waited = commit(&mut state, "a1", call("w1", "task", json!({ "action": "wait", "task_id": "j" })));
        assert!(waited.is_empty(), "a wait call shows no card");
        let shown = commit(&mut state, "t1", result("w1", "done"));
        assert!(matches!(shown.as_slice(), [Shown::Update(update)] if update.id().as_str() == "call:w1"));
        assert!(state.window.is_empty(), "the orphan result adds no row");

        commit(&mut state, "a2", call("s1", "shell", json!({ "command": "ls" })));
        commit(&mut state, "t2", result("s1", "a.txt"));
        let [row] = state.window.make_contiguous() else {
            panic!("one card for the shell call");
        };
        let ThreadItem::ToolCall { run, .. } = &*row.item else {
            panic!("a tool card");
        };
        assert!(run.result.is_some(), "a result with its card fills the run");
    }
}
