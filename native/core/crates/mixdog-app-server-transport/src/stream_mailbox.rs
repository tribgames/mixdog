//! The phone's streaming mailbox (Node `remote-streaming-mailbox.ts` `createRemoteStreamingMailbox` over
//! `desktop-service-protocol.ts` `createLatestStateMailbox`): one latest state per session and one batch timer. A proved text
//! append (`isStreamingTextAppend`, `shared/streaming-text-append.ts`) that ends a quiet spell is sent at once and holds the appends
//! after it for one window of [`BATCH_MS`]; every other transition (a completion, a replay, an approval, a field nobody knows)
//! bypasses the timer and is critical. One frame may be in flight at a time: while the socket has not acknowledged it, publications
//! collapse to the newest, and a critical publication stays critical until a frame carries it (back-pressure never downgrades
//! it). A disconnect clears every delayed state.
//!
//! The mailbox is a state machine on an injected clock: the caller passes `now` and fires [`Mailbox::fire`] when
//! [`Mailbox::due`] is reached; what it sends is returned as [`Frame`]s.

use serde_json::Value;

/// `REMOTE_STREAM_BATCH_MS`.
pub const BATCH_MS: u64 = 90;

/// One frame for the socket: `send(sequence, update, critical)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub sequence: u64,
    pub value: Value,
    pub critical: bool,
}

#[derive(Default)]
pub struct Mailbox {
    previous: Option<Value>,
    delayed: Option<Value>,
    due: Option<u64>,
    critical_pending: bool,
    latest: Option<Value>,
    in_flight: Option<u64>,
    sequence: u64,
}

impl Mailbox {
    /// When the batch timer is due (`timer !== null`).
    pub fn due(&self) -> Option<u64> {
        self.due
    }

    /// `publish(update)`.
    pub fn publish(&mut self, update: Value, now: u64) -> Vec<Frame> {
        let append = is_streaming_text_append(self.previous.as_ref(), &update);
        self.previous = Some(update.clone());
        let mut out = Vec::new();
        if !append {
            self.cancel_delay();
            self.critical_pending = true;
            self.latest = Some(update);
            self.flush(&mut out);
            return out;
        }
        if self.due.is_some() {
            self.delayed = Some(update);
            return out;
        }
        self.send_and_hold(update, now, &mut out);
        out
    }

    /// The batch timer fired at `now`: the window's latest append is sent and opens the next window.
    pub fn fire(&mut self, now: u64) -> Vec<Frame> {
        let mut out = Vec::new();
        if self.due.is_none_or(|due| due > now) {
            return out;
        }
        self.due = None;
        if let Some(latest) = self.delayed.take() {
            self.send_and_hold(latest, now, &mut out);
        }
        out
    }

    /// `acknowledge(sequence)`: the frame in flight left; the newest publication waiting goes.
    pub fn acknowledge(&mut self, sequence: u64) -> Vec<Frame> {
        let mut out = Vec::new();
        if self.in_flight != Some(sequence) {
            return out;
        }
        self.in_flight = None;
        self.flush(&mut out);
        out
    }

    /// `reset(update)`: a resync; the update goes at once, critical.
    pub fn reset(&mut self, update: Value) -> Vec<Frame> {
        self.cancel_delay();
        self.previous = Some(update.clone());
        self.critical_pending = true;
        self.in_flight = None;
        self.latest = Some(update);
        let mut out = Vec::new();
        self.flush(&mut out);
        out
    }

    /// `clear()`: the connection went; nothing delayed or waiting survives it.
    pub fn clear(&mut self) {
        self.cancel_delay();
        self.previous = None;
        self.critical_pending = false;
        self.in_flight = None;
        self.latest = None;
    }

    fn cancel_delay(&mut self) {
        self.due = None;
        self.delayed = None;
    }

    // An append sent now holds the appends after it for one window; the window's latest append ends it and opens the next one.
    fn send_and_hold(&mut self, update: Value, now: u64, out: &mut Vec<Frame>) {
        self.latest = Some(update);
        self.flush(out);
        self.due = Some(now + BATCH_MS);
    }

    fn flush(&mut self, out: &mut Vec<Frame>) {
        if self.in_flight.is_some() {
            return;
        }
        let Some(value) = self.latest.take() else { return };
        self.sequence += 1;
        self.in_flight = Some(self.sequence);
        let critical = std::mem::take(&mut self.critical_pending);
        out.push(Frame { sequence: self.sequence, value, critical });
    }
}

fn record(value: Option<&Value>) -> Option<&serde_json::Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn js_len(text: &str) -> usize {
    mixdog_js::utf16_len(text)
}

/// `partialOf`: an unfinished line with a row, text and a safe non-negative offset.
fn partial_of(state: &serde_json::Map<String, Value>) -> Option<&serde_json::Map<String, Value>> {
    let partial = record(state.get("streamingPartial"))?;
    if partial.get("id").is_none_or(Value::is_null) || partial.get("text").and_then(Value::as_str).is_none_or(str::is_empty) {
        return None;
    }
    let from = partial.get("from").and_then(Value::as_f64)?;
    (from.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&from)).then_some(partial)
}

/// `streamingTailWithPartial`: the live row as painted.
fn tail_with_partial(state: &serde_json::Map<String, Value>) -> Option<Value> {
    let tail = record(state.get("streamingTail"));
    let Some(partial) = partial_of(state) else { return tail.cloned().map(Value::Object) };
    let partial_text = partial.get("text").and_then(Value::as_str).unwrap_or_default();
    let from = partial.get("from").and_then(Value::as_f64).unwrap_or_default();
    let row = match tail {
        Some(tail) => {
            let text = tail.get("text").and_then(Value::as_str);
            text.filter(|text| tail.get("id") == partial.get("id") && tail.get("kind").and_then(Value::as_str) == Some("assistant") && js_len(text) as f64 == from).map(|text| {
                let mut row = tail.clone();
                row.insert("text".to_owned(), Value::String(format!("{text}{partial_text}")));
                Value::Object(row)
            })
        }
        None => {
            let identity = record(partial.get("tail"));
            let settled = state.get("items").and_then(Value::as_array).is_some_and(|items| items.iter().rev().any(|item| record(Some(item)).and_then(|item| item.get("id")) == partial.get("id")));
            identity.filter(|identity| from == 0.0 && identity.get("id") == partial.get("id") && !mixdog_js::js_trim(partial_text).is_empty() && !settled).map(|identity| {
                let mut row = identity.clone();
                row.insert("kind".to_owned(), Value::from("assistant"));
                row.insert("id".to_owned(), partial.get("id").cloned().unwrap_or(Value::Null));
                row.insert("streaming".to_owned(), Value::Bool(true));
                row.insert("text".to_owned(), Value::from(partial_text));
                Value::Object(row)
            })
        }
    };
    row.or_else(|| tail.cloned().map(Value::Object))
}

/// The live answer's text as the phone paints it (`streamingTailWithPartial(update.snapshot).text`), if any.
pub fn painted_text(update: &Value) -> Option<String> {
    let state = record(update.get("snapshot"))?;
    tail_with_partial(state)?.get("text").and_then(Value::as_str).map(str::to_owned)
}

/// `sameFields`: the same keys but `omitted`, each with an equal value.
fn same_fields(before: &serde_json::Map<String, Value>, after: &serde_json::Map<String, Value>, omitted: &[&str]) -> bool {
    let kept = |map: &serde_json::Map<String, Value>| map.keys().filter(|key| !omitted.contains(&key.as_str())).count();
    kept(before) == kept(after) && before.iter().filter(|(key, _)| !omitted.contains(&key.as_str())).all(|(key, value)| after.get(key) == Some(value))
}

/// `isStreamingTextAppend`: the update only grew the live answer's text.
pub fn is_streaming_text_append(before: Option<&Value>, after: &Value) -> bool {
    let Some(before) = record(before) else { return false };
    let Some(after) = after.as_object() else { return false };
    let live = |update: &serde_json::Map<String, Value>| update.get("frameSource").and_then(Value::as_str) == Some("live");
    let lane_end = after.get("laneEnd").is_some_and(|end| !matches!(end, Value::Null | Value::Bool(false)) && end.as_str() != Some(""));
    let (Some(old), Some(next)) = (record(before.get("snapshot")), record(after.get("snapshot"))) else { return false };
    let busy = |state: &serde_json::Map<String, Value>| state.get("busy") == Some(&Value::Bool(true));
    if !live(before) || !live(after) || before.get("sessionId") != after.get("sessionId") || lane_end || !busy(old) || !busy(next) || old.get("items") != next.get("items") {
        return false;
    }
    let (Some(Value::Object(left)), Some(Value::Object(right))) = (tail_with_partial(old), tail_with_partial(next)) else { return false };
    let (Some(left_text), Some(right_text)) = (left.get("text").and_then(Value::as_str), right.get("text").and_then(Value::as_str)) else { return false };
    if left.get("id").is_none_or(Value::is_null) || left.get("id") != right.get("id") || right.get("kind").and_then(Value::as_str) != Some("assistant") || js_len(right_text) <= js_len(left_text) || !right_text.starts_with(left_text) {
        return false;
    }
    same_fields(&left, &right, &["text"]) && same_fields(old, next, &["streamingTail", "streamingPartial"])
}



