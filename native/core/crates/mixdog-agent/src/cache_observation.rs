//! Evidence for the Anthropic cache diagnostic, not cache admission or billing.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_core_api::domain::cache_tail::{Admission, Claim, ColdRequest, Counters, Permit, Resolution, TailGate, TailGateHandle, Unreduced, Verdict};
use mixdog_core_api::domain::provider::Usage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::prefix_guard::Snapshot;

pub(crate) fn is_anthropic(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth")
}

/// A pressure reading needs the whole prompt, not a lower bound made of the fields that arrived.
pub(crate) fn has_prompt(usage: &Usage) -> bool {
    let cache = Counters::of_usage(usage);
    usage.raw.as_ref().and_then(|raw| raw.get("input_tokens")).and_then(serde_json::Value::as_u64).is_some() && cache.read.is_some() && cache.created.is_some()
}

#[derive(Clone, Debug)]
pub(crate) struct Observation {
    at: i64,
    ttl_ms: i64,
    route: String,
    prefix: String,
    message_count: usize,
    messages: String,
    read: u64,
    written: u64,
}

impl Observation {
    pub fn read(value: &Value) -> Option<Self> {
        Some(Self {
            at: value.get("at")?.as_i64()?,
            ttl_ms: value.get("ttlMs")?.as_i64()?,
            route: value.get("route")?.as_str()?.into(),
            prefix: value.get("prefix")?.as_str()?.into(),
            message_count: usize::try_from(value.get("messageCount")?.as_u64()?).ok()?,
            messages: value.get("messages")?.as_str()?.into(),
            read: value.get("read")?.as_u64()?,
            written: value.get("written")?.as_u64()?,
        })
    }

    pub fn saved(&self) -> Value {
        json!({
            "at": self.at, "ttlMs": self.ttl_ms, "route": self.route, "prefix": self.prefix,
            "messageCount": self.message_count, "messages": self.messages,
            "read": self.read, "written": self.written,
        })
    }
}

pub(crate) struct Request<'a> {
    pub dispatched_at: i64,
    pub ttl_ms: Option<i64>,
    pub wire: &'a str,
    pub serving_model: &'a str,
    pub account: Option<&'a str>,
    pub admitted_route: Option<&'a str>,
    pub changed_intentionally: bool,
    pub prefix: Option<&'a Snapshot>,
    pub wire_prefix: Option<&'a Value>,
}

pub(crate) struct Miss {
    pub read: u64,
    pub previous_prefix: u64,
    pub idle_ms: i64,
}

fn message_digest(hashes: &[String]) -> String {
    let mut hash = Sha256::new();
    for message in hashes {
        hash.update(message.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

fn route(wire: &str, model: &str, account: Option<&str>, admitted: Option<&str>) -> String {
    let parts = json!([wire, model, account, admitted]);
    format!("{:x}", Sha256::digest(parts.to_string().as_bytes()))
}

fn request_prefix(prefix: &Snapshot, wire: Option<&Value>) -> String {
    let system_markers: Vec<&str> = wire
        .and_then(|wire| wire.get("markers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|marker| marker.starts_with('s'))
        .collect();
    let field = |name| wire.and_then(|wire| wire.get(name));
    let parts = json!([prefix.request_prefix_hash, field("tools"), field("system"), field("params"), field("toolChoice"), system_markers]);
    format!("{:x}", Sha256::digest(parts.to_string().as_bytes()))
}

/// An unreported field cannot renew the observation. A mismatched or expired scope retires it,
/// even when the current reply has no replacement counters.
pub(crate) fn settle(previous: &mut Option<Observation>, request: Request<'_>, counters: Counters) -> Option<Miss> {
    let account = request.account.filter(|id| !id.is_empty());
    let Some((prefix, ttl)) = request.prefix.zip(request.ttl_ms).filter(|(_, ttl)| *ttl > 0 && (account.is_some() || request.admitted_route.is_some())) else {
        *previous = None;
        return None;
    };
    let route = route(request.wire, request.serving_model, account, request.admitted_route);
    let request_prefix = request_prefix(prefix, request.wire_prefix);
    let miss = previous.take().and_then(|old| {
        let idle = request.dispatched_at.saturating_sub(old.at);
        if request.changed_intentionally
            || idle < 0
            || idle >= ttl
            || old.ttl_ms != ttl
            || old.route != route
            || old.prefix != request_prefix
            || !prefix.message_hashes.get(..old.message_count).is_some_and(|head| message_digest(head) == old.messages)
        {
            return None;
        }
        let baseline = old.read.saturating_add(old.written);
        *previous = Some(old);
        let read = counters.read?;
        (read < baseline.div_ceil(2) && baseline.saturating_sub(read) >= 4096).then_some(Miss { read, previous_prefix: baseline, idle_ms: idle })
    });
    if let (Some(read), Some(written)) = (counters.read, counters.created) {
        *previous = Some(Observation {
            at: request.dispatched_at,
            ttl_ms: ttl,
            route,
            prefix: request_prefix,
            message_count: prefix.message_hashes.len(),
            messages: message_digest(&prefix.message_hashes),
            read,
            written,
        });
    }
    miss
}

/// The owner already knows the actual endpoint, credential scope and conservative dispatch time.
/// Observe its permit without changing admission, settlement or the book.
#[derive(Clone, Default)]
pub(crate) struct Dispatches(Arc<Mutex<Option<Dispatch>>>);

#[derive(Clone)]
pub(crate) struct Dispatch {
    pub route: String,
    pub at: i64,
    pub ttl_ms: i64,
}

impl Dispatches {
    pub fn latest(&self) -> Option<Dispatch> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn observe(&self, gate: TailGateHandle) -> TailGateHandle {
        TailGateHandle(Arc::new(Observe { gate: gate.0, dispatches: self.clone() }))
    }
}

struct Observe {
    gate: Arc<dyn TailGate>,
    dispatches: Dispatches,
}

impl TailGate for Observe {
    fn admit<'a>(&'a self, admission: Admission<'a>) -> Pin<Box<dyn Future<Output = Verdict> + Send + 'a>> {
        Box::pin(async move {
            let verdict = self.gate.admit(admission).await;
            if let Verdict::Send(permit) = &verdict
                && let Some(tail) = permit.manifest.tail_marker()
            {
                *self.dispatches.0.lock().unwrap_or_else(PoisonError::into_inner) =
                    Some(Dispatch { route: format!("{:x}", Sha256::digest(permit.route.0.as_bytes())), at: permit.dispatched_at, ttl_ms: tail.ttl_ms as i64 });
            }
            verdict
        })
    }

    fn settle(&self, permit: &Permit, counters: Option<Counters>) {
        self.gate.settle(permit, counters);
    }

    fn claim(&self, request: ColdRequest) -> Claim {
        self.gate.claim(request)
    }

    fn resolve(&self, ticket: u64, resolution: Resolution) -> Option<Unreduced> {
        self.gate.resolve(ticket, resolution)
    }

    fn rebuilt(&self) -> u64 {
        self.gate.rebuilt()
    }

    fn snapshot(&self) -> Option<Value> {
        self.gate.snapshot()
    }

    fn generation(&self) -> u64 {
        self.gate.generation()
    }

    fn wait_for(&self, ticket: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        self.gate.wait_for(ticket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: i64 = 300_000;

    fn usage(raw: serde_json::Value) -> Usage {
        Usage { raw: Some(raw), ..Usage::default() }
    }

    fn prefix(messages: &[&str]) -> Snapshot {
        Snapshot { request_prefix_hash: "tools".into(), message_hashes: messages.iter().map(|s| (*s).into()).collect(), ..Snapshot::default() }
    }

    fn request(prefix: &Snapshot, at: i64) -> Request<'_> {
        Request {
            dispatched_at: at,
            ttl_ms: Some(TTL),
            wire: "messages",
            serving_model: "sonnet",
            account: Some("first"),
            admitted_route: None,
            changed_intentionally: false,
            prefix: Some(prefix),
            wire_prefix: None,
        }
    }

    fn seed(prefix: &Snapshot) -> Option<Observation> {
        let mut baseline = None;
        settle(&mut baseline, request(prefix, 100), Counters { read: Some(6000), created: Some(4000), ..Counters::default() });
        baseline
    }

    #[test]
    fn unreported_read_is_not_a_miss_and_does_not_move_the_observation() {
        let first = prefix(&["system", "old"]);
        let next = prefix(&["system", "old", "new"]);
        let mut baseline = seed(&first);
        let raw = usage(json!({ "cache_creation_input_tokens": 0 }));
        assert!(settle(&mut baseline, request(&next, 200), Counters::of_usage(&raw)).is_none());
        // Through a persisted carry, the next explicit read still compares with the original prefix and timestamp.
        let saved = baseline.unwrap().saved();
        let mut baseline = Observation::read(&saved);
        let raw = usage(json!({ "cache_read_input_tokens": 0, "cache_creation_input_tokens": 8000 }));
        let miss = settle(&mut baseline, request(&next, 300), Counters::of_usage(&raw)).unwrap();
        assert_eq!((miss.read, miss.previous_prefix, miss.idle_ms), (0, 10_000, 200));
        let miss = settle(&mut baseline, request(&next, 400), Counters::of_usage(&raw)).unwrap();
        assert_eq!(miss.previous_prefix, 8000, "the observed write becomes a baseline, never a read");
    }

    #[test]
    fn unreported_usage_cannot_bridge_expiry_or_an_incompatible_request() {
        let first = prefix(&["system", "old"]);
        let rewritten = prefix(&["system", "rewritten"]);
        let other_tools = Snapshot { request_prefix_hash: "other-tools".into(), ..first.clone() };
        let other_wire_prefix = json!({ "system": ["changed"] });
        let absent = Counters::default();
        let zero = Counters { read: Some(0), created: Some(0), ..Counters::default() };
        for incompatible in [
            request(&first, 100 + TTL),
            Request { ttl_ms: Some(3_600_000), ..request(&first, 200) },
            request(&rewritten, 200),
            request(&other_tools, 200),
            Request { wire_prefix: Some(&other_wire_prefix), ..request(&first, 200) },
            Request { wire: "other", ..request(&first, 200) },
            Request { serving_model: "other", ..request(&first, 200) },
            Request { account: Some("second"), ..request(&first, 200) },
            Request { account: None, ..request(&first, 200) },
            Request { changed_intentionally: true, ..request(&first, 200) },
        ] {
            let at = incompatible.dispatched_at;
            let mut baseline = seed(&first);
            assert!(settle(&mut baseline, incompatible, absent).is_none());
            assert!(settle(&mut baseline, request(&first, at + 10), zero).is_none());
        }
        let mut baseline = seed(&first);
        settle(&mut baseline, request(&first, 100 + TTL - 20), absent);
        assert!(settle(&mut baseline, request(&first, 100 + TTL), zero).is_none(), "an unknown send did not renew the TTL");
    }

    #[test]
    fn observed_read_can_report_a_miss_without_claiming_a_write() {
        let first = prefix(&["system", "old"]);
        let mut baseline = seed(&first);
        let raw = usage(json!({ "input_tokens": 500, "cache_read_input_tokens": 0 }));
        assert!(!has_prompt(&raw));
        assert_eq!(settle(&mut baseline, request(&first, 200), Counters::of_usage(&raw)).unwrap().read, 0);
        let zero = usage(json!({ "input_tokens": 500, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }));
        assert!(has_prompt(&zero));
        assert_eq!(settle(&mut baseline, request(&first, 300), Counters::of_usage(&zero)).unwrap().previous_prefix, 10_000);
        assert!(settle(&mut baseline, request(&first, 400), Counters::of_usage(&zero)).is_none(), "explicit zero replaced the positive baseline");
    }

    #[test]
    fn transmitted_tool_choice_change_retires_the_baseline() {
        use mixdog_ai::providers::anthropic::prefix_trace::fingerprint;

        let prefix = prefix(&["system", "old"]);
        let wire = |choice: Value| fingerprint(json!({ "tool_choice": choice }).as_object().unwrap()).persistable();
        let auto = wire(json!({ "type": "auto" }));
        let serial = wire(json!({ "type": "auto", "disable_parallel_tool_use": true }));
        let report = |read, written| Counters { read: Some(read), created: Some(written), ..Counters::default() };
        let mut baseline = None;
        settle(&mut baseline, Request { wire_prefix: Some(&auto), ..request(&prefix, 100) }, report(8000, 0));
        assert!(settle(&mut baseline, Request { wire_prefix: Some(&serial), ..request(&prefix, 200) }, report(0, 8000)).is_none());
        let miss = settle(&mut baseline, Request { wire_prefix: Some(&serial), ..request(&prefix, 300) }, report(0, 0)).unwrap();
        assert_eq!((miss.read, miss.previous_prefix), (0, 8000));
    }

    #[test]
    fn ttl_is_checked_at_dispatch_even_on_the_last_live_millisecond() {
        let prefix = prefix(&["old"]);
        let zero = Counters { read: Some(0), created: Some(0), ..Counters::default() };
        let miss = settle(&mut seed(&prefix), request(&prefix, 300_099), zero).unwrap();
        assert_eq!(miss.idle_ms, 299_999);
        assert!(settle(&mut seed(&prefix), request(&prefix, 300_100), zero).is_none());
    }

    #[test]
    fn an_api_key_route_uses_admission_scope_without_a_roster_account() {
        let first = prefix(&["system", "old"]);
        let on = |route: &'static str, at| Request { account: None, admitted_route: Some(route), ..request(&first, at) };
        let mut baseline = None;
        settle(&mut baseline, on("endpoint-key-a", 100), Counters { read: Some(0), created: Some(8000), ..Counters::default() });
        assert!(settle(&mut baseline, on("endpoint-key-b", 200), Counters::default()).is_none());
        let zero = Counters { read: Some(0), created: Some(0), ..Counters::default() };
        assert!(settle(&mut baseline, on("endpoint-key-a", 300), zero).is_none());
        settle(&mut baseline, on("endpoint-key-a", 400), Counters { read: Some(0), created: Some(8000), ..Counters::default() });
        assert_eq!(settle(&mut baseline, on("endpoint-key-a", 500), zero).unwrap().previous_prefix, 8000);
    }
}
