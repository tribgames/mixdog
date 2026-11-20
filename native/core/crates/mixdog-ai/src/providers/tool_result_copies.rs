//! A scoped hit can cite the original only when this payload actually carries
//! its exact body. The stored and prepared messages always keep the full hit.

use std::collections::{HashMap, HashSet};

use mixdog_core_api::domain::provider::{Content, Message, Role};
use sha2::{Digest, Sha256};

pub(super) enum WireUse<'a> {
    Call,
    Result(Option<&'a str>),
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
    let uses: Vec<_> = uses.collect();
    let mut wire_counts = HashMap::new();
    for (_, id, kind) in &uses {
        let (calls, results) = wire_counts.entry(*id).or_insert((0, 0));
        match kind {
            WireUse::Call => *calls += 1,
            WireUse::Result(_) => *results += 1,
        }
    }
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
