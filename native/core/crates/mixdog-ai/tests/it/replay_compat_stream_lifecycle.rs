//! `provider-openai-compat-stream-lifecycle`, the WIRE cases: `OpenAICompatProvider#send` as the production builder's
//! adapter for the recorded provider config, sent through `ModelBroker::send` to the driver's endpoint serving the
//! recorded replies; the requests compared whole as they arrived.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::provider_case::CaseSet;
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
async fn replay_requests(id: &str, entry: &str, end: End) {
    let set = CaseSet::load(SET);
    let case = set.case(id);
    let endpoint = Endpoint::start().await;
    endpoint.serve(case);
    let home = tempfile::tempdir().expect("a home");
    let builder = replay_world::builder(&endpoint, home.path(), Vec::new());
    let constructed = case.args_of("OpenAICompatProvider", 0);
    let name = constructed[0].as_str();
    let cfg = &constructed[1];
    // A named OpenAI-compatible endpoint of the user's config is the custom provider of the Chat Completions protocol.
    // `sendCompatResponses` is the provider's Responses wire: Mixdog's custom endpoint of that protocol.
    let protocol = if entry == "sendCompatResponses" { "openai-responses" } else { "openai-chat" };
    let cfg = json!({
        "type": "custom",
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
    let send = replay_world::send(&*adapter, request, &cancel);
    match end {
        End::Served => {
            let _ = within("the send", send).await;
        }
        End::Cancelled => {
            let canceller = async {
                endpoint.until("the request", |e| !e.arrivals().is_empty()).await;
                cancel.cancel();
            };
            let _ = within("the cancelled send", async { tokio::join!(send, canceller) }).await;
            // Node's cancel closed the held response's connection; the endpoint records that close.
            endpoint
                .until("the client to close the cancelled request's connection", |e| {
                    e.arrivals().iter().any(|a| a.try_get("clientClosedConnection").is_some())
                })
                .await;
        }
    }
    set.assert_requests(case, &endpoint.arrivals(), None);
}

#[tokio::test(start_paused = true)]
async fn chat_in_band_fatal_error_stays_terminal() {
    replay_requests("chat-in-band-fatal-error-stays-terminal", "OpenAICompatProvider#send", End::Served).await;
}

#[tokio::test(start_paused = true)]
async fn responses_in_band_fatal_error_stays_terminal() {
    replay_requests("responses-in-band-fatal-error-stays-terminal", "sendCompatResponses", End::Served).await;
}

#[tokio::test(start_paused = true)]
async fn chat_cancel_releases_pending_read_and_signal_listener() {
    replay_requests("chat-cancel-releases-pending-read-and-signal-listener", "OpenAICompatProvider#send", End::Cancelled).await;
}

#[tokio::test(start_paused = true)]
async fn responses_cancel_releases_pending_read_and_signal_listener() {
    replay_requests("responses-cancel-releases-pending-read-and-signal-listener", "sendCompatResponses", End::Cancelled).await;
}
