//! Thinking replay is bound to the request prefix that produced it (Node
//! `session/thinking-binding.mjs`, with `assistantMessageWithoutThinkingReplay` of
//! `thinking-replay-recovery.mjs` and `collectAssistantToolCallIds` of `context-tool-pairs.mjs`).
//!
//! An Anthropic thinking block's signature records the conversation prefix it was generated under:
//! the system prompt, the tool set and every earlier message. Where the runtime itself changes that
//! prefix (a folded or migrated prompt, a tool-surface migration) the stored thinking can never be
//! replayed again, so it is stripped once, at that boundary. One round is never stripped: a trailing
//! tool round whose next request still continues it must go back starting with its thinking, so
//! when the prefix changed under such a round the round is ended explicitly instead.
//!
//! Messages are the stored bodies (`Value`); every function replaces changed messages and never
//! mutates, and reports whether anything changed.

use serde_json::{json, Value};

const THINKING_BLOCK_TYPES: [&str; 2] = ["thinking", "redacted_thinking"];

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

/// `collectAssistantToolCallIds`: the call ids of an assistant turn, de-duplicated in order, from
/// its `toolCalls` and the `tool_use` blocks of `assistantBlocks` and `content`.
pub fn collect_assistant_tool_call_ids(message: &Value) -> Vec<String> {
    if role(message) != Some("assistant") {
        return Vec::new();
    }
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: Option<&Value>| {
        if let Some(id) = id.and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_owned());
            }
        }
    };
    if let Some(calls) = message.get("toolCalls").and_then(Value::as_array) {
        calls.iter().for_each(|call| add(call.get("id")));
    }
    for blocks in [message.get("assistantBlocks"), message.get("content")] {
        if let Some(blocks) = blocks.and_then(Value::as_array) {
            blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")).for_each(|b| add(b.get("id")));
        }
    }
    ids
}

fn calls_tools(message: &Value) -> bool {
    !collect_assistant_tool_call_ids(message).is_empty()
        || message
            .get("providerReplay")
            .and_then(|r| r.get("items"))
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|i| i.get("type").and_then(Value::as_str) == Some("tool_use")))
}

/// `openToolRoundStart`: where the trailing open tool round starts (the assistant/tool run that ends
/// with the latest assistant turn's results; later user or notification input may follow), `None`
/// when the latest assistant turn is a final reply. Read from the persisted transcript alone.
pub fn open_tool_round_start(messages: &[Value]) -> Option<usize> {
    let latest = messages.iter().rposition(|m| role(m) == Some("assistant"))?;
    if !calls_tools(&messages[latest]) {
        return None;
    }
    let mut start = latest;
    while start > 0 && matches!(role(&messages[start - 1]), Some("assistant" | "tool")) {
        start -= 1;
    }
    Some(start)
}

fn keeps_replay_block(block: &Value) -> bool {
    let kind = block.get("type").and_then(Value::as_str);
    let thinking = kind.is_some_and(|k| THINKING_BLOCK_TYPES.contains(&k));
    let empty_text = kind == Some("text") && block.get("text").and_then(Value::as_str).is_none_or(str::is_empty);
    !thinking && !empty_text
}

/// `strippedList`: the kept blocks when some were dropped.
fn stripped_list(list: Option<&Value>) -> Option<Vec<Value>> {
    let list = list?.as_array().filter(|l| !l.is_empty())?;
    let kept: Vec<Value> = list.iter().filter(|b| keeps_replay_block(b)).cloned().collect();
    (kept.len() != list.len()).then_some(kept)
}

/// `assistantMessageWithoutThinkingReplay`: the replay-free copy of one assistant message, `None`
/// when it carries nothing the API could have objected to.
pub fn assistant_message_without_thinking_replay(message: &Value) -> Option<Value> {
    if role(message) != Some("assistant") {
        return None;
    }
    let mut next = message.as_object()?.clone();
    let mut changed = false;
    if let Some(items) = stripped_list(message.get("providerReplay").and_then(|r| r.get("items"))) {
        changed = true;
        // An assistant turn whose ordered replay is now empty has nothing to replay verbatim; the
        // flattened content/toolCalls lowering takes over.
        if items.is_empty() {
            next.shift_remove("providerReplay");
        } else {
            let mut replay = message["providerReplay"].as_object().cloned().unwrap_or_default();
            replay.insert("items".into(), Value::Array(items));
            next.insert("providerReplay".into(), Value::Object(replay));
        }
    }
    if let Some(blocks) = stripped_list(message.get("assistantBlocks")) {
        changed = true;
        if blocks.is_empty() {
            next.shift_remove("assistantBlocks");
        } else {
            next.insert("assistantBlocks".into(), Value::Array(blocks));
        }
    }
    if message.get("thinkingBlocks").and_then(Value::as_array).is_some_and(|b| !b.is_empty()) {
        changed = true;
        next.shift_remove("thinkingBlocks");
    }
    changed.then(|| Value::Object(next))
}

/// `withoutThinkingReplay`: the messages without Anthropic thinking replay; text and tool calls stay.
/// The trailing open tool round keeps its thinking: everything stripped is a leading run, which
/// leaves the round's own blocks valid. `changed` is false when nothing was.
pub fn without_thinking_replay(messages: &[Value]) -> (Vec<Value>, bool) {
    let end = open_tool_round_start(messages).unwrap_or(messages.len());
    let mut changed = false;
    let out = messages
        .iter()
        .enumerate()
        .map(|(index, message)| match (index < end).then(|| assistant_message_without_thinking_replay(message)).flatten() {
            Some(stripped) => {
                changed = true;
                stripped
            }
            None => message.clone(),
        })
        .collect();
    (out, changed)
}

/// The runtime turn that ends an open tool round: a context ack, so the transcript never shows it
/// and Compact never reads it as a reply.
fn tool_round_closure() -> Value {
    json!({ "role": "assistant", "content": ".", "meta": { "source": "context-ack", "synthetic": true } })
}

/// `rebindToChangedPrefix`: the messages for a request prefix that changed under them — no thinking
/// replay at all. An open tool round that carries thinking can neither keep it (bound to the old
/// prefix) nor lose it (its continuation must start with it), so it is ended first by a runtime
/// turn right after its last tool result, ahead of any later input; the next request then starts a
/// new turn.
pub fn rebind_to_changed_prefix(messages: &[Value]) -> (Vec<Value>, bool) {
    let Some(open) = open_tool_round_start(messages) else { return without_thinking_replay(messages) };
    let latest = messages.iter().rposition(|m| role(m) == Some("assistant")).map_or(0, |i| i + 1);
    let mut end = latest;
    while role(messages.get(end).unwrap_or(&Value::Null)) == Some("tool") {
        end += 1;
    }
    let round_thinks = messages[open..end].iter().any(|m| assistant_message_without_thinking_replay(m).is_some());
    if !round_thinks {
        return without_thinking_replay(messages);
    }
    let mut with_closure = messages[..end].to_vec();
    with_closure.push(tool_round_closure());
    with_closure.extend_from_slice(&messages[end..]);
    (without_thinking_replay(&with_closure).0, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's real functions over nine transcripts.
    #[test]
    fn thinking_binding_follows_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/thinking_binding.json")).expect("fixture");
        for (name, row) in golden.as_object().unwrap() {
            let messages: Vec<Value> = row["messages"].as_array().unwrap().clone();
            assert_eq!(json!(open_tool_round_start(&messages).map_or(-1, |i| i as i64)), row["open"], "{name} open");
            let (without, changed) = without_thinking_replay(&messages);
            assert_eq!(json!(without), row["without"], "{name} without");
            assert_eq!(!changed, row["without_same"].as_bool().unwrap(), "{name} without changed");
            let (rebound, changed) = rebind_to_changed_prefix(&messages);
            assert_eq!(json!(rebound), row["rebind"], "{name} rebind");
            assert_eq!(!changed, row["rebind_same"].as_bool().unwrap(), "{name} rebind changed");
        }
    }
}
