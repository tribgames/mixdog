//! Test support for the call-site layer: a production call site driven through a transport whose every request outlives
//! its exchange's timer, and the checks of what it did against `golden/connect_errors.json` `sites` (the real Node
//! function of the same site, recorded by `connect-errors/record.mjs --only sites`).
//!
//! The transport expires the request with the exchange the site chose, through the same [`deadline_error`] the link
//! uses, so the class (`Surface`), the window and the label each site picks are what the check reads. Time is paused
//! (`#[tokio::test(start_paused = true)]`): nothing waits.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::link::Exchange;
use super::link::HttpResponse;
use super::link::HttpSend;
use super::link::deadline_error;

/// What one expired request told the transport.
#[derive(Clone, Debug)]
pub(crate) struct Seen {
    /// The error text the link gives that exchange.
    pub text: String,
    /// The window the exchange gave the request.
    pub after: Duration,
}

#[derive(Default)]
pub(crate) struct TimingOut {
    seen: Mutex<Vec<Seen>>,
}

impl TimingOut {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

#[async_trait]
impl HttpSend for TimingOut {
    async fn send(&self, _request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("the request is never answered");
        let error = deadline_error(expired, DeliveryState::Ambiguous, exchange.surface);
        self.seen.lock().unwrap().push(Seen { text: error.message.clone(), after: expired.after });
        Err(error)
    }
}

/// Collects the Node stderr lines (`mixdog_rt::node_log`) the current thread emits until the guard drops, as the bytes
/// Node writes (no newline). Only for a current-thread test runtime, where spawned work runs on this thread.
pub(crate) fn capture_logs() -> (impl Fn() -> Vec<String>, mixdog_rt::node_log::CaptureGuard) {
    let (lines, guard) = mixdog_rt::node_log::capture();
    (move || lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect(), guard)
}
/// The recording of one site.
pub(crate) fn recorded(site: &str) -> Value {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
    golden["sites"][site].clone()
}

/// The class and window the site chose are Node's: its first request read as the raw `fetch` of Node's site rejected
/// (the call class's text, label and milliseconds included), and its window is one of the timers Node armed.
pub(crate) fn assert_transport(site: &str, transport: &TimingOut) {
    assert_text(site, transport);
    assert_window(site, transport);
}

/// A site that arms no timer: Node's request ends at the shared dispatcher's headers timeout
/// (`shared/llm/http-agent.mjs:413`, 600_000 unless `MIXDOG_LLM_HEADERS_TIMEOUT_MS` says otherwise; the recording
/// shortens it), and so does the Rust one.
pub(crate) fn assert_dispatcher(site: &str, transport: &TimingOut) {
    assert_text(site, transport);
    assert!(recorded(site)["armed"].as_array().unwrap().is_empty(), "{site}: Node armed a timer");
    let seen = transport.seen();
    assert_eq!(seen.first().unwrap().after, Duration::from_millis(600_000), "{site}");
}

/// The text the call class gives the first request is one the raw `fetch` of Node's site rejected with.
fn assert_text(site: &str, transport: &TimingOut) {
    let golden = recorded(site);
    let seen = transport.seen();
    let first = seen.first().unwrap_or_else(|| panic!("{site}: the site sent no request"));
    let rejected: Vec<&str> = golden["fetchRejected"].as_array().unwrap().iter().map(|r| r["message"].as_str().unwrap()).collect();
    assert!(rejected.contains(&first.text.as_str()), "{site}: Rust reads {:?}, Node's fetch rejected {rejected:?}", first.text);
}

/// The window the site's first request got is one of the timers Node armed.
pub(crate) fn assert_window(site: &str, transport: &TimingOut) {
    let seen = transport.seen();
    let first = seen.first().unwrap_or_else(|| panic!("{site}: the site sent no request"));
    let armed: Vec<u64> = recorded(site)["armed"].as_array().unwrap().iter().map(|a| a["ms"].as_u64().unwrap()).collect();
    assert!(armed.contains(&(first.after.as_millis() as u64)), "{site}: window {:?} is not one of Node's timers {armed:?}", first.after);
}

/// The text the site throws where Node passes the fetch's text on.
pub(crate) fn assert_thrown(site: &str, message: &str) {
    let golden = recorded(site);
    assert_eq!(message, golden["thrown"]["message"].as_str().unwrap(), "{site}");
}

/// The message of a failed login step.
pub(crate) fn login_message(failure: &mixdog_core_api::domain::login::LoginFailure) -> &str {
    match failure {
        mixdog_core_api::domain::login::LoginFailure::Failed { message, .. } => message,
        other => panic!("{other:?}"),
    }
}

/// For a site whose Node caller swallows the failure (the recording resolves): the error this port's listing returns
/// carries the text Node's `fetch` rejected with.
pub(crate) fn assert_rejected_as_nodes(site: &str, message: &str) {
    let rejected: Vec<String> = recorded(site)["fetchRejected"].as_array().unwrap().iter().map(|r| r["message"].as_str().unwrap().to_owned()).collect();
    assert!(rejected.iter().any(|r| r == message), "{site}: Rust returns {message:?}, Node's fetch rejected {rejected:?}");
}
