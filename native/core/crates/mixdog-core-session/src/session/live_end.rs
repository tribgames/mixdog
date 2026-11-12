//! The live end of a turn: Node's `turnDoneItem` (`src/tui/session/turn.mjs:573-601`), built from what the run
//! showed while it ran, not from the durable completion (`failedTurnCompletion`, `ask-turn-failure.mjs:26-45`;
//! `attachAssistantTranscriptCompletion`, `ask-turn-settle.mjs`) the history restores from. The two share the
//! turn's own identity (and for a failure the failure record, `turnFailureRecord`); the live row adds the stream's
//! counters (`finalOutputTokens`, `accumulatedThinkingMs`, `cards.toolCards`) and stamps the close time, where the
//! completion stamps the start.

use std::collections::HashSet;

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_protocol::tool_visibility::is_hidden_control_tool_name;
use mixdog_protocol::tool_visibility::is_skill_tool_name;
use mixdog_protocol::tool_visibility::is_task_wait;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::failure_record::Facts;

/// The built-in skills' names, trimmed and lower-cased (`skillsStatus().skills` with `source === 'builtin'`,
/// `builtinSkillNamesFor`, `turn-tool-cards.mjs:39-55`). A live turn reads them when a batch of tool calls carries a skill
/// call, to hide a built-in skill load before its result exists. `None`: the status could not be read.
pub trait BuiltinSkills: Send + Sync + 'static {
    fn names(&self) -> Option<HashSet<String>>;
}

/// `TURN_DONE_VERBS` (`tui/session/labels.mjs`).
const DONE_VERBS: [&str; 8] = ["Thought", "Reasoned", "Mapped", "Checked", "Solved", "Composed", "Synthesized", "Wrapped"];

/// `pickDoneVerb(turn)`: the verb of the turn that follows `turn` closed ones (`stats.turns`).
pub fn done_verb(turn: usize) -> &'static str {
    DONE_VERBS[(turn * 5 + 2) % DONE_VERBS.len()]
}

/// A shown item as the live turn holds it (`turn.mjs`, `turn-tool-cards.mjs`), not as a restore rebuilds it from the record:
/// an assistant row carries its turn's `attemptId` and `completionVerb` and `streaming: false`; the turn's input row carries
/// no `checkpointId` (the turn's end does); a tool row reads as the turn's card, an aggregate even for one call
/// ([`mixdog_protocol::ToolRun::live`]). `attempt` is the stored row's own `attemptId`, `verb` the open turn's.
/// A reply the history does not stamp (the partial reply of a cancelled turn is stored as the bare message) reads live as
/// the stream's text, untrimmed (`stream.assistantText`, `raw`), under the turn's route and identity (`turn`: the input
/// row's `meta.transcript`) and its own `messageId`, stamped `at` the time it showed.
pub(crate) fn live_form(mut item: mixdog_protocol::ThreadItem, attempt: Option<&str>, verb: Option<&str>, turn: Option<&Value>, raw: Option<&str>, at: i64) -> mixdog_protocol::ThreadItem {
    use mixdog_protocol::MaybeBlob;
    use mixdog_protocol::ThreadItem;
    match &mut item {
        ThreadItem::UserMessage { checkpoint_id, .. } => *checkpoint_id = None,
        ThreadItem::AgentMessage { text, meta, .. } => {
            if let Some(attempt) = attempt {
                meta.ext.insert("attemptId".into(), json!(attempt));
            } else if let Some(turn) = turn.and_then(Value::as_object) {
                for key in ["agent", "model", "modelId", "provider", "attemptId", "device"] {
                    if let Some(value) = turn.get(key).filter(|value| value.as_str().is_some_and(|text| !text.is_empty())) {
                        meta.ext.entry(key.to_owned()).or_insert_with(|| value.clone());
                    }
                }
                meta.ext.entry("at").or_insert_with(|| json!(at));
                meta.ext.entry("messageId").or_insert_with(|| json!(format!("msg_{}", uuid::Uuid::new_v4().simple())));
                if let (MaybeBlob::Inline(shown), Some(raw)) = (&mut *text, raw)
                    && js_trim(raw) == *shown
                {
                    *shown = raw.to_owned();
                }
            }
            // `beginTurn`'s `transcriptMeta` rides every live row of the turn: a bot's message names its sender and chain.
            if let Some(turn) = turn.and_then(Value::as_object) {
                for key in ["sender", "fromAgent", "hop", "botChain"] {
                    if let Some(value) = turn.get(key) {
                        meta.ext.entry(key.to_owned()).or_insert_with(|| value.clone());
                    }
                }
            }
            if let Some(verb) = verb {
                meta.ext.insert("completionVerb".into(), json!(verb));
            }
            meta.ext.insert("streaming".into(), json!(false));
        }
        ThreadItem::ToolCall { run, .. } => run.live = Some(true),
        _ => {}
    }
    item
}

/// JavaScript truthiness of a call field.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The first of `paths` the call has and is not null (`a ?? b ?? c`); a path is a key or `key/key`.
fn first<'a>(call: &'a Value, paths: &[&str]) -> Option<&'a Value> {
    paths.iter().find_map(|path| call.pointer(&format!("/{path}")).filter(|value| !value.is_null()))
}

/// `toolCallName`, `toolCallArgs` (`tool-call-fields.mjs`): the call's name (`tool` when it states none) and arguments.
fn call_name(call: &Value) -> String {
    first(call, &["name", "function/name", "toolName", "tool_name"]).map_or_else(|| "tool".to_owned(), |name| name.as_str().map_or_else(|| value_to_string(name), str::to_owned))
}

fn call_args(call: &Value) -> Option<&Value> {
    first(call, &["arguments", "args", "input", "function/arguments"])
}

/// `transcriptToolCallDisplayMode(..) !== 'visible'` of a call whose skill source is `builtin` (`turn-tool-cards.mjs:25-35`).
fn hidden_mode(name: &str, args: Option<&Value>, builtin: Option<&HashSet<String>>) -> bool {
    if is_task_wait(name, args) || is_hidden_control_tool_name(name) {
        return true;
    }
    let Some(builtin) = builtin.filter(|names| !names.is_empty()) else { return false };
    if !is_skill_tool_name(name) {
        return false;
    }
    let field = |key: &str| args.and_then(|args| args.get(key)).filter(|value| truthy(value));
    let skill = field("name").or_else(|| field("skill")).or_else(|| field("skill_name")).map(value_to_string).unwrap_or_default();
    let skill = js_trim(&skill).to_lowercase();
    !skill.is_empty() && builtin.contains(&skill)
}

/// What the turn's stream and cards counted: `stream.assistantText` and `stream.thinkingText` (UTF-16 code units, as
/// `String.length`), the spinner's `outputTokens`, the thinking segments (`startThinkingSegment`,
/// `closeThinkingSegment`) and `cards.toolCards`.
#[derive(Debug, Default)]
pub(crate) struct LiveCounts {
    output_tokens: u64,
    reply_units: u64,
    reasoning_units: u64,
    tool_cards: u64,
    /// `stream.thinkingStartedAt` is set: the turn thought at all.
    thought: bool,
    /// `stream.accumulatedThinkingMs`.
    thinking_ms: i64,
    /// `stream.thinkingSegmentStartedAt`: the open segment's start.
    segment_since: Option<i64>,
}

fn units(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

impl LiveCounts {
    /// One model call's `deltaOutput` (`applyUsageDelta` into the spinner's `outputTokens`).
    pub(crate) fn usage(&mut self, output_tokens: u64) {
        self.output_tokens += output_tokens;
    }

    /// An assistant text delta (`appendTextDelta`): the open thinking segment ends. An empty chunk is nothing
    /// (`onTextDelta`).
    pub(crate) fn text(&mut self, text: &str, now: i64) {
        if text.is_empty() {
            return;
        }
        self.end_thinking(now);
        self.reply_units += units(text);
    }

    /// A reasoning delta (`appendReasoningDelta`): a segment opens unless one is open.
    pub(crate) fn reasoning(&mut self, text: &str, now: i64) {
        self.thought = true;
        self.segment_since.get_or_insert(now);
        self.reasoning_units += units(text);
    }

    /// One provider batch of tool calls (`openToolCalls`, `turn-tool-cards.mjs:160-176` `visibleToolCalls`): the open
    /// thinking segment ends for any batch with a call, and each call that gets a card is counted (`trackCard` pushes
    /// one entry per call, aggregate or standalone, so same-category calls merging into one card change nothing). A
    /// call gets no card when it is a task wait, a hidden control tool or a built-in skill load, unless it has no id.
    /// The skill source is read only when the batch carries a skill call.
    pub(crate) fn tool_batch(&mut self, calls: &[Value], skills: &dyn BuiltinSkills, now: i64) {
        let calls: Vec<&Value> = calls.iter().filter(|call| truthy(call)).collect();
        if calls.is_empty() {
            return;
        }
        let builtin = calls.iter().any(|call| is_skill_tool_name(&call_name(call))).then(|| skills.names()).flatten();
        let shown = calls
            .iter()
            .filter(|call| {
                let id = first(call, &["id", "toolCallId", "tool_call_id", "call_id"]);
                !hidden_mode(&call_name(call), call_args(call), builtin.as_ref()) || !id.is_some_and(truthy)
            })
            .count();
        self.end_thinking(now);
        self.tool_cards += shown as u64;
    }

    /// `closeThinkingSegment` at the turn's close.
    pub(crate) fn close(&mut self, now: i64) {
        self.end_thinking(now);
    }

    /// `isNoOpTurn` of a turn that finished normally (`publishTurnClose`, `turn.mjs:615-624`): no tool card, no
    /// result content and no assistant output, so the turn is not marked with an end.
    pub(crate) fn is_no_op(&self, result: &str) -> bool {
        self.tool_cards == 0 && self.reply_units == 0 && js_trim(result).is_empty()
    }

    fn end_thinking(&mut self, now: i64) {
        if let Some(since) = self.segment_since.take() {
            self.thinking_ms += (now - since).max(0);
        }
    }

    /// `finalOutputTokens`: the spinner's tokens, or the estimate of the text and thinking when it is larger
    /// (`Math.round(length / 4)`, half up).
    fn final_output_tokens(&self) -> u64 {
        self.output_tokens.max((self.reply_units + self.reasoning_units + 2) / 4)
    }
}

/// `createTranscriptRouteMetadata(session)` without its time and workflow agent: the non-empty `modelId`, the display
/// `model` (`displayModelName`) and `provider` of the route, in Node's order.
pub(crate) fn route_meta(provider: &str, model: &str) -> Map<String, Value> {
    let (provider, model) = (js_trim(provider), js_trim(model));
    let mut meta = Map::new();
    if !model.is_empty() {
        meta.insert("modelId".into(), json!(model));
        let name = mixdog_core_run::run_host::model_display::display_model_name(model, "");
        if !name.is_empty() {
            meta.insert("model".into(), json!(name));
        }
    }
    if !provider.is_empty() {
        meta.insert("provider".into(), json!(provider));
    }
    meta
}

/// `turnDoneItem` of a turn that ended with `status` (`turnOutcome`), as the row Node's transcript holds, keys in
/// Node's order. `final_assistant` is the turn's last reply (`stream.currentAssistantId`, set when the turn finished
/// normally). `record` is the `turnFailureRecord` of a failure (the turn's `failureDetail`, `failureDiagnostic`,
/// `quota`, `errorKind`), empty for another end. `facts.raw` is the turn's `meta.transcript`, of which Node's
/// `routeMeta` is all but `at` and `messageId`.
pub(crate) fn live_end_row(
    counts: &LiveCounts,
    facts: &Facts<'_>,
    route: &Map<String, Value>,
    status: &str,
    final_assistant: Option<&str>,
    record: &Map<String, Value>,
    id: &str,
) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("kind".into(), json!("turndone"));
    row.insert("id".into(), json!(id));
    if let Some(checkpoint) = facts.text("checkpointId") {
        row.insert("checkpointId".into(), json!(checkpoint));
    }
    row.insert("elapsedMs".into(), json!((facts.now - facts.started()).max(0)));
    row.insert("status".into(), json!(status));
    if let Some(reply) = final_assistant {
        row.insert("finalAssistantId".into(), json!(reply));
    }
    row.insert("outputTokens".into(), json!(counts.final_output_tokens()));
    row.insert("thinkingElapsedMs".into(), json!(if counts.thought { counts.thinking_ms } else { 0 }));
    row.insert("toolCount".into(), json!(counts.tool_cards));
    row.insert("verb".into(), json!(facts.verb()));
    row.insert("at".into(), json!(facts.now));
    for key in ["detail", "errorDetails"] {
        if let Some(text) = record.get(key).filter(|text| text.as_str().is_some_and(|text| !text.is_empty())) {
            row.insert(key.into(), text.clone());
        }
    }
    // `transcriptMeta` is the session's route, then what the submitted input states over it (`beginTurn`).
    for (key, value) in route {
        row.insert(key.clone(), value.clone());
    }
    if let Some(meta) = facts.raw.as_object() {
        for (key, value) in meta.iter().filter(|(key, _)| !matches!(key.as_str(), "at" | "messageId")) {
            row.insert(key.clone(), value.clone());
        }
    }
    // The turn's identity is in every live row (`beginTurn`); a turn whose input row states none takes the one its
    // completion records.
    row.entry("attemptId").or_insert_with(|| json!(facts.attempt()));
    for key in ["quota", "errorKind"] {
        if let Some(value) = record.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    row
}

#[cfg(test)]
mod tests {

    /// The live form of a shown item (`live_form`): the `edit` scenario's rows of the Node daemon carry `attemptId`, `completionVerb` and
    /// `streaming: false` on an assistant row, no `checkpointId` on the input row, and a tool card that reads as the turn's.
    #[test]
    fn a_shown_item_takes_the_live_form() {
        use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem, ToolRun};
        let reply = ThreadItem::AgentMessage { id: "a".into(), text: MaybeBlob::Inline("hi".into()), meta: ItemMeta::default(), imported_tool_runs: Vec::new() };
        let ThreadItem::AgentMessage { meta, .. } = live_form(reply, Some("att"), Some("Mapped"), None, None, 0) else { panic!("a reply stays a reply") };
        assert_eq!(
            (meta.ext.get("attemptId"), meta.ext.get("completionVerb"), meta.ext.get("streaming")),
            (Some(&json!("att")), Some(&json!("Mapped")), Some(&json!(false)))
        );
        let call = ThreadItem::ToolCall { id: "t".into(), name: "read".into(), input: json!({}), output: None, run: Box::new(ToolRun::default()), meta: ItemMeta::default() };
        let ThreadItem::ToolCall { run, .. } = live_form(call, None, None, None, None, 0) else { panic!("a call stays a call") };
        assert_eq!(run.live, Some(true));
    }

    /// The partial reply of a cancelled turn is stored as the bare message, so its live row reads the stream's text untrimmed and takes
    /// the turn's route and identity, a `messageId` of its own and the time it showed (the Node daemon's `cancel` scenario).
    #[test]
    fn a_reply_the_history_does_not_stamp_reads_live_under_the_turns_identity() {
        use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem};
        let turn = json!({ "attemptId": "att", "agent": "Default", "model": "m", "modelId": "m-id", "provider": "p", "at": 1 });
        let reply = ThreadItem::AgentMessage { id: "a".into(), text: MaybeBlob::Inline("once upon".into()), meta: ItemMeta::default(), imported_tool_runs: Vec::new() };
        let ThreadItem::AgentMessage { text, meta, .. } = live_form(reply, None, Some("Mapped"), Some(&turn), Some("once upon "), 7) else { panic!("a reply stays a reply") };
        assert_eq!(text, MaybeBlob::Inline("once upon ".into()));
        let read = |key: &str| meta.ext.get(key).cloned();
        assert_eq!(
            (read("attemptId"), read("agent"), read("model"), read("modelId"), read("provider"), read("at"), read("completionVerb")),
            (Some(json!("att")), Some(json!("Default")), Some(json!("m")), Some(json!("m-id")), Some(json!("p")), Some(json!(7)), Some(json!("Mapped")))
        );
        assert!(meta.ext.get("messageId").and_then(Value::as_str).is_some_and(|id| !id.is_empty()));
    }

    use super::*;

    struct Names(Option<HashSet<String>>);

    impl BuiltinSkills for Names {
        fn names(&self) -> Option<HashSet<String>> {
            self.0.clone()
        }
    }

    #[test]
    fn a_batch_counts_the_calls_that_get_a_card_as_nodes_visible_tool_calls_do() {
        let builtin = Names(Some(["browser use".to_owned()].into()));
        let mut counts = LiveCounts::default();
        counts.tool_batch(&[json!(null), json!({ "id": "c1", "name": "read", "arguments": { "path": "a" } })], &builtin, 0);
        counts.tool_batch(&[json!({ "id": "c2", "name": "functions.Task", "arguments": "{\"action\":\"WAIT\"}" }), json!({ "id": "c3", "name": "todo" })], &builtin, 0);
        assert_eq!(counts.tool_cards, 1, "a task wait and a control tool get no card");
        counts.tool_batch(&[json!({ "id": "c4", "name": "skill", "arguments": { "name": " Browser Use " } }), json!({ "id": "c5", "name": "skill", "arguments": { "name": "mine" } })], &builtin, 0);
        assert_eq!(counts.tool_cards, 2, "a built-in skill load gets none, a user skill does");
        counts.tool_batch(&[json!({ "name": "tool_search" }), json!({ "id": "", "name": "todo" })], &builtin, 0);
        assert_eq!(counts.tool_cards, 4, "a call with no id keeps its card");
        counts.tool_batch(&[json!({ "id": "c6", "name": "skill", "arguments": { "name": "browser use" } })], &Names(None), 0);
        assert_eq!(counts.tool_cards, 5, "an unreadable skill source hides nothing");
    }

    #[test]
    fn the_estimate_rounds_half_up_and_a_thinking_segment_counts_only_when_it_closed() {
        let mut counts = LiveCounts::default();
        counts.reasoning("ab", 10);
        counts.text("cdefg", 40);
        counts.close(90);
        // 7 units / 4 = 1.75 rounds to 2; the segment 10..40.
        assert_eq!((counts.final_output_tokens(), counts.thinking_ms), (2, 30));
        counts.usage(5);
        assert_eq!(counts.final_output_tokens(), 5);
    }
}