//! Transcript repair before a provider send, and unique tool-call ids.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;

use crate::message::AgentMessage;

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
                // What every codec sends for a call without a result: the row stored here is lowered to those bytes.
                None => out.push(AgentMessage::new(mixdog_core_api::domain::provider::Message::missing_tool_result(id.clone()))),
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

/// Where a tool call enters a session, and the one place its id is decided: a call's id is one no earlier call of
/// the session had. A provider may give two calls the same id: local and compatible servers reuse ids across turns
/// (`call_0` again), and an id made up for a provider that sends none can come out the same for the same call. One
/// of these serves one provider round (`createToolCallIdResolver`). The calls still in the transcript are known, and a
/// call is told apart from them, from the ids this round already handed out and (in the final batch) from the other
/// calls of the batch. The calls that left it (a compaction took them out) are not known one by one: the session
/// counts the times calls have left ([`Self::in_session`]), a call's id says which count it entered at
/// ([`distinct_id`](mixdog_protocol::tool_call_ids::distinct_id)), and so it equals none of an earlier count. Under
/// such an id the provider's own still goes back to it (`wire_id_map`). Everything after this point (a result's draft,
/// its row, a recovery) names a call by its id alone.
///
/// A call is seen twice per round: as the stream finishes it ([`Self::resolve`])
/// and in the response's final batch ([`Self::resolve_all`]). The n-th call
/// carrying an original id in the final batch is the n-th one the stream
/// finished, so both get the same new id, while two calls sharing an id stay
/// distinct.
pub struct ToolCallIds {
    history: HashSet<String>,
    epoch: u64,
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
        Self { history, epoch: 0, handed_out: HashSet::new(), by_original: std::collections::HashMap::new() }
    }

    /// The round of a session in which calls have left the transcript `epoch` times.
    pub fn in_session(mut self, epoch: u64) -> Self {
        self.epoch = epoch;
        self
    }

    /// The times calls have left a session whose transcript is `messages`, as far as the transcript says: the highest
    /// count one of its calls entered at.
    pub fn epoch_in(messages: &[AgentMessage]) -> u64 {
        messages.iter().flat_map(AgentMessage::assistant_call_ids).map(|id| mixdog_protocol::tool_call_ids::epoch_of(&id)).max().unwrap_or(0)
    }

    fn is_taken(&self, id: &str) -> bool {
        self.handed_out.contains(id) || self.history.contains(id)
    }

    /// The first free id of the call's provider id at this round's count. What it is told apart from is the ids already
    /// held; a call later in the batch needs no place kept: its id is its own provider's text written out
    /// (`distinct_id`), which no id made here for another provider id can equal.
    fn allocate(&mut self, call: &mut ToolCall) {
        use mixdog_protocol::tool_call_ids::distinct_id;
        let original = call.id.clone();
        let mut n = 1;
        let id = loop {
            let id = distinct_id(&original, self.epoch, n);
            if !self.is_taken(&id) {
                break id;
            }
            n += 1;
        };
        self.handed_out.insert(id.clone());
        self.by_original.entry(original).or_default().push(id.clone());
        call.id = id;
    }

    /// A call the stream finished.
    pub fn resolve(&mut self, call: &mut ToolCall) {
        if call.id.is_empty() {
            return;
        }
        self.allocate(call);
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
                None => self.allocate(call),
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
        assert_eq!(messages[3].text(), mixdog_core_api::domain::provider::MISSING_TOOL_RESULT);
        assert!(messages[3].message.is_error, "a missing result is a failed one, as every wire sends it");
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
        assert_eq!(first.id, "call_0~0.2");
        assert_eq!(second.id, "call_0~0.3");
    }

    /// A server may issue an id shaped like one a session makes. It enters as the server's own text, not as a call of
    /// `c` at the first count, so a call the server later names `c` at that count takes a different id, and each goes
    /// back to the server as it gave it.
    #[test]
    fn a_servers_id_shaped_like_a_sessions_enters_as_its_own_text() {
        use mixdog_protocol::tool_call_ids::provider_id;
        let mut issued = call("c~1");
        ToolCallIds::new(&[]).resolve(&mut issued);
        let mut later = call("c");
        ToolCallIds::new(&[AgentMessage::user("summary")]).in_session(1).resolve(&mut later);
        assert_ne!(issued.id, later.id, "two calls, two ids");
        assert_eq!((provider_id(&issued.id).as_ref(), provider_id(&later.id).as_ref()), ("c~1", "c"));
        assert_eq!(ToolCallIds::epoch_in(&[AgentMessage::assistant("", vec![issued])]), 0, "the server's `~1` is no count");
    }

    /// A provider gives a call the id of one the session held earlier and a compaction has since taken out of the
    /// transcript, which no longer shows it. The call enters under an id of its own all the same, and so does every
    /// later call under that provider id, in the same round, in the same count of compactions and after the next. The
    /// provider is still answered under the id it gave.
    #[test]
    fn a_call_under_the_id_of_one_that_left_the_transcript_enters_under_an_id_of_its_own() {
        use mixdog_protocol::tool_call_ids::{OPENAI_CHAT_IDS, wire_id_map};
        let mut entered: Vec<String> = Vec::new();
        // Before any compaction the call keeps its provider's id.
        let mut first = call("call_0");
        ToolCallIds::new(&[]).resolve(&mut first);
        assert_eq!(first.id, "call_0");
        entered.push(first.id);
        // After one, the transcript is the summary alone: nothing in it says `call_0` was ever used.
        let compacted = vec![AgentMessage::user("summary")];
        assert_eq!(ToolCallIds::epoch_in(&compacted), 0);
        let mut ids = ToolCallIds::new(&compacted).in_session(1);
        let (mut again, mut twice, mut other) = (call("call_0"), call("call_0"), call("call_1"));
        ids.resolve(&mut again);
        ids.resolve(&mut twice);
        ids.resolve(&mut other);
        let mut batch = [call("call_0"), call("call_0"), call("call_1")];
        ids.resolve_all(&mut batch);
        assert_eq!([again.id.as_str(), twice.id.as_str(), other.id.as_str()], ["call_0~1", "call_0~1.2", "call_1~1"]);
        assert_eq!(batch.each_ref().map(|call| call.id.as_str()), ["call_0~1", "call_0~1.2", "call_1~1"], "the batch carries what the stream handed out");
        // The next round of the same count sees those calls in its transcript.
        let transcript = vec![AgentMessage::user("summary"), AgentMessage::assistant("", batch.to_vec())];
        assert_eq!(ToolCallIds::epoch_in(&transcript), 1, "a transcript says the count its calls entered at");
        let mut third = call("call_0");
        ToolCallIds::new(&transcript).in_session(1).resolve(&mut third);
        assert_eq!(third.id, "call_0~1.3");
        entered.extend(batch.into_iter().map(|call| call.id).chain([third.id]));
        // After the next compaction, again with nothing of them left in the transcript.
        let mut fourth = call("call_0");
        ToolCallIds::new(&compacted).in_session(2).resolve(&mut fourth);
        assert_eq!(fourth.id, "call_0~2");
        assert_eq!(wire_id_map([fourth.id.as_str()], OPENAI_CHAT_IDS)[&fourth.id], "call_0", "the provider's own id goes back to it");
        entered.push(fourth.id);
        let distinct: HashSet<&String> = entered.iter().collect();
        assert_eq!(distinct.len(), entered.len(), "no id of the session is given twice: {entered:?}");
    }
}
