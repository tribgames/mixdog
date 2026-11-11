//! Values a tool call marked sensitive — a browser `fill` with `sensitive: true`,
//! such as a verification code read from a mail — remembered per session and
//! replaced by a marker wherever the session's transcript is stored: the
//! session file, the crash-recovery checkpoint and the search copy, earlier
//! records that carried the value included. The live transcript the provider
//! sees is left as sent (its prefix must not change).
//!
//! A value stays known for the life of the process — as long as any plaintext
//! copy of it (the loaded session) can still be written — and is never
//! evicted. In text, replacement is the exact substring, longest spelling
//! first, so a shorter value never splits a longer one.
//!
//! A marker is opaque to every redaction (the one written here, and the one
//! the desktop writes for a saved login): a value is matched whole against
//! the text and replaced unless that occurrence lies entirely inside markers
//! already there, so redacting twice is redacting once and a value such as `e`
//! never rewrites a marker's letters, while a value that contains or spans
//! marker text is still replaced.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::{json_stringify, js_trim_start, number_to_string, value_to_string};
use serde_json::{Map, Value};

use crate::memory::session_search::ingest::SensitiveValues;

pub const MARKER: &str = "[redacted]";
/// What the desktop writes for a Computer Use saved-login password.
pub const SAVED_LOGIN_MARKER: &str = "[saved login]";
const MARKERS: [&str; 2] = [MARKER, SAVED_LOGIN_MARKER];

/// Message fields a provider adapter replays or re-reads as native state.
const REPLAY_FIELDS: [&str; 7] =
    ["providerReplay", "reasoning", "thinkingBlocks", "assistantBlocks", "reasoningItems", "reasoningContent", "providerMetadata"];
/// Opaque provider tokens a tool call may carry.
const SIGNATURE_FIELDS: [&str; 2] = ["thoughtSignature", "thought_signature"];
/// Part types that are encodings, never text.
const MEDIA_TYPES: [&str; 9] =
    ["image", "image_url", "input_image", "file", "input_file", "document", "audio", "input_audio", "video"];

#[derive(Default)]
struct Known {
    version: u64,
    values: BTreeSet<String>,
    /// Longest first.
    spellings: Vec<String>,
}

type Listener = Arc<dyn Fn(u64) + Send + Sync>;

/// Told the id of a session that gained values carried from another one (`carry`).
type CarriedListener = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct Inner {
    by_session: HashMap<String, Known>,
    listeners: HashMap<String, Vec<(u64, Listener)>>,
    next_listener: u64,
    /// Session → the sessions its text went to (`carry`): every value it gains goes there too.
    carries: HashMap<String, BTreeSet<String>>,
}

#[derive(Default)]
pub struct SensitiveStore {
    inner: Mutex<Inner>,
    carried: std::sync::OnceLock<CarriedListener>,
}

/// Stops its listener when dropped.
pub struct Subscription {
    store: Arc<SensitiveStore>,
    session: String,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut inner = self.store.lock();
        if let Some(list) = inner.listeners.get_mut(&self.session) {
            list.retain(|(id, _)| *id != self.id);
            if list.is_empty() {
                inner.listeners.remove(&self.session);
            }
        }
    }
}

fn fill_values(call: &Value) -> Vec<String> {
    let mut args = call.get("arguments").cloned().unwrap_or(Value::Null);
    if let Value::String(text) = &args {
        match serde_json::from_str::<Value>(text) {
            Ok(parsed) => args = parsed,
            Err(_) => return Vec::new(),
        }
    }
    if call.get("name").and_then(Value::as_str) != Some("browser") || args.get("action").and_then(Value::as_str) != Some("fill") {
        return Vec::new();
    }
    let input = match args.get("input") {
        Some(input @ Value::Object(_)) => input,
        _ => &args,
    };
    if input.get("sensitive") != Some(&Value::Bool(true)) {
        return Vec::new();
    }
    let mut values = vec![input.get("text")];
    for field in input.get("fields").and_then(Value::as_array).into_iter().flatten() {
        values.push(field.get("text"));
        values.push(field.get("value"));
    }
    values.into_iter().filter_map(|v| v.and_then(Value::as_str)).filter(|v| !v.is_empty()).map(str::to_owned).collect()
}

/// [start, end) of every marker in `text`, in order.
fn marker_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for marker in MARKERS {
        let mut from = 0;
        while let Some(found) = text[from..].find(marker) {
            let at = from + found;
            spans.push((at, at + marker.len()));
            from = at + marker.len();
        }
    }
    spans.sort_by_key(|span| span.0);
    spans
}

fn next_boundary(text: &str, at: usize) -> usize {
    at + text[at..].chars().next().map_or(1, char::len_utf8)
}

/// `text` with each occurrence of `spelling` replaced by the marker, except
/// one lying entirely inside markers. An occurrence that partly overlaps a
/// marker replaces that marker whole, so no marker is left broken.
fn redact_spelling(text: &str, spelling: &str) -> String {
    let spans = marker_spans(text);
    let mut next = String::new();
    let mut copied = 0;
    let mut at = text.find(spelling);
    while let Some(start) = at {
        let end = start + spelling.len();
        let touched: Vec<&(usize, usize)> = spans.iter().filter(|(from, to)| *from < end && start < *to).collect();
        let mut reach = start;
        for (from, to) in &touched {
            if *from > reach {
                break;
            }
            reach = reach.max(*to);
        }
        if reach >= end {
            let resume = next_boundary(text, start);
            at = text[resume..].find(spelling).map(|found| resume + found);
            continue;
        }
        let from = start.min(touched.first().map_or(start, |s| s.0));
        let to = end.max(touched.last().map_or(end, |s| s.1));
        next.push_str(text.get(copied..from).unwrap_or(""));
        next.push_str(MARKER);
        copied = to;
        at = text[to..].find(spelling).map(|found| to + found);
    }
    next.push_str(&text[copied.min(text.len())..]);
    next
}

/// Every spelling (longest first) replaced, passes repeated until no spelling
/// occurs outside the markers: a replacement can join a spelling that holds
/// marker text (`a[redacted]`) to the text before it. Each replacement lowers
/// the number of characters outside the markers, so the repetition ends.
fn redact_text(text: &str, spellings: &[String]) -> String {
    let mut out = text.to_owned();
    loop {
        let before = out.clone();
        for spelling in spellings {
            out = redact_spelling(&out, spelling);
        }
        if out == before {
            return out;
        }
    }
}

/// Where the longest tail of `text` that is a proper prefix of one of `strings` starts.
fn pending_start(text: &str, strings: &[&str]) -> usize {
    let mut start = text.len();
    for string in strings {
        let boundaries: Vec<usize> = string.char_indices().map(|(i, _)| i).filter(|i| *i > 0).collect();
        for length in boundaries.into_iter().rev() {
            if length > text.len() || length <= text.len() - start {
                continue;
            }
            if text.ends_with(&string[..length]) {
                start = text.len() - length;
                break;
            }
        }
    }
    start
}

/// `start`, moved left to the start of every one of `strings` that lies across it.
fn cover_start(text: &str, mut start: usize, strings: &[&str]) -> usize {
    let mut moved = true;
    while moved {
        moved = false;
        for string in strings {
            let mut from = 0;
            while let Some(found) = text[from..].find(string) {
                let at = from + found;
                if at >= start {
                    break;
                }
                if start < at + string.len() {
                    start = at;
                    moved = true;
                }
                from = next_boundary(text, at);
            }
        }
    }
    start
}

/// How much of the redacted `out` is settled: no later text can change it.
fn settled_end(out: &str, spellings: &[String]) -> usize {
    let spans = marker_spans(out);
    let longest = spellings[0].len();
    let all: Vec<&str> = spellings.iter().map(String::as_str).chain(MARKERS).collect();
    let mut end = pending_start(out, &all);
    let mut moved = true;
    while moved {
        moved = false;
        if let Some((from, _)) = spans.iter().find(|(from, to)| *from < end && end < *to) {
            end = *from;
            moved = true;
        }
        let window = end.saturating_sub(longest.saturating_sub(1));
        let joined = (window..end).find(|&start| {
            if !out.is_char_boundary(start) {
                return false;
            }
            let part = &out[start..end];
            let joins = |spelling: &String| {
                spelling.len() > part.len()
                    && MARKERS.iter().any(|m| spelling.starts_with(&format!("{part}{m}")) || format!("{part}{m}").starts_with(spelling.as_str()))
            };
            spellings.iter().any(joins)
        });
        if let Some(start) = joined {
            end = start;
            moved = true;
        }
    }
    end
}

fn redact_json_value(store: &SensitiveStore, session: &str, value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text_or_json(store, session, text)),
        Value::Number(number) => {
            let spelled = number.as_f64().map_or_else(|| number.to_string(), number_to_string);
            if store.contains(session, &spelled) { Value::String(MARKER.into()) } else { value.clone() }
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| redact_json_value(store, session, item)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), redact_json_value(store, session, item));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Text redacted as text, or — when it is a JSON object, array or string — as
/// the JSON document it is, so it still parses afterwards. A JSON document is
/// judged by its decoded values, never its raw text: an escape spells a value
/// the raw text does not contain.
fn redact_text_or_json(store: &SensitiveStore, session: &str, text: &str) -> String {
    if matches!(js_trim_start(text).chars().next(), Some('{' | '[' | '"'))
        && let Ok(parsed @ (Value::Object(_) | Value::Array(_) | Value::String(_))) = serde_json::from_str::<Value>(text)
    {
        let redacted = redact_json_value(store, session, &parsed);
        return if redacted == parsed { text.to_owned() } else { json_stringify(&redacted) };
    }
    store.redact_text(session, text)
}

/// `isAttachmentReference`: `/^[a-f0-9]{64}$/` over `String(value.attachmentRef || '')` (a falsy
/// reference is the empty text, any other value its JS string form: an array of one hash spells
/// it); a reference is an encoding, never text.
fn is_attachment_reference(part: &Map<String, Value>) -> bool {
    let spelled = match part.get("attachmentRef") {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    };
    spelled.len() == 64 && spelled.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn map_part_text(store: &SensitiveStore, session: &str, part: &Value) -> Value {
    match part {
        Value::String(text) => Value::String(redact_text_or_json(store, session, text)),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str).is_some_and(|t| MEDIA_TYPES.contains(&t)) || is_attachment_reference(map) {
                return part.clone();
            }
            for key in ["text", "content"] {
                if let Some(Value::String(text)) = map.get(key) {
                    let next = redact_text_or_json(store, session, text);
                    let mut out = map.clone();
                    out.insert(key.to_owned(), Value::String(next));
                    return Value::Object(out);
                }
            }
            if let Some(Value::Array(inner)) = map.get("content") {
                let mut out = map.clone();
                out.insert("content".into(), Value::Array(inner.iter().map(|p| map_part_text(store, session, p)).collect()));
                return Value::Object(out);
            }
            part.clone()
        }
        _ => part.clone(),
    }
}

fn has_replay_state(message: &Value) -> bool {
    let Some(map) = message.as_object() else { return false };
    REPLAY_FIELDS.iter().any(|f| map.contains_key(*f))
        || map.get("toolCalls").and_then(Value::as_array).is_some_and(|calls| {
            calls.iter().any(|c| c.as_object().is_some_and(|o| SIGNATURE_FIELDS.iter().any(|f| o.contains_key(*f))))
        })
}

fn replay_state_text(message: &Value) -> String {
    let mut state: Vec<Value> = REPLAY_FIELDS.iter().filter_map(|f| message.get(*f).cloned()).collect();
    for call in message.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
        for field in SIGNATURE_FIELDS {
            if let Some(v) = call.get(field) {
                state.push(v.clone());
            }
        }
    }
    json_stringify(&Value::Array(state))
}

/// The message without provider-native replay state.
fn strip_replay(message: &Value) -> Value {
    let mut out = message.as_object().cloned().unwrap_or_default();
    for field in REPLAY_FIELDS {
        out.shift_remove(field);
    }
    if let Some(Value::Array(calls)) = out.get_mut("toolCalls") {
        for call in calls.iter_mut() {
            if let Value::Object(map) = call {
                for field in SIGNATURE_FIELDS {
                    map.shift_remove(field);
                }
            }
        }
    }
    Value::Object(out)
}

impl SensitiveStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Remembers the sensitive values of the execution calls for `session`
    /// and, when one is new, tells the session's listeners before returning
    /// (so before the call runs). True when the session gained a value.
    pub fn remember(&self, session: &str, calls: &[Value]) -> bool {
        let values: Vec<String> = calls.iter().flat_map(fill_values).collect();
        if session.is_empty() || values.is_empty() {
            return false;
        }
        self.gain(session, values)
    }

    /// Text of `from` went to `to` (a worker's report to its owner): every value `from` holds, and every value it gains
    /// later, is `to`'s too, and so on along `to`'s own carries. `to` is told as by a mark of its own, and the carried
    /// listener ([`Self::on_carried`]) is told each session that gained a value this way.
    pub fn carry(&self, from: &str, to: &str) {
        if from.is_empty() || to.is_empty() || from == to {
            return;
        }
        let values: Vec<String> = {
            let mut inner = self.lock();
            inner.carries.entry(from.to_owned()).or_default().insert(to.to_owned());
            inner.by_session.get(from).map(|known| known.values.iter().cloned().collect()).unwrap_or_default()
        };
        if !values.is_empty() {
            self.gain_carried(&[to.to_owned()], values, from);
        }
    }

    /// The one listener told the id of every session that gains values carried from another (the session directory,
    /// which runs that session's rewrite whether it is loaded, running or not). A second one is refused.
    pub fn on_carried(&self, listener: impl Fn(&str) + Send + Sync + 'static) -> bool {
        self.carried.set(Arc::new(listener)).is_ok()
    }

    /// `values` marked for `session`, then carried along its carries. True when `session` gained one.
    fn gain(&self, session: &str, values: Vec<String>) -> bool {
        let Some(next) = self.add(session, &values) else { return false };
        self.gain_carried(&next, values, session);
        true
    }

    /// `values` reach every session of `targets` and, from each that gains one, its own carries; never back to
    /// `origin` or to a session reached already.
    fn gain_carried(&self, targets: &[String], values: Vec<String>, origin: &str) {
        let mut seen: BTreeSet<String> = BTreeSet::from([origin.to_owned()]);
        let mut queue: Vec<String> = targets.to_vec();
        while let Some(session) = queue.pop() {
            if !seen.insert(session.clone()) {
                continue;
            }
            if let Some(next) = self.add(&session, &values) {
                if let Some(listener) = self.carried.get() {
                    listener(&session);
                }
                queue.extend(next);
            }
        }
    }

    /// Adds `values` to `session`, tells its listeners when one is new and returns the sessions it carries to; `None`
    /// when it gained nothing.
    fn add(&self, session: &str, values: &[String]) -> Option<Vec<String>> {
        let (version, listeners, carries) = {
            let mut inner = self.lock();
            let known = inner.by_session.entry(session.to_owned()).or_default();
            let fresh: Vec<&String> = values.iter().filter(|v| !known.values.contains(*v)).collect();
            if fresh.is_empty() {
                return None;
            }
            let mut ordered: Vec<String> = known.spellings.clone();
            for value in &fresh {
                // As typed, and as a JSON string spells it (an echo may keep arguments as JSON text).
                let quoted = json_stringify(&Value::String((*value).clone()));
                for spelling in [(*value).clone(), quoted[1..quoted.len() - 1].to_owned()] {
                    if !ordered.contains(&spelling) {
                        ordered.push(spelling);
                    }
                }
            }
            let fresh: Vec<String> = fresh.into_iter().cloned().collect();
            known.values.extend(fresh);
            // Longest first; equal lengths keep the order they were first seen in.
            ordered.sort_by_key(|s| std::cmp::Reverse(s.encode_utf16().count()));
            known.spellings = ordered;
            known.version += 1;
            let version = known.version;
            let listeners: Vec<Listener> =
                inner.listeners.get(session).map(|l| l.iter().map(|(_, f)| f.clone()).collect()).unwrap_or_default();
            let carries: Vec<String> = inner.carries.get(session).map(|to| to.iter().cloned().collect()).unwrap_or_default();
            (version, listeners, carries)
        };
        for listener in listeners {
            listener(version);
        }
        Some(carries)
    }

    /// Calls `listener` whenever `session` gains a sensitive value, until the
    /// returned subscription is dropped.
    pub fn on_marked(self: &Arc<Self>, session: &str, listener: impl Fn(u64) + Send + Sync + 'static) -> Subscription {
        let mut inner = self.lock();
        inner.next_listener += 1;
        let id = inner.next_listener;
        inner.listeners.entry(session.to_owned()).or_default().push((id, Arc::new(listener)));
        Subscription { store: self.clone(), session: session.to_owned(), id }
    }

    /// Changes whenever `session` gains a value, so a stored copy made before
    /// is written again in full.
    pub fn version(&self, session: &str) -> u64 {
        self.lock().by_session.get(session).map_or(0, |k| k.version)
    }

    fn spellings(&self, session: &str) -> Vec<String> {
        self.lock().by_session.get(session).map(|k| k.spellings.clone()).unwrap_or_default()
    }

    /// `text` with the session's sensitive values replaced.
    pub fn redact_text(&self, session: &str, text: &str) -> String {
        let spellings = self.spellings(session);
        if spellings.is_empty() { text.to_owned() } else { redact_text(text, &spellings) }
    }

    /// Whether `text` holds one of the session's sensitive values.
    pub fn contains(&self, session: &str, text: &str) -> bool {
        self.spellings(session).iter().any(|s| text.contains(s.as_str()))
    }

    /// Text that is still streaming, redacted, without the part later text can
    /// still change: what of `text` can be journaled now. As the text grows
    /// each result starts the next, and none shows what the finished text's
    /// redaction hides.
    pub fn redact_settled_text(&self, session: &str, text: &str) -> String {
        let spellings = self.spellings(session);
        if spellings.is_empty() {
            return text.to_owned();
        }
        let pending: Vec<&str> = spellings.iter().map(String::as_str).chain(MARKERS).collect();
        let cut = cover_start(text, pending_start(text, &pending), &pending);
        let out = redact_text(&text[..cut], &spellings);
        out[..settled_end(&out, &spellings)].to_owned()
    }

    /// A message's content with the session's values redacted in its text.
    pub fn redact_content(&self, session: &str, content: &Value) -> Value {
        if self.version(session) == 0 {
            return content.clone();
        }
        match content {
            Value::String(text) => Value::String(redact_text_or_json(self, session, text)),
            Value::Array(parts) => Value::Array(parts.iter().map(|p| map_part_text(self, session, p)).collect()),
            Value::Object(map) if map.get("content").is_some_and(Value::is_array) => map_part_text(self, session, content),
            other => other.clone(),
        }
    }

    /// A message as it is stored for `session`.
    pub fn redact_message(&self, session: &str, message: &Value) -> Value {
        if self.version(session) == 0 || !message.is_object() {
            return message.clone();
        }
        let mut out = message.as_object().cloned().unwrap_or_default();
        let mut changed = false;
        if let Some(content) = message.get("content") {
            let next = self.redact_content(session, content);
            changed = next != *content;
            out.insert("content".into(), next);
        }
        if let Some(Value::Array(calls)) = message.get("toolCalls") {
            let next: Vec<Value> = calls
                .iter()
                .map(|call| match call.get("arguments") {
                    Some(args) if call.is_object() => {
                        let redacted = redact_json_value(self, session, args);
                        if redacted == *args {
                            call.clone()
                        } else {
                            let mut map = call.as_object().cloned().unwrap_or_default();
                            map.insert("arguments".into(), redacted);
                            Value::Object(map)
                        }
                    }
                    _ => call.clone(),
                })
                .collect();
            if next != *calls {
                out.insert("toolCalls".into(), Value::Array(next));
                changed = true;
            }
        }
        let replay_holds = has_replay_state(message) && self.contains(session, &replay_state_text(message));
        if !changed && !replay_holds {
            return message.clone();
        }
        let redacted = Value::Object(out);
        if has_replay_state(message) { strip_replay(&redacted) } else { redacted }
    }

    pub fn redact_messages(&self, session: &str, messages: &[Value]) -> Vec<Value> {
        messages.iter().map(|m| self.redact_message(session, m)).collect()
    }
}

impl SensitiveValues for SensitiveStore {
    fn version(&self, session_id: &str) -> Option<String> {
        match SensitiveStore::version(self, session_id) {
            0 => None,
            version => Some(version.to_string()),
        }
    }

    fn redact_messages(&self, session_id: &str, messages: &[Value]) -> Vec<Value> {
        SensitiveStore::redact_messages(self, session_id, messages)
    }

    fn redact_text(&self, session_id: &str, text: &str) -> String {
        SensitiveStore::redact_text(self, session_id, text)
    }
}
