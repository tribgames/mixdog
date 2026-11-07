//! The rows Node's transcript restore shows for one stored message (`restoreTranscriptRange`,
//! `transcript-restore/restore.mjs`), as Node-shaped row objects, one record at a time.
//!
//! Node found a message's meaning by matching its text (internal wrappers, task envelopes, the
//! cancel line, the context-ack marker). The store holds that meaning as typed facts instead
//! (`ItemRecord.visible`, `ItemRecord.prompt`, `meta.taskCard`, `meta.turnEnd`, `meta.source`),
//! written at commit and by the migration, so nothing here reads text for a decision.
//!
//! Not done here, by design: merging runs of finished tool rows into aggregate cards and hiding
//! control tools (both the client's row fold, `packages/protocol-client/src/rows.ts`), and the
//! tool result of an earlier call (a [`Restored::Result`] the caller merges into that call's
//! item).

use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_store::routine_result::is_routine_result_message;
use mixdog_store::routine_result::routine_result_notice_text;
use mixdog_store::schema::record::ItemRecord;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::session::user_text::js_trim;
use crate::session::user_text::tool_result_text;

pub(super) type Row = Map<String, Value>;

/// What one message restores to.
#[derive(Debug, Clone, PartialEq)]
pub enum Restored {
    /// A new row. `source` is the message's `meta.source`.
    Row { row: Row, source: Option<String> },
    /// The result of the call `call_id` shown by an earlier row.
    Result(ResultFact),
    /// A group-room line.
    Room { id: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResultFact {
    pub call_id: String,
    pub text: String,
    /// The stored message's own `isError` flag, when it is a boolean.
    pub is_error: Option<bool>,
    /// `uiDiffFromMessage`: a present `uiDiff` is always a string.
    pub ui_diff: Option<String>,
    /// `toolMetaFromMessage`.
    pub tool_meta: Option<Value>,
}

/// JS truthiness.
pub(in crate::session) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// A string field, or `""`.
pub(super) fn text_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn non_empty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    Some(text_field(value, key)).filter(|s| !s.is_empty())
}

/// `Number(value)` of a field; `NaN` for an absent one.
fn number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

pub(super) use mixdog_js::json_number as num_value;

fn put_text(row: &mut Row, key: &str, value: &Value) {
    if let Some(text) = value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
        row.insert(key.to_owned(), json!(text));
    }
}

/// `transcriptRouteMetadataFields`.
fn route_fields(value: &Value) -> Row {
    let mut out = Row::new();
    if value.is_object() {
        for key in ["modelId", "model", "provider", "agent"] {
            put_text(&mut out, key, value);
        }
    }
    out
}

fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn clip(value: &Value, fallback: &str, limit: usize) -> String {
    let text = if truthy(value) {
        match value {
            Value::String(s) => s.clone(),
            other => mixdog_js::value_to_string(other),
        }
    } else {
        fallback.to_owned()
    };
    slice_utf16(&text, limit)
}

/// `normalizeMessageAttachments`.
pub fn normalize_attachments(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(list)) = value else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in list {
        let id = text_field(raw, "id");
        if !is_hex64(id) || seen.contains(id) || out.len() >= 64 {
            continue;
        }
        seen.insert(id.to_owned());
        let kind = match text_field(raw, "kind") {
            k @ ("image" | "file" | "text") => k,
            _ => "file",
        };
        let size = number(raw.get("size"));
        let mut entry = json!({
            "id": id,
            "attachmentRef": id,
            "kind": kind,
            "name": clip(raw.get("name").unwrap_or(&Value::Null), "attachment", 200),
            "mimeType": clip(raw.get("mimeType").unwrap_or(&Value::Null), "application/octet-stream", 100),
            "size": if size.is_finite() && size >= 0.0 { num_value(size) } else { json!(0) },
        });
        let original = raw.get("original").unwrap_or(&Value::Null);
        if is_hex64(text_field(original, "attachmentRef")) {
            entry["original"] = json!({
                "attachmentRef": text_field(original, "attachmentRef"),
                "mimeType": clip(original.get("mimeType").unwrap_or(&Value::Null), "", 100),
            });
        }
        out.push(entry);
    }
    out
}

/// `normalizeMessageReactions`.
pub(in crate::session) fn normalize_reactions(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(list)) = value else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::new();
    for raw in list {
        let agent = text_field(raw, "agentId");
        let emoji = text_field(raw, "emoji");
        let agent_ok = (1..=80).contains(&agent.len())
            && agent.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !agent_ok || emoji.is_empty() || utf16_len(emoji) > 16 {
            continue;
        }
        if out.iter().any(|entry| entry["agentId"] == agent) {
            continue;
        }
        let mut entry = json!({ "agentId": agent, "emoji": emoji });
        if let Some(at) = raw.get("at").and_then(Value::as_f64).filter(|f| f.is_finite()) {
            entry["at"] = num_value(at);
        }
        out.push(entry);
    }
    out
}

/// `normalizeRoutineTrigger`.
pub fn normalize_routine_trigger(value: Option<&Value>) -> Option<Value> {
    let value = value.filter(|v| v.is_object())?;
    let name = slice_utf16(js_trim(text_field(value, "name")), 200);
    let kind = text_field(value, "kind");
    if name.is_empty() || !matches!(kind, "schedule" | "webhook") {
        return None;
    }
    let event = slice_utf16(js_trim(text_field(value, "event")), 200);
    let mut out = json!({ "kind": kind, "name": name });
    if !event.is_empty() {
        out["event"] = json!(event);
    }
    Some(out)
}

/// `restoredFailureFields`.
fn failure_fields(value: &Value) -> Row {
    let mut out = Row::new();
    if text_field(value, "status") != "failed" {
        return out;
    }
    out.extend(route_fields(value));
    put_text(&mut out, "detail", value);
    put_text(&mut out, "errorDetails", value);
    if let Some(kind) = value.get("errorKind").filter(|k| k.is_object())
        && kind.get("kind").is_some_and(Value::is_string)
    {
        out.insert("errorKind".into(), kind.clone());
    }
    if let Some(quota) = value.get("quota").filter(|q| q.is_object())
        && quota.get("provider").is_some_and(Value::is_string)
    {
        out.insert("quota".into(), quota.clone());
    }
    out
}

fn held_request(message: &Value) -> bool {
    text_field_at(message, "source") == "held-request"
        && truthy_opt(message.pointer("/meta/heldRequest/id"))
}

fn text_field_at<'a>(message: &'a Value, key: &str) -> &'a str {
    message.get("meta").map_or("", |meta| text_field(meta, key))
}

/// `isPostedMessage`: stamped so, or a message id the routine delivery minted.
fn is_posted(message: &Value, transcript: &Value) -> bool {
    if transcript.get("posted") == Some(&Value::Bool(true)) {
        return true;
    }
    if !text_field(transcript, "messageId").starts_with("routine_") {
        return false;
    }
    text_field(message, "role") != "user" || is_routine_result_message(message) || held_request(message)
}

/// `restoredTranscriptMetadata`: the row attributes of `meta.transcript`, and its completion.
pub struct Metadata {
    pub fields: Row,
    pub completion: Option<Row>,
}

pub fn metadata(message: &Value) -> Metadata {
    let Some(value) = message.pointer("/meta/transcript").filter(|v| v.is_object()) else {
        return Metadata { fields: Row::new(), completion: None };
    };
    let mut completion = None;
    if let Some(done) = value.get("completion").filter(|c| c.is_object()) {
        let status = text_field(done, "status");
        let elapsed = number(done.get("elapsedMs"));
        if !status.is_empty() && elapsed.is_finite() {
            let mut entry = Row::new();
            entry.insert("status".into(), json!(status));
            entry.insert("elapsedMs".into(), num_value(elapsed.max(0.0)));
            put_text(&mut entry, "verb", done);
            put_text(&mut entry, "checkpointId", done);
            entry.extend(failure_fields(done));
            let attempt = non_empty(done, "attemptId").or_else(|| non_empty(value, "attemptId"));
            if let Some(attempt) = attempt {
                entry.insert("attemptId".into(), json!(attempt));
            }
            let at = number(done.get("at"));
            if at.is_finite() {
                entry.insert("at".into(), num_value(at));
            }
            completion = Some(entry);
        }
    }
    let mut fields = Row::new();
    put_text(&mut fields, "messageId", value);
    let at = number(value.get("at"));
    if at.is_finite() {
        fields.insert("at".into(), num_value(at));
    }
    if is_posted(message, value) {
        fields.insert("posted".into(), json!(true));
    }
    fields.extend(route_fields(value));
    for key in ["sender", "device", "fromAgent", "checkpointId"] {
        put_text(&mut fields, key, value);
    }
    let attachments = normalize_attachments(value.get("attachments"));
    if !attachments.is_empty() {
        fields.insert("attachments".into(), Value::Array(attachments));
    }
    let reactions = normalize_reactions(value.get("reactions"));
    if !reactions.is_empty() {
        fields.insert("reactions".into(), Value::Array(reactions));
    }
    if let Some(trigger) = normalize_routine_trigger(value.get("routineTrigger")) {
        fields.insert("routineTrigger".into(), trigger);
    }
    if let Some(Value::Array(skills)) = value.get("appliedSkills")
        && !skills.is_empty()
    {
        let names: Vec<&Value> =
            skills.iter().filter(|s| s.as_str().is_some_and(|s| !s.is_empty())).collect();
        fields.insert("appliedSkills".into(), json!(names));
    }
    if let Some(done) = &completion {
        fields.insert("completion".into(), Value::Object(done.clone()));
    }
    Metadata { fields, completion }
}

/// The ids of one record's rows: the record's own id for the first, `<iid>:<n>` after it.
pub struct Ids<'a> {
    pub(super) iid: &'a str,
    part: usize,
}

impl<'a> Ids<'a> {
    pub fn new(iid: &'a str) -> Self {
        Self { iid, part: 0 }
    }

    /// A live record's later rows have ids of their own, opaque like the record's (Node's `nextId()` gives every card one): the
    /// record's 128-bit id plus the row's position. A stored record from another source (`hist_...`) keeps `<iid>:<n>`.
    pub fn next(&mut self) -> String {
        self.part += 1;
        if self.part == 1 {
            return self.iid.to_owned();
        }
        match self.iid.strip_prefix("itm_").filter(|hex| hex.len() == 32).and_then(|hex| u128::from_str_radix(hex, 16).ok()) {
            Some(bits) => format!("itm_{:032x}", bits.wrapping_add((self.part - 1) as u128)),
            None => format!("{}:{}", self.iid, self.part),
        }
    }
}

/// The id of the item a tool call shows: ties the call to its result's record.
pub(super) fn call_item_id(call_id: &str) -> String {
    format!("call:{call_id}")
}

fn turn_done(completion: &Row, metadata: &Row, id: String, final_assistant: Option<&str>) -> Row {
    let at = completion.get("at").and_then(Value::as_f64).or_else(|| metadata.get("at").and_then(Value::as_f64));
    let mut row = Row::new();
    row.insert("kind".into(), json!("turndone"));
    row.insert("id".into(), json!(id));
    row.extend(completion.clone());
    if completion.get("status").and_then(Value::as_str) == Some("done")
        && let Some(id) = final_assistant.filter(|id| !id.is_empty())
    {
        row.insert("finalAssistantId".into(), json!(id));
    }
    if let Some(at) = at.filter(|a| a.is_finite()) {
        row.insert("at".into(), num_value(at));
    }
    if let Some(message_id) = metadata.get("messageId") {
        row.insert("messageId".into(), message_id.clone());
    }
    row
}

fn content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => tool_result_text(other),
        None => String::new(),
    }
}

fn message_calls(message: &Value) -> &[Value] {
    for key in ["tool_calls", "toolCalls"] {
        if let Some(Value::Array(calls)) = message.get(key) {
            return calls;
        }
    }
    &[]
}

/// The `args` of a stored call: `function.arguments ?? arguments`, parsed when it is JSON text.
fn call_args(call: &Value) -> Option<Value> {
    let args = call
        .pointer("/function/arguments")
        .filter(|v| !v.is_null())
        .or_else(|| call.get("arguments"))?;
    match args {
        Value::String(text) => Some(serde_json::from_str(text).unwrap_or_else(|_| args.clone())),
        other => Some(other.clone()),
    }
}

use mixdog_protocol::tool_visibility::is_task_wait;

fn restored_tool_calls(message: &Value, meta: &Row, ids: &mut Ids<'_>, out: &mut Vec<Restored>) {
    let at = meta.get("at").and_then(Value::as_f64).filter(|a| a.is_finite());
    for call in message_calls(message) {
        let named = ["/function/name", "/name"]
            .iter()
            .filter_map(|p| call.pointer(p))
            .find(|v| truthy(v))
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => mixdog_js::value_to_string(other),
            })
            .unwrap_or_else(|| "tool".to_owned());
        let name = match js_trim(&named) {
            "" => "tool".to_owned(),
            trimmed => trimmed.to_owned(),
        };
        let args = call_args(call).filter(|a| a != &json!(""));
        if is_task_wait(&name, args.as_ref()) {
            continue;
        }
        let mut row = Row::new();
        row.insert("kind".into(), json!("tool"));
        row.insert("id".into(), json!(ids.next()));
        row.insert("name".into(), json!(name));
        if let Some(args) = args {
            row.insert("args".into(), args);
        }
        row.insert("expanded".into(), json!(false));
        row.insert("count".into(), json!(1));
        row.insert("completedCount".into(), json!(1));
        if let Some(at) = at {
            row.insert("at".into(), num_value(at));
            row.insert("startedAt".into(), num_value(at));
            row.insert("completedAt".into(), num_value(at));
        }
        if let Some(call_id) = call.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            row.insert("callId".into(), json!(call_id));
        }
        out.push(Restored::Row { row, source: None });
    }
}

/// `toolMetaFromMessage`.
fn tool_meta(message: &Value) -> Option<Value> {
    let meta = message
        .get("toolMeta")
        .filter(|m| truthy(m))
        .or_else(|| message.pointer("/content/toolMeta"))?;
    let code = meta.get("code").and_then(Value::as_str).filter(|c| !c.is_empty())?;
    let missing: Vec<&Value> = match meta.get("missing") {
        Some(Value::Array(list)) => list.iter().filter(|n| n.as_str().is_some_and(|n| !n.is_empty())).collect(),
        _ => Vec::new(),
    };
    let mut out = json!({ "code": code, "missing": missing });
    if let Some(owner) = meta.get("ownerSessionId").and_then(Value::as_str).filter(|id| owner_session_id(id)) {
        out["ownerSessionId"] = json!(owner);
    }
    Some(out)
}

/// `visualizeOwnerMetaSessionId`.
fn owner_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn result_fact(message: &Value) -> Option<ResultFact> {
    let call_id = match message.get("tool_call_id") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        _ => message.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_owned(),
    };
    if call_id.is_empty() {
        return None;
    }
    Some(ResultFact {
        call_id,
        text: content_text(message),
        is_error: message.get("isError").and_then(Value::as_bool),
        ui_diff: message
            .as_object()
            .and_then(|m| m.get("uiDiff"))
            .map(|d| d.as_str().unwrap_or_default().to_owned()),
        tool_meta: tool_meta(message),
    })
}

/// `restoredAssistantTranscriptItems` and the message's tool calls.
fn assistant_rows(message: &Value, ids: &mut Ids<'_>, out: &mut Vec<Restored>) {
    let Metadata { fields, completion } = metadata(message);
    let runs = imported_tool_runs(message);
    if let Some(runs) = runs {
        let mut meta = fields;
        meta.shift_remove("completion");
        let mut row = Row::new();
        row.insert("kind".into(), json!("assistant"));
        row.insert("id".into(), json!(ids.next()));
        row.insert("text".into(), json!(text_field(message, "content")));
        row.insert("importedToolRuns".into(), runs);
        row.extend(meta);
        out.push(Restored::Row { row, source: Some("import".into()) });
        return;
    }
    let text = content_text(message);
    let text = js_trim(&text);
    if !text.is_empty() {
        let mut meta = fields.clone();
        meta.shift_remove("completion");
        let id = ids.next();
        let mut row = Row::new();
        row.insert("kind".into(), json!("assistant"));
        row.insert("id".into(), json!(id));
        row.insert("text".into(), json!(text));
        row.extend(meta.clone());
        out.push(Restored::Row { row, source: None });
        // A failed end follows the message's tool calls (`restoredFailedTurnItems`).
        if let Some(done) = completion.filter(|c| c.get("status").and_then(Value::as_str) != Some("failed")) {
            let end = turn_done(&done, &meta, ids.next(), Some(&id));
            out.push(Restored::Row { row: end, source: None });
        }
    }
    restored_tool_calls(message, &fields, ids, out);
}

/// `importedToolRuns` without the line check, which the client keeps (`ImportedToolRun`): the
/// runs of an imported assistant message whose shape is a well-formed run list.
fn imported_tool_runs(message: &Value) -> Option<Value> {
    if text_field_at(message, "source") != "import" || !message.get("content").is_some_and(Value::is_string) {
        return None;
    }
    let runs = message.pointer("/meta/importedToolRuns")?.as_array()?;
    let mut kept = Vec::new();
    let mut cursor = 0u64;
    let length = utf16_len(text_field(message, "content")) as u64;
    for run in runs {
        let (Some(start), Some(end)) = (run.get("start").and_then(Value::as_u64), run.get("end").and_then(Value::as_u64))
        else {
            continue;
        };
        let tools = run.get("tools").and_then(Value::as_array);
        let well_formed = tools.is_some_and(|tools| {
            !tools.is_empty()
                && tools.iter().all(|t| {
                    t.get("name").is_some_and(Value::is_string)
                        && t.get("count").and_then(Value::as_u64).is_some_and(|c| c > 0)
                })
        });
        if start >= cursor && end > start && end <= length && well_formed {
            cursor = end;
            kept.push(run.clone());
        }
    }
    (!kept.is_empty()).then_some(Value::Array(kept))
}

/// `restoredFailedTurnItems`: the ends recorded on a message that holds no reply text.
fn failed_turn_rows(message: &Value, ids: &mut Ids<'_>, out: &mut Vec<Restored>) {
    let Metadata { fields, completion } = metadata(message);
    let mut meta = fields;
    meta.shift_remove("completion");
    if let Some(Value::Array(previous)) = message.pointer("/meta/transcript/previousCompletions") {
        for value in previous {
            let mut stored = Map::new();
            stored.insert("completion".into(), value.clone());
            if let Some(at) = value.get("at") {
                stored.insert("at".into(), at.clone());
            }
            let historical = metadata(&json!({ "meta": { "transcript": stored } }));
            if let Some(done) = historical.completion {
                let mut shown = historical.fields;
                shown.shift_remove("completion");
                let row = turn_done(&done, &shown, ids.next(), None);
                out.push(Restored::Row { row, source: None });
            }
        }
    }
    if let Some(done) = completion.filter(|c| c.get("status").and_then(Value::as_str) == Some("failed")) {
        out.push(Restored::Row { row: turn_done(&done, &meta, ids.next(), None), source: None });
    }
}

fn status_done(id: String, status: &str, label: &str) -> Row {
    let mut row = Row::new();
    row.insert("kind".into(), json!("statusdone"));
    row.insert("id".into(), json!(id));
    row.insert("status".into(), json!(status));
    row.insert("label".into(), json!(label));
    row
}

/// `modelSwitchItem`: the row of an in-place model switch (live and restored); none for a
/// boundary without a provider and model.
pub(super) fn model_switch_row(id: String, boundary: &Value) -> Option<Row> {
    if !(truthy_opt(boundary.get("provider")) && truthy_opt(boundary.get("modelId"))) {
        return None;
    }
    let mut row = status_done(id, "model-switched", "Model switched");
    copy_present(&mut row, boundary, &["provider", "modelId", "at"]);
    Some(row)
}

/// The id of a switch's row, from its anchor and time: the live row and the restored one name
/// the same item. A boundary with no time has none (restore numbers it with its record's rows).
pub(super) fn model_switch_id(anchor_iid: &str, boundary: &Value) -> Option<String> {
    let at = number(boundary.get("at"));
    at.is_finite().then(|| format!("{anchor_iid}:model:{}", num_value(at)))
}

fn copy_present(row: &mut Row, boundary: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = boundary.get(key) {
            row.insert((*key).to_owned(), value.clone());
        }
    }
}

/// The in-place switches a message records (`sessionInheritances`, `modelSwitches`,
/// `workflowSwitches`, `orchestrationModeSwitches`).
fn boundary_rows(message: &Value, ids: &mut Ids<'_>, out: &mut Vec<Restored>) {
    let list = |key: &str| -> Vec<Value> {
        message.pointer(&format!("/meta/{key}")).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    for boundary in list("sessionInheritances") {
        if !(truthy_opt(boundary.get("sessionId"))
            && truthy_opt(boundary.get("provider"))
            && truthy_opt(boundary.get("modelId")))
        {
            continue;
        }
        let mut row = status_done(ids.next(), "inherited", "Session inherited");
        row.insert("detail".into(), json!("Continuing with the previous context."));
        copy_present(&mut row, &boundary, &["provider", "modelId", "at"]);
        out.push(Restored::Row { row, source: None });
    }
    for boundary in list("modelSwitches") {
        let id = model_switch_id(ids.iid, &boundary).unwrap_or_else(|| ids.next());
        if let Some(row) = model_switch_row(id, &boundary) {
            out.push(Restored::Row { row, source: None });
        }
    }
    for boundary in list("workflowSwitches") {
        if !truthy_opt(boundary.get("to")) {
            continue;
        }
        let mut row = status_done(ids.next(), "workflow-switched", "Workflow switched");
        copy_present(&mut row, &boundary, &["from", "to"]);
        if boundary.get("unavailable") == Some(&Value::Bool(true)) {
            row.insert("unavailable".into(), json!(true));
        }
        copy_present(&mut row, &boundary, &["at"]);
        out.push(Restored::Row { row, source: None });
    }
    for boundary in list("orchestrationModeSwitches") {
        if !truthy_opt(boundary.get("to")) {
            continue;
        }
        let mut row = status_done(ids.next(), "orchestration-mode-switched", "Delegation mode switched");
        copy_present(&mut row, &boundary, &["from", "to", "at"]);
        out.push(Restored::Row { row, source: None });
    }
}

/// The row of a tool card the store recorded for a delivered notification
/// (`restoredNotificationToolItem`; the card is `meta.taskCard`).
fn task_card_row(card: &Value, message: &Value, ids: &mut Ids<'_>) -> Row {
    let meta = metadata(message).fields;
    let at = number(message.pointer("/meta/transcript/at"));
    let mut row = Row::new();
    row.insert("kind".into(), json!("tool"));
    row.insert("id".into(), json!(ids.next()));
    if let Some(message_id) = meta.get("messageId") {
        row.insert("messageId".into(), message_id.clone());
    }
    for key in ["name", "args", "result", "rawResult", "isError"] {
        if let Some(value) = card.get(key) {
            row.insert(key.to_owned(), value.clone());
        }
    }
    row.insert("expanded".into(), json!(false));
    row.insert("count".into(), json!(1));
    row.insert("completedCount".into(), json!(1));
    if at.is_finite() {
        row.insert("at".into(), num_value(at));
        row.insert("startedAt".into(), num_value(at));
        row.insert("completedAt".into(), num_value(at));
    }
    row
}

/// `userText.imageRefs(content)`: the stored original of each image the bubble draws, by the
/// `[Image: …]` line that draws it; every image keeps its slot, none when no image has one.
fn image_refs(content: &Value) -> Vec<Value> {
    let Value::Array(parts) = content else {
        return Vec::new();
    };
    let mut slots = Vec::new();
    let mut pending = String::new();
    for part in parts {
        let attachment = part.is_object() && is_hex64(text_field(part, "attachmentRef"));
        let media_reference = text_field(part, "type") == "text"
            && truthy_opt(part.get("attachmentReference"))
            && part.get("text").is_some_and(Value::is_string);
        if media_reference {
            continue;
        }
        if attachment && text_field(part, "type") == "text" && matches!(text_field(part, "textKind"), "paste" | "file") {
            pending.clear();
            continue;
        }
        if matches!(text_field(part, "type"), "image" | "input_image") {
            let line = if pending.is_empty() {
                let mime = non_empty(part, "mimeType").or_else(|| non_empty(part, "mediaType")).unwrap_or("image");
                format!("[Image: {mime}]")
            } else {
                pending.clone()
            };
            pending.clear();
            slots.push(if attachment {
                json!({ "line": line, "ref": text_field(part, "attachmentRef") })
            } else {
                json!({ "line": line })
            });
            continue;
        }
        let text = if attachment { String::new() } else { tool_result_text(&json!([part])) };
        pending = last_image_metadata_line(&text);
    }
    if slots.iter().any(|slot| slot.get("ref").is_some()) { slots } else { Vec::new() }
}

/// The last line of `text` when it ends in an image metadata line
/// (`[Image: …]` / `[Image source: …]`), else `""`.
fn last_image_metadata_line(text: &str) -> String {
    let last = js_trim(text).rsplit('\n').next().unwrap_or_default();
    let last = js_trim(last.strip_suffix('\r').unwrap_or(last));
    let is_line = (last.starts_with("[Image:") || last.starts_with("[Image source:"))
        && last.ends_with(']')
        && !last[..last.len() - 1].contains([']', '\r', '\n']);
    if is_line { last.to_owned() } else { String::new() }
}

/// A user-role message: `restoredUserTranscriptItems`.
fn user_rows(record: &ItemRecord, message: &Value, ids: &mut Ids<'_>, out: &mut Vec<Restored>) {
    let meta = message.get("meta");
    if matches!(meta, Some(Value::String(kind)) if kind == "skill" || kind == "hook") {
        return;
    }
    let source = text_field_at(message, "source");
    let fields = metadata(message).fields;
    let stamp = |row: &mut Row| {
        for key in ["messageId", "at", "posted"] {
            if let Some(value) = fields.get(key).filter(|v| truthy(v)) {
                row.insert(key.to_owned(), value.clone());
            }
        }
    };
    if is_routine_result_message(message) || held_request(message) {
        let held = held_request(message);
        let routine = message.pointer("/meta/routine");
        let routine_field = |name: &str| number(routine.and_then(|r| r.get(name))) > 0.0;
        let warn = if held {
            message.pointer("/meta/heldRequest/status").and_then(Value::as_str) == Some("pending")
        } else {
            routine_field("relayFailed")
                || (!routine_field("omitted")
                    && (routine.is_some_and(|r| text_field(r, "status") == "failed")))
        };
        let mut row = Row::new();
        row.insert("kind".into(), json!("notice"));
        row.insert("id".into(), json!(ids.next()));
        row.insert(
            "text".into(),
            json!(if held { held_request_text(message) } else { routine_result_notice_text(message) }),
        );
        row.insert("tone".into(), json!(if warn { "warn" } else { "info" }));
        if !held {
            row.extend(routine_notice_fields(message));
        }
        stamp(&mut row);
        out.push(Restored::Row { row, source: Some(source.to_owned()) });
        return;
    }
    if let Some(card) = meta.and_then(|m| m.get("taskCard")).filter(|c| c.is_object()) {
        let row = task_card_row(card, message, ids);
        out.push(Restored::Row { row, source: Some(source.to_owned()) });
        return;
    }
    if meta.and_then(|m| m.get("turnEnd")).is_some_and(Value::is_object) {
        let mut row = Row::new();
        row.insert("kind".into(), json!("turndone"));
        row.insert("id".into(), json!(ids.next()));
        row.insert("status".into(), json!("cancelled"));
        row.insert("elapsedMs".into(), json!(0));
        if let Some(message_id) = fields.get("messageId").filter(|v| truthy(v)) {
            row.insert("messageId".into(), message_id.clone());
        }
        out.push(Restored::Row { row, source: None });
        return;
    }
    let Some(text) = record.prompt_text() else {
        return;
    };
    let mut row = Row::new();
    row.insert("kind".into(), json!("user"));
    row.insert("id".into(), json!(ids.next()));
    row.insert("text".into(), json!(text));
    row.extend(fields);
    if source != "import" {
        let refs = image_refs(message.get("content").unwrap_or(&Value::Null));
        if !refs.is_empty() {
            row.insert("imageRefs".into(), Value::Array(refs));
        }
        if source == "steering" {
            row.insert("steered".into(), json!(true));
        }
    }
    out.push(Restored::Row { row, source: (!source.is_empty()).then(|| source.to_owned()) });
}

/// `normalizeHandoffFiles`.
fn normalize_handoff_files(files: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(list)) = files else { return Vec::new() };
    list.iter()
        .filter(|file| file.is_object() && !text_field(file, "path").is_empty())
        .take(8)
        .map(|file| {
            let or = |key: &str, fallback: &str| match file.get(key) {
                Some(v) if truthy(v) => mixdog_js::value_to_string(v),
                _ => fallback.to_owned(),
            };
            let size = number(file.get("size"));
            let id = text_field(file, "id");
            let mut out = Map::new();
            out.insert("name".into(), json!(slice_utf16(&or("name", "file"), 200)));
            out.insert("path".into(), json!(slice_utf16(text_field(file, "path"), 1024)));
            let kind = text_field(file, "kind");
            out.insert("kind".into(), json!(if matches!(kind, "image" | "file" | "text") { kind } else { "file" }));
            out.insert("mimeType".into(), json!(slice_utf16(&or("mimeType", "application/octet-stream"), 100)));
            out.insert("size".into(), num_value(if size >= 0.0 { size } else { 0.0 }));
            if id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
                out.insert("id".into(), json!(id));
            }
            Value::Object(out)
        })
        .collect()
}

/// The fields `routineResultNotice(message)` gives a notice besides `text` and `tone`: the
/// `routine` payload the app localizes the label from, and (a task report) the stored files
/// as `attachments`, which `SessionAttachments` finds them by.
fn routine_notice_fields(message: &Value) -> Row {
    let routine = message.pointer("/meta/routine").unwrap_or(&Value::Null);
    let field = |name: &str| routine.get(name).filter(|v| !v.is_null());
    let mut payload = Map::new();
    let mut row = Row::new();
    if number(routine.get("omitted")) > 0.0 {
        payload.insert("omitted".into(), routine["omitted"].clone());
    } else if number(routine.get("relayFailed")) > 0.0 {
        payload.insert("relayFailed".into(), routine["relayFailed"].clone());
    } else if text_field(routine, "kind") == "task" {
        payload.insert("kind".into(), json!("task"));
        for name in ["name", "status", "summary", "sessionId"] {
            if let Some(v) = routine.get(name) {
                payload.insert(name.into(), v.clone());
            }
        }
        if text_field(routine, "target") == "session" {
            payload.insert("target".into(), json!("session"));
        }
        for name in ["agentId", "sendId"] {
            if let Some(v) = field(name).filter(|v| truthy(v)) {
                payload.insert(name.into(), v.clone());
            }
        }
        if let Some(ids @ Value::Array(list)) = routine.get("sendIds")
            && list.len() > 1
        {
            payload.insert("sendIds".into(), ids.clone());
        }
        let files = normalize_handoff_files(routine.get("files"));
        if !files.is_empty() {
            payload.insert("files".into(), Value::Array(files));
        }
        if !text_field(routine, "line").is_empty() {
            payload.insert("line".into(), routine["line"].clone());
        }
        let attachments = normalize_attachments(message.pointer("/meta/transcript/attachments"));
        if !attachments.is_empty() {
            row.insert("attachments".into(), Value::Array(attachments));
        }
    } else {
        let failed = text_field(routine, "status") == "failed";
        let text_or_empty = |name: &str| match routine.get(name) {
            Some(v) if truthy(v) => mixdog_js::value_to_string(v),
            _ => String::new(),
        };
        if text_field(routine, "kind") == "webhook" {
            payload.insert("kind".into(), json!("webhook"));
        }
        payload.insert("name".into(), json!(text_or_empty("name")));
        payload.insert("status".into(), json!(if failed { "failed" } else { "completed" }));
        payload.insert("summary".into(), json!(text_or_empty("summary")));
        for name in ["runId", "runSessionId"] {
            if let Some(v) = field(name).filter(|v| truthy(v)) {
                payload.insert(name.into(), v.clone());
            }
        }
        if failed {
            if let Some(v) = field("reason").filter(|v| truthy(v)) {
                payload.insert("reason".into(), v.clone());
            }
            if routine.get("paused").is_some_and(truthy) {
                payload.insert("paused".into(), json!(true));
            }
        }
    }
    row.insert("routine".into(), Value::Object(payload));
    row
}

/// `heldRequestNotice(message).text`.
fn held_request_text(message: &Value) -> String {
    let held = message.pointer("/meta/heldRequest").unwrap_or(&Value::Null);
    let tool = non_empty(held, "tool").unwrap_or("tool");
    let target = non_empty(held, "target").map(|t| format!(" → {t}")).unwrap_or_default();
    let label = match text_field(held, "status") {
        "pending" => "Approval needed",
        "approved" => "Approved",
        "denied" => "Denied",
        "expired" => "Expired (denied)",
        _ => "Approval needed",
    };
    format!("⏸ {label} · {tool}{target}")
}

/// The rows of one stored message record, in order. `None` for a record that shows nothing.
pub fn restore(record: &ItemRecord, message: &Value) -> Vec<Restored> {
    let iid = record.iid.as_str();
    let mut ids = Ids::new(iid);
    let mut out = Vec::new();
    if text_field_at(message, "source") == "agent-room" && truthy_opt(message.pointer("/meta/room/kind")) {
        out.push(Restored::Room { id: iid.to_owned() });
        return out;
    }
    match text_field(message, "role") {
        "user" => user_rows(record, message, &mut ids, &mut out),
        "assistant" if !is_context_ack(message) => assistant_rows(message, &mut ids, &mut out),
        "tool" => out.extend(result_fact(message).map(Restored::Result)),
        _ => {}
    }
    let event_start = out.len();
    failed_turn_rows(message, &mut ids, &mut out);
    boundary_rows(message, &mut ids, &mut out);
    let has_previous = message
        .pointer("/meta/transcript/previousCompletions")
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty());
    if has_previous {
        let at = |restored: &Restored| match restored {
            Restored::Row { row, .. } => row.get("at").and_then(Value::as_f64).filter(|a| a.is_finite()),
            _ => None,
        };
        let times: Vec<Option<f64>> = out[event_start..].iter().map(at).collect();
        if times.iter().all(Option::is_some) {
            let mut events: Vec<(f64, Restored)> =
                times.into_iter().flatten().zip(out.drain(event_start..)).collect();
            events.sort_by(|a, b| a.0.total_cmp(&b.0));
            out.extend(events.into_iter().map(|(_, restored)| restored));
        }
    }
    out
}

/// `isContextAckMessage` by its typed marker: the bare `.` acknowledgement of injected context.
fn is_context_ack(message: &Value) -> bool {
    text_field_at(message, "source") == "context-ack"
        && message.get("content").and_then(Value::as_str).is_some_and(|c| js_trim(c) == ".")
        && !message.get("toolCalls").is_some_and(Value::is_array)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A live record's later rows have opaque ids of their own (Node's `nextId()` per card), derived from the record's id and stable per
    /// record; a stored record from another source keeps `<iid>:<n>`.
    #[test]
    fn a_later_row_of_a_live_record_has_an_opaque_id_of_its_own() {
        let iid = "itm_00000000000000000000000000000fff";
        let mut ids = Ids::new(iid);
        assert_eq!(
            (ids.next(), ids.next(), ids.next()),
            (iid.to_owned(), "itm_00000000000000000000000000001000".to_owned(), "itm_00000000000000000000000000001001".to_owned())
        );
        let mut stored = Ids::new("hist_S_1_1");
        assert_eq!((stored.next(), stored.next()), ("hist_S_1_1".to_owned(), "hist_S_1_1:2".to_owned()));
    }
}
