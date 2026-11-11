//! `anthropic-prefix-trace.mjs`: a diagnostic per-block fingerprint of an Anthropic request body: the tools, each system
//! block, the thinking parameters, the cache marker positions and, at each marked message, a chained hash of the messages up
//! to it, as short hashes only. The last two requests per session are kept in memory so a usage-detected cache miss (the agent
//! loop's `actual_cache_miss`) can say which block, marker or message breakpoint moved; the latest one also rides on the
//! session record (`providerPrefixBaseline`), so the first request after a restart is compared with the last one before it.

use std::sync::Mutex;
use std::sync::PoisonError;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const HASH_CHARS: usize = 12;
const MAX_SESSIONS: usize = 256;

/// One request's fingerprint. `chain` (the hash after every message) is kept in memory only.
#[derive(Clone, Debug, PartialEq)]
pub struct Fingerprint {
    tools: String,
    system: Vec<String>,
    params: Option<String>,
    markers: Vec<String>,
    message_marks: Option<Vec<(u64, String)>>,
    chain: Option<Vec<String>>,
}

struct Entry {
    previous: Option<Fingerprint>,
    current: Fingerprint,
}

/// Sessions in insertion order, the oldest first (`bySession`, a `Map` whose first key is evicted).
static BY_SESSION: Mutex<Vec<(String, Entry)>> = Mutex::new(Vec::new());

fn hash(value: &Value) -> String {
    let digest = Sha256::digest(mixdog_js::json_stringify(value).as_bytes());
    let mut hex = format!("{digest:x}");
    hex.truncate(HASH_CHARS);
    hex
}

fn without_marker(block: &Value) -> Value {
    match block {
        Value::Object(map) => Value::Object(map.iter().filter(|(key, _)| *key != "cache_control").map(|(k, v)| (k.clone(), v.clone())).collect()),
        other => other.clone(),
    }
}

/// A message as the cache reads it: markers stripped, a string content as the one text block a marker would turn it into.
fn message_without_markers(message: &Value) -> Value {
    let content = match message.get("content") {
        Some(Value::String(text)) => json!([{ "type": "text", "text": text }]),
        Some(Value::Array(blocks)) => Value::Array(blocks.iter().map(without_marker).collect()),
        Some(other) if !other.is_null() => other.clone(),
        _ => json!([]),
    };
    let mut out = message.as_object().cloned().unwrap_or_default();
    out.insert("content".into(), content);
    Value::Object(out)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` of the JSON values a fingerprint holds.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => mixdog_js::json_stringify(other),
    }
}

fn marker_ttl(marker: &Value) -> String {
    match marker.get("ttl") {
        Some(ttl) if truthy(ttl) => js_string(ttl),
        _ => "5m".into(),
    }
}

/// `anthropicPrefixFingerprint(body)`.
pub fn fingerprint(body: &Map<String, Value>) -> Fingerprint {
    let empty = Vec::new();
    let system = body.get("system").and_then(Value::as_array).unwrap_or(&empty);
    let messages = body.get("messages").and_then(Value::as_array).unwrap_or(&empty);
    let mut markers = Vec::new();
    for (index, block) in system.iter().enumerate() {
        if let Some(marker) = block.get("cache_control").filter(|m| truthy(m)) {
            markers.push(format!("s{index}:{}", marker_ttl(marker)));
        }
    }
    let params = hash(&json!({ "thinking": body.get("thinking").cloned().unwrap_or(Value::Null), "output_config": body.get("output_config").cloned().unwrap_or(Value::Null) }));
    let mut chain = Vec::new();
    let mut message_marks = Vec::new();
    let mut link = params.clone();
    for (index, message) in messages.iter().enumerate() {
        link = hash(&json!([link, message_without_markers(message)]));
        chain.push(link.clone());
        let marked = message.get("content").and_then(Value::as_array).and_then(|blocks| blocks.iter().find_map(|b| b.get("cache_control").filter(|m| truthy(m))));
        if let Some(marker) = marked {
            markers.push(format!("m{index}:{}", marker_ttl(marker)));
            message_marks.push((index as u64, link.clone()));
        }
    }
    Fingerprint {
        tools: hash(body.get("tools").filter(|t| truthy(t)).unwrap_or(&json!([]))),
        system: system.iter().map(|block| hash(&without_marker(block))).collect(),
        params: Some(params),
        markers,
        message_marks: Some(message_marks),
        chain: Some(chain),
    }
}

impl Fingerprint {
    /// `persistableAnthropicPrefix(fingerprint)`: what the session record keeps (hashes only, no chain).
    pub fn persistable(&self) -> Value {
        let mut out = Map::new();
        out.insert("tools".into(), json!(self.tools));
        out.insert("system".into(), json!(self.system));
        out.insert("params".into(), self.params.as_ref().map_or(Value::Null, |p| json!(p)));
        out.insert("markers".into(), json!(self.markers));
        out.insert("messageMarks".into(), self.message_marks.as_ref().map_or(Value::Null, |marks| Value::Array(marks.iter().map(|(i, h)| json!({ "i": i, "h": h })).collect())));
        Value::Object(out)
    }

    /// A record's `providerPrefixBaseline` read back; `None` for anything that is not an object.
    fn from_persisted(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        let strings = |key: &str| map.get(key).and_then(Value::as_array).map(|items| items.iter().map(js_string).collect::<Vec<_>>()).unwrap_or_default();
        Some(Self {
            tools: map.get("tools").map(js_string).unwrap_or_default(),
            system: strings("system"),
            params: map.get("params").filter(|p| truthy(p)).map(js_string),
            markers: strings("markers"),
            message_marks: map.get("messageMarks").and_then(Value::as_array).map(|marks| {
                marks.iter().map(|mark| (mark.get("i").and_then(Value::as_u64).unwrap_or(u64::MAX), mark.get("h").map(js_string).unwrap_or_default())).collect()
            }),
            chain: None,
        })
    }
}

fn sessions() -> std::sync::MutexGuard<'static, Vec<(String, Entry)>> {
    BY_SESSION.lock().unwrap_or_else(PoisonError::into_inner)
}

fn insert(map: &mut Vec<(String, Entry)>, key: String, entry: Entry) {
    map.retain(|(k, _)| *k != key);
    map.push((key, entry));
    if map.len() > MAX_SESSIONS {
        map.remove(0);
    }
}

/// `seedAnthropicPrefix(sessionId, fingerprint)`: a restarted process takes the record's fingerprint as the session's latest
/// request. A no-op once the session has one.
pub fn seed(session: &str, persisted: Option<&Value>) {
    let Some(print) = persisted.filter(|_| !session.is_empty()).and_then(Fingerprint::from_persisted) else { return };
    let mut map = sessions();
    if map.iter().any(|(k, _)| k == session) {
        return;
    }
    insert(&mut map, session.to_owned(), Entry { previous: None, current: print });
}

/// `recordAnthropicPrefix(sessionId, fingerprint)`: `print` becomes the session's latest request, the one before it the previous.
pub fn record(session: Option<&str>, print: Fingerprint) {
    let Some(session) = session.filter(|s| !s.is_empty()) else { return };
    let mut map = sessions();
    let previous = map.iter().find(|(k, _)| k == session).map(|(_, entry)| entry.current.clone());
    insert(&mut map, session.to_owned(), Entry { previous, current: print });
}

/// `persistableAnthropicPrefix(latestAnthropicPrefix(sessionId))`.
pub fn latest_persistable(session: &str) -> Option<Value> {
    sessions().iter().find(|(k, _)| k == session).map(|(_, entry)| entry.current.persistable())
}

/// `anthropicPrefixChanges(sessionId)`: `changedBlocks`, `markersChanged` and (when both sides carry the chain's ends)
/// `lostMessageBreakpoints` between the session's last two requests; `None` before it has two.
pub fn changes(session: &str) -> Option<Map<String, Value>> {
    let map = sessions();
    let entry = &map.iter().find(|(k, _)| k == session)?.1;
    let (previous, current) = (entry.previous.as_ref()?, &entry.current);
    let mut changed = Vec::new();
    if previous.tools != current.tools {
        changed.push("tools".to_owned());
    }
    for index in 0..previous.system.len().max(current.system.len()) {
        if previous.system.get(index) != current.system.get(index) {
            changed.push(format!("s{index}"));
        }
    }
    if let (Some(a), Some(b)) = (&previous.params, &current.params)
        && a != b
    {
        changed.push("params".into());
    }
    // Message markers move every turn; only the system markers are a layout change.
    let system_markers = |print: &Fingerprint| print.markers.iter().filter(|m| m.starts_with('s')).cloned().collect::<Vec<_>>().join(",");
    let mut out = Map::new();
    out.insert("changedBlocks".into(), json!(if changed.is_empty() { "none".to_owned() } else { changed.join(",") }));
    out.insert("markersChanged".into(), json!(system_markers(previous) != system_markers(current)));
    if let (Some(marks), Some(chain)) = (&previous.message_marks, &current.chain) {
        let lost: Vec<String> = marks.iter().filter(|(i, h)| usize::try_from(*i).ok().and_then(|i| chain.get(i)) != Some(h)).map(|(i, _)| format!("m{i}")).collect();
        out.insert("lostMessageBreakpoints".into(), json!(if lost.is_empty() { "none".to_owned() } else { lost.join(",") }));
    }
    Some(out)
}
