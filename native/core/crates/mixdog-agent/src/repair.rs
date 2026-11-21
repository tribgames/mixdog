//! Transcript repair before a provider send, and unique tool-call ids.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;

use crate::message::AgentMessage;

const TOOL_MISSING_STUB: &str = "[Older tool result unavailable after context compaction]";

/// The tool result answering `call_id`: first in the tool block right after
/// the assistant turn, then anywhere later, then anywhere earlier.
fn pick_result<'a>(messages: &'a [AgentMessage], assistant_idx: usize, call_id: &str) -> Option<&'a AgentMessage> {
    let mut after_block = assistant_idx + 1;
    while after_block < messages.len() && messages[after_block].role() == Role::Tool {
        if messages[after_block].tool_call_id() == Some(call_id) {
            return Some(&messages[after_block]);
        }
        after_block += 1;
    }
    let is_answer = |m: &&AgentMessage| m.role() == Role::Tool && m.tool_call_id() == Some(call_id);
    messages[after_block.min(messages.len())..].iter().find(is_answer).or_else(|| messages[..assistant_idx].iter().find(is_answer))
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
                    let mut stub = AgentMessage::tool_text(id.clone(), TOOL_MISSING_STUB, crate::message::ToolKind::Normal);
                    stub.tool_kind = None;
                    out.push(stub);
                }
            }
            placed.insert(id);
        }
    }
    out
}

fn ensure_pairing(messages: &mut Vec<AgentMessage>) -> usize {
    let mut popped = 0;
    while let Some(last_assistant) = messages.iter().rposition(|m| m.role() == Role::Assistant && !m.tool_calls().is_empty()) {
        let mut block_end = last_assistant + 1;
        while block_end < messages.len() && messages[block_end].role() == Role::Tool {
            block_end += 1;
        }
        let block = &messages[last_assistant + 1..block_end];
        let matched = messages[last_assistant].tool_calls().iter().all(|call| block.iter().any(|m| m.tool_call_id() == Some(call.id.as_str())));
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
        let anchored = prev > 0 && messages[prev - 1].role() == Role::Assistant && messages[prev - 1].tool_calls().iter().any(|call| call.id == call_id);
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
/// turn that reuses one. One of these serves one provider round
/// (`createToolCallIdResolver`): a call keeps its id unless the history, an id
/// this round already handed out or (in the final batch) another call of the
/// batch holds it, and then gets the smallest free `<id>-<n>`.
///
/// A call is seen twice per round: as the stream finishes it ([`Self::resolve`])
/// and in the response's final batch ([`Self::resolve_all`]). The n-th call
/// carrying an original id in the final batch is the n-th one the stream
/// finished, so both get the same new id, while two calls sharing an id stay
/// distinct.
pub struct ToolCallIds {
    history: HashSet<String>,
    handed_out: HashSet<String>,
    by_original: std::collections::HashMap<String, Vec<String>>,
}

impl ToolCallIds {
    pub fn new(messages: &[AgentMessage]) -> Self {
        let mut history = HashSet::new();
        for message in messages {
            if message.role() == Role::Tool
                && let Some(id) = message.tool_call_id()
            {
                history.insert(id.to_owned());
            }
            history.extend(message.assistant_call_ids());
        }
        Self { history, handed_out: HashSet::new(), by_original: std::collections::HashMap::new() }
    }

    fn is_taken(&self, id: &str, reserved: &HashSet<&str>) -> bool {
        self.handed_out.contains(id) || reserved.contains(id) || self.history.contains(id)
    }

    fn allocate(&mut self, call: &mut ToolCall, reserved: &HashSet<&str>) {
        let original = call.id.clone();
        let mut id = original.clone();
        if self.is_taken(&id, &HashSet::new()) {
            let mut n = 2;
            while self.is_taken(&format!("{original}-{n}"), reserved) {
                n += 1;
            }
            id = format!("{original}-{n}");
        }
        self.handed_out.insert(id.clone());
        self.by_original.entry(original).or_default().push(id.clone());
        call.id = id;
    }

    /// A call the stream finished.
    pub fn resolve(&mut self, call: &mut ToolCall) {
        if call.id.is_empty() {
            return;
        }
        self.allocate(call, &HashSet::new());
    }

    /// The final batch of the response.
    pub fn resolve_all(&mut self, calls: &mut [ToolCall]) {
        let originals: Vec<String> = calls.iter().map(|call| call.id.clone()).collect();
        let mut seen: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for (index, call) in calls.iter_mut().enumerate() {
            if call.id.is_empty() {
                continue;
            }
            let original = originals[index].as_str();
            let nth = seen.entry(original).or_insert(0);
            let mapped = self.by_original.get(original).and_then(|ids| ids.get(*nth)).cloned();
            *nth += 1;
            match mapped {
                Some(id) => call.id = id,
                None => {
                    // Ids later in the batch that no earlier pass has placed yet stay theirs.
                    let reserved: HashSet<&str> = originals[index + 1..].iter().map(String::as_str).filter(|id| !id.is_empty()).collect();
                    self.allocate(call, &reserved);
                }
            }
        }
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
        ToolCall { id: id.into(), name: "read".into(), arguments: JsonValue::Null, native_type: None }
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
        let mut messages = vec![AgentMessage::user("go"), AgentMessage::tool_result("zz", Content::Text("x".into()), ToolKind::Normal)];
        assert!(repair_before_send(&mut messages));
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn reused_ids_get_the_smallest_free_suffix() {
        let history = vec![AgentMessage::assistant("", vec![call("call_0")]), AgentMessage::tool_text("call_0", "r", ToolKind::Normal)];
        let mut ids = ToolCallIds::new(&history);
        let mut first = call("call_0");
        let mut second = call("call_0");
        ids.resolve(&mut first);
        ids.resolve(&mut second);
        assert_eq!(first.id, "call_0-2");
        assert_eq!(second.id, "call_0-3");
    }
}
