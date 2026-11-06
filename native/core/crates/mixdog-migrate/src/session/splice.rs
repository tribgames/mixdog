//! The transcript 1.4.5's `recoverTurnCheckpoint` leaves on a session it recovers a
//! force-killed turn into (`v145:ORCH/session/manager/turn-checkpoint.mjs:55-127,488-489`):
//! the checkpoint's disposition against the durable record, then the record's first
//! `boundary` messages followed by the turn as `finalizeTurnInterruptionSnapshot` closes it
//! (`turn-interruption.mjs:55-155,386-400`) with abort reason `process-crash`.
//!
//! JS strict equality is [`strict_eq`]: objects never equal one another, as parsed JSON
//! objects are never the same object.

use mixdog_agent::compact::pressure::AttachmentBytes;
use mixdog_agent::compact::pressure::restore_turn_checkpoint_context_state_rows;
use mixdog_agent::compact::pressure::rows_exact_signature;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::json::js_to_string;
use crate::json::js_truthy;

const PROCESS_RESTART_INTERRUPT_MESSAGE: &str = "[Request interrupted by process restart]";
const INTERRUPTED_TOOL_RESULT: &str = "Cancelled";
const TOOL_MISSING_STUB: &str = "[Older tool result unavailable after context compaction]";
/// `PROVIDER_REPLAY_FIELDS` and `TOOL_CALL_SIGNATURE_FIELDS` (`provider-replay.mjs:10,20`).
const PROVIDER_REPLAY_FIELDS: [&str; 7] =
    ["providerReplay", "reasoning", "thinkingBlocks", "assistantBlocks", "reasoningItems", "reasoningContent", "providerMetadata"];
const TOOL_CALL_SIGNATURE_FIELDS: [&str; 2] = ["thoughtSignature", "thought_signature"];

/// What recovery does with a checkpoint.
#[derive(Debug, PartialEq)]
pub enum Splice {
    /// The record carries the turn already.
    Covered,
    /// Kept unrecovered: the record is not the one the checkpoint was taken against.
    Conflict,
    /// The record keeps its first `keep` messages, then `turn` follows.
    Replay { keep: usize, turn: Vec<Value> },
}

/// `a === b` for two property reads (`None` is `undefined`).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `value?.[key]` of a parsed JSON value.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn role_is(message: &Value, role: &str) -> bool {
    prop(Some(message), "role").and_then(Value::as_str) == Some(role)
}

/// `Number.isInteger(value)`, as the integer.
fn integer(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = mixdog_js::to_number_of(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    if js_truthy(value) { js_to_string(value.expect("truthy")) } else { String::new() }
}

/// The entries of `new Map(Array.isArray(value) ? value : [])`: a repeated key keeps its
/// first position and its last value. An entry that is not an object (a `TypeError` in
/// Node) never occurs in a journal 1.4.5 wrote and is skipped.
fn js_map(value: Option<&Value>) -> Vec<(Option<Value>, Option<Value>)> {
    let mut out: Vec<(Option<Value>, Option<Value>)> = Vec::new();
    for entry in value.and_then(Value::as_array).into_iter().flatten() {
        let (key, val) = match entry {
            Value::Array(a) => (a.first().cloned(), a.get(1).cloned()),
            Value::Object(o) => (o.get("0").cloned(), o.get("1").cloned()),
            _ => continue,
        };
        match out.iter_mut().find(|(k, _)| strict_eq(k.as_ref(), key.as_ref())) {
            Some(slot) => slot.1 = val,
            None => out.push((key, val)),
        }
    }
    out
}

fn contains(set: &[Value], value: &Value) -> bool {
    set.iter().any(|v| strict_eq(Some(v), Some(value)))
}

/// `collectAssistantToolCallIds` (`context-tool-pairs.mjs:9`).
fn assistant_tool_call_ids(message: &Value) -> Vec<Value> {
    let mut ids: Vec<Value> = Vec::new();
    if !role_is(message, "assistant") {
        return ids;
    }
    let mut add = |id: Option<&Value>| {
        if let Some(id) = id.filter(|id| js_truthy(Some(id)))
            && !contains(&ids, id)
        {
            ids.push(id.clone());
        }
    };
    for call in prop(Some(message), "toolCalls").and_then(Value::as_array).into_iter().flatten() {
        add(prop(Some(call), "id"));
    }
    for field in ["assistantBlocks", "content"] {
        for block in prop(Some(message), field).and_then(Value::as_array).into_iter().flatten() {
            if prop(Some(block), "type").and_then(Value::as_str) == Some("tool_use") {
                add(prop(Some(block), "id"));
            }
        }
    }
    ids
}

/// `pickToolResultForAssistant` (`context-tool-pairs.mjs:44`).
fn pick_tool_result<'a>(messages: &'a [Value], assistant: usize, id: &Value) -> Option<&'a Value> {
    let answers = |m: &Value| role_is(m, "tool") && strict_eq(prop(Some(m), "toolCallId"), Some(id));
    let mut after = assistant + 1;
    while after < messages.len() && role_is(&messages[after], "tool") {
        if answers(&messages[after]) {
            return Some(&messages[after]);
        }
        after += 1;
    }
    messages[after.min(messages.len())..].iter().chain(&messages[..assistant]).find(|m| answers(m))
}

/// `sanitizeToolPairs` (`context-tool-pairs.mjs:62`).
fn sanitize_tool_pairs(messages: Vec<Value>) -> Vec<Value> {
    let mut placed: Vec<Value> = Vec::new();
    let mut result = Vec::with_capacity(messages.len());
    for (idx, m) in messages.iter().enumerate() {
        if role_is(m, "tool") {
            continue;
        }
        result.push(m.clone());
        for id in assistant_tool_call_ids(m) {
            if contains(&placed, &id) {
                continue;
            }
            result.push(match pick_tool_result(&messages, idx, &id) {
                Some(existing) => existing.clone(),
                None => json!({"role": "tool", "content": TOOL_MISSING_STUB, "toolCallId": id}),
            });
            placed.push(id);
        }
    }
    result
}

/// `{ ...value }` of a value read from JSON.
fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(o)) => o.clone(),
        Some(Value::Array(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Some(Value::String(s)) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Value::String(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Map::new(),
    }
}

/// `finalizeTurnInterruptionSnapshot({turnOutgoing, snapshot, abortReason: 'process-crash'})`.
/// A process crash is not a user cancel, so the turn is kept whole and only a started
/// response is closed.
pub fn finalize_after_crash(turn: &[Value], snapshot: Option<&Value>) -> Vec<Value> {
    let source = snapshot.filter(|s| s.is_object());
    let field = |key: &str| prop(source, key);
    let mut messages = turn.to_vec();
    if field("responseStarted") != Some(&Value::Bool(true)) {
        return messages;
    }
    let streaming = field("phase").and_then(Value::as_str) != Some("tools");
    if let Some(tail) = messages.last_mut()
        && streaming
        && (role_is(tail, "tool") || role_is(tail, "user"))
    {
        let mut meta = spread(prop(Some(tail), "meta"));
        meta.insert("sentRequestTail".into(), Value::Bool(true));
        tail.as_object_mut().expect("a message with a role").insert("meta".into(), Value::Object(meta));
    }
    append_observed_turn_output(
        &mut messages,
        &text_or_empty(field("partialAssistantContent")),
        &text_or_empty(field("partialReasoningContent")),
        &js_map(field("observedToolCalls")),
        &js_map(field("observedToolResults")),
    );
    let mut paired = sanitize_tool_pairs(messages);
    paired.push(json!({"role": "user", "content": PROCESS_RESTART_INTERRUPT_MESSAGE}));
    paired
}

/// `appendObservedTurnOutput` (`turn-interruption.mjs:160`).
fn append_observed_turn_output(
    messages: &mut Vec<Value>,
    text: &str,
    reasoning: &str,
    calls: &[(Option<Value>, Option<Value>)],
    results: &[(Option<Value>, Option<Value>)],
) {
    let represented: Vec<Value> = messages.iter().flat_map(assistant_tool_call_ids).collect();
    let unrepresented: Vec<Value> = calls
        .iter()
        .filter_map(|(_, observed)| prop(observed.as_ref(), "call"))
        .filter(|call| prop(Some(call), "id").is_some_and(|id| js_truthy(Some(id)) && !contains(&represented, id)))
        .cloned()
        .collect();
    if !text.is_empty() || !reasoning.is_empty() || !unrepresented.is_empty() {
        let mut assistant = Map::new();
        assistant.insert("role".into(), "assistant".into());
        assistant.insert("content".into(), text.into());
        if !reasoning.is_empty() {
            assistant.insert("reasoningContent".into(), reasoning.into());
        }
        if !unrepresented.is_empty() {
            assistant.insert("toolCalls".into(), Value::Array(unrepresented));
        }
        messages.push(Value::Object(assistant));
    }

    let mut answered: Vec<Value> = messages
        .iter()
        .filter(|m| role_is(m, "tool"))
        .filter_map(|m| prop(Some(m), "toolCallId").filter(|id| js_truthy(Some(id))).cloned())
        .collect();
    for (_, result) in results {
        let Some(id) = prop(result.as_ref(), "toolCallId").filter(|id| js_truthy(Some(id))) else {
            continue;
        };
        if contains(&answered, id) {
            continue;
        }
        let mut tool = Map::new();
        tool.insert("role".into(), "tool".into());
        let content = prop(result.as_ref(), "content").filter(|c| !c.is_null()).cloned();
        tool.insert("content".into(), content.unwrap_or_else(|| "".into()));
        tool.insert("toolCallId".into(), id.clone());
        if let Some(kind) = prop(result.as_ref(), "toolKind").filter(|k| js_truthy(Some(k))) {
            tool.insert("toolKind".into(), kind.clone());
        }
        messages.push(Value::Object(tool));
        answered.push(id.clone());
    }

    let mut all: Vec<Value> = Vec::new();
    for id in messages.iter().flat_map(assistant_tool_call_ids) {
        if !contains(&all, &id) {
            all.push(id);
        }
    }
    for id in all {
        if contains(&answered, &id) {
            continue;
        }
        messages.push(json!({"role": "tool", "content": INTERRUPTED_TOOL_RESULT, "toolCallId": id, "toolKind": "error"}));
        answered.push(id);
    }
}

/// `stripProviderReplayMessage` (`provider-replay.mjs:50`).
fn strip_provider_replay(message: Value) -> Value {
    let Value::Object(mut object) = message else {
        return message;
    };
    let signed = |call: &Value| call.as_object().is_some_and(|c| TOOL_CALL_SIGNATURE_FIELDS.iter().any(|f| c.contains_key(*f)));
    let calls = object.get("toolCalls").and_then(Value::as_array).filter(|calls| calls.iter().any(signed)).map(|calls| {
        calls
            .iter()
            .map(|call| match call {
                Value::Object(c) if signed(call) => {
                    let mut plain = c.clone();
                    for field in TOOL_CALL_SIGNATURE_FIELDS {
                        plain.shift_remove(field);
                    }
                    Value::Object(plain)
                }
                _ => call.clone(),
            })
            .collect::<Vec<_>>()
    });
    for field in PROVIDER_REPLAY_FIELDS {
        object.shift_remove(field);
    }
    if let Some(calls) = calls {
        object.insert("toolCalls".into(), Value::Array(calls));
    }
    Value::Object(object)
}

/// `checkpointDisposition` then `replayCheckpoint` for the folded `checkpoint` against the
/// durable record (`header` and its `messages`). A legacy checkpoint's prefix is signed as
/// `contextMessagesSignature` signs it, reading referenced parts from `blobs`.
pub fn splice<B: AttachmentBytes + ?Sized>(
    header: &Map<String, Value>,
    messages: &[Value],
    checkpoint: &Map<String, Value>,
    blobs: &B,
) -> Result<Splice, B::Error> {
    let token = checkpoint.get("turnToken");
    if token.is_some_and(Value::is_string) && strict_eq(header.get("turnCoverage"), token) {
        return Ok(Splice::Covered);
    }
    let active = header.get("activeTurnCheckpoint");
    let full = checkpoint.get("fullTranscript") == Some(&Value::Bool(true));
    let keep = if checkpoint.contains_key("boundary") {
        let base = checkpoint.get("base");
        let base_epoch = prop(base, "epoch").filter(|e| e.as_str().is_some_and(|e| !e.is_empty()));
        let same_turn = strict_eq(prop(active, "turnToken"), token);
        let on_base_epoch = base_epoch.is_some() && strict_eq(header.get("transcriptEpoch"), base_epoch);
        if full {
            if !(on_base_epoch || same_turn) {
                return Ok(Splice::Conflict);
            }
            0
        } else {
            let Some(boundary) = integer(checkpoint.get("boundary")).filter(|b| *b >= 0.0) else {
                return Ok(Splice::Conflict);
            };
            // `boundary > Number(base.length)`: false against NaN.
            if base_epoch.is_none() || boundary > mixdog_js::to_number_of(prop(base, "length")) {
                return Ok(Splice::Conflict);
            }
            if !(on_base_epoch && messages.len() as f64 >= boundary) {
                return Ok(Splice::Conflict);
            }
            boundary as usize
        }
    } else {
        // `legacyDisposition`: a checkpoint written before checkpoints named their base.
        let marker = prop(active, "turnToken");
        if number_or_zero(checkpoint.get("generation")) != number_or_zero(header.get("generation"))
            || (marker.is_some_and(Value::is_string) && !strict_eq(marker, token))
            || full
        {
            return Ok(Splice::Conflict);
        }
        let state = checkpoint.get("contextState");
        let Some(count) = integer(prop(state, "committedPrefixCount")).filter(|c| *c >= 0.0) else {
            return Ok(Splice::Conflict);
        };
        let Some(signature) = prop(state, "committedPrefixSignature").and_then(Value::as_str) else {
            return Ok(Splice::Conflict);
        };
        if (messages.len() as f64) < count || rows_exact_signature(&messages[..count as usize], blobs)? != signature {
            return Ok(Splice::Conflict);
        }
        if messages.len() as f64 != count && !strict_eq(marker, token) {
            return Ok(Splice::Conflict);
        }
        count as usize
    };
    let turn: &[Value] = checkpoint.get("turnMessages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let finalized =
        if checkpoint.get("sealed") == Some(&Value::Bool(true)) { turn.to_vec() } else { finalize_after_crash(turn, checkpoint.get("interruption")) };
    let route_changed = strict_eq(prop(active, "turnToken"), token) && prop(active, "routeChanged") == Some(&Value::Bool(true));
    let turn = if route_changed { finalized.into_iter().map(strip_provider_replay).collect() } else { finalized };
    Ok(Splice::Replay { keep, turn })
}

/// What recovery then does to the session's header (`turn-checkpoint.mjs:497-503`): the
/// context reading re-anchored to the spliced `rows` (`restoreTurnCheckpointContextState`),
/// the turn's last prefix baseline kept, and the active-turn marker dropped. `now` stands for
/// the recovery's `Date.now()`.
pub fn restore_header<B: AttachmentBytes + ?Sized>(
    header: &mut Map<String, Value>,
    rows: &[Value],
    checkpoint: &Value,
    blobs: &B,
    now: f64,
) -> Result<(), B::Error> {
    let restored = restore_turn_checkpoint_context_state_rows(header, rows, checkpoint, blobs, now)?;
    restored.patch.apply(header);
    if let Some(baseline) = prop(prop(Some(checkpoint), "contextState"), "prefixBaseline").filter(|b| js_truthy(Some(b))) {
        header.insert("providerPrefixBaseline".into(), baseline.clone());
    }
    header.shift_remove("activeTurnCheckpoint");
    Ok(())
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::pressure::BlobError;

    use super::*;

    /// The one blob the restore golden stores (`checkpoint_restore.json` `blob`).
    struct OneBlob(Vec<u8>);

    impl AttachmentBytes for OneBlob {
        type Error = String;

        fn bytes(&self, reference: &str) -> Result<Vec<u8>, BlobError<String>> {
            if crate::durable::sha256_hex(&self.0) == reference { Ok(self.0.clone()) } else { Err(BlobError::Permanent) }
        }

        fn office_text(&self, _: &[u8], filename: &str) -> Result<Option<String>, String> {
            Err(format!("no office part in these rows: {filename}"))
        }
    }

    fn golden_blob(golden: &Value) -> OneBlob {
        OneBlob(golden["blob"].as_str().unwrap().as_bytes().to_vec())
    }

    /// The cases of `vectors/checkpoint_splice.cases.json` against what v1.4.5 leaves for them
    /// (`vectors/checkpoint_splice.mjs`).
    #[test]
    fn splices_as_v145_recovery_does() {
        let cases: Map<String, Value> = serde_json::from_str(include_str!("vectors/checkpoint_splice.cases.json")).unwrap();
        let golden: Map<String, Value> = serde_json::from_str(include_str!("vectors/checkpoint_splice.json")).unwrap();
        assert_eq!(cases.len(), golden.len());
        for (name, case) in &cases {
            let durable = case["durable"].as_object().unwrap();
            let messages = durable["messages"].as_array().unwrap();
            let got = splice(durable, messages, case["checkpoint"].as_object().unwrap(), &OneBlob(Vec::new())).unwrap();
            let want = &golden[name];
            match got {
                Splice::Replay { keep, turn } => {
                    assert_eq!(want["action"], "replay", "{name}");
                    let spliced: Vec<Value> = messages[..keep].iter().cloned().chain(turn).collect();
                    // Byte-exact: key order included.
                    assert_eq!(
                        serde_json::to_string(&spliced).unwrap(),
                        serde_json::to_string(&want["messages"]).unwrap(),
                        "{name}"
                    );
                }
                Splice::Covered => assert_eq!(want["action"], "covered", "{name}"),
                Splice::Conflict => assert_eq!(want["action"], "conflict", "{name}"),
            }
        }
    }

    /// A checkpoint whose context state v1.4.5 captured: the spliced transcript and the header
    /// are those v1.4.5 recovery leaves (`vectors/checkpoint_restore.mjs`), key order included.
    #[test]
    fn restores_the_header_as_v145_recovery_does() {
        let golden: Value = serde_json::from_str(include_str!("vectors/checkpoint_restore.json")).unwrap();
        let mut header = golden["durable"].as_object().unwrap().clone();
        let messages = header.shift_remove("messages").unwrap();
        let messages = messages.as_array().unwrap();
        let checkpoint = &golden["checkpoint"];
        let blobs = golden_blob(&golden);
        let Splice::Replay { keep, turn } = splice(&header, messages, checkpoint.as_object().unwrap(), &blobs).unwrap() else {
            panic!("a replay");
        };
        let rows: Vec<Value> = messages[..keep].iter().cloned().chain(turn).collect();
        assert_eq!(serde_json::to_string(&rows).unwrap(), serde_json::to_string(&golden["messages"]).unwrap());
        // Without `boundary` it is a legacy checkpoint: replayed on the prefix its context state
        // signed (v1.4.5's own signature), a conflict on any other.
        let mut legacy = checkpoint.as_object().unwrap().clone();
        legacy.shift_remove("boundary");
        legacy.shift_remove("base");
        assert_eq!(splice(&header, messages, &legacy, &blobs).unwrap(), Splice::Replay { keep, turn: rows[keep..].to_vec() });
        // The stored text is part of the signed prefix: without its blob the prefix differs.
        assert_eq!(splice(&header, messages, &legacy, &OneBlob(Vec::new())).unwrap(), Splice::Conflict);
        legacy["contextState"]["committedPrefixSignature"] = json!("other");
        assert_eq!(splice(&header, messages, &legacy, &blobs).unwrap(), Splice::Conflict);

        restore_header(&mut header, &rows, checkpoint, &blobs, 0.0).unwrap();
        assert_eq!(serde_json::to_string(&header).unwrap(), serde_json::to_string(&golden["header"]).unwrap());
    }

    /// Without its context state's slice, the reading stays as it was and is marked unanchored
    /// when it holds tokens; the marker still goes.
    #[test]
    fn an_unprovable_reading_is_marked_unanchored() {
        let golden: Value = serde_json::from_str(include_str!("vectors/checkpoint_restore.json")).unwrap();
        let mut header = golden["durable"].as_object().unwrap().clone();
        header.shift_remove("messages");
        header.insert("lastContextTokens".into(), json!(10));
        let mut checkpoint = golden["checkpoint"].clone();
        checkpoint["contextState"]["committedPrefixSignature"] = json!("other");
        restore_header(&mut header, golden["messages"].as_array().unwrap(), &checkpoint, &golden_blob(&golden), 0.0).unwrap();
        assert_eq!(header["contextPressureUnanchoredAfterRestart"], true);
        assert!(!header.contains_key("contextPressureBaselineTokens"));
        assert_eq!(header["providerPrefixBaseline"], json!({"hash":"p1","count":3}));
        assert!(!header.contains_key("activeTurnCheckpoint"));
    }
}
