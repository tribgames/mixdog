//! The tool-in-flight state of a Responses stream, as Node keeps it: the latched `toolInFlight` flag, the
//! pending calls and the active tool items with their aliases (`openai-ws-response-state/tool-calls.mjs`,
//! `tool-stream-state.mjs`, and the HTTP/SSE collector's `output-items.mjs`). A stream's item boundary reports
//! `tool` while it is set, so the condition is the flag itself and not what the items look like now.

use std::collections::HashMap;
use std::collections::HashSet;

use serde_json::Value;

/// The three collectors Node has for a Responses stream, which differ in what they report and when they settle.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Collector {
    /// `openai-ws-stream` over `openai-ws-response-state` (also the socket of a compatible route).
    WebSocket,
    /// `openai-oauth-http-sse` over `openai-http-sse-response-state`.
    HttpSse,
    /// `openai-compat-responses-events`.
    Compat,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

#[derive(Default)]
pub(super) struct ToolFlight {
    /// `toolInFlight`.
    in_flight: bool,
    /// `pendingCalls`: item id to the call id and name the item carried.
    pending: HashMap<String, (String, String)>,
    /// `createActiveToolItemTracker().items`.
    items: HashSet<String>,
    aliases: HashMap<String, HashSet<String>>,
}

impl ToolFlight {
    pub(super) fn in_flight(&self) -> bool {
        self.in_flight
    }

    /// `pendingToolUse` / `toolInputPending`: a call is pending, active, or latched in flight.
    pub(super) fn pending_tool_use(&self) -> bool {
        !self.pending.is_empty() || !self.items.is_empty() || self.in_flight
    }

    /// The compatible collector's test of the same cutoff (`state.toolInFlight || pendingCalls.size > 0`).
    pub(super) fn compat_pending(&self) -> bool {
        self.in_flight || !self.pending.is_empty()
    }

    /// `activeToolKeys` plus every alias already recorded for any of them.
    fn keys(&self, item: Option<&Value>, fallback: &str) -> HashSet<String> {
        let mut keys: HashSet<String> = HashSet::new();
        let mut add = |value: &str| {
            if !value.is_empty() {
                keys.insert(value.to_owned());
            }
        };
        add(fallback);
        if let Some(item) = item {
            add(text(item, "id"));
            add(text(item, "call_id"));
        }
        for key in keys.clone() {
            if let Some(aliases) = self.aliases.get(&key) {
                keys.extend(aliases.iter().cloned());
            }
        }
        keys
    }

    fn mark(&mut self, item: Option<&Value>, fallback: &str) {
        let keys = self.keys(item, fallback);
        for key in &keys {
            self.items.insert(key.clone());
            self.aliases.insert(key.clone(), keys.clone());
        }
    }

    fn clear(&mut self, item: Option<&Value>, fallback: &str) {
        for key in self.keys(item, fallback) {
            self.items.remove(&key);
            self.aliases.remove(&key);
        }
    }

    /// `settle()` / `recomputeToolInFlight`.
    fn settle(&mut self) {
        self.in_flight = !self.pending.is_empty() || !self.items.is_empty();
    }

    /// `markStarted(item)`: also a server-truncated call, which stays in flight.
    pub(super) fn started(&mut self, item: &Value) {
        self.mark(Some(item), "");
        self.in_flight = true;
    }

    /// `response.output_item.added`.
    pub(super) fn item_added(&mut self, collector: Collector, item: &Value) {
        let id = text(item, "id");
        match text(item, "type") {
            "function_call" => {
                self.started(item);
                self.pending.insert(id.to_owned(), (text(item, "call_id").to_owned(), text(item, "name").to_owned()));
            }
            "tool_search_call" => {
                self.started(item);
                // Only the HTTP/SSE collector records the search as a pending call, and only with an id.
                if collector == Collector::HttpSse && !id.is_empty() {
                    self.pending.insert(id.to_owned(), (text(item, "call_id").to_owned(), "load_tool".to_owned()));
                }
            }
            "custom_tool_call" => self.started(item),
            _ => {}
        }
    }

    /// `response.function_call_arguments.delta` / `response.custom_tool_call_input.delta`.
    pub(super) fn input_delta(&mut self, item_id: &str) {
        self.mark(None, item_id);
        self.in_flight = true;
    }

    /// `response.function_call_arguments.done`: only the WebSocket collector settles here, and only for a call that
    /// had its id and name from the item.
    pub(super) fn arguments_done(&mut self, collector: Collector, item_id: &str) {
        if collector != Collector::WebSocket {
            return;
        }
        if self.pending.get(item_id).is_some_and(|(call, name)| !call.is_empty() && !name.is_empty()) {
            self.pending.remove(item_id);
            self.settle();
        }
    }

    /// A finished `function_call` / `tool_search_call` / `custom_tool_call` item.
    pub(super) fn item_done(&mut self, collector: Collector, item: &Value) {
        let id = text(item, "id");
        match text(item, "type") {
            "function_call" => {
                // Only the HTTP/SSE collector drops the pending call of an unnamed item too.
                if collector == Collector::HttpSse || !id.is_empty() {
                    self.pending.remove(id);
                }
                self.clear(Some(item), id);
                self.settle();
            }
            "tool_search_call" | "custom_tool_call" => {
                if collector == Collector::HttpSse {
                    self.pending.remove(id);
                }
                self.clear(Some(item), id);
                self.settle();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The flag is latched: a message boundary while a call's arguments still stream is `tool`; once the call's item is
    /// done it is not; and an argument delta for an unknown item latches it again with nothing to clear it.
    #[test]
    fn the_flag_follows_the_items_aliases_and_pending_calls() {
        let mut flight = ToolFlight::default();
        let call = json!({ "type": "function_call", "id": "fc1", "call_id": "c1", "name": "read" });
        flight.item_added(Collector::WebSocket, &call);
        assert!(flight.in_flight());
        flight.arguments_done(Collector::WebSocket, "fc1");
        assert!(flight.in_flight(), "the item stays active until it is done");
        flight.item_done(Collector::WebSocket, &call);
        assert!(!flight.in_flight());
        flight.input_delta("ghost");
        assert!(flight.in_flight());
    }
}
