//! The cache layout of a final Anthropic Messages body: every `cache_control` marker in wire order (tools, system,
//! messages), the prefix digest after each block, and the marker that covers the owning transcript.
//!
//! The digest chain is the provider's lookup key as far as the wire shows it: the model, then each block with its
//! `cache_control` left out (an entry written under a marker is read later from the same block unmarked), with the
//! cache-affecting options (`thinking`, `tool_choice`) placed ahead of the messages so a change of them reaches every
//! message entry and none of the system's. A message whose content is a plain string is the one text block it is sent as
//! once marked.

use mixdog_core_api::domain::cache_tail::{Digest, Marker, WireManifest, Zone, TTL_1H_MS, TTL_5M_MS};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

/// The hasher as a writer: values are serialized straight into it, with no intermediate buffer.
struct Feed<'a>(&'a mut Sha256);

impl std::io::Write for Feed<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn feed_bytes(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

/// A JSON value is self-delimiting; the separator keeps adjacent values apart.
fn feed_value<T: Serialize + ?Sized>(hasher: &mut Sha256, value: &T) {
    let _ = serde_json::to_writer(Feed(hasher), value);
    hasher.update([0x1e]);
}

/// A block as its entry is keyed: every field but `cache_control`. Returns the marker's lifetime, when it has one.
fn feed_block(hasher: &mut Sha256, role: Option<&str>, block: &Value) -> Option<u64> {
    if let Some(role) = role {
        feed_bytes(hasher, role.as_bytes());
    }
    match block {
        Value::Object(map) => {
            for (key, value) in map.iter().filter(|(key, _)| key.as_str() != "cache_control") {
                feed_bytes(hasher, key.as_bytes());
                feed_value(hasher, value);
            }
            map.get("cache_control").map(|control| match control.get("ttl").and_then(Value::as_str) {
                Some("1h") => TTL_1H_MS,
                _ => TTL_5M_MS,
            })
        }
        Value::String(text) => {
            feed_bytes(hasher, b"type");
            feed_value(hasher, "text");
            feed_bytes(hasher, b"text");
            feed_value(hasher, text.as_str());
            None
        }
        other => {
            feed_value(hasher, other);
            None
        }
    }
}

struct Chain {
    hasher: Sha256,
    manifest: WireManifest,
}

impl Chain {
    fn block(&mut self, zone: Zone, role: Option<&str>, block: &Value) {
        let ttl = feed_block(&mut self.hasher, role, block);
        let digest = Digest(self.hasher.clone().finalize().into());
        self.manifest.boundaries.push(digest);
        if let Some(ttl_ms) = ttl {
            self.manifest.markers.push(Marker { zone, ttl_ms, block: self.manifest.boundaries.len() - 1, digest });
        }
    }
}

/// The manifest of `body`, the JSON object an Anthropic attempt sends.
pub fn anthropic(body: &Value) -> WireManifest {
    body.as_object().map_or_else(WireManifest::default, of_body)
}

/// The manifest of the body the encoder holds before it serializes it: no parse of the bytes it sends.
pub fn of_body(body: &Map<String, Value>) -> WireManifest {
    let mut chain = Chain { hasher: Sha256::new(), manifest: WireManifest::default() };
    feed_bytes(&mut chain.hasher, b"anthropic-messages");
    feed_value(&mut chain.hasher, body.get("model").unwrap_or(&Value::Null));
    for tool in body.get("tools").and_then(Value::as_array).into_iter().flatten() {
        chain.block(Zone::Tools, None, tool);
    }
    match body.get("system") {
        Some(Value::Array(blocks)) => blocks.iter().for_each(|block| chain.block(Zone::System, None, block)),
        Some(text @ Value::String(_)) => chain.block(Zone::System, None, text),
        _ => {}
    }
    for key in ["thinking", "tool_choice"] {
        feed_bytes(&mut chain.hasher, key.as_bytes());
        feed_value(&mut chain.hasher, body.get(key).unwrap_or(&Value::Null));
    }
    let messages = body.get("messages").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        match message.get("content") {
            Some(Value::Array(blocks)) => blocks.iter().for_each(|block| chain.block(Zone::Messages, Some(role), block)),
            Some(content) => chain.block(Zone::Messages, Some(role), content),
            None => {}
        }
    }
    let mut manifest = chain.manifest;
    manifest.tail = manifest.markers.iter().rposition(|m| m.zone == Zone::Messages);
    manifest
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body(messages: Value) -> Value {
        json!({
            "model": "claude-x",
            "system": [{ "type": "text", "text": "sys", "cache_control": { "type": "ephemeral", "ttl": "1h" } }],
            "messages": messages,
            "tools": [{ "name": "t", "input_schema": {} }],
        })
    }

    #[test]
    fn markers_follow_wire_order_and_the_tail_is_the_last_message_marker() {
        let manifest = anthropic(&body(json!([
            { "role": "user", "content": "hi" },
            { "role": "assistant", "content": [{ "type": "text", "text": "yo" }] },
            { "role": "user", "content": [{ "type": "text", "text": "go", "cache_control": { "type": "ephemeral" } }] },
        ])));
        assert_eq!(manifest.boundaries.len(), 5, "one tool, one system block, three message blocks");
        assert_eq!(manifest.markers.iter().map(|m| (m.zone, m.ttl_ms, m.block)).collect::<Vec<_>>(), vec![(Zone::System, TTL_1H_MS, 1), (Zone::Messages, TTL_5M_MS, 4)]);
        assert_eq!(manifest.tail_marker().map(|m| m.block), Some(4));
    }

    /// The block an earlier request marked is read by a later one that leaves it unmarked, whether it went out as a string
    /// or as blocks.
    #[test]
    fn an_entry_written_under_a_marker_is_reachable_from_the_same_prefix_unmarked() {
        let first = anthropic(&body(json!([{ "role": "user", "content": [{ "type": "text", "text": "go", "cache_control": { "type": "ephemeral" } }] }])));
        let tail = first.tail_marker().unwrap().clone();
        let next = anthropic(&body(json!([
            { "role": "user", "content": "go" },
            { "role": "assistant", "content": [{ "type": "text", "text": "ok" }] },
            { "role": "user", "content": [{ "type": "text", "text": "more", "cache_control": { "type": "ephemeral" } }] },
        ])));
        assert!(next.reaches(tail.block, tail.digest));
        let edited = anthropic(&body(json!([
            { "role": "user", "content": "went" },
            { "role": "user", "content": [{ "type": "text", "text": "more", "cache_control": { "type": "ephemeral" } }] },
        ])));
        assert!(!edited.reaches(tail.block, tail.digest), "an edit cannot inherit the entry");
    }

    #[test]
    fn changed_tools_or_thinking_reach_no_message_entry() {
        let messages = json!([{ "role": "user", "content": [{ "type": "text", "text": "go", "cache_control": { "type": "ephemeral" } }] }]);
        let base = anthropic(&body(messages.clone()));
        let tail = base.tail_marker().unwrap().clone();
        let mut tools = body(messages.clone());
        tools["tools"] = json!([{ "name": "u", "input_schema": {} }]);
        assert!(!anthropic(&tools).reaches(tail.block, tail.digest));
        let mut thinking = body(messages);
        thinking["thinking"] = json!({ "type": "adaptive" });
        let changed = anthropic(&thinking);
        assert!(!changed.reaches(tail.block, tail.digest));
        assert_eq!(changed.markers[0].digest, base.markers[0].digest, "the system entry is not the thinking's");
    }

    /// The cost of admission on a ~2 MB transcript (about 500k tokens): the previous path parsed the sent bytes back and
    /// serialized every value again into its own buffer; the manifest now reads the encoder's map and streams each value
    /// into the hasher. Run with `--nocapture` to read the numbers; the digests must agree.
    #[test]
    fn the_manifest_of_a_large_body_needs_no_parse_and_no_value_buffers() {
        let messages: Vec<Value> = (0..2_000)
            .flat_map(|n| {
                [
                    json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": format!("t{n}"), "content": "x".repeat(1_000) }] }),
                    json!({ "role": "assistant", "content": [{ "type": "text", "text": format!("answer {n}") }] }),
                ]
            })
            .chain([json!({ "role": "user", "content": [{ "type": "text", "text": "go", "cache_control": { "type": "ephemeral" } }] })])
            .collect();
        let body = body(Value::Array(messages));
        let bytes = serde_json::to_vec(&body).unwrap();
        let map = body.as_object().unwrap();
        let previous = |bytes: &[u8]| {
            // The previous admission: parse the sent bytes, then a `to_vec` per hashed value.
            let parsed: Value = serde_json::from_slice(bytes).unwrap();
            let mut hasher = Sha256::new();
            for message in parsed["messages"].as_array().unwrap() {
                for block in message["content"].as_array().unwrap() {
                    for (_, value) in block.as_object().unwrap() {
                        feed_bytes(&mut hasher, &serde_json::to_vec(value).unwrap());
                    }
                }
            }
            hasher.finalize()
        };
        let rounds = 5;
        let started = std::time::Instant::now();
        for _ in 0..rounds {
            std::hint::black_box(previous(&bytes));
        }
        let before = started.elapsed() / rounds;
        let started = std::time::Instant::now();
        let mut manifest = WireManifest::default();
        for _ in 0..rounds {
            manifest = std::hint::black_box(of_body(map));
        }
        let after = started.elapsed() / rounds;
        eprintln!("manifest of a {} byte body: previous {before:?} per attempt, now {after:?}", bytes.len());
        assert_eq!(manifest, anthropic(&serde_json::from_slice(&bytes).unwrap()), "the same manifest from the map and from the bytes");
        assert!(manifest.tail.is_some());
    }

    #[test]
    fn a_body_with_only_static_markers_has_no_tail() {
        let manifest = anthropic(&body(json!([{ "role": "user", "content": "one shot" }])));
        assert_eq!(manifest.tail, None);
    }
}
