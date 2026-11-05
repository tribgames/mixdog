//! The ids a compaction took out of the model context (Node
//! `compactionArchiveProjection` + `droppedIdentitySummary`): the stable ids of
//! the messages whose text left, and the tool calls that left, in `before`
//! order. The log keeps every pre-compaction item; these ids tell the store
//! which rows to show as archived.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Role;
use mixdog_js::js_trim;

use crate::env::Dropped;
use crate::message::AgentMessage;

fn has_text(content: &Content) -> bool {
    match content {
        Content::Text(text) => !js_trim(text).is_empty(),
        Content::Parts(parts) => {
            parts.iter().any(|part| matches!(part, ContentPart::Text(text) if !js_trim(text).is_empty()))
        }
    }
}

fn push_unique(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|existing| existing == id) {
        list.push(id.to_owned());
    }
}

/// Node's `droppedMessages` (messages with an id absent from `after`) and
/// `droppedIdentities`; both are empty together when nothing visible left
/// (the archive is not prepared, so Node reports 0 and null).
pub fn dropped_summary(before: &[AgentMessage], after: &[AgentMessage]) -> (u64, Option<Dropped>) {
    let Some(dropped) = dropped_identities(before, after) else {
        return (0, None);
    };
    let count = before
        .iter()
        .filter_map(|m| m.message_id.as_deref().filter(|id| !id.is_empty()))
        .filter(|id| !after.iter().any(|copy| copy.message_id.as_deref() == Some(*id)))
        .count();
    (count as u64, Some(dropped))
}

/// `None` when nothing identifiable left the context (a rewrite-only pass).
pub fn dropped_identities(before: &[AgentMessage], after: &[AgentMessage]) -> Option<Dropped> {
    let mut message_ids: Vec<String> = Vec::new();
    let mut call_ids: Vec<String> = Vec::new();
    let mut projected = false;
    for message in before {
        let Some(id) = message.message_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let copies: Vec<&AgentMessage> =
            after.iter().filter(|copy| copy.message_id.as_deref() == Some(id)).collect();
        let lost: Vec<&str> = if copies.is_empty() {
            message.tool_calls().iter().map(|call| call.id.as_str()).filter(|c| !c.is_empty()).collect()
        } else {
            message
                .tool_calls()
                .iter()
                .map(|call| call.id.as_str())
                .filter(|c| !c.is_empty())
                .filter(|c| !copies.iter().any(|copy| copy.tool_calls().iter().any(|k| k.id == *c)))
                .collect()
        };
        let lost_text = copies.is_empty()
            || (has_text(&message.message.content) && !copies.iter().any(|copy| has_text(&copy.message.content)));
        if lost.is_empty() && !lost_text {
            continue;
        }
        projected = true;
        if lost_text {
            push_unique(&mut message_ids, id);
        }
        for call in lost {
            push_unique(&mut call_ids, call);
        }
        if message.message.role == Role::Tool
            && let Some(result) = message.message.tool_call_id.as_deref().filter(|r| !r.is_empty())
        {
            push_unique(&mut call_ids, result);
        }
    }
    projected.then_some(Dropped { message_ids, call_ids })
}
