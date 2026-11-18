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
    f(&pressure::Books { signer: &signer, native: &books.native, agent_mode: books.agent_mode, env: &mixdog_ai::registry::keys::ProcessEnv })
}

fn change(patch: Option<HeaderPatch>) -> Option<HeaderChange> {
    patch.map(|patch| HeaderChange { set: patch.set, unset: patch.unset })
}

/// The change with the session's transcript-cache book (`cacheTailBook`) the call's owner settled, when it changed: the
/// authoritative receipt the next admission and a restart read. The previous record of a bare lifetime
/// (`lastProviderCacheTail`) is dropped with the first book written.
pub(crate) fn with_tail_book(change: Option<HeaderChange>, book: Option<&Value>) -> Option<HeaderChange> {
    let Some(book) = book else { return change };
    let mut change = change.unwrap_or(HeaderChange { set: Header::new(), unset: Vec::new() });
    change.set.insert("cacheTailBook".into(), book.clone());
    change.unset.push("lastProviderCacheTail".into());
    Some(change)
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
pub(crate) fn compact_usage_change(header: &Header, excludes: bool, delta: &Value, now: f64) -> Option<HeaderChange> {
    change(Some(pressure::iteration_metrics(header, &with_loop_ids(header, delta), excludes, now)))
}

/// `onUsageDelta(delta)` for one model call: `delta` is the call's `usageDeltaEvent`
/// (`live_rows::usage_delta`), `outgoing` the transcript its request carried and `send_tools` its tools.
/// `excludes` is the convention of the adapter that produced the call's usage, carried on its report.
pub(crate) fn usage_change(header: &Header, excludes: bool, delta: &Value, outgoing: &[AgentMessage], send_tools: &[ToolDefinition], books: Option<&Books>, sent_at: f64, now: f64) -> Option<HeaderChange> {
    let provider = provider_of(header);
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
    let excludes = settled.input_excludes_cache;
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

    /// Usage is read by the convention of the adapter that produced it, which travels on its report: a run that falls back
    /// from an inclusive adapter to an exclusive one (and the reverse), on a provider name no list holds, persists the whole
    /// prompt (1,205) of each call, not the first adapter's reading of the second's usage.
    #[test]
    fn a_fallback_run_persists_each_adapters_usage_by_that_adapters_convention() {
        let mut header = Header::new();
        header.insert("provider".into(), json!("my-gateway"));
        // The same 1,205-token prompt as each adapter reports it: inclusive input holds the cache, exclusive input leaves it out.
        let call = |excludes: bool| {
            let input_tokens = if excludes { 5 } else { 1205 };
            let usage = mixdog_core_api::domain::provider::Usage { input_tokens, cache_read_tokens: 1000, cache_write_tokens: 200, ..Default::default() };
            let report = super::super::run::UsageReport {
                iteration: 1,
                usage,
                model: "m".into(),
                requested_model: "m".into(),
                delta_tool_calls: 0,
                request_ms: 0,
                delta_prompt: 1205,
                send_tools: Vec::new(),
                reasoning_tokens: None,
                reasoning_tokens_complete: false,
                outgoing: Vec::new().into(),
                sent_at_ms: 0,
                input_excludes_cache: excludes, tail_book: None,
            };
            let delta = super::super::live_rows::usage_delta("s", &report, 1);
            let change = usage_change(&header, report.input_excludes_cache, &delta, &[], &[], None, 0.0, 1.0).expect("a change");
            change.set.get("lastContextTokens").and_then(Value::as_f64).expect("a reading")
        };
        for (first, second) in [(false, true), (true, false)] {
            assert_eq!(call(first), 1205.0, "the first adapter's usage, excludes={first}");
            assert_eq!(call(second), 1205.0, "the fallback adapter's usage, excludes={second}");
        }
    }


    /// The owner's book is written as it was settled, and nothing is inferred from the usage itself.
    #[test]
    fn the_settled_book_is_persisted_and_no_usage_alone_writes_one() {
        let book = json!({ "v": 1, "generation": 2, "receipts": [] });
        let change = with_tail_book(None, Some(&book)).expect("a change");
        assert_eq!(change.set.get("cacheTailBook"), Some(&book));
        assert_eq!(change.unset, vec!["lastProviderCacheTail".to_owned()]);
        assert!(with_tail_book(None, None).is_none(), "a call whose owner learned nothing writes no book");
    }

    #[cfg(node_twin)]
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
