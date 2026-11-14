//! The session's side of what a run's usage reports write into its header: the host's meters
//! ([`Books`]) become the signer the ports in `mixdog_agent::compact::pressure::ask_usage` read, and
//! the patch they answer becomes the header change a meta record carries.

use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::HeaderPatch;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::env::CompactPass;
use mixdog_agent::env::SessionPressure;
use mixdog_agent::message::AgentMessage;
use mixdog_ai::registry::accounted::input_excludes_cache;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;

use super::run::SendCheck;
use super::run::Settled;
use super::turn_ops::Books;

/// The stored row of each message (`message_of` keeps it on the message), as the session's messages
/// carry them in Node.
struct StoredRow;

impl MessageRows for StoredRow {
    fn row(&self, message: &AgentMessage) -> Value {
        message.stored.as_ref().map_or(Value::Null, |row| Value::Object((**row).clone()))
    }
}

fn provider_of(header: &Header) -> &str {
    header.get("provider").and_then(Value::as_str).unwrap_or_default()
}

/// `f` over the thread's books as the ports read them.
fn with_books<R>(books: &Books, provider: &str, f: impl FnOnce(&pressure::Books<'_>) -> R) -> R {
    let owner = ProviderId::from(provider);
    let meter = MessageMeter { media: &*books.media, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &*books.images, rows: &StoredRow };
    f(&pressure::Books { signer: &signer, native: &books.native, agent_mode: books.agent_mode })
}

fn change(patch: Option<HeaderPatch>) -> Option<HeaderChange> {
    patch.map(|patch| HeaderChange { set: patch.set, unset: patch.unset })
}

/// `bumpUsageMetricsTurnId(session)`, at the start of a turn (`whileTurnDispatched`).
pub(crate) fn turn_started(header: &Header) -> Option<HeaderChange> {
    change(pressure::turn_started(header))
}

/// `loopUsageMetricsTurnId()` / `loopUsageMetricsEpoch()` (`send-phase.mjs`, `pre-send-compact.mjs`): a report names the
/// session's current turn and epoch, so an iteration counter restarted by a compaction is not mistaken for a second epoch.
fn with_loop_ids(header: &Header, delta: &Value) -> Value {
    let mut delta = delta.clone();
    delta["usageMetricsTurnId"] = header.get("usageMetricsTurnId").cloned().unwrap_or(json!(0));
    delta["usageMetricsEpoch"] = header.get("usageMetricsEpoch").cloned().unwrap_or(json!(0));
    delta
}

/// The summary usage of a compaction pass (`accumulateCompactUsage` -> `onUsageDelta`): the call's metrics only; no send,
/// so no baseline and no `lastProviderSendAt`.
pub(crate) fn compact_usage_change(header: &Header, delta: &Value, now: f64) -> Option<HeaderChange> {
    let excludes = input_excludes_cache(provider_of(header));
    change(Some(pressure::iteration_metrics(header, &with_loop_ids(header, delta), excludes, now)))
}

/// `onUsageDelta(delta)` for one model call: `delta` is the call's `usageDeltaEvent`
/// (`live_rows::usage_delta`), `outgoing` the transcript its request carried and `send_tools` its tools.
pub(crate) fn usage_change(header: &Header, delta: &Value, outgoing: &[AgentMessage], send_tools: &[ToolDefinition], books: Option<&Books>, sent_at: f64, now: f64) -> Option<HeaderChange> {
    let provider = provider_of(header);
    let excludes = input_excludes_cache(provider);
    let delta = &with_loop_ids(header, delta);
    let patch = match books {
        Some(books) => with_books(books, provider, |books| pressure::usage_change(header, delta, outgoing, send_tools, Some(books), excludes, sent_at, now)),
        None => pressure::usage_change(header, delta, outgoing, send_tools, None, excludes, sent_at, now),
    };
    change(patch)
}

/// The check before a send that compacts nothing.
pub(crate) fn check_change(header: &Header, check: &SendCheck, books: &Books, now: f64) -> Option<HeaderChange> {
    change(with_books(books, provider_of(header), |books| pressure::check_change(header, &check.messages, &check.tools, check.reactive, books, now)))
}

/// The session's reading of a request about to go out: its provider pressure, as its check prices it, and its unanchored mark.
pub(crate) fn send_pressure(header: &Header, messages: &[AgentMessage], tools: &[ToolDefinition], books: &Books) -> SessionPressure {
    with_books(books, provider_of(header), |books| pressure::send_pressure(header, messages, tools, books))
}

/// A stage of a pre-send compaction pass.
pub(crate) fn pass_change(header: &Header, pass: &CompactPass, books: &Books, now: f64) -> Option<HeaderChange> {
    change(with_books(books, provider_of(header), |books| pressure::pass_change(header, pass, books, now)))
}

/// The ask's settlement: `applyAskTerminalUsageTotals`, then the complete-boundary baseline.
/// `incremental`: some call of the ask already counted its own usage.
pub(crate) fn settled_change(header: &Header, settled: &Settled, incremental: bool, books: Option<&Books>, now: f64) -> Option<HeaderChange> {
    let provider = provider_of(header);
    let excludes = input_excludes_cache(provider);
    let ask = pressure::Settled {
        transcript: &settled.transcript,
        usage: &settled.usage,
        last_turn_usage: &settled.last_turn_usage,
        tool_calls_total: settled.tool_calls_total,
        send_tools: &settled.send_tools,
    };
    let patch = match books {
        Some(books) => with_books(books, provider, |books| pressure::settled_change(header, &ask, incremental, Some(books), excludes, now)),
        None => pressure::settled_change(header, &ask, incremental, None, excludes, now),
    };
    change(patch)
}

/// What `recordStandaloneStatusTelemetry` reads of a settled ask: the transcript estimate
/// (`estimateTranscriptContextUsage(session.messages, session.tools, { provider })`, 0 without meters)
/// and the effort the latest user message ran at (`turnEffort`).
pub(crate) fn gateway_facts(header: &Header, settled: &Settled, books: Option<&Books>) -> (f64, Option<String>) {
    let provider = header.get("provider");
    let estimate = books.map_or(0.0, |books| {
        with_books(books, provider_of(header), |books| {
            let tools = mixdog_agent::compact::tool_schema::RequestTools { native: books.native, defined: &settled.send_tools };
            pressure::estimate_transcript_context_usage(&settled.transcript, &tools, provider, books)
        })
    });
    let effort = super::gateway_usage::turn_effort(settled.transcript.iter().filter_map(|message| message.stored.as_deref()));
    (estimate, effort)
}

/// `HEARTBEAT_THROTTLE_MS`(`manager/runtime-liveness.mjs`).
const HEARTBEAT_THROTTLE_MS: f64 = 60_000.0;

/// The disk-side heartbeat of `markSessionStreamDelta`: a semantic model event refreshes
/// `session.lastHeartbeatAt` once the stored one is more than a minute old.
pub(crate) fn stream_heartbeat(header: &Header, now: f64) -> Option<HeaderChange> {
    let last = header.get("lastHeartbeatAt").and_then(Value::as_f64).unwrap_or(0.0);
    if now - last <= HEARTBEAT_THROTTLE_MS {
        return None;
    }
    let mut set = Header::new();
    set.insert("lastHeartbeatAt".into(), mixdog_js::json_number(now));
    Some(HeaderChange { set, unset: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's own `markSessionStreamDelta` / `markSessionToolCall` over a run of events with the clock moved across the
    /// 60 s boundary (`fixtures/agent/compact/record_usage.mjs` -> `golden/heartbeat.json`). The semantic kinds ask for
    /// the heartbeat; a transport chunk, a keepalive and a tool's start (`markSessionToolCall`) never do.
    #[test]
    fn the_heartbeat_follows_node_over_a_run_of_events() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/agent/compact/golden/heartbeat.json")).expect("golden");
        let mut header = Header::new();
        let mut saves = 0;
        for event in golden["events"].as_array().expect("events") {
            let kind = event["kind"].as_str().expect("kind");
            if matches!(kind, "text" | "reasoning" | "tool" | "semantic")
                && let Some(change) = stream_heartbeat(&header, event["at"].as_f64().expect("at"))
            {
                header.extend(change.set);
                saves += 1;
            }
            assert_eq!(header.get("lastHeartbeatAt").cloned().unwrap_or(Value::Null), event["after"], "{kind} at {}", event["at"]);
            assert_eq!(saves, event["saves"].as_i64().expect("saves"), "{kind}: saves");
        }
    }
}