//! Transcript repair before a provider send, and unique tool-call ids.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;

use crate::message::AgentMessage;

const TOOL_MISSING_STUB: &str = "[Older tool result unavailable after context compaction]";

/// The tool result answering `call_id`: first in the tool block right after
/// the assistant turn, then anywhere later, then anywhere earlier.
fn pick_result<'a>(
    messages: &'a [AgentMessage],
    assistant_idx: usize,
    call_id: &str,
) -> Option<&'a AgentMessage> {
    let mut after_block = assistant_idx + 1;
    while after_block < messages.len() && messages[after_block].role() == Role::Tool {
        if messages[after_block].tool_call_id() == Some(call_id) {
            return Some(&messages[after_block]);
        }
        after_block += 1;
    }
    let is_answer = |m: &&AgentMessage| m.role() == Role::Tool && m.tool_call_id() == Some(call_id);
    messages[after_block.min(messages.len())..]
        .iter()
        .find(is_answer)
        .or_else(|| messages[..assistant_idx].iter().find(is_answer))
}

/// Tool results are placed only by the assistant turn that called them: a
/// loose one (orphaned, duplicated, misplaced) is dropped, a call without a
/// result gets a stub. Non-tool order is kept.
pub fn sanitize_tool_pairs(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    let mut placed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(messages.len());
    for (idx, message) in messages.iter().enumerate() {
        if message.role() == Role::Tool {
            continue;
        }
        out.push(message.clone());
        if message.role() != Role::Assistant {
            continue;
        }
        for id in message.assistant_call_ids() {
            if placed.contains(&id) {
                continue;
            }
            match pick_result(messages, idx, &id) {
                Some(result) => out.push(result.clone()),
                None => {
                    let mut stub = AgentMessage::tool_text(
                        id.clone(),
                        TOOL_MISSING_STUB,
                        crate::message::ToolKind::Normal,
                    );
                    stub.tool_kind = None;
                    out.push(stub);
                }
            }
            placed.insert(id);
        }
    }
    out
}

/// An assistant turn left without results for all its calls (an abort between
/// the assistant push and the tool pushes) is removed with its contiguous tool
/// block; a tool result with no anchoring assistant call is dropped. Returns
/// how many messages were removed.
fn ensure_pairing(messages: &mut Vec<AgentMessage>) -> usize {
    let mut popped = 0;
    while let Some(last_assistant) = messages
        .iter()
        .rposition(|m| m.role() == Role::Assistant && !m.tool_calls().is_empty())
    {
        let mut block_end = last_assistant + 1;
        while block_end < messages.len() && messages[block_end].role() == Role::Tool {
            block_end += 1;
        }
        let block = &messages[last_assistant + 1..block_end];
        let matched = messages[last_assistant]
            .tool_calls()
            .iter()
            .all(|call| block.iter().any(|m| m.tool_call_id() == Some(call.id.as_str())));
        if matched {
            break;
        }
        let removed = block_end - last_assistant;
        messages.drain(last_assistant..block_end);
        popped += removed;
    }
    for i in (0..messages.len()).rev() {
        if messages[i].role() != Role::Tool {
            continue;
        }
        let Some(call_id) = messages[i].tool_call_id().map(str::to_owned) else {
            messages.remove(i);
            popped += 1;
            continue;
        };
        let mut prev = i;
        while prev > 0 && messages[prev - 1].role() == Role::Tool {
            prev -= 1;
        }
        let anchored = prev > 0
            && messages[prev - 1].role() == Role::Assistant
            && messages[prev - 1]
                .tool_calls()
                .iter()
                .any(|call| call.id == call_id);
        if !anchored {
            messages.remove(i);
            popped += 1;
        }
    }
    popped
}

/// Pre-provider transcript repair: reattach valid results, then drop what
/// cannot be paired. Returns whether the transcript changed.
pub fn repair_before_send(messages: &mut Vec<AgentMessage>) -> bool {
    let sanitized = sanitize_tool_pairs(messages);
    let mut changed = sanitized != *messages;
    if changed {
        *messages = sanitized;
    }
    if ensure_pairing(messages) > 0 {
        changed = true;
    }
    changed
}

/// A tool call id is unique within a transcript: local and compatible servers
/// reuse ids across turns, and the pairing repairs drop a second assistant
/// turn that reuses one. A call whose id the history or this round already
/// holds gets the smallest free `<id>-<n>`.
pub struct ToolCallIds {
    taken: HashSet<String>,
}

impl ToolCallIds {
    pub fn new(messages: &[AgentMessage]) -> Self {
        let mut taken = HashSet::new();
        for message in messages {
            if message.role() == Role::Tool
                && let Some(id) = message.tool_call_id()
            {
                taken.insert(id.to_owned());
            }
            taken.extend(message.assistant_call_ids());
        }
        Self { taken }
    }

    pub fn resolve(&mut self, call: &mut ToolCall) {
        if call.id.is_empty() {
            return;
        }
        let original = call.id.clone();
        let mut id = original.clone();
        if self.taken.contains(&id) {
            let mut n = 2;
            while self.taken.contains(&format!("{original}-{n}")) {
                n += 1;
            }
            id = format!("{original}-{n}");
        }
        self.taken.insert(id.clone());
        call.id = id;
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::ToolCall;
    use mixdog_protocol::JsonValue;

    use super::*;
    use crate::message::ToolKind;

    fn call(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "read".into(),
            arguments: JsonValue::Null,
            native_type: None,
        }
    }

    #[test]
    fn dangling_assistant_turn_is_removed_but_later_user_survives() {
        let mut messages = vec![
            AgentMessage::user("go"),
            AgentMessage::assistant("", vec![call("a"), call("b")]),
            AgentMessage::tool_text("a", "ok", ToolKind::Normal),
            AgentMessage::user("new prompt"),
        ];
        // sanitize stubs the missing `b`, so the pair is whole afterwards.
        assert!(repair_before_send(&mut messages));
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[3].tool_call_id(), Some("b"));
        assert_eq!(messages[3].text(), TOOL_MISSING_STUB);
        assert_eq!(messages[4].text(), "new prompt");
    }

    #[test]
    fn orphan_tool_result_is_dropped() {
        let mut messages = vec![
            AgentMessage::user("go"),
            AgentMessage::tool_result("zz", Content::Text("x".into()), ToolKind::Normal),
        ];
        assert!(repair_before_send(&mut messages));
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn reused_ids_get_the_smallest_free_suffix() {
        let history = vec![
            AgentMessage::assistant("", vec![call("call_0")]),
            AgentMessage::tool_text("call_0", "r", ToolKind::Normal),
        ];
        let mut ids = ToolCallIds::new(&history);
        let mut first = call("call_0");
        let mut second = call("call_0");
        ids.resolve(&mut first);
        ids.resolve(&mut second);
        assert_eq!(first.id, "call_0-2");
        assert_eq!(second.id, "call_0-3");
    }
}
