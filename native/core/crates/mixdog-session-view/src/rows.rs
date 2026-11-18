//! Transcript rows: an item as the row the UI shows, and the merge of runs of finished tool rows into aggregate cards (the rows
//! of `packages/protocol-client/src/rows.ts`). A row has the exact shape Node's transcript has, field for field, so every
//! surface reads it unchanged.
//!
//! The fold keeps an item's individual rows before it merges consecutive cards:
//! - [`item_rows`] projects an item, using [`row_of`] for ordinary rows. `meta.ext` supplies remaining row attributes after the
//!   typed fields, except for payloads that need normalization.
//! - [`merge_tool_rows`] collapses a run of finished tool rows into one `__aggregate__` row and drops the tool rows the
//!   transcript hides.
//!
//! What the TypeScript keeps in two `WeakSet`s (the rows a live turn built, and the live rows whose card the turn's Stop ended)
//! is [`Row::live`] and [`Row::stopped`]: no row carries it.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::json_stringify;
use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_view_model::errors::err_text::PresentOptions;
use mixdog_view_model::errors::err_text::present_error_text;
use mixdog_view_model::results::status::aggregate_bucket_for_category;
use mixdog_view_model::results::status::aggregate_loading_targets_steps;
use mixdog_view_model::results::status::aggregate_raw_result_steps;
use mixdog_view_model::results::status::aggregate_result_patch_steps;
use mixdog_view_model::results::status::aggregate_tool_members_steps;
use mixdog_view_model::results::status::merge_aggregate_category_entries;
use mixdog_view_model::results::status::string_ui_diff_patch;
use mixdog_view_model::results::status::tool_call_outcome;
use mixdog_view_model::results::status::tool_result_display;
use mixdog_view_model::results::status::with_cancelled_result_marker;
use mixdog_view_model::results::summary::summarize_tool_result;
use mixdog_view_model::tool_contract::is_transcript_hidden_control_tool_name;
use mixdog_view_model::tool_contract::is_transcript_hidden_tool_item;
use mixdog_view_model::tool_status::tool_result_terminal_status;
use mixdog_view_model::tool_surface::AggregateEntry;
use mixdog_view_model::tool_surface::aggregate_done_categories_steps;
use mixdog_view_model::tool_surface::aggregate_tool_category_entries;
use mixdog_view_model::tool_surface::is_task_wait_tool_call;
use mixdog_view_model::tool_work_units::classify_tool_category;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// Rows folded per step of a long snapshot (`ITEMS_PER_STEP` of session-state.ts).
pub const ITEMS_PER_STEP: usize = 16;
/// Rows merged per step (`ROWS_PER_STEP` of rows.ts).
pub const ROWS_PER_STEP: usize = 16;

/// A JSON value that may be absent (`undefined`).
pub(crate) type Opt<'a> = Option<&'a Value>;

/// `value?.key` of an object; any other value has no members (`asObj`).
pub(crate) fn fld<'a>(value: Opt<'a>, key: &str) -> Opt<'a> {
    value?.as_object()?.get(key)
}

/// `typeof v === 'string' ? v : ''`.
pub(crate) fn text<'a>(value: Opt<'a>) -> &'a str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// JavaScript truthiness.
pub(crate) fn truthy(value: Opt) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b`.
pub(crate) fn coalesce<'a>(a: Opt<'a>, b: Opt<'a>) -> Opt<'a> {
    match a {
        None | Some(Value::Null) => b,
        found => found,
    }
}

/// `v != null`.
fn defined(value: Opt) -> bool {
    !matches!(value, None | Some(Value::Null))
}

pub(crate) fn is_obj(value: Opt) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `Number(v)`.
fn num(value: Opt) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `finite(v)`: a number.
fn is_number(value: Opt) -> bool {
    matches!(value, Some(Value::Number(_)))
}

/// `String(v)` of a value that may be absent.
pub(crate) fn js_string(value: Opt) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `a[k] = v` for a defined `v` (an absent member is `undefined`: `JSON.stringify` drops it).
pub(crate) fn put(out: &mut Map<String, Value>, key: &str, value: Opt) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value.clone());
    }
}

/// `present(key, v)`: a non-empty string.
fn put_text(out: &mut Map<String, Value>, key: &str, value: Opt) {
    if let Some(Value::String(own)) = value
        && !own.is_empty()
    {
        out.insert(key.to_owned(), Value::String(own.clone()));
    }
}

/// `atField`.
fn put_at(out: &mut Map<String, Value>, meta: Opt) {
    if let at @ Some(Value::Number(_)) = fld(meta, "at") {
        put(out, "at", at);
    }
}

/// `transcriptRouteMetadataFields`: the route a user or assistant row was produced on.
fn put_route(out: &mut Map<String, Value>, meta: Opt) {
    for key in ["modelId", "model", "provider", "agent"] {
        put_text(out, key, fld(meta, key));
    }
}

/// `String(v || fallback).slice(0, max)` (UTF-16 units).
fn text_or(value: Opt, fallback: &str, max: usize) -> String {
    let own = if truthy(value) { js_string(value) } else { fallback.to_owned() };
    slice_utf16(&own, max)
}

/// `Array.join(sep)`: null and undefined elements are empty.
fn js_join(items: &[Value], sep: &str) -> String {
    items.iter().map(|item| if item.is_null() { String::new() } else { value_to_string(item) }).collect::<Vec<_>>().join(sep)
}

fn is_hex64(candidate: &str) -> bool {
    candidate.len() == 64 && candidate.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// One transcript row and what the TypeScript kept about it outside the row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub value: Value,
    /// A tool row a live turn built (`ToolRun.live`): `merge_tool_rows` reads it.
    pub live: bool,
    /// A live tool row whose card the turn's Stop ended (`meta.status` `interrupted`): its aggregate is finalized as cancelled.
    pub stopped: bool,
}

impl Row {
    fn plain(value: Value) -> Self {
        Self { value, live: false, stopped: false }
    }

    pub fn as_ref(&self) -> RowRef<'_> {
        RowRef { value: &self.value, live: self.live, stopped: self.stopped }
    }
}

/// A row held elsewhere (the fold keeps the rows and the two flags apart).
#[derive(Debug, Clone, Copy)]
pub struct RowRef<'a> {
    pub value: &'a Value,
    pub live: bool,
    pub stopped: bool,
}

/// The `ext` member a history page's row carries the compaction dividers shown after it under (the core's `DIVIDERS_AFTER`,
/// reads.rs): the items of each divider, which a page cannot list as rows of its own (a page cursor names a stored row).
const DIVIDERS_AFTER: &str = "dividersAfter";

const FINISHED: [&str; 4] = ["completed", "failed", "declined", "interrupted"];

/// One `ThreadItem` as its transcript row; `None` for an item that has none (reasoning: today's thinking is the `thinking` state
/// field, never a row; control tools and task waits).
pub fn row_of(item: &Value) -> Option<Row> {
    let item_ref = Some(item);
    let meta = fld(item_ref, "meta");
    if text(fld(item_ref, "type")) == "roomRow" {
        return Some(Row::plain(room_row_item(item, meta)));
    }
    let mut row = row_body(item, meta)?;
    if let Value::Object(map) = &mut row.value {
        for (key, value) in ext_of(item, meta) {
            if key != DIVIDERS_AFTER && !(key == "toolMeta" && text(fld(item_ref, "type")) == "toolCall") {
                map.insert(key, value);
            }
        }
    }
    Some(row)
}

/// A history page's item as its rows: its own row, then the rows of the compaction dividers that follow it.
pub fn rows_of(item: &Value) -> Vec<Row> {
    let after = fld(fld(fld(Some(item), "meta"), "ext"), DIVIDERS_AFTER);
    let dividers = match after {
        Some(Value::Array(list)) => list.iter().filter_map(row_of).collect(),
        _ => Vec::new(),
    };
    item_rows(item).into_iter().chain(dividers).collect()
}

/// One completion of a woken batch: its text's byte range in the row's joined text, and what the batch recorded of its job.
struct BatchEntry {
    range: std::ops::Range<usize>,
    execution: Value,
}

/// The byte index of a UTF-16 code unit offset (what the core records and a JavaScript client slices by).
fn byte_at(content: &str, utf16: u64) -> Option<usize> {
    let mut units = 0u64;
    for (at, ch) in content.char_indices() {
        if units == utf16 {
            return Some(at);
        }
        units += ch.len_utf16() as u64;
    }
    (units == utf16).then_some(content.len())
}

fn escape_field(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `parseTaskNotification`'s outer fields (task id, status, surface) of one envelope, as the `execution` record a row reads.
fn envelope_execution(envelope: &str) -> Value {
    match mixdog_view_model::card_model::background_task::parse_background_task_result(envelope) {
        Some(parsed) => json!({ "id": parsed.task_id, "status": parsed.status, "surface": parsed.surface }),
        None => json!({}),
    }
}

/// The completions of a turn input row, located in its text. A row the core wrote for a batch carries them as data
/// (`details.completions`, UTF-16 offsets into the text): nothing is cut by its content. A row stored before that data existed has
/// only `details.consumedExecutionIds`, one id per queued entry in order, and an entry's text is its `<task-notification>` envelope
/// whose first field is its own `<task-id>`: entry k starts at the first line after entry k-1's start that opens an envelope naming
/// id k, and the last entry ends with the text. The envelope writers do not escape a result, so a result may quote envelopes; the
/// only cut that can then be wrong is a result quoting the envelope of the very next completion (same task id) before that
/// completion's own envelope. A row whose ids cannot all be found (an entry that named none, or an execution id other than its
/// envelope's task id, as `restart:` ids are) is not split: it stays the one card it always was. Twin of `batchEntries` (rows.ts).
fn batch_entries(content: &str, details: Opt) -> Vec<BatchEntry> {
    if let Some(Value::Array(recorded)) = fld(details, "completions").filter(|list| list.as_array().is_some_and(|list| !list.is_empty())) {
        let mut entries = Vec::new();
        for one in recorded {
            let one = Some(one);
            let (Some(start), Some(end)) = (fld(one, "start").and_then(Value::as_u64), fld(one, "end").and_then(Value::as_u64)) else { return Vec::new() };
            let (Some(start), Some(end)) = (byte_at(content, start), byte_at(content, end)) else { return Vec::new() };
            let mut execution = Map::new();
            for (key, from) in [("id", "executionId"), ("surface", "surface"), ("status", "status")] {
                put_text(&mut execution, key, fld(one, from));
            }
            entries.push(BatchEntry { range: start..end, execution: Value::Object(execution) });
        }
        return entries;
    }
    let ids: Vec<&str> = match fld(details, "consumedExecutionIds") {
        Some(Value::Array(list)) => list.iter().map(|id| id.as_str().unwrap_or("")).collect(),
        _ => Vec::new(),
    };
    if ids.len() < 2 || ids.iter().any(|id| id.is_empty()) {
        return Vec::new();
    }
    let mut starts: Vec<usize> = Vec::new();
    let mut from = 0usize;
    for (at, id) in ids.iter().enumerate() {
        let opening = format!("<task-notification>\n<task-id>{}</task-id>\n", escape_field(id));
        let found = if at == 0 {
            content.starts_with(&opening).then_some(0)
        } else {
            content.get(from..).and_then(|rest| rest.find(&format!("\n{opening}"))).map(|found| from + found + 1)
        };
        let Some(found) = found else { return Vec::new() };
        starts.push(found);
        from = found + 1;
    }
    (0..starts.len())
        .map(|at| {
            let end = starts.get(at + 1).map_or(content.len(), |next| next - 1);
            BatchEntry { range: starts[at]..end, execution: envelope_execution(&content[starts[at]..end]) }
        })
        .collect()
}

/// The canonical marker written by the importers. The Rust importer clips names by UTF-16, the older importer by code point.
fn imported_tool_line(tools: &[(&str, u64)], code_points: bool) -> String {
    let suffix = |remaining| if remaining > 0 { format!(", +{remaining} more") } else { String::new() };
    let mut line = "[ran tools: ".to_owned();
    let mut shown = 0;
    for (name, count) in tools {
        let display = if code_points && name.chars().count() > 40 {
            format!("{}…", name.chars().take(39).collect::<String>())
        } else if !code_points && utf16_len(name) > 40 {
            format!("{}…", slice_utf16(name, 39))
        } else {
            (*name).to_owned()
        };
        let entry = format!("{}{display} ×{count}", if shown > 0 { ", " } else { "" });
        if shown > 0 && utf16_len(&line) + utf16_len(&entry) + suffix(tools.len() - shown - 1).len() + 1 > 400 {
            break;
        }
        line.push_str(&entry);
        shown += 1;
    }
    line.push_str(&suffix(tools.len() - shown));
    line.push(']');
    line
}

fn push_imported_row(rows: &mut Vec<Row>, mut row: Map<String, Value>, id: Opt) {
    // The core uses `:<n>` for other items attached to this same stored message.
    if rows.is_empty() {
        put(&mut row, "id", id);
    } else {
        row.insert("id".to_owned(), json!(format!("{}:import:{}", js_string(id), rows.len())));
    }
    rows.push(Row::plain(Value::Object(row)));
}

fn imported_assistant_rows(item: &Value, meta: Opt) -> Option<Vec<Row>> {
    let content = item.get("text")?.as_str()?;
    let runs = item.get("importedToolRuns")?.as_array().filter(|runs| !runs.is_empty())?;
    let assistant = row_of(item)?.value;
    let assistant = assistant.as_object()?;
    let id = assistant.get("id");
    let mut rows = Vec::new();
    let push_text = |rows: &mut Vec<Row>, raw: &str| {
        let prose = js_trim(raw);
        if !prose.is_empty() {
            let mut row = assistant.clone();
            row.insert("text".to_owned(), json!(prose));
            push_imported_row(rows, row, id);
        }
    };
    let mut cursor = 0;
    for run in runs {
        let (Some(start), Some(end)) = (run.get("start").and_then(Value::as_u64), run.get("end").and_then(Value::as_u64)) else { continue };
        let (Some(start), Some(end)) = (byte_at(content, start), byte_at(content, end)) else { continue };
        if start < cursor || end <= start {
            continue;
        }
        let Some(tools) = run.get("tools").and_then(Value::as_array).filter(|tools| !tools.is_empty()) else { continue };
        let Some(tools): Option<Vec<(&str, u64)>> = tools.iter().map(|tool| {
            Some((tool.get("name")?.as_str()?, tool.get("count")?.as_u64().filter(|count| *count > 0)?))
        }).collect() else { continue };
        let marker = &content[start..end];
        if marker != imported_tool_line(&tools, true) && marker != imported_tool_line(&tools, false) {
            continue;
        }
        push_text(&mut rows, &content[cursor..start]);
        for (name, count) in tools {
            if is_transcript_hidden_control_tool_name(name) {
                continue;
            }
            let mut row = Map::new();
            row.insert("kind".to_owned(), json!("tool"));
            row.insert("name".to_owned(), json!(name));
            row.insert("count".to_owned(), json!(count));
            row.insert("completedCount".to_owned(), json!(count));
            row.insert("imported".to_owned(), json!(true));
            row.insert("expanded".to_owned(), json!(false));
            if is_number(fld(meta, "at")) {
                for key in ["at", "startedAt", "completedAt"] {
                    put(&mut row, key, fld(meta, "at"));
                }
            }
            if assistant.get("archived") == Some(&Value::Bool(true)) {
                row.insert("archived".to_owned(), json!(true));
            }
            push_imported_row(&mut rows, row, id);
        }
        cursor = end;
    }
    push_text(&mut rows, &content[cursor..]);
    Some(rows)
}

/// A reply may expand into imported prose and tools, and a queued batch into one card per completion.
/// In either case the first visible row keeps the item id and subsequent ids are local to that item.
pub fn item_rows(item: &Value) -> Vec<Row> {
    let meta = fld(Some(item), "meta");
    let details = fld(Some(item), "details");
    if text(fld(Some(item), "type")) == "agentMessage"
        && let Some(imported) = imported_assistant_rows(item, meta)
    {
        return imported;
    }
    if text(fld(Some(item), "type")) == "userMessage" && text(coalesce(fld(meta, "source"), fld(details, "source"))) == "task-notification" {
        let content = user_row(item, meta).get("text").and_then(Value::as_str).unwrap_or("").to_owned();
        let entries = batch_entries(&content, details);
        if entries.len() > 1 {
            return entries
                .iter()
                .enumerate()
                .filter_map(|(at, entry)| {
                    let mut each = item.clone();
                    if at > 0 {
                        each["id"] = json!(format!("{}:{at}", text(fld(Some(item), "id"))));
                    }
                    each["content"] = json!([{ "type": "text", "text": &content[entry.range.clone()] }]);
                    each["meta"]["ext"]["execution"] = entry.execution.clone();
                    row_of(&each)
                })
                .collect();
        }
    }
    row_of(item).into_iter().collect()
}
fn row_body(item: &Value, meta: Opt) -> Option<Row> {
    let item_ref = Some(item);
    let id = fld(item_ref, "id");
    let failed = text(fld(meta, "status")) == "failed";
    let mut row = Map::new();
    match text(fld(item_ref, "type")) {
        "userMessage" => return user_message_row(item, meta).map(|map| Row::plain(Value::Object(map))),
        "agentMessage" => {
            row.insert("kind".to_owned(), json!("assistant"));
            put(&mut row, "id", id);
            row.insert("text".to_owned(), json!(text(fld(item_ref, "text"))));
            put_text(&mut row, "messageId", fld(meta, "messageId"));
            put_at(&mut row, meta);
            put_route(&mut row, meta);
        }
        "turnEnd" => return Some(Row::plain(turn_end_row(item, meta))),
        "mcpToolCall" => {
            let name = format!("mcp__{}__{}", text(fld(item_ref, "server")), text(fld(item_ref, "tool")));
            let output = output_text(coalesce(fld(item_ref, "result"), fld(item_ref, "error")));
            let args = fld(item_ref, "arguments").cloned();
            return tool_row(item, meta, &name, args, output, failed || fld(item_ref, "error").is_some());
        }
        "webSearch" => {
            let mut args = Map::new();
            put(&mut args, "query", fld(item_ref, "query"));
            return tool_row(item, meta, "web_search", Some(Value::Object(args)), None, failed);
        }
        // A stored card states its result once, on its run; a live one may carry `output`.
        "toolCall" => {
            let output = output_text(coalesce(fld(item_ref, "output"), fld(fld(item_ref, "run"), "result")));
            return tool_row(item, meta, text(fld(item_ref, "name")), fld(item_ref, "input").cloned(), output, failed);
        }
        "subAgentActivity" => {
            let mut args = Map::new();
            put(&mut args, "agent", fld(item_ref, "agent"));
            put(&mut args, "threadId", fld(item_ref, "threadId"));
            return tool_row(item, meta, "agent", Some(Value::Object(args)), None, failed);
        }
        "agentJob" => {
            let mut args = Map::new();
            put(&mut args, "tag", fld(item_ref, "tag"));
            put(&mut args, "task_id", fld(item_ref, "taskId"));
            return tool_row(item, meta, "agent", Some(Value::Object(args)), None, failed);
        }
        // The product's compaction divider (compaction-archive-capture.mjs): status `compacted`, label `Conversation compacted`.
        "contextCompaction" => {
            row.insert("kind".to_owned(), json!("statusdone"));
            put(&mut row, "id", id);
            row.insert("status".to_owned(), json!("compacted"));
            let label = text(fld(meta, "label"));
            row.insert("label".to_owned(), json!(if label.is_empty() { "Conversation compacted" } else { label }));
            put_text(&mut row, "detail", fld(meta, "detail"));
            put_at(&mut row, meta);
        }
        "statusRow" => {
            put(&mut row, "kind", fld(item_ref, "kind"));
            put(&mut row, "id", id);
            put_text(&mut row, "label", fld(meta, "label"));
            put_text(&mut row, "detail", fld(meta, "detail"));
            put_route(&mut row, meta);
            put_at(&mut row, meta);
        }
        // `reasoning` and every other type: no row.
        _ => return None,
    }
    Some(Row::plain(Value::Object(row)))
}

/// The `turndone` row of a turn end (turn.mjs `turnDoneItem`, restore.mjs `restoredTranscriptItems` for a stored completion): the
/// typed members are the row's own attributes, and what only the live end states (`outputTokens`, `thinkingElapsedMs`, `toolCount`,
/// `attemptId`, `completionVerb`) is `meta.ext`, applied last by `row_of`.
fn turn_end_row(item: &Value, meta: Opt) -> Value {
    let item_ref = Some(item);
    let mut row = Map::new();
    row.insert("kind".to_owned(), json!("turndone"));
    put(&mut row, "id", fld(item_ref, "id"));
    put_text(&mut row, "checkpointId", fld(item_ref, "checkpointId"));
    put(&mut row, "elapsedMs", fld(item_ref, "elapsedMs"));
    put(&mut row, "status", fld(item_ref, "status"));
    put_text(&mut row, "finalAssistantId", fld(item_ref, "finalAssistantId"));
    put_text(&mut row, "verb", fld(item_ref, "verb"));
    put_at(&mut row, meta);
    put_text(&mut row, "detail", fld(item_ref, "detail"));
    put_text(&mut row, "errorDetails", fld(item_ref, "errorDetails"));
    put_route(&mut row, meta);
    put_text(&mut row, "messageId", fld(meta, "messageId"));
    if is_obj(fld(item_ref, "quota")) {
        put(&mut row, "quota", fld(item_ref, "quota"));
    }
    if is_obj(fld(item_ref, "errorKind")) {
        put(&mut row, "errorKind", fld(item_ref, "errorKind"));
    }
    Value::Object(row)
}

// ───────────────────────────── tool rows ─────────────────────────────

/// A tool result or argument value as the text the product stores: a string as is, anything else as JSON.
fn output_text(value: Opt) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(own)) => Some(own.clone()),
        Some(other) => Some(json_stringify(other)),
    }
}

/// The error text a card shows for a failed call: the error presenter of the errors module.
fn present_error(value: &str, surface: &str) -> String {
    present_error_text(Some(&Value::String(value.to_owned())), &PresentOptions { surface, ..PresentOptions::default() })
}

fn put_tool_meta(row: &mut Map<String, Value>, meta: Opt) {
    let code = text(fld(meta, "code"));
    if code.is_empty() {
        return;
    }
    let missing: Vec<&str> = fld(meta, "missing")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| !name.is_empty())
        .collect();
    let mut normalized = json!({ "code": code, "missing": missing });
    let owner = text(fld(meta, "ownerSessionId"));
    if (1..=128).contains(&owner.len()) && owner.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-')) {
        normalized["ownerSessionId"] = json!(owner);
    }
    row.insert("toolMeta".to_owned(), normalized);
}

/// One tool call's row: restore.mjs `restoredToolCallItems` for the call, `attachRestoredToolResult` once it has finished.
fn tool_row(item: &Value, meta: Opt, name: &str, args: Option<Value>, output: Option<String>, failed: bool) -> Option<Row> {
    let item_ref = Some(item);
    if is_transcript_hidden_control_tool_name(name) || is_task_wait_tool_call(name, args.as_ref().unwrap_or(&Value::Null)) {
        return None;
    }
    let ext = fld(meta, "ext");
    let status = text(fld(meta, "status"));
    let finished = FINISHED.contains(&status);
    // A live turn's card starts when its call shows and completes when its result lands (turn-tool-cards.mjs `startedAt: Date.now()`,
    // aggregate-result.mjs `completedAt: Date.now()`), the times its run carries; a restored one reads its message's time for both.
    let run = fld(item_ref, "run");
    let live = fld(run, "live") == Some(&Value::Bool(true));
    let mut row = Map::new();
    row.insert("kind".to_owned(), json!("tool"));
    put(&mut row, "id", fld(item_ref, "id"));
    row.insert("name".to_owned(), json!(name));
    if let Some(args) = &args
        && args != &json!("")
    {
        row.insert("args".to_owned(), args.clone());
    }
    row.insert("expanded".to_owned(), json!(false));
    // A card the core extended with later responses (`agent_response`) states how many it covers on its run.
    let count = fld(run, "count").and_then(Value::as_u64).filter(|n| *n >= 1).unwrap_or(1);
    row.insert("count".to_owned(), json!(count));
    row.insert("completedCount".to_owned(), json!(if finished { count } else { 0 }));
    let at = fld(meta, "at");
    if is_number(at) {
        let started = if live && is_number(fld(run, "startedAt")) { fld(run, "startedAt") } else { at };
        put(&mut row, "at", at);
        put(&mut row, "startedAt", started);
        if finished {
            let completed = if live && is_number(fld(run, "completedAt")) { fld(run, "completedAt") } else { at };
            put(&mut row, "completedAt", completed);
        }
    }
    put_text(&mut row, "callId", coalesce(fld(run, "callId"), fld(ext, "callId")));
    put_text(&mut row, "messageId", fld(meta, "messageId"));
    // The core ends a live card as `interrupted` only with the abort's error result: a failed call whose card the Stop ended.
    let stopped = live && status == "interrupted";
    if !finished {
        return Some(Row { value: Value::Object(row), live, stopped });
    }
    let result = output.unwrap_or_default();
    row.insert("result".to_owned(), json!(result));
    // `attachRestoredToolResult` -> `assignUiDiffFromMessage`: the result message's diff is the card's.
    for (key, value) in string_ui_diff_patch(fld(run, "uiDiff")) {
        row.insert(key, value);
    }
    put_tool_meta(&mut row, coalesce(fld(run, "toolMeta"), fld(ext, "toolMeta")));
    if let raw @ Some(Value::String(_)) = fld(run, "rawResult") {
        put(&mut row, "rawResult", raw);
    }
    // A cancel/crash body is not a red failure (restore.mjs): it shows the Cancelled tone.
    let cancelled = tool_result_terminal_status(&result) == "cancelled";
    let (is_call_error, is_exit_error) = if cancelled {
        (false, false)
    } else {
        let errored = failed || stopped || fld(ext, "isError") == Some(&Value::Bool(true)) || fld(run, "isError") == Some(&Value::Bool(true));
        let outcome = tool_call_outcome(&json!({ "isError": errored, "toolName": name }), &result);
        (outcome.is_call_error, outcome.is_exit_error)
    };
    row.insert("isError".to_owned(), json!(is_call_error));
    row.insert("errorCount".to_owned(), json!(u8::from(is_call_error)));
    row.insert("callErrorCount".to_owned(), json!(u8::from(is_call_error)));
    row.insert("exitErrorCount".to_owned(), json!(u8::from(is_exit_error)));
    Some(Row { value: Value::Object(row), live, stopped })
}

// ───────────────────────────── aggregate cards ─────────────────────────────

/// A tool row that can join an aggregate: a finished per-call card (restore.mjs `mergeRestoredToolItems` merges restored cards,
/// which have all finished; a call still running stays its own card until its result arrives).
fn mergeable(row: &Value) -> bool {
    live_mergeable(row) && row.get("result").is_some()
}

/// A live tool row joins its bucket's aggregate whether or not its result has arrived (`syncAggregateHeader` counts the call at once).
fn live_mergeable(row: &Value) -> bool {
    let row = Some(row);
    text(fld(row, "kind")) == "tool" && fld(row, "aggregate") != Some(&Value::Bool(true)) && fld(row, "imported") != Some(&Value::Bool(true))
}

struct Member<'a> {
    row: RowRef<'a>,
    category: String,
}

struct Run<'a> {
    bucket: String,
    live: bool,
    members: Vec<Member<'a>>,
}

/// Ownership belongs to the call, not to an aggregate that can contain different owners.
fn restore_member_metadata(tool_members: &mut [Value], members: &[Member<'_>], yield_point: &mut impl FnMut()) {
    for (i, (tool, member)) in tool_members.iter_mut().zip(members).enumerate() {
        if i % ROWS_PER_STEP == ROWS_PER_STEP - 1 {
            yield_point();
        }
        if let Some(meta) = member.row.value.get("toolMeta") {
            tool["toolMeta"] = meta.clone();
        }
    }
}

/// `mergeToolRows`: collapses every run of two or more consecutive finished tool rows of one bucket into one `__aggregate__`
/// card, shaped exactly like the live turn's (restore.mjs `buildRestoredAggregateItem`), and drops the tool rows the transcript
/// hides. A non-tool row ends a run.
pub fn merge_tool_rows(rows: &[RowRef<'_>]) -> Vec<Value> {
    merge_tool_rows_steps(rows, || {})
}

/// `merge_tool_rows` in steps: `yield_point` is called every `ROWS_PER_STEP` rows so a long transcript merges in budgeted turns.
pub fn merge_tool_rows_steps(rows: &[RowRef<'_>], mut yield_point: impl FnMut()) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    // A live card's header is sealed (`finalizeToolHeaders`, header-sync.mjs:13-31) once the block it is in ends: the turn's next
    // non-tool row (`clearAggregateContinuation` at assistant text, a steer or a compact, turn.mjs:256,322; the turn's end,
    // `finalizeToolCards`, turn-tool-cards.mjs:291, which a Stop runs too). Until then it shows the active header form, finished or not.
    let mut live_cards: Vec<(usize, bool)> = Vec::new();
    let mut run: Option<Run<'_>> = None;
    for (seen, item) in rows.iter().enumerate() {
        if (seen + 1) % ROWS_PER_STEP == 0 {
            yield_point();
        }
        let value = item.value;
        if text(fld(Some(value), "kind")) == "tool" && is_transcript_hidden_tool_item(value) {
            continue;
        }
        let live = item.live;
        if !(if live { live_mergeable(value) } else { mergeable(value) }) {
            flush(run.take(), &mut merged, &mut live_cards, &mut yield_point);
            merged.push(value.clone());
            continue;
        }
        let category = classify_tool_category(text(fld(Some(value), "name")), fld(Some(value), "args").unwrap_or(&Value::Null));
        // Agent cards never merge on restore: the live rule scopes their grouping to one provider batch.
        let bucket = if category == "Agent" { String::new() } else { aggregate_bucket_for_category(&category, "") };
        if bucket.is_empty() {
            flush(run.take(), &mut merged, &mut live_cards, &mut yield_point);
            // A live standalone card (`standaloneCardSpec`) is sealed (`finalizeToolHeaders`) and shown (`materialize`) when its turn ends.
            let mut card = value.clone();
            if live && let Value::Object(map) = &mut card {
                map.insert("headerFinalized".to_owned(), json!(true));
                map.insert("deferredDisplayReady".to_owned(), json!(true));
            }
            merged.push(card);
            continue;
        }
        if let Some(open) = run.as_mut()
            && open.bucket == bucket
            && open.live == live
        {
            open.members.push(Member { row: *item, category });
            continue;
        }
        flush(run.take(), &mut merged, &mut live_cards, &mut yield_point);
        run = Some(Run { bucket, live, members: vec![Member { row: *item, category }] });
    }
    flush(run.take(), &mut merged, &mut live_cards, &mut yield_point);
    let last_other = merged.iter().rposition(|row| text(fld(Some(row), "kind")) != "tool");
    for (at, stopped) in live_cards {
        let sealed = stopped || last_other.is_some_and(|other| at < other);
        if let Some(Value::Object(map)) = merged.get_mut(at) {
            map.insert("headerFinalized".to_owned(), json!(sealed));
        }
    }
    merged
}

/// A run of any length aggregates in steps too: one step per `ROWS_PER_STEP` of its members.
fn flush(run: Option<Run<'_>>, merged: &mut Vec<Value>, live_cards: &mut Vec<(usize, bool)>, yield_point: &mut impl FnMut()) {
    let Some(Run { members, live, .. }) = run else { return };
    if live {
        live_cards.push((merged.len(), members.iter().any(|member| member.row.stopped)));
    }
    // A restore merges two or more finished cards (`mergeRestoredToolItems`); a live turn's tool cards put every call of a bucket on an aggregate, even one.
    if members.len() >= 2 || live {
        let mut card = aggregate_row_steps(&members, live, yield_point);
        if members.iter().all(|member| member.row.value.get("archived") == Some(&Value::Bool(true))) {
            card["archived"] = json!(true);
        }
        merged.push(card);
    } else {
        merged.extend(members.iter().map(|member| member.row.value.clone()));
    }
}

/// The call record the aggregate helpers read for one member; `resolved` holds what its result states (`None` while it has none).
fn call_record(member: &Member<'_>, live: bool, resolved: Option<Map<String, Value>>) -> Value {
    let item = Some(member.row.value);
    let mut call = Map::new();
    // A live card keys its calls by the provider's call id (`aggregateCallEntry`), a restored one by the restored item's id.
    put(&mut call, "callId", if live { fld(item, "callId") } else { fld(item, "id") });
    call.insert("name".to_owned(), json!(text(fld(item, "name"))));
    put(&mut call, "args", fld(item, "args"));
    call.insert("category".to_owned(), json!(member.category));
    if let Some(fields) = resolved {
        call.extend(fields);
        for (key, value) in string_ui_diff_patch(fld(item, "uiDiff")) {
            call.insert(key, value);
        }
        call.insert("resolved".to_owned(), json!(true));
        put(&mut call, "startedAt", fld(item, "startedAt"));
        put(&mut call, "completedAt", fld(item, "completedAt"));
        return Value::Object(call);
    }
    // `aggregateCallEntry`: a call whose result has not arrived.
    for key in ["isError", "isCallError", "isExitError"] {
        call.insert(key.to_owned(), json!(false));
    }
    for key in ["exitCode", "resultText", "rawResultText", "completedAt", "summary"] {
        call.insert(key.to_owned(), Value::Null);
    }
    call.insert("resolved".to_owned(), json!(false));
    put(&mut call, "startedAt", fld(item, "startedAt"));
    Value::Object(call)
}

/// The category entries as the object Node's `Object.fromEntries(map)` made of them.
fn entries_object(entries: &[AggregateEntry]) -> Value {
    Value::Object(entries.iter().map(|entry| (entry.key.clone(), entry.to_value())).collect())
}

/// The card of one run, every pass over its members stepped: the per-member work (outcome, summary, category entries) and then the
/// finalization (result patch and its members and detail line, last diff, loading targets, call ids, done categories, raw result).
/// `live`: the card of a live turn (turn-aggregate-cards.mjs): its calls are keyed by their provider call id, it carries no `at` or
/// `callIds`, and it is `deferredDisplayReady`; while a call has no result yet it holds only the header `syncAggregateHeader` keeps.
fn aggregate_row_steps(members: &[Member<'_>], live: bool, yield_point: &mut impl FnMut()) -> Value {
    let mut header: Vec<AggregateEntry> = Vec::new();
    let mut calls: Vec<Value> = Vec::new();
    for member in members {
        if calls.len() % ROWS_PER_STEP == ROWS_PER_STEP - 1 {
            yield_point();
        }
        let item = Some(member.row.value);
        let name = text(fld(item, "name"));
        let args = fld(item, "args").unwrap_or(&Value::Null);
        merge_aggregate_category_entries(&mut header, &aggregate_tool_category_entries(name, args, &member.category));
        if !member.row.value.as_object().is_some_and(|map| map.contains_key("result")) {
            calls.push(call_record(member, live, None));
            continue;
        }
        let result_text = js_string(coalesce(fld(item, "result"), Some(&json!(""))));
        let raw_result_text = js_string(coalesce(coalesce(fld(item, "rawResult"), fld(item, "result")), Some(&json!(""))));
        let is_error = fld(item, "isError") == Some(&Value::Bool(true));
        let mut fields = Map::new();
        if live {
            // The live card's result (`applyAggregateCallFields` of `toolResultDisplay`): the text a card shows (a command's body without its
            // exit header, a failure as its presented error) beside the raw body.
            let outcome = tool_result_display(&json!({ "isError": is_error }), &raw_result_text, name, &present_error);
            let outcome_error = fld(Some(&outcome), "isError") == Some(&Value::Bool(true));
            for key in ["isError", "isCallError", "isExitError", "exitCode"] {
                put(&mut fields, key, fld(Some(&outcome), key));
            }
            put(&mut fields, "resultText", fld(Some(&outcome), "text"));
            fields.insert("rawResultText".to_owned(), json!(raw_result_text));
            let summary = if outcome_error { None } else { summarize_tool_result(name, args, &raw_result_text, outcome_error) };
            fields.insert("summary".to_owned(), summary.map_or(Value::Null, Value::from));
        } else {
            let outcome = tool_call_outcome(&json!({ "isError": is_error, "toolName": name }), &result_text);
            fields.insert("isError".to_owned(), json!(outcome.is_call_error));
            fields.insert("isCallError".to_owned(), json!(outcome.is_call_error));
            fields.insert("isExitError".to_owned(), json!(outcome.is_exit_error));
            fields.insert("exitCode".to_owned(), outcome.exit_code.map_or(Value::Null, json_number));
            fields.insert("resultText".to_owned(), json!(result_text));
            fields.insert("rawResultText".to_owned(), json!(raw_result_text));
            let summary = if !outcome.is_call_error && !js_trim(&result_text).is_empty() { summarize_tool_result(name, args, &result_text, false) } else { None };
            fields.insert("summary".to_owned(), summary.map_or(Value::Null, Value::from));
        }
        calls.push(call_record(member, live, Some(fields)));
    }
    let loading_targets = aggregate_loading_targets_steps(&calls, &mut *yield_point);
    let first = Some(members[0].row.value);
    let resolved_count = calls.iter().filter(|call| fld(Some(*call), "resolved") == Some(&Value::Bool(true))).count();
    let mut args = Map::new();
    args.insert("categoryOrder".to_owned(), Value::Array(header.iter().map(|entry| Value::from(entry.key.clone())).collect()));
    if !loading_targets.is_empty() {
        args.insert("loadingTargets".to_owned(), Value::Array(loading_targets.into_iter().map(Value::from).collect()));
    }
    let mut card = Map::new();
    card.insert("kind".to_owned(), json!("tool"));
    put(&mut card, "id", fld(first, "id"));
    card.insert("name".to_owned(), json!("__aggregate__"));
    card.insert("args".to_owned(), Value::Object(args));
    if resolved_count < calls.len() {
        card.insert("count".to_owned(), json!(calls.len()));
        card.insert("completedCount".to_owned(), json!(resolved_count));
        card.insert("categories".to_owned(), entries_object(&header));
        let mut tool_members = aggregate_tool_members_steps(&calls, &mut *yield_point);
        restore_member_metadata(&mut tool_members, members, &mut *yield_point);
        card.insert("toolMembers".to_owned(), Value::Array(tool_members));
        card.insert("aggregate".to_owned(), json!(true));
        card.insert("result".to_owned(), Value::Null);
        card.insert("rawResult".to_owned(), Value::Null);
        card.insert("isError".to_owned(), json!(false));
        card.insert("expanded".to_owned(), json!(false));
        card.insert("headerFinalized".to_owned(), json!(false));
        if defined(fld(first, "startedAt")) {
            put(&mut card, "startedAt", fld(first, "startedAt"));
        }
        card.insert("deferredDisplayReady".to_owned(), json!(true));
        return Value::Object(card);
    }
    // Every pass over the members below steps with the same quantum: the helpers' stepped forms, and the two small ones here.
    let mut outcome_patch = aggregate_result_patch_steps(&calls, &calls, calls.len(), &mut *yield_point);
    if let Some(tool_members) = outcome_patch.get_mut("toolMembers").and_then(Value::as_array_mut) {
        restore_member_metadata(tool_members, members, &mut *yield_point);
    }
    let mut latest_ui_diff: Opt = None;
    for (from_end, member) in members.iter().rev().enumerate() {
        if (from_end + 1) % ROWS_PER_STEP == 0 {
            yield_point();
        }
        if member.row.value.as_object().is_some_and(|map| map.contains_key("uiDiff")) {
            latest_ui_diff = fld(Some(member.row.value), "uiDiff");
            break;
        }
    }
    let last = Some(members[members.len() - 1].row.value);
    let mut call_ids: Vec<Value> = Vec::new();
    for (index, member) in members.iter().enumerate() {
        if index % ROWS_PER_STEP == ROWS_PER_STEP - 1 {
            yield_point();
        }
        let call_id = fld(Some(member.row.value), "callId");
        if truthy(call_id) {
            call_ids.extend(call_id.cloned());
        }
    }
    let done_categories = aggregate_done_categories_steps(&calls, &mut *yield_point);
    let raw_result = aggregate_raw_result_steps(&calls, &mut *yield_point);
    // `finalizeAggregateCard(…, { cancelled })` (aggregate-result.mjs:80-91): a card the Stop ended keeps the cancelled marker.
    if live && members.iter().any(|member| member.row.stopped) {
        let detail = with_cancelled_result_marker(text(fld(Some(&outcome_patch), "result")), &outcome_patch);
        if let Value::Object(patch) = &mut outcome_patch {
            patch.insert("result".to_owned(), json!(detail));
            patch.insert("text".to_owned(), json!(detail));
        }
    }
    card.insert("aggregate".to_owned(), json!(true));
    if !live && !call_ids.is_empty() {
        card.insert("callIds".to_owned(), Value::Array(call_ids));
    }
    card.insert("categories".to_owned(), entries_object(&header));
    card.insert("doneCategories".to_owned(), entries_object(&done_categories));
    card.insert("completedCount".to_owned(), json!(calls.len()));
    if let Value::Object(patch) = outcome_patch {
        card.extend(patch);
    }
    card.insert("rawResult".to_owned(), if raw_result.is_empty() { Value::Null } else { json!(raw_result) });
    if let Some(diff) = latest_ui_diff {
        card.insert("uiDiff".to_owned(), diff.clone());
    }
    card.insert("expanded".to_owned(), json!(false));
    card.insert("headerFinalized".to_owned(), json!(true));
    if live {
        card.insert("deferredDisplayReady".to_owned(), json!(true));
    } else if defined(fld(first, "at")) {
        put(&mut card, "at", fld(first, "at"));
    }
    if defined(fld(first, "startedAt")) {
        put(&mut card, "startedAt", fld(first, "startedAt"));
    }
    if defined(fld(last, "completedAt")) {
        put(&mut card, "completedAt", fld(last, "completedAt"));
    }
    Value::Object(card)
}

// ───────────────────────────── user rows and attachments ─────────────────────────────

const ATTACHMENT_KINDS: [&str; 3] = ["image", "file", "text"];

fn bare(digest: Opt) -> String {
    let digest = text(digest);
    digest.strip_prefix("sha256:").unwrap_or(digest).to_owned()
}

/// `normalizeMessageAttachments` (transcript-metadata.mjs): well-formed, de-duplicated records, at most 64, each keyed by the
/// bare content hash and repeating it as `attachmentRef`.
fn attachment_records(value: Opt) -> Vec<Value> {
    let Some(Value::Array(entries)) = value else { return Vec::new() };
    let mut seen: Vec<&str> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for entry in entries {
        let raw = Some(entry);
        let id = text(fld(raw, "id"));
        if !is_hex64(id) || seen.contains(&id) || out.len() >= 64 {
            continue;
        }
        seen.push(id);
        let original = fld(raw, "original");
        let kind = text(fld(raw, "kind"));
        let size = num(fld(raw, "size"));
        let mut record = Map::new();
        record.insert("id".to_owned(), json!(id));
        record.insert("attachmentRef".to_owned(), json!(id));
        record.insert("kind".to_owned(), json!(if ATTACHMENT_KINDS.contains(&kind) { kind } else { "file" }));
        record.insert("name".to_owned(), json!(text_or(fld(raw, "name"), "attachment", 200)));
        record.insert("mimeType".to_owned(), json!(text_or(fld(raw, "mimeType"), "application/octet-stream", 100)));
        record.insert("size".to_owned(), if size.is_finite() && size >= 0.0 { json_number(size) } else { json!(0) });
        if is_hex64(text(fld(original, "attachmentRef"))) {
            record.insert(
                "original".to_owned(),
                json!({ "attachmentRef": text(fld(original, "attachmentRef")), "mimeType": slice_utf16(text(fld(original, "mimeType")), 100) }),
            );
        }
        out.push(Value::Object(record));
    }
    out
}

fn put_attachments(out: &mut Map<String, Value>, value: Opt) {
    let attachments = attachment_records(value);
    if !attachments.is_empty() {
        out.insert("attachments".to_owned(), Value::Array(attachments));
    }
}

fn is_agent_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `normalizeMessageReactions` (transcript-metadata.mjs).
fn put_reactions(out: &mut Map<String, Value>, value: Opt) {
    let Some(Value::Array(entries)) = value else { return };
    let mut reactions: Vec<Value> = Vec::new();
    for entry in entries {
        let raw = Some(entry);
        let agent_id = text(fld(raw, "agentId"));
        let emoji = text(fld(raw, "emoji"));
        if !is_agent_id(agent_id) || emoji.is_empty() || utf16_len(emoji) > 16 || reactions.iter().any(|r| text(fld(Some(r), "agentId")) == agent_id) {
            continue;
        }
        let mut reaction = Map::new();
        reaction.insert("agentId".to_owned(), json!(agent_id));
        reaction.insert("emoji".to_owned(), json!(emoji));
        if is_number(fld(raw, "at")) {
            put(&mut reaction, "at", fld(raw, "at"));
        }
        reactions.push(Value::Object(reaction));
    }
    if !reactions.is_empty() {
        out.insert("reactions".to_owned(), Value::Array(reactions));
    }
}

fn put_routine_trigger(out: &mut Map<String, Value>, value: Opt) {
    let name = js_trim(text(fld(value, "name")));
    let kind = text(fld(value, "kind"));
    if name.is_empty() || !matches!(kind, "schedule" | "webhook") {
        return;
    }
    let mut trigger = json!({ "kind": kind, "name": slice_utf16(name, 200) });
    let event = js_trim(text(fld(value, "event")));
    if !event.is_empty() {
        trigger["event"] = json!(slice_utf16(event, 200));
    }
    out.insert("routineTrigger".to_owned(), trigger);
}

/// The typed source of a user-role item that the product shows as something other than the user's prompt.
const NOTICE_SOURCES: [&str; 3] = ["schedule-result", "held-request", "task-notification"];
/// The ext keys the source branches consume to build the row themselves (the stored payloads, not row attributes).
const SOURCE_PAYLOAD_KEYS: [&str; 9] = ["routine", "heldRequest", "execution", "attachments", "messageId", "posted", "name", "args", "isError"];

/// `meta.ext` as row attributes: for a notice or card source the stored payloads it was built from are not row attributes.
fn ext_of(item: &Value, meta: Opt) -> Map<String, Value> {
    let mut ext = fld(meta, "ext").and_then(Value::as_object).cloned().unwrap_or_default();
    let item_type = text(fld(Some(item), "type"));
    let submission = text(ext.get("clientSubmissionId")).to_owned();
    if item_type == "turnEnd" && !submission.is_empty() {
        // Node's turn end names the prompt by the row id it shows, the submission id (`checkpointId`, turn.mjs `turnDoneItem`);
        // the core's own `checkpointId` is the user item's id, the submission riding in `ext`. A client names a prompt by what it
        // shows (rewind resolves the submission id), so the row shows Node's value.
        ext.shift_remove("clientSubmissionId");
        ext.insert("checkpointId".to_owned(), json!(submission));
        return ext;
    }
    if item_type == "userMessage" && NOTICE_SOURCES.contains(&text(coalesce(fld(meta, "source"), item.pointer("/details/source")))) {
        for key in SOURCE_PAYLOAD_KEYS {
            ext.shift_remove(key);
        }
    }
    ext
}

/// Posted into the thread outside any turn (restore.mjs `isPostedMessage`): stamped so, or a message id minted by the routine
/// delivery (`routine_<runId>`).
fn put_posted(out: &mut Map<String, Value>, posted: Opt, message_id: Opt) {
    if posted == Some(&Value::Bool(true)) || text(message_id).starts_with("routine_") {
        out.insert("posted".to_owned(), json!(true));
    }
}

/// `normalizeHandoffFiles` (handoff-artifacts.mjs).
fn handoff_files(value: Opt) -> Vec<Value> {
    let Some(Value::Array(files)) = value else { return Vec::new() };
    files
        .iter()
        .filter(|file| !text(fld(Some(*file), "path")).is_empty())
        .take(8)
        .map(|file| {
            let file = Some(file);
            let kind = text(fld(file, "kind"));
            let size = num(fld(file, "size"));
            let mut out = Map::new();
            out.insert("name".to_owned(), json!(text_or(fld(file, "name"), "file", 200)));
            out.insert("path".to_owned(), json!(slice_utf16(text(fld(file, "path")), 1024)));
            out.insert("kind".to_owned(), json!(if ATTACHMENT_KINDS.contains(&kind) { kind } else { "file" }));
            out.insert("mimeType".to_owned(), json!(text_or(fld(file, "mimeType"), "application/octet-stream", 100)));
            out.insert("size".to_owned(), if size >= 0.0 { json_number(size) } else { json!(0) });
            if is_hex64(text(fld(file, "id"))) {
                put(&mut out, "id", fld(file, "id"));
            }
            Value::Object(out)
        })
        .collect()
}

/// `routineResultNotice` (routine-result.mjs): the line, tone and `routine` payload of a stored routine result.
fn routine_notice(ext: Opt, attachments: Opt) -> Map<String, Value> {
    let routine = fld(ext, "routine");
    let mut out = Map::new();
    if num(fld(routine, "omitted")) > 0.0 {
        out.insert("text".to_owned(), json!(format!("⏱ Routine results omitted: {}", js_string(fld(routine, "omitted")))));
        out.insert("tone".to_owned(), json!("info"));
        out.insert("routine".to_owned(), json!({ "omitted": fld(routine, "omitted") }));
        return out;
    }
    if num(fld(routine, "relayFailed")) > 0.0 {
        out.insert("text".to_owned(), json!(format!("⚠ Task results not relayed: {} — they are shown above", js_string(fld(routine, "relayFailed")))));
        out.insert("tone".to_owned(), json!("warn"));
        out.insert("routine".to_owned(), json!({ "relayFailed": fld(routine, "relayFailed") }));
        return out;
    }
    if fld(routine, "kind") == Some(&json!("task")) {
        let session = fld(routine, "target") == Some(&json!("session"));
        let status = text(fld(routine, "status"));
        let what = match status {
            "started" => "started",
            "blocked" => "waiting for confirmation",
            other => other,
        };
        let summary = fld(routine, "summary");
        let tail = if truthy(summary) { format!(" — {}", text(summary)) } else { String::new() };
        out.insert(
            "text".to_owned(),
            json!(format!("🛠 {} {what} · {}{tail}", if session { "Session" } else { "Agent task" }, text(fld(routine, "name")))),
        );
        out.insert("tone".to_owned(), json!(if status == "failed" { "warn" } else { "info" }));
        let mut payload = Map::new();
        payload.insert("kind".to_owned(), json!("task"));
        put(&mut payload, "name", fld(routine, "name"));
        put(&mut payload, "status", fld(routine, "status"));
        put(&mut payload, "summary", summary);
        put(&mut payload, "sessionId", fld(routine, "sessionId"));
        if session {
            payload.insert("target".to_owned(), json!("session"));
        }
        put_text(&mut payload, "agentId", fld(routine, "agentId"));
        put_text(&mut payload, "sendId", fld(routine, "sendId"));
        if let Some(Value::Array(ids)) = fld(routine, "sendIds")
            && ids.len() > 1
        {
            put(&mut payload, "sendIds", fld(routine, "sendIds"));
        }
        let files = handoff_files(fld(routine, "files"));
        if !files.is_empty() {
            payload.insert("files".to_owned(), Value::Array(files));
        }
        put_text(&mut payload, "line", fld(routine, "line"));
        out.insert("routine".to_owned(), Value::Object(payload));
        let mut records = attachments.and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(Value::Array(legacy)) = fld(ext, "attachments") {
            records.extend(legacy.iter().cloned());
        }
        put_attachments(&mut out, Some(&Value::Array(records)));
        return out;
    }
    let webhook = fld(routine, "kind") == Some(&json!("webhook"));
    let failed = fld(routine, "status") == Some(&json!("failed"));
    let summary = if truthy(fld(routine, "summary")) { js_string(fld(routine, "summary")) } else { String::new() };
    let detail = match (failed, summary.is_empty()) {
        (true, true) => "Failed".to_owned(),
        (true, false) => format!("Failed: {summary}"),
        (false, _) => summary.clone(),
    };
    let name = if truthy(fld(routine, "name")) { js_string(fld(routine, "name")) } else { String::new() };
    let tail = if detail.is_empty() { String::new() } else { format!(" — {detail}") };
    out.insert("text".to_owned(), json!(format!("{} · {name}{tail}", if webhook { "🔗 Webhook" } else { "⏱ Schedule" })));
    out.insert("tone".to_owned(), json!(if failed { "warn" } else { "info" }));
    let mut payload = Map::new();
    if webhook {
        payload.insert("kind".to_owned(), json!("webhook"));
    }
    payload.insert("name".to_owned(), json!(name));
    payload.insert("status".to_owned(), json!(if failed { "failed" } else { "completed" }));
    payload.insert("summary".to_owned(), json!(summary));
    put_text(&mut payload, "runId", fld(routine, "runId"));
    put_text(&mut payload, "runSessionId", fld(routine, "runSessionId"));
    if failed {
        put_text(&mut payload, "reason", fld(routine, "reason"));
        if truthy(fld(routine, "paused")) {
            payload.insert("paused".to_owned(), json!(true));
        }
    }
    out.insert("routine".to_owned(), Value::Object(payload));
    out
}

/// `heldRequestNotice` (held-message.mjs).
fn held_notice(held: Opt) -> Map<String, Value> {
    let tool = text(fld(held, "tool"));
    let target = if truthy(fld(held, "target")) { format!(" → {}", text(fld(held, "target"))) } else { String::new() };
    let what = format!("{}{target}", if tool.is_empty() { "tool" } else { tool });
    let label = match text(fld(held, "status")) {
        "approved" => "Approved",
        "denied" => "Denied",
        "expired" => "Expired (denied)",
        _ => "Approval needed",
    };
    let mut out = Map::new();
    out.insert("text".to_owned(), json!(format!("⏸ {label} · {what}")));
    out.insert("tone".to_owned(), json!(if fld(held, "status") == Some(&json!("pending")) { "warn" } else { "info" }));
    put(&mut out, "heldRequest", held);
    out
}

/// A user-role item by its typed message source (`meta.source`; the core drops `skill` and `hook` rows and sends internal wrappers
/// and interrupted ends as typed records, so nothing here reads text). Some older items keep their payloads and stamps in `meta.ext`.
fn user_message_row(item: &Value, meta: Opt) -> Option<Map<String, Value>> {
    let item_ref = Some(item);
    let id = fld(item_ref, "id");
    let body = user_row(item, meta);
    let ext = fld(meta, "ext");
    // The row's facts the item states in `details` (UserRowDetails): its source and held request.
    let details = fld(item_ref, "details");
    let held = if is_obj(fld(ext, "heldRequest")) { fld(ext, "heldRequest") } else { fld(details, "heldRequest") };
    let mut stamp = Map::new();
    let message_id = coalesce(fld(meta, "messageId"), fld(ext, "messageId"));
    put_text(&mut stamp, "messageId", message_id);
    if let at @ Some(Value::Number(number)) = fld(meta, "at")
        && number.as_f64().is_some_and(|f| f != 0.0)
    {
        put(&mut stamp, "at", at);
    }
    put_posted(&mut stamp, coalesce(fld(meta, "posted"), fld(ext, "posted")), message_id);
    match text(coalesce(fld(meta, "source"), fld(details, "source"))) {
        "schedule-result" => {
            let mut row = Map::new();
            row.insert("kind".to_owned(), json!("notice"));
            put(&mut row, "id", id);
            row.extend(routine_notice(ext, body.get("attachments")));
            row.extend(stamp);
            Some(row)
        }
        // A held request without its id cannot be answered, so it has no row.
        "held-request" => {
            if !(is_obj(held) && truthy(fld(held, "id"))) {
                return None;
            }
            let mut row = Map::new();
            row.insert("kind".to_owned(), json!("notice"));
            put(&mut row, "id", id);
            row.extend(held_notice(held));
            row.extend(stamp);
            Some(row)
        }
        "steering" => {
            let mut row = body;
            row.insert("steered".to_owned(), json!(true));
            Some(row)
        }
        "task-notification" => {
            // `completionCardFromExecution` (agent-envelope.mjs), from the typed execution record.
            let exec = fld(ext, "execution");
            let surface = if text(fld(exec, "surface")).is_empty() { "task".to_owned() } else { js_to_lowercase(text(fld(exec, "surface"))) };
            let status = js_to_lowercase(text(fld(exec, "status")));
            let result = text(body.get("text")).to_owned();
            let mut args = Map::new();
            args.insert("type".to_owned(), json!("result"));
            if !status.is_empty() {
                args.insert("status".to_owned(), json!(status));
            }
            put(&mut args, "task_id", fld(exec, "id"));
            args.insert("surface".to_owned(), json!(surface));
            let failed_status = matches!(status.as_str(), "failed" | "error" | "timeout" | "cancelled" | "canceled" | "killed");
            let mut row = Map::new();
            row.insert("kind".to_owned(), json!("tool"));
            put(&mut row, "id", id);
            put_text(&mut row, "messageId", message_id);
            row.insert("name".to_owned(), json!(if ["agent", "shell", "web_search"].contains(&surface.as_str()) { surface.as_str() } else { "task" }));
            row.insert("args".to_owned(), Value::Object(args));
            row.insert("result".to_owned(), json!(result));
            row.insert("rawResult".to_owned(), json!(result));
            row.insert("isError".to_owned(), json!(failed_status || js_to_lowercase(&result).starts_with("error:")));
            row.insert("expanded".to_owned(), json!(false));
            row.insert("count".to_owned(), json!(1));
            row.insert("completedCount".to_owned(), json!(1));
            if is_number(fld(meta, "at")) {
                for key in ["at", "startedAt", "completedAt"] {
                    put(&mut row, key, fld(meta, "at"));
                }
            }
            Some(row)
        }
        // `import` renders verbatim, as a plain prompt
        _ => Some(body),
    }
}

/// A user message: its text parts form the prompt `text` (a pasted text is part of the prompt); an attachment part is a record of
/// `attachments` keyed by the blob's content hash.
fn user_row(item: &Value, meta: Opt) -> Map<String, Value> {
    let item_ref = Some(item);
    let parts: &[Value] = match fld(item_ref, "content") {
        Some(Value::Array(parts)) => parts,
        _ => &[],
    };
    let attachments: Vec<Value> = parts
        .iter()
        .filter(|part| text(fld(Some(*part), "type")) == "attachment")
        .map(|part| {
            let part = Some(part);
            let blob = fld(part, "blob");
            let media = text(fld(blob, "mediaType"));
            let mime_type = if media.is_empty() { "application/octet-stream" } else { media };
            let original = fld(part, "original");
            let filename = text(fld(part, "filename"));
            let fallback_name = if mime_type.starts_with("image/") { "image" } else { "file" };
            let mut record = Map::new();
            record.insert("id".to_owned(), json!(bare(fld(blob, "digest"))));
            // the stored value; the normalizer defaults an absent one to `file`
            record.insert("kind".to_owned(), fld(part, "kind").cloned().unwrap_or(Value::Null));
            record.insert("name".to_owned(), json!(if filename.is_empty() { fallback_name } else { filename }));
            record.insert("mimeType".to_owned(), json!(mime_type));
            put(&mut record, "size", fld(blob, "bytes"));
            if fld(original, "digest").is_some() {
                record.insert("original".to_owned(), json!({ "attachmentRef": bare(fld(original, "digest")), "mimeType": text(fld(original, "mediaType")) }));
            }
            Value::Object(record)
        })
        .collect();
    let mut row = Map::new();
    row.insert("kind".to_owned(), json!("user"));
    // Node's row id is the submission id (`pushUserOrSyntheticItem(text, id)`), which a client matches its pending bubble by
    // (conversation-prompt-items.ts `pendingPromptTranscriptItems`); the core carries it as `clientSubmissionId`.
    let submission = text(fld(item_ref, "clientSubmissionId"));
    if submission.is_empty() {
        put(&mut row, "id", fld(item_ref, "id"));
    } else {
        row.insert("id".to_owned(), json!(submission));
    }
    let body: String = parts.iter().filter(|part| matches!(text(fld(Some(*part), "type")), "text" | "pastedText")).map(|part| text(fld(Some(part), "text"))).collect();
    row.insert("text".to_owned(), json!(body));
    put_text(&mut row, "messageId", fld(meta, "messageId"));
    put_at(&mut row, meta);
    put_route(&mut row, meta);
    put_text(&mut row, "device", fld(item_ref, "device"));
    put_text(&mut row, "checkpointId", fld(item_ref, "checkpointId"));
    // `persistedUserTranscriptMetadata`: who sent a bot's message.
    let details = fld(item_ref, "details");
    put_text(&mut row, "sender", fld(details, "sender"));
    put_text(&mut row, "fromAgent", fld(details, "fromAgent"));
    put_routine_trigger(&mut row, fld(details, "routineTrigger"));
    put_reactions(&mut row, fld(details, "reactions"));
    // restore.mjs `restoredTranscriptMetadata`: the stored attachments (`meta.transcript.attachments`, the core's
    // `details.attachments`) the pasted-text and file chips read and open from the store.
    let mut attachments = attachments;
    if let Some(Value::Array(stored)) = fld(details, "attachments") {
        attachments.extend(stored.iter().cloned());
    }
    put_attachments(&mut row, Some(&Value::Array(attachments)));
    // restore.mjs: each `[Image: …]` line's stored original, which the transcript chip draws its picture from.
    if let Some(Value::Array(refs)) = fld(details, "imageRefs")
        && !refs.is_empty()
    {
        row.insert("imageRefs".to_owned(), Value::Array(refs.clone()));
    }
    if let Some(Value::Array(skills)) = fld(item_ref, "appliedSkills")
        && !skills.is_empty()
    {
        let applied: Vec<Value> = skills.iter().filter(|skill| matches!(skill, Value::String(name) if !name.is_empty())).cloned().collect();
        row.insert("appliedSkills".to_owned(), Value::Array(applied));
    }
    row
}

// ───────────────────────────── room rows ─────────────────────────────

/// `roomRowTargets` (agent-room.mjs): a row's addressees as `(id, name)`, from lists or the single strings older rows carry.
fn room_targets(row: Opt) -> Vec<(String, String)> {
    let listed = |key: &str| -> Vec<Value> {
        match fld(row, key) {
            Some(Value::Array(list)) => list.clone(),
            other => vec![other.cloned().unwrap_or(Value::Null)],
        }
    };
    let names = listed("toName");
    listed("to")
        .iter()
        .filter_map(|id| id.as_str().filter(|id| !id.is_empty()))
        .enumerate()
        .map(|(index, id)| {
            let name = names.get(index).and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or(id);
            (id.to_owned(), name.to_owned())
        })
        .collect()
}

/// `roomRowText` (agent-room.mjs): the plain-text line of a row.
fn room_row_text(room: Opt, body: &str) -> String {
    let names = match fld(room, "names") {
        Some(Value::Array(list)) => js_join(list, ", "),
        _ => String::new(),
    };
    let who = [names.as_str(), text(fld(room, "name")), text(fld(room, "speaker"))].into_iter().find(|name| !name.is_empty()).unwrap_or("agent");
    match text(fld(room, "kind")) {
        "user" | "speech" => body.to_owned(),
        "pass" if truthy(fld(room, "failed")) => format!("{who} · no reply"),
        "pass" => format!("{who} · pass"),
        "cap" if truthy(fld(room, "usage")) => "Paused: the usage limit was reached.".to_owned(),
        "cap" => "Stopped at the room limit. Continue to run another batch.".to_owned(),
        "stopped" => "Stopped.".to_owned(),
        _ => "Interrupted.".to_owned(),
    }
}

/// `roomRowItem` (agent-room.mjs): the user's bubble, or a notice row whose `room` payload the app renders as speech, pass or limit
/// line. The core's `roomRow` item carries the payload (`kind`, `name`, `to`, `usage`, ...) as `room`, a user row's files, image chips
/// and reactions as `attachments` / `images` / `reactions`, and the message id and time in `meta`; the payload's own `at` is the
/// line's time, which the row puts after the id as Node's does.
fn room_row_item(item: &Value, meta: Opt) -> Value {
    let item_ref = Some(item);
    let mut room = fld(item_ref, "room").and_then(Value::as_object).cloned().unwrap_or_default();
    room.shift_remove("at");
    let targets = room_targets(Some(&Value::Object(room.clone())));
    if !targets.is_empty() {
        room.insert("to".to_owned(), Value::Array(targets.iter().map(|(id, _)| json!(id)).collect()));
        room.insert("toName".to_owned(), Value::Array(targets.iter().map(|(_, name)| json!(name)).collect()));
    }
    let room_value = Value::Object(room);
    let room_ref = Some(&room_value);
    let message_id = text(fld(meta, "messageId"));
    let kind = text(fld(room_ref, "kind"));
    let user = kind == "user";
    let mut row = Map::new();
    row.insert("kind".to_owned(), json!(if user { "user" } else { "notice" }));
    if user && !message_id.is_empty() {
        row.insert("id".to_owned(), json!(message_id));
    } else {
        put(&mut row, "id", fld(item_ref, "id"));
    }
    row.insert("text".to_owned(), json!(room_row_text(room_ref, text(fld(item_ref, "text")))));
    if !user {
        row.insert("tone".to_owned(), json!("info"));
    }
    let mut room_out = room_value.as_object().cloned().unwrap_or_default();
    if !message_id.is_empty() {
        room_out.insert("id".to_owned(), json!(message_id));
    }
    put_at(&mut room_out, meta);
    row.insert("room".to_owned(), Value::Object(room_out));
    if !message_id.is_empty() {
        row.insert("messageId".to_owned(), json!(message_id));
    }
    put_at(&mut row, meta);
    if user || kind == "speech" {
        put_attachments(&mut row, fld(item_ref, "attachments"));
    }
    if user {
        if let Some(Value::Array(images)) = fld(item_ref, "images")
            && !images.is_empty()
        {
            put(&mut row, "images", fld(item_ref, "images"));
        }
        put_reactions(&mut row, fld(item_ref, "reactions"));
        if truthy(fld(room_ref, "fromSession")) {
            if truthy(fld(room_ref, "fromAgent")) {
                put(&mut row, "fromAgent", fld(room_ref, "fromAgent"));
            } else {
                row.insert("sender".to_owned(), json!("lead"));
            }
        }
    }
    Value::Object(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_prose_and_counted_tools_interleave_without_duplication_on_replay() {
        use crate::reducer::SessionReducer;
        use mixdog_app_protocol::JsonRpcNotification;
        use mixdog_app_server_client::ThreadReducer;

        let prefix = "😀 First.\n\n";
        let marker = "[ran tools: read ×2, grep ×1]";
        let between = "\n\n[ran tools: shell ×99]\n\n";
        let last_marker = "[ran tools: shell ×1]";
        let last_start = utf16_len(prefix) + utf16_len(marker) + utf16_len(between);
        let item = json!({
            "type": "agentMessage", "id": "imported", "text": format!("{prefix}{marker}{between}{last_marker}\n\nDone."),
            "importedToolRuns": [
                { "start": utf16_len(prefix), "end": utf16_len(prefix) + utf16_len(marker), "tools": [{ "name": "read", "count": 2 }, { "name": "grep", "count": 1 }] },
                { "start": utf16_len(prefix) + utf16_len(marker) + 2, "end": last_start - 2, "tools": [{ "name": "shell", "count": 1 }] },
                { "start": last_start, "end": last_start + utf16_len(last_marker), "tools": [{ "name": "shell", "count": 1 }] }
            ],
            "meta": { "at": 42, "messageId": "msg_imported", "provider": "p" }
        });
        let prose = |id: &str, text: &str| json!({ "kind": "assistant", "id": id, "text": text, "at": 42, "messageId": "msg_imported", "provider": "p" });
        let tool = |id: &str, name: &str, count: u64| json!({
            "kind": "tool", "id": id, "name": name, "count": count, "completedCount": count, "imported": true, "expanded": false,
            "at": 42, "startedAt": 42, "completedAt": 42
        });
        let mut expected = vec![
            prose("imported", "😀 First."),
            tool("imported:import:1", "read", 2),
            tool("imported:import:2", "grep", 1),
            prose("imported:import:3", "[ran tools: shell ×99]"),
            tool("imported:import:4", "shell", 1),
            prose("imported:import:5", "Done."),
        ];
        assert_eq!(rows_of(&item).into_iter().map(|row| row.value).collect::<Vec<_>>(), expected);
        let reducer = SessionReducer;
        let tail = json!({ "type": "agentMessage", "id": "imported:1", "text": "Later." });
        let fold = reducer.initial(&json!({ "thread": { "id": "t" }, "items": [item, tail], "state": {} }));
        let replay: JsonRpcNotification = serde_json::from_value(json!({ "method": "item/completed", "params": { "item": item } })).unwrap();
        let replayed = reducer.apply(&fold, &replay);
        expected.push(json!({ "kind": "assistant", "id": "imported:1", "text": "Later." }));
        assert_eq!(replayed["items"], json!(expected));
    }

    #[test]
    fn completed_tools_keep_validated_metadata_on_each_grouped_preview() {
        let call = |id: &str, tool_meta: Value| json!({
            "type": "toolCall", "id": id, "name": "visualize", "input": {}, "meta": { "status": "completed" },
            "run": { "result": "opened", "toolMeta": tool_meta }
        });
        let good = call("one", json!({ "code": "visualize_owner", "missing": ["display", "", 5], "ownerSessionId": "room:owner-1", "extra": "ignored" }));
        let bad = call("two", json!({ "code": "visualize_owner", "ownerSessionId": "../other/session" }));
        let expected = json!({ "code": "visualize_owner", "missing": ["display"], "ownerSessionId": "room:owner-1" });
        assert_eq!(row_of(&good).unwrap().value["toolMeta"], expected);
        let grouped = merged(&[good, bad]);
        assert_eq!(grouped[0]["toolMembers"][0]["toolMeta"], expected);
        assert_eq!(grouped[0]["toolMembers"][1]["toolMeta"], json!({ "code": "visualize_owner", "missing": [] }));
        assert!(row_of(&call("three", json!({ "ownerSessionId": "valid-shape" }))).unwrap().value.get("toolMeta").is_none());
    }

    #[test]
    fn routine_prompts_show_the_trigger_and_one_reaction_per_bot() {
        let row = row_of(&json!({
            "type": "userMessage", "id": "u", "content": [{ "type": "text", "text": "check" }],
            "details": {
                "source": "routine-trigger", "routineTrigger": { "kind": "webhook", "name": " Checks ", "event": " opened " },
                "reactions": [{ "agentId": "bot", "emoji": "👍", "at": 4 }, { "agentId": "bot", "emoji": "👋" }, { "agentId": "bad/bot", "emoji": "👍" }]
            }
        })).unwrap().value;
        assert_eq!(row["routineTrigger"], json!({ "kind": "webhook", "name": "Checks", "event": "opened" }));
        assert_eq!(row["reactions"], json!([{ "agentId": "bot", "emoji": "👍", "at": 4 }]));
    }

    #[test]
    fn posted_task_reports_restore_the_typed_stamp_and_downloadable_artifact() {
        let id = "a".repeat(64);
        let attachment = json!({ "id": id, "name": "report.txt", "kind": "file", "mimeType": "text/plain", "size": 5 });
        let mut file = attachment.clone();
        file["path"] = json!("/report.txt");
        let routine = json!({ "kind": "task", "name": "Build", "status": "completed", "files": [file] });
        let row = row_of(&json!({
            "type": "userMessage", "id": "notice", "content": [],
            "details": { "source": "schedule-result", "attachments": [attachment, attachment] },
            "meta": { "messageId": "msg_notice", "posted": true, "at": 7, "ext": { "routine": routine, "messageId": "old", "posted": false } }
        })).unwrap().value;
        let mut download = attachment;
        download["attachmentRef"] = json!(id);
        assert_eq!(row, json!({
            "kind": "notice", "id": "notice", "text": "🛠 Agent task completed · Build", "tone": "info",
            "messageId": "msg_notice", "posted": true, "at": 7, "routine": routine, "attachments": [download]
        }));
    }

    fn merged(items: &[Value]) -> Vec<Value> {
        let rows: Vec<Row> = items.iter().filter_map(row_of).collect();
        let refs: Vec<RowRef<'_>> = rows.iter().map(Row::as_ref).collect();
        merge_tool_rows(&refs)
    }

    fn call(id: &str, status: &str, output: Option<&str>) -> Value {
        let mut item = json!({ "type": "toolCall", "id": id, "name": "read", "input": { "path": id }, "meta": { "status": status, "at": 1 } });
        if let Some(output) = output {
            item["output"] = json!(output);
        }
        item
    }

    fn envelope(id: &str, status: &str, summary: &str, result: &str) -> String {
        let body = if result.is_empty() { String::new() } else { format!("<result>\n{result}\n</result>\n") };
        format!("<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n{body}</task-notification>")
    }

    fn batch_item(details: Value, text: &str) -> Value {
        json!({
            "type": "userMessage", "id": "u1", "content": [{ "type": "text", "text": text }],
            "details": details,
            "meta": { "at": 5, "source": "task-notification", "ext": { "execution": { "id": "t-ok", "surface": "agent", "status": "completed" } } }
        })
    }

    fn shown(rows: &[Row]) -> Vec<(String, String, String, String, bool, i64, usize)> {
        rows.iter()
            .map(|r| {
                let v = &r.value;
                (v["id"].as_str().unwrap().into(), v["name"].as_str().unwrap().into(), v["args"]["task_id"].as_str().unwrap().into(), v["args"]["status"].as_str().unwrap().into(), v["isError"] == true, v["count"].as_i64().unwrap(), v["result"].as_str().unwrap().len())
            })
            .collect()
    }

    /// A turn that took three completions (an agent with a result that quotes envelopes, an agent that failed, a shell task) shows
    /// three cards cut by the entries the core recorded, not by the text; the same row stored without the entries is located by its
    /// execution ids; a row whose ids cannot be found, and a single completion, stay one card.
    #[test]
    fn a_turn_that_took_three_completions_shows_three_cards() {
        let bad = envelope("t-bad", "failed", "Agent \"fix\" failed: boom", "");
        let shell = envelope("t-sh", "completed", "Shell task completed (exit 0): npm test", "");
        let ok = envelope("t-ok", "completed", "Agent \"rev\" completed", &format!("see 한글 😀\n{bad}\n{shell}"));
        let texts = [&ok, &bad, &shell];
        let joined = texts.iter().map(|t| t.as_str()).collect::<Vec<_>>().join("\n");
        let mut at = 0usize;
        let located: Vec<Value> = texts
            .iter()
            .zip([("t-ok", "agent", "completed"), ("t-bad", "agent", "failed"), ("t-sh", "shell", "completed")])
            .map(|(t, (id, surface, status))| {
                let start = at;
                at += t.encode_utf16().count() + 1;
                json!({ "executionId": id, "surface": surface, "status": status, "start": start, "end": at - 1 })
            })
            .collect();
        let ids = json!(["t-ok", "t-bad", "t-sh"]);
        let want = |first: &str| {
            let (a, b, c) = (first.len(), bad.len(), shell.len());
            vec![
                ("u1".to_owned(), "agent".to_owned(), "t-ok".to_owned(), "completed".to_owned(), false, 1, a),
                ("u1:1".to_owned(), "agent".to_owned(), "t-bad".to_owned(), "failed".to_owned(), true, 1, b),
                ("u1:2".to_owned(), "shell".to_owned(), "t-sh".to_owned(), "completed".to_owned(), false, 1, c),
            ]
        };
        assert_eq!(shown(&rows_of(&batch_item(json!({ "consumedExecutionIds": ids, "completions": located }), &joined))), want(&ok));
        // Stored before the entries existed: located by the ids (a result quoting an envelope of another task is not cut).
        let other = envelope("t-other", "completed", "Agent \"o\" completed", "quoted");
        let quoting = envelope("t-ok", "completed", "Agent \"rev\" completed", &format!("{other}\n{other}"));
        let old = [quoting.as_str(), bad.as_str(), shell.as_str()].join("\n");
        assert_eq!(shown(&rows_of(&batch_item(json!({ "consumedExecutionIds": ids }), &old))), want(&quoting));
        assert_eq!(rows_of(&batch_item(json!({ "consumedExecutionIds": ["t-ok", null, "t-sh"] }), &joined)).len(), 1);
        assert_eq!(rows_of(&batch_item(json!({ "consumedExecutionIds": ["t-ok", "restart:t-bad", "t-sh"] }), &joined)).len(), 1);
        assert_eq!(rows_of(&batch_item(json!({ "consumedExecutionIds": ["t-ok"] }), &ok)).len(), 1);
    }
    #[test]
    fn a_tool_call_still_running_is_its_own_card_and_reasoning_has_no_row() {
        let rows = merged(&[
            call("a", "completed", Some("one")),
            call("b", "completed", Some("two")),
            call("c", "inProgress", None),
            json!({ "type": "reasoning", "id": "r", "summary": ["x"], "content": [], "meta": {} }),
        ]);
        let named: Vec<(&str, &str)> = rows.iter().map(|r| (r["id"].as_str().unwrap(), r["name"].as_str().unwrap())).collect();
        assert_eq!(named, [("a", "__aggregate__"), ("c", "read")]);
        assert_eq!(rows[1]["completedCount"], 0);
        assert!(rows[1].get("result").is_none());
    }

    #[test]
    fn a_live_card_completes_at_its_results_time_and_a_restored_one_at_its_message_time() {
        let item = |run: Value| json!({ "type": "toolCall", "id": "a", "name": "read", "input": { "path": "a" }, "output": "one", "run": run, "meta": { "status": "completed", "at": 1000 } });
        let live = row_of(&item(json!({ "live": true, "completedAt": 1015 }))).unwrap();
        assert!(live.live && !live.stopped);
        assert_eq!((live.value["startedAt"].clone(), live.value["completedAt"].clone()), (json!(1000), json!(1015)));
        let restored = row_of(&item(json!({ "completedAt": 1015 }))).unwrap();
        assert!(!restored.live);
        assert_eq!((restored.value["startedAt"].clone(), restored.value["completedAt"].clone()), (json!(1000), json!(1000)));
    }

    #[test]
    fn a_stopped_live_card_is_flagged_and_its_aggregate_is_sealed() {
        let stopped = json!({
            "type": "toolCall", "id": "a", "name": "read", "input": { "path": "a" }, "output": "Error: aborted",
            "run": { "live": true, "callId": "c1" }, "meta": { "status": "interrupted", "at": 5 }
        });
        let row = row_of(&stopped).unwrap();
        assert!(row.live && row.stopped);
        let cards = merge_tool_rows(&[row.as_ref()]);
        assert_eq!(cards[0]["name"], "__aggregate__");
        assert_eq!(cards[0]["headerFinalized"], true);
        assert!(cards[0]["result"].is_string());
    }

    #[test]
    fn a_user_row_takes_its_submission_id_its_text_parts_and_its_attachments() {
        let digest = "a".repeat(64);
        let item = json!({
            "type": "userMessage", "id": "core-id", "clientSubmissionId": "sub-1",
            "content": [
                { "type": "text", "text": "look " },
                { "type": "pastedText", "text": "here" },
                { "type": "attachment", "kind": "image", "filename": "p.png", "blob": { "digest": format!("sha256:{digest}"), "mediaType": "image/png", "bytes": 12 } }
            ],
            "meta": { "at": 7, "model": "m", "ext": { "extra": 1 } }
        });
        let row = row_of(&item).unwrap().value;
        assert_eq!(row["id"], "sub-1");
        assert_eq!(row["text"], "look here");
        assert_eq!(row["model"], "m");
        assert_eq!(row["extra"], 1);
        assert_eq!(row["attachments"][0]["id"], digest);
        assert_eq!(row["attachments"][0]["attachmentRef"], digest);
        assert_eq!(row["attachments"][0]["size"], 12);
    }

    #[test]
    fn a_user_row_carries_the_stored_attachments_and_image_refs_its_details_state() {
        let (paste, image) = ("a".repeat(64), "e".repeat(64));
        let line = "[Image: source: image.png, 893x258, displayed at 893x258]";
        let stored = json!({ "id": paste, "attachmentRef": paste, "kind": "text", "name": "Pasted text #1", "mimeType": "text/plain", "size": 40 });
        let item = json!({
            "type": "userMessage", "id": "u",
            "content": [{ "type": "text", "text": format!("look\n{line}") }],
            "details": { "attachments": [stored], "imageRefs": [{ "line": line, "ref": image }] },
            "meta": { "at": 1 }
        });
        let row = row_of(&item).unwrap().value;
        assert_eq!(row["attachments"], json!([stored]));
        assert_eq!(row["imageRefs"], json!([{ "line": line, "ref": image }]));
        let plain = row_of(&json!({ "type": "userMessage", "id": "p", "content": [{ "type": "text", "text": "hi" }], "meta": {} })).unwrap().value;
        assert!(plain.get("imageRefs").is_none() && plain.get("attachments").is_none());
    }

    #[test]
    fn a_held_request_without_an_id_has_no_row_and_a_schedule_result_is_a_notice() {
        let held = |request: Value| json!({ "type": "userMessage", "id": "h", "content": [], "meta": { "source": "held-request", "ext": { "heldRequest": request } } });
        assert!(row_of(&held(json!({ "status": "pending", "tool": "bash" }))).is_none());
        let shown = row_of(&held(json!({ "id": "r1", "status": "pending", "tool": "bash", "target": "x" }))).unwrap().value;
        assert_eq!((shown["kind"].clone(), shown["text"].clone(), shown["tone"].clone()), (json!("notice"), json!("⏸ Approval needed · bash → x"), json!("warn")));
        let schedule = json!({ "type": "userMessage", "id": "s", "content": [], "meta": { "source": "schedule-result", "ext": { "messageId": "routine_9", "routine": { "name": "nightly", "status": "failed", "summary": "boom" } } } });
        let row = row_of(&schedule).unwrap().value;
        assert_eq!(row["text"], "⏱ Schedule · nightly — Failed: boom");
        assert_eq!(row["posted"], true);
        assert_eq!(row["routine"]["status"], "failed");
    }

    #[test]
    fn a_room_row_is_the_users_bubble_or_a_notice_line() {
        let speech = json!({ "type": "roomRow", "id": "r1", "text": "hi", "room": { "kind": "speech", "to": "a", "at": 9 }, "meta": { "at": 3, "messageId": "m1" } });
        let row = row_of(&speech).unwrap().value;
        assert_eq!((row["kind"].clone(), row["id"].clone(), row["text"].clone()), (json!("notice"), json!("r1"), json!("hi")));
        assert_eq!(row["room"]["to"], json!(["a"]));
        assert_eq!(row["room"]["toName"], json!(["a"]));
        assert_eq!(row["room"]["id"], "m1");
        let pass = json!({ "type": "roomRow", "id": "r2", "room": { "kind": "pass", "name": "bo", "failed": true }, "meta": {} });
        assert_eq!(row_of(&pass).unwrap().value["text"], "bo · no reply");
        let user = json!({ "type": "roomRow", "id": "r3", "text": "yo", "room": { "kind": "user", "fromSession": true }, "meta": { "messageId": "m3" } });
        let row = row_of(&user).unwrap().value;
        assert_eq!((row["kind"].clone(), row["id"].clone(), row["sender"].clone()), (json!("user"), json!("m3"), json!("lead")));
    }

    #[test]
    fn a_turn_end_names_its_prompt_by_the_submission_and_ext_is_applied_last() {
        let end = json!({ "type": "turnEnd", "id": "t", "checkpointId": "core", "elapsedMs": 5, "status": "completed", "meta": { "ext": { "clientSubmissionId": "sub", "toolCount": 2, "dividersAfter": [] } } });
        let row = row_of(&end).unwrap().value;
        assert_eq!((row["checkpointId"].clone(), row["toolCount"].clone(), row.get("dividersAfter").cloned()), (json!("sub"), json!(2), None));
    }

    #[test]
    fn a_history_pages_item_brings_its_compaction_dividers() {
        let item = json!({ "type": "agentMessage", "id": "a", "text": "x", "meta": { "ext": { "dividersAfter": [{ "type": "contextCompaction", "id": "d", "meta": {} }] } } });
        let rows = rows_of(&item);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].value["label"], "Conversation compacted");
    }

    /// A card the core extended with later responses (`agent_response`) states how many it covers on its run: its row is counted by
    /// that, finished or not; an ordinary card, or a run with no usable count, stays one.
    #[test]
    fn a_card_whose_run_covers_several_responses_is_counted_by_them() {
        let card = |run: Value, status: &str| json!({
            "type": "toolCall", "id": "r", "name": "agent", "input": { "type": "result", "status": "completed", "task_id": "t1", "surface": "agent" },
            "run": run, "meta": { "status": status, "at": 5 }
        });
        let counted = |item: Value| {
            let row = row_of(&item).unwrap().value;
            (row["count"].clone(), row["completedCount"].clone())
        };
        assert_eq!(counted(card(json!({ "result": "x", "count": 3, "completedCount": 3 }), "completed")), (json!(3), json!(3)));
        assert_eq!(counted(card(json!({ "result": "x", "count": 3 }), "running")), (json!(3), json!(0)));
        assert_eq!(counted(card(json!({ "result": "x" }), "completed")), (json!(1), json!(1)));
        assert_eq!(counted(card(json!({ "result": "x", "count": 0 }), "completed")), (json!(1), json!(1)));
        assert_eq!(counted(call("c", "completed", Some("ok"))), (json!(1), json!(1)));
    }

    #[test]
    fn hidden_control_tools_and_task_waits_give_no_row() {
        assert!(row_of(&json!({ "type": "toolCall", "id": "t", "name": "todo", "input": {}, "meta": { "status": "completed" } })).is_none());
        assert!(row_of(&json!({ "type": "toolCall", "id": "t", "name": "task", "input": { "action": "wait" }, "meta": { "status": "completed" } })).is_none());
    }
}
