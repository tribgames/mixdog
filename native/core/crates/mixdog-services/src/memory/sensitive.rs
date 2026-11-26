//! The live transcript the provider sees is left as sent: its prefix must not change.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::{js_trim_start, json_stringify, number_to_string, value_to_string};
use serde_json::{Map, Value};

use crate::memory::session_search::ingest::SensitiveValues;

pub const MARKER: &str = "[redacted]";
/// What the desktop writes for a Computer Use saved-login password.
pub const SAVED_LOGIN_MARKER: &str = "[saved login]";
const MARKERS: [&str; 2] = [MARKER, SAVED_LOGIN_MARKER];

/// Message fields a provider adapter replays or re-reads as native state.
const REPLAY_FIELDS: [&str; 7] = ["providerReplay", "reasoning", "thinkingBlocks", "assistantBlocks", "reasoningItems", "reasoningContent", "providerMetadata"];
/// Opaque provider tokens a tool call may carry.
const SIGNATURE_FIELDS: [&str; 2] = ["thoughtSignature", "thought_signature"];
/// Part types that are encodings, never text.
const MEDIA_TYPES: [&str; 9] = ["image", "image_url", "input_image", "file", "input_file", "document", "audio", "input_audio", "video"];

#[derive(Default)]
struct Known {
    version: u64,
    values: BTreeMap<String, u64>,
    /// Longest first.
    spellings: Vec<String>,
}

impl Known {
    fn gain(&mut self, values: &[String]) -> (bool, u64) {
        let next_version = self.version + 1;
        let mut changed = false;
        for value in values {
            if self.values.contains_key(value) {
                continue;
            }
            self.values.insert(value.clone(), next_version);
            changed = true;
            // An echo may keep the value as JSON string text.
            let quoted = json_stringify(&Value::String(value.clone()));
            for spelling in [value.clone(), quoted[1..quoted.len() - 1].to_owned()] {
                if !self.spellings.contains(&spelling) {
                    self.spellings.push(spelling);
                }
            }
        }
        if !changed {
            let covered = values.iter().filter_map(|v| self.values.get(v).copied()).max().unwrap_or(0);
            return (false, covered);
        }
        // Longest first; equal lengths keep the order they were first seen in.
        self.spellings.sort_by_key(|s| std::cmp::Reverse(s.encode_utf16().count()));
        self.version = next_version;
        (true, self.version)
    }
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

/// Where the marks outlive the process: a carry is written before [`SensitiveStore::carry`] returns, and a gain before any
/// listener hears of it (so before the call that made the mark runs).
pub trait MarkJournal: Send + Sync {
    /// Text of `from` reached `to`.
    fn carried(&self, from: &str, to: &str);
    /// `values` marked for `origin` reached `sessions`, each holding them from the version given.
    fn marked(&self, origin: &str, values: &[String], sessions: &[(String, u64)]);
}

#[derive(Default)]
pub struct SensitiveStore {
    inner: Mutex<Inner>,
    carried: std::sync::OnceLock<CarriedListener>,
    journal: std::sync::OnceLock<Arc<dyn MarkJournal>>,
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
    // The order is by UTF-16 length, which is not the order in bytes (a CJK character is one unit and three bytes).
    let longest = spellings.iter().map(String::len).max().unwrap_or_default();
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

/// JS truthiness of a JSON value (absent is falsy).
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
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
        || map
            .get("toolCalls")
            .and_then(Value::as_array)
            .is_some_and(|calls| calls.iter().any(|c| c.as_object().is_some_and(|o| SIGNATURE_FIELDS.iter().any(|f| o.contains_key(*f)))))
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
        let gained = {
            let mut inner = self.lock();
            let fresh = inner.carries.entry(from.to_owned()).or_default().insert(to.to_owned());
            if fresh && let Some(journal) = self.journal.get() {
                journal.carried(from, to);
            }
            let values: Vec<String> = inner.by_session.get(from).map(|known| known.values.keys().cloned().collect()).unwrap_or_default();
            if values.is_empty() { Vec::new() } else { self.spread_locked(&mut inner, from, &[to.to_owned()], values) }
        };
        self.notify_gained(from, &gained);
    }

    /// Drops all in-memory state for a purged `session` (`by_session`, `listeners`, and `carries`), collapsing
    /// transitive carry edges (`A -> session -> C` becomes `A -> C`) so later carries neither traverse the purged
    /// session nor lose downstream reachability.
    pub fn forget_session(&self, session: &str) {
        if session.is_empty() {
            return;
        }
        let mut inner = self.lock();
        inner.by_session.remove(session);
        inner.listeners.remove(session);
        let outgoing = inner.carries.remove(session).unwrap_or_default();
        let mut empty_sources = Vec::new();
        for (from, targets) in &mut inner.carries {
            if targets.remove(session) {
                for to in &outgoing {
                    if to != from && to != session {
                        targets.insert(to.clone());
                    }
                }
            }
            if targets.is_empty() {
                empty_sources.push(from.clone());
            }
        }
        for from in empty_sources {
            inner.carries.remove(&from);
        }
    }

    /// The one listener told the id of every session that gains values carried from another (the session directory,
    /// which runs that session's rewrite whether it is loaded, running or not). A second one is refused.
    pub fn on_carried(&self, listener: impl Fn(&str) + Send + Sync + 'static) -> bool {
        self.carried.set(Arc::new(listener)).is_ok()
    }

    /// The one journal the marks are written to (bound by the thread store); a second one is refused.
    pub fn journal_with(&self, journal: Arc<dyn MarkJournal>) -> bool {
        self.journal.set(journal).is_ok()
    }

    /// Install already durable edges before startup restores any marks. No live callbacks or journal writes.
    pub fn restore_carries(&self, carries: Vec<(String, String)>) {
        let mut inner = self.lock();
        for (from, to) in carries {
            if !from.is_empty() && !to.is_empty() && from != to {
                inner.carries.entry(from).or_default().insert(to);
            }
        }
    }

    /// Restore a durable mark before serving sessions, without publishing it again. Return every session that
    /// owes a scan, even if it already knew the value (e.g. retrying an interrupted settlement).
    pub fn restore(&self, origin: String, mut sessions: Vec<String>, mut values: Vec<String>) -> BTreeSet<String> {
        values.retain(|value| !value.is_empty());
        let mut owed = BTreeSet::new();
        if values.is_empty() {
            return owed;
        }
        sessions.reverse();
        sessions.push(origin);
        let mut inner = self.lock();
        while let Some(session) = sessions.pop() {
            if session.is_empty() || !owed.insert(session.clone()) {
                continue;
            }
            let _ = inner.by_session.entry(session.clone()).or_default().gain(&values);
            // A durable edge may have been added just before the previous process stopped, before it
            // journaled the recipient. The recorded sessions alone are not the recovery boundary.
            if let Some(next) = inner.carries.get(&session) {
                sessions.extend(next.iter().cloned());
            }
        }
        owed
    }

    /// `values` marked for `session`, then carried along its carries. True when `session` gained one.
    fn gain(&self, session: &str, values: Vec<String>) -> bool {
        let gained = {
            let mut inner = self.lock();
            self.spread_locked(&mut inner, session, &[session.to_owned()], values)
        };
        self.notify_gained(session, &gained);
        !gained.is_empty()
    }

    /// Traverses the carry graph from `targets` and publishes `journal.marked` under one `self.lock()` so
    /// `forget_session` cannot interleave mid-BFS or before journaling completes.
    fn spread_locked(&self, inner: &mut Inner, origin: &str, targets: &[String], values: Vec<String>) -> Vec<(String, u64, Vec<Listener>)> {
        if values.is_empty() {
            return Vec::new();
        }
        let is_origin_mark = targets.len() == 1 && targets[0] == origin;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        if !targets.iter().any(|t| t == origin) {
            seen.insert(origin.to_owned());
        }
        let mut queue: Vec<String> = targets.to_vec();
        let mut gained: Vec<(String, u64, Vec<Listener>)> = Vec::new();
        let mut reached: Vec<(String, u64)> = Vec::new();
        while let Some(session) = queue.pop() {
            if !seen.insert(session.clone()) {
                continue;
            }
            let (changed, version) = inner.by_session.entry(session.clone()).or_default().gain(&values);
            if let Some(next) = inner.carries.get(&session) {
                queue.extend(next.iter().cloned());
            }
            if version > 0 {
                reached.push((session.clone(), version));
            }
            if changed {
                let listeners: Vec<Listener> = inner.listeners.get(&session).map(|l| l.iter().map(|(_, f)| f.clone()).collect()).unwrap_or_default();
                gained.push((session, version, listeners));
            }
        }
        if gained.is_empty() && (is_origin_mark || reached.is_empty()) {
            return Vec::new();
        }
        if let Some(journal) = self.journal.get() {
            journal.marked(origin, &values, &reached);
        }
        gained
    }

    fn notify_gained(&self, origin: &str, gained: &[(String, u64, Vec<Listener>)]) {
        for (session, version, listeners) in gained {
            for listener in listeners {
                listener(*version);
            }
            if (session != origin || listeners.is_empty())
                && let Some(listener) = self.carried.get()
            {
                listener(session);
            }
        }
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
        let named = |parts: &[Value]| -> Vec<Value> { parts.iter().map(|p| self.redact_part_names(session, map_part_text(self, session, p))).collect() };
        match content {
            Value::String(text) => Value::String(redact_text_or_json(self, session, text)),
            Value::Array(parts) => Value::Array(named(parts)),
            Value::Object(map) if map.get("content").is_some_and(Value::is_array) => {
                let mut out = map.clone();
                out.insert("content".into(), Value::Array(named(map["content"].as_array().expect("an array"))));
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    /// An attachment's or media part's file name (`name`, `filename`, `title`, and a `path` that ends in it) redacted
    /// as text: the name a person gave the file can spell the value. The attached-files note's record of each file
    /// (`attachmentReference.files[]`, `name` and `path`, rendered into the note's already redacted text) is stored
    /// with the row and published to its clients, so it is redacted the same way
    /// (`benchmarks/rust-core/recorders/node-patches/node-fix-sensitive-attachment-names.patch` makes Node's the same).
    fn redact_part_names(&self, session: &str, part: Value) -> Value {
        let Value::Object(mut map) = part else { return part };
        let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "attachment" || MEDIA_TYPES.contains(&kind) || is_truthy(map.get("attachmentRef")) {
            self.redact_name_keys(session, &mut map);
        }
        if let Some(Value::Array(files)) = map.get_mut("attachmentReference").and_then(|r| r.get_mut("files")) {
            for file in files.iter_mut() {
                if let Value::Object(file) = file {
                    self.redact_name_keys(session, file);
                }
            }
        }
        Value::Object(map)
    }

    fn redact_name_keys(&self, session: &str, map: &mut Map<String, Value>) {
        for key in ["name", "filename", "title", "path"] {
            if let Some(Value::String(name)) = map.get(key) {
                let next = self.redact_text(session, name);
                map.insert(key.to_owned(), Value::String(next));
            }
        }
    }

    fn redact_tool_calls(&self, session: &str, calls: &[Value]) -> Option<Value> {
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
        (next != calls).then_some(Value::Array(next))
    }

    fn redact_task_card(&self, session: &str, message: &Value) -> Option<Value> {
        let card = message.get("meta").and_then(|meta| meta.get("taskCard"))?;
        let next = redact_json_value(self, session, card);
        if next == *card {
            return None;
        }
        let mut meta = message["meta"].as_object().cloned().unwrap_or_default();
        meta.insert("taskCard".into(), next);
        Some(Value::Object(meta))
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
        if let Some(Value::Array(calls)) = message.get("toolCalls")
            && let Some(next) = self.redact_tool_calls(session, calls)
        {
            out.insert("toolCalls".into(), next);
            changed = true;
        }
        if let Some(meta) = self.redact_task_card(session, message) {
            out.insert("meta".into(), meta);
            changed = true;
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

    fn redact_message(&self, session_id: &str, message: &Value) -> Value {
        SensitiveStore::redact_message(self, session_id, message)
    }

    fn redact_text(&self, session_id: &str, text: &str) -> String {
        SensitiveStore::redact_text(self, session_id, text)
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    /// The look-back is as long as the longest spelling in bytes, not the first one's: the spellings run longest first
    /// in UTF-16 units, where a spelling of multi-byte characters is shorter than its bytes.
    #[test]
    fn the_settled_end_looks_back_over_the_longest_spelling_in_bytes() {
        let wide = format!("{}{MARKER}Z", "\u{5bc6}".repeat(6));
        let ascii = format!("abcdefg{MARKER}Z");
        assert!(wide.encode_utf16().count() < ascii.encode_utf16().count() && wide.len() > ascii.len());
        let spellings = vec![ascii, wide];
        // What a later `[redacted]` would join, with the tail that starts one still open.
        let out = format!("{}[red", "\u{5bc6}".repeat(6));
        assert_eq!(settled_end(&out, &spellings), 0);
    }

    #[test]
    fn carry_reports_covered_version_for_already_holding_sessions_without_refiring_listeners() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Default)]
        struct RecordingJournal {
            marked: Mutex<Vec<(String, Vec<String>, Vec<(String, u64)>)>>,
        }

        impl MarkJournal for RecordingJournal {
            fn carried(&self, _from: &str, _to: &str) {}
            fn marked(&self, origin: &str, values: &[String], sessions: &[(String, u64)]) {
                self.marked.lock().unwrap_or_else(PoisonError::into_inner).push((origin.to_owned(), values.to_vec(), sessions.to_vec()));
            }
        }

        let fill = |secret: &str| serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "sensitive": true, "text": secret } });
        let store = Arc::new(SensitiveStore::default());
        let journal = Arc::new(RecordingJournal::default());
        assert!(store.journal_with(journal.clone()));

        let b_marks = Arc::new(AtomicUsize::new(0));
        let b_marks_cb = b_marks.clone();
        let _sub_b = store.on_marked("s-b", move |_| {
            b_marks_cb.fetch_add(1, Ordering::SeqCst);
        });
        let carried_hits = Arc::new(Mutex::new(Vec::<String>::new()));
        let carried_hits_cb = carried_hits.clone();
        assert!(store.on_carried(move |session| {
            carried_hits_cb.lock().unwrap_or_else(PoisonError::into_inner).push(session.to_owned());
        }));

        // B gains secret-1 at version 1, then secret-2 at version 2.
        assert!(store.remember("s-b", &[fill("secret-1")]));
        assert!(store.remember("s-b", &[fill("secret-2")]));
        assert_eq!(b_marks.load(Ordering::SeqCst), 2);
        // Set up downstream edge B -> C (C does not hold secret-1 yet).
        store.carry("s-b", "s-c");
        // Now A gains only secret-1 and carries to B (which already holds secret-1 at version 1, NOT version 2).
        assert!(store.remember("s-a", &[fill("secret-1")]));
        let before_carry_calls = journal.marked.lock().unwrap_or_else(PoisonError::into_inner).len();
        let before_b_marks = b_marks.load(Ordering::SeqCst);
        carried_hits.lock().unwrap_or_else(PoisonError::into_inner).clear();

        store.carry("s-a", "s-b");

        assert_eq!(b_marks.load(Ordering::SeqCst), before_b_marks, "B already held secret-1 and must not re-fire listener");
        assert!(carried_hits.lock().unwrap_or_else(PoisonError::into_inner).is_empty(), "C already gained secret-1 via B -> C");
        let calls = journal.marked.lock().unwrap_or_else(PoisonError::into_inner);
        assert_eq!(calls.len(), before_carry_calls + 1, "carry must report reached already-holding sessions to journal");
        let (origin, values, sessions) = calls.last().unwrap();
        assert_eq!(origin, "s-a");
        assert_eq!(values, &vec!["secret-1".to_owned()]);
        assert!(sessions.contains(&("s-b".to_owned(), 1)), "B must report version 1 covering secret-1: {sessions:?}");
        assert!(sessions.contains(&("s-c".to_owned(), 1)), "C must be reached through B at version 1: {sessions:?}");
    }

    #[test]
    fn forget_session_drops_state_and_collapses_carries_without_revisiting_forgotten_session() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Default)]
        struct RecordingJournal {
            marked: Mutex<Vec<(String, Vec<String>, Vec<(String, u64)>)>>,
        }

        impl MarkJournal for RecordingJournal {
            fn carried(&self, _from: &str, _to: &str) {}
            fn marked(&self, origin: &str, values: &[String], sessions: &[(String, u64)]) {
                self.marked.lock().unwrap_or_else(PoisonError::into_inner).push((origin.to_owned(), values.to_vec(), sessions.to_vec()));
            }
        }

        let fill = |secret: &str| serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "sensitive": true, "text": secret } });
        let store = Arc::new(SensitiveStore::default());
        let journal = Arc::new(RecordingJournal::default());
        assert!(store.journal_with(journal.clone()));

        let b_hits = Arc::new(AtomicUsize::new(0));
        let b_hits_cb = b_hits.clone();
        let _sub_b = store.on_marked("s-b", move |_| {
            b_hits_cb.fetch_add(1, Ordering::SeqCst);
        });

        assert!(store.remember("s-b", &[fill("secret-b")]));
        store.carry("s-a", "s-b");
        store.carry("s-b", "s-c");
        assert_eq!(b_hits.load(Ordering::SeqCst), 1);

        store.forget_session("s-b");

        assert_eq!(store.version("s-b"), 0);
        assert!(!store.contains("s-b", "secret-b"));

        let before = journal.marked.lock().unwrap_or_else(PoisonError::into_inner).len();
        assert!(store.remember("s-a", &[fill("secret-after-forget")]));

        assert_eq!(b_hits.load(Ordering::SeqCst), 1, "forgotten session's listener must not fire");
        assert_eq!(store.version("s-b"), 0, "forgotten session must not be traversed by later carries");
        assert!(store.contains("s-c", "secret-after-forget"), "collapsed transitive carry A -> C must still deliver to C");

        let calls = journal.marked.lock().unwrap_or_else(PoisonError::into_inner);
        assert_eq!(calls.len(), before + 1);
        let (_, _, sessions) = calls.last().unwrap();
        assert!(!sessions.iter().any(|(s, _)| s == "s-b"), "journal must not receive forgotten s-b: {sessions:?}");
        assert!(sessions.iter().any(|(s, _)| s == "s-c"), "journal must receive surviving downstream s-c: {sessions:?}");
    }

    #[test]
    fn spread_holds_store_lock_across_bfs_and_journal_marked_and_releases_before_listeners() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;

        struct LockingSpyJournal {
            store: Arc<SensitiveStore>,
            carried_locked: AtomicBool,
            marked_locked: AtomicBool,
            armed_forget: AtomicBool,
            forget_done: Arc<AtomicBool>,
            reached: Mutex<Vec<String>>,
            forget_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
        }

        impl MarkJournal for LockingSpyJournal {
            fn carried(&self, _from: &str, _to: &str) {
                if self.store.inner.try_lock().is_err() {
                    self.carried_locked.store(true, Ordering::SeqCst);
                }
            }

            fn marked(&self, _origin: &str, _values: &[String], sessions: &[(String, u64)]) {
                assert!(self.store.inner.try_lock().is_err(), "SensitiveStore::lock() must be held during journal.marked");
                self.marked_locked.store(true, Ordering::SeqCst);
                *self.reached.lock().unwrap_or_else(PoisonError::into_inner) = sessions.iter().map(|(s, _)| s.clone()).collect();
                if self.armed_forget.swap(false, Ordering::SeqCst) {
                    let store = self.store.clone();
                    let done = self.forget_done.clone();
                    let (tx, rx) = mpsc::channel();
                    let handle = std::thread::spawn(move || {
                        let _ = tx.send(());
                        store.forget_session("s-b");
                        done.store(true, Ordering::SeqCst);
                    });
                    rx.recv().unwrap();
                    // Give the spawned thread a chance to hit SensitiveStore::lock() while journal.marked is active.
                    std::thread::yield_now();
                    assert!(!self.forget_done.load(Ordering::SeqCst), "forget_session(s-b) must block until spread + journal.marked completes");
                    *self.forget_handle.lock().unwrap_or_else(PoisonError::into_inner) = Some(handle);
                }
            }
        }

        let store = Arc::new(SensitiveStore::default());
        let forget_done = Arc::new(AtomicBool::new(false));
        let journal = Arc::new(LockingSpyJournal {
            store: store.clone(),
            carried_locked: AtomicBool::new(false),
            marked_locked: AtomicBool::new(false),
            armed_forget: AtomicBool::new(false),
            forget_done: forget_done.clone(),
            reached: Mutex::default(),
            forget_handle: Mutex::default(),
        });
        assert!(store.journal_with(journal.clone()));

        let listener_unlocked = Arc::new(AtomicBool::new(false));
        let listener_unlocked_cb = listener_unlocked.clone();
        let store_for_listener = store.clone();
        let _sub_a = store.on_marked("s-a", move |_| {
            // Re-acquiring `SensitiveStore::lock()` on the same thread proves the lock was dropped before firing listeners.
            assert!(store_for_listener.version("s-a") > 0);
            listener_unlocked_cb.store(true, Ordering::SeqCst);
        });
        let carried_unlocked = Arc::new(AtomicBool::new(false));
        let carried_unlocked_cb = carried_unlocked.clone();
        let store_for_carried = store.clone();
        assert!(store.on_carried(move |_| {
            assert!(store_for_carried.version("s-c") > 0);
            carried_unlocked_cb.store(true, Ordering::SeqCst);
        }));

        store.carry("s-a", "s-b");
        store.carry("s-b", "s-c");
        assert!(journal.carried_locked.load(Ordering::SeqCst));

        journal.armed_forget.store(true, Ordering::SeqCst);
        let fill = |secret: &str| serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "sensitive": true, "text": secret } });
        assert!(store.remember("s-a", &[fill("secret-atomic")]));

        if let Some(handle) = journal.forget_handle.lock().unwrap_or_else(PoisonError::into_inner).take() {
            handle.join().unwrap();
        }

        assert!(journal.marked_locked.load(Ordering::SeqCst));
        assert!(forget_done.load(Ordering::SeqCst));
        assert!(listener_unlocked.load(Ordering::SeqCst));
        assert!(carried_unlocked.load(Ordering::SeqCst));

        let reached = journal.reached.lock().unwrap_or_else(PoisonError::into_inner).clone();
        assert_eq!(reached.into_iter().collect::<BTreeSet<_>>(), BTreeSet::from(["s-a".to_owned(), "s-b".to_owned(), "s-c".to_owned()]));
        assert_eq!(store.version("s-b"), 0, "forget_session(s-b) ran after journal.marked and s-b was not recreated");
        assert!(store.contains("s-c", "secret-atomic"), "downstream s-c received the value");

        // Subsequent mark on s-a must traverse collapsed A -> C directly without recreating s-b.
        assert!(store.remember("s-a", &[fill("secret-after")]));
        assert_eq!(store.version("s-b"), 0);
        assert!(store.contains("s-c", "secret-after"));
    }
}
