//! The session's side of what a run's usage reports write into its header: the host's meters
//! ([`Books`]) become the signer the ports in `mixdog_agent::compact::pressure::ask_usage` read, and
//! the patch they answer becomes the header change a meta record carries.

use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::HeaderPatch;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::message::AgentMessage;
use mixdog_ai::registry::accounted::input_excludes_cache;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;

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

/// `onUsageDelta(delta)` for one model call: `delta` is the call's `usageDeltaEvent`
/// (`live_rows::usage_delta`), `outgoing` the transcript its request carried and `send_tools` its tools.
pub(crate) fn usage_change(header: &Header, delta: &Value, outgoing: &[AgentMessage], send_tools: &[ToolDefinition], books: Option<&Books>, now: f64) -> Option<HeaderChange> {
    let provider = provider_of(header);
    let excludes = input_excludes_cache(provider);
    let patch = match books {
        Some(books) => with_books(books, provider, |books| pressure::usage_change(header, delta, outgoing, send_tools, Some(books), excludes, now)),
        None => pressure::usage_change(header, delta, outgoing, send_tools, None, excludes, now),
    };
    change(patch)
}

/// The check before a send that compacts nothing.
pub(crate) fn check_change(header: &Header, check: &SendCheck, books: &Books, now: f64) -> Option<HeaderChange> {
    change(with_books(books, provider_of(header), |books| pressure::check_change(header, &check.messages, &check.tools, check.reactive, books, now)))
}

/// A compaction that changed the transcript was adopted.
pub(crate) fn compacted_change(header: &Header, now: f64) -> Option<HeaderChange> {
    change(pressure::compacted_change(header, now))
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
