//! A scoped hit can cite the original only when this payload actually carries
//! its exact body. The stored and prepared messages always keep the full hit.

use std::collections::{HashMap, HashSet};

use mixdog_core_api::domain::provider::{Content, Message, Role};
use sha2::{Digest, Sha256};

pub(super) enum WireUse<'a> {
    Call,
    Result(Option<&'a str>),
}

/// How many calls name each id, and the one result an id has (`None` when several do).
fn transcript_ids(messages: &[Message]) -> (HashMap<&str, usize>, HashMap<&str, Option<&Message>>) {
    let mut calls = HashMap::new();
    let mut results = HashMap::new();
    for message in messages {
        match message.role {
            Role::Assistant => {
                for call in &message.tool_calls {
                    *calls.entry(call.id.as_str()).or_insert(0) += 1;
                }
            }
            Role::Tool => {
                if let Some(id) = message.tool_call_id.as_deref() {
                    results.entry(id).and_modify(|entry| *entry = None).or_insert(Some(message));
                }
            }
            _ => {}
        }
    }
    (calls, results)
}

fn wire_counts<'a>(uses: &[(usize, &'a str, WireUse<'a>)]) -> HashMap<&'a str, (usize, usize)> {
    let mut counts = HashMap::new();
    for (_, id, kind) in uses {
        let (calls, results) = counts.entry(*id).or_insert((0, 0));
        match kind {
            WireUse::Call => *calls += 1,
            WireUse::Result(_) => *results += 1,
        }
    }
    counts
}

pub(super) fn receipts<'a>(
    messages: &[Message],
    wire_id: impl Fn(&str) -> String,
    uses: impl Iterator<Item = (usize, &'a str, WireUse<'a>)>,
) -> Vec<(usize, String)> {
    let plain_result = |message: &Message| message.role == Role::Tool && !message.is_error && message.native_tool_search.is_none();
    if !messages.iter().any(|m| m.scoped_cache_source.is_some()) {
        return Vec::new();
    }
    let (calls, results) = transcript_ids(messages);
    let uses: Vec<_> = uses.collect();
    let wire_counts = wire_counts(&uses);
    let unambiguous = |id: &str| {
        !id.is_empty()
            && calls.get(id) == Some(&1)
            && wire_counts.get(id) == Some(&(1, 1))
            // A projected stand-in is not proof of the original transcript identity.
            && wire_id(id) == id
    };
    let mut called = HashSet::new();
    let mut seen = HashMap::new();
    let mut replacements = Vec::new();
    for (index, id, kind) in uses {
        let body = match kind {
            WireUse::Call => {
                called.insert(id);
                continue;
            }
            WireUse::Result(Some(body)) => body,
            WireUse::Result(None) => continue,
        };
        if !called.contains(id) || !unambiguous(id) {
            continue;
        }
        let Some(Some(message)) = results.get(id) else { continue };
        if !plain_result(message) || !matches!(&message.content, Content::Text(text) if text == body) {
            continue;
        }
        let Some(source) = &message.scoped_cache_source else {
            seen.insert(id, body);
            continue;
        };
        if seen.get(source.call_id.as_str()) == Some(&body)
            && !body.starts_with("[tool output offloaded:")
            && source.body_sha256 == format!("{:x}", Sha256::digest(body.as_bytes()))
        {
            let receipt = format!("Same result as tool call {} above.", source.call_id);
            if receipt.len() < body.len() {
                replacements.push((index, receipt));
            }
        }
    }
    replacements
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::{ScopedCacheSource, ToolCall};

    use super::*;

    const BODY: &str = "a tool result long enough that a receipt for it is shorter than the result itself";

    fn call(id: &str) -> Message {
        let mut message = Message::new(Role::Assistant, Content::Text(String::new()));
        message.tool_calls.push(ToolCall { id: id.into(), name: "grep".into(), arguments: serde_json::json!({}), native_type: None });
        message
    }

    fn result(id: &str, source: Option<&str>) -> Message {
        let mut message = Message::new(Role::Tool, Content::Text(BODY.into()));
        message.tool_call_id = Some(id.into());
        message.scoped_cache_source =
            source.map(|call_id| ScopedCacheSource { call_id: call_id.into(), body_sha256: format!("{:x}", Sha256::digest(BODY.as_bytes())) });
        message
    }

    fn uses(ids: &[&'static str]) -> Vec<(usize, &'static str, WireUse<'static>)> {
        ids.iter().enumerate().flat_map(|(at, id)| [(at * 2, *id, WireUse::Call), (at * 2 + 1, *id, WireUse::Result(Some(BODY)))]).collect()
    }

    #[test]
    fn a_scoped_hit_whose_source_result_is_on_the_wire_becomes_a_receipt() {
        let messages = [call("c1"), result("c1", None), call("c2"), result("c2", Some("c1"))];
        let sent = receipts(&messages, |id| id.to_owned(), uses(&["c1", "c2"]).into_iter());
        assert_eq!(sent, [(3, "Same result as tool call c1 above.".to_owned())]);
    }

    #[test]
    fn a_projected_call_id_is_no_proof_of_the_original_identity() {
        let messages = [call("c1"), result("c1", None), call("c2"), result("c2", Some("c1"))];
        let sent = receipts(&messages, |id| format!("{id}-projected"), uses(&["c1", "c2"]).into_iter());
        assert!(sent.is_empty());
    }

    #[test]
    fn a_transcript_without_a_scoped_hit_has_no_receipts() {
        let messages = [call("c1"), result("c1", None)];
        assert!(receipts(&messages, |id| id.to_owned(), uses(&["c1"]).into_iter()).is_empty());
    }
}
