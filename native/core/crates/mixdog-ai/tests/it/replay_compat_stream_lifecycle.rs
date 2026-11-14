//! `provider-openai-compat-stream-lifecycle`, the WIRE cases: `OpenAICompatProvider#send` as the production builder's
//! adapter for the recorded provider config, sent through `ModelBroker::send` to the driver's endpoint serving the
//! recorded replies; the requests compared whole as they arrived.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use mixdog_ai::broker::SendError;
use mixdog_testkit::Exact;

use crate::provider_case::CaseSet;
use crate::replay_errors::Left;
use crate::replay_errors::compare_error;
use crate::replay_errors::compare_outcome;
use crate::replay_world::Events;
use crate::provider_case::Endpoint;
use crate::provider_case::within;
use crate::replay_world;

const SET: &str = "openai-compat-stream-lifecycle";

/// How the recorded send ends.
#[derive(Clone, Copy, PartialEq)]
enum End {
    /// The provider ends it.
    Served,
    /// The caller cancels once the first event arrived (`interruption: cancel`).
    Cancelled,
}

/// Sends the case's recorded send (`entry`: `#send`, or `sendCompatResponses` with the provider first) through the
/// adapter of its recorded provider and compares the arrivals.
async fn replay_requests(set: &CaseSet, id: &str, entry: &str, end: End) {
    let case = set.case(id);
    let endpoint = Endpoint::start().await;
    endpoint.serve(case);
    let home = tempfile::tempdir().expect("a home");
    let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
    let constructed = case.args_of("OpenAICompatProvider", 0);
    let name = constructed[0].as_str();
    let cfg = &constructed[1];
    // A named OpenAI-compatible endpoint of the user's config is the custom provider of the Chat Completions protocol.
    // `sendCompatResponses` is the provider's Responses wire: Mixdog's custom endpoint of that protocol.
    let protocol = if entry == "sendCompatResponses" { "openai-responses" } else { "openai-chat" };
    let cfg = json!({
        "type": "custom",
        "schemaVersion": 2,
        "name": "Custom",
        "protocol": protocol,
        "baseURL": cfg.get("baseURL").as_str(),
        "apiKey": cfg.get("apiKey").as_str(),
    });
    // Mixdog builds a user's endpoint as `custom-<id>`; Node's test constructed the class under the bare name.
    let adapter = replay_world::adapter(&builder, &format!("custom-{name}"), &cfg).await;
    let args = case.args_of(entry, 0);
    // `sendCompatResponses(provider, messages, model, tools, opts)` takes the provider first.
    let args = if entry == "sendCompatResponses" { &args[1..] } else { args };
    assert_eq!(args[2].as_array().len(), 0, "no tools");
    let request = ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: args[0].as_array().iter().map(replay_world::message).collect(),
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    let cancel = CancellationToken::new();
    let sink = Events { cancel_on_text: (end == End::Cancelled).then(|| cancel.clone()), ..Events::default() };
    let (sent, events) = within("the send", replay_world::send_with(&*adapter, request, &cancel, sink)).await;
    if end == End::Cancelled {
        // Node's cancel closed the held response's connection; the endpoint records that close.
        endpoint
            .until("the client to close the cancelled request's connection", |e| {
                e.arrivals().iter().any(|a| a.try_get("clientClosedConnection").is_some())
            })
            .await;
    }
    set.assert_requests(case, &endpoint.arrivals(), None);
    // The outcome is group B's replay (declared below); its fields are still checked against what left the core.
    compare_result(&format!("{SET} {id}"), case.recorded().raw(), &Left::of(&sent, &events), &sent);
}

/// The case's `{ error, outcome, classification, ... }` against what left the provider layer.
fn compare_result(what: &str, result: &Exact, left: &Left<'_>, sent: &Result<u32, SendError>) {
    for (key, value) in result.entries() {
        let what = format!("{what}.{key}");
        match key.as_str() {
            "error" => compare_error(&what, value, left),
            "outcome" => compare_outcome(&what, value, left),
            // `classifyError`: `permanent` and `auth` surface the error with no retry (the one request compared above),
            // `transient` retries it.
            "classification" => match value.as_str() {
                "permanent" | "auth" => assert!(
                    matches!(sent, Err(SendError::Provider(_) | SendError::Cancelled)),
                    "{what}: surfaced without a retry: {sent:?}"
                ),
                "transient" => assert!(matches!(sent, Err(SendError::Exhausted(_))), "{what}: retried: {sent:?}"),
                other => panic!("{what}: classification {other}"),
            },
            // The recorder's check that the send rejected with the caller's abort reason.
            "rejectedWithTheCallerReason" => assert_eq!(left.cancelled(), value.as_bool(), "{what}"),
            // The AbortSignal listeners left after the send: Node's release of the pending read, which on the wire is
            // the client's close of the held response (compared with the requests).
            "listenersAfter" => assert_eq!(value.as_f64(), 0.0, "{what}: Node released the pending read"),
            other => panic!("{what}: no comparison for result.{other}"),
        }
    }
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: SET, run: every_wire_case_sends_as_nodes }];

/// The WIRE cases this branch replays, each with its recorded entry and how it ends.
const REPLAYED: [(&str, &str, End); 4] = [
    ("chat-in-band-fatal-error-stays-terminal", "OpenAICompatProvider#send", End::Served),
    ("responses-in-band-fatal-error-stays-terminal", "sendCompatResponses", End::Served),
    ("chat-cancel-releases-pending-read-and-signal-listener", "OpenAICompatProvider#send", End::Cancelled),
    ("responses-cancel-releases-pending-read-and-signal-listener", "sendCompatResponses", End::Cancelled),
];

/// Every case of the set in one test, so the set's drop holds each: the WIRE cases' requests compared here, the rest
/// named with the branch that replays them.
#[tokio::test(start_paused = true)]
async fn every_wire_case_sends_as_nodes() {
    let set = CaseSet::load(SET);
    let replayed: Vec<&str> = REPLAYED.iter().map(|(id, _, _)| *id).collect();
    let others: Vec<&str> = set.ids().into_iter().filter(|id| !replayed.contains(id)).collect();
    set.not_replayed(&others, "the set's other cases: group B's replay, not in this branch");
    set.not_replayed(&replayed, "this test compares the requests only; the outcome's replay is group B's, not in this branch");
    for (id, entry, end) in REPLAYED {
        replay_requests(&set, id, entry, end).await;
    }
}
