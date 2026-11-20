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

/// What the real Node function of each call site did when its request was never answered: the timers it armed (ms), the
/// texts its `fetch` rejected with, the message it threw (none where its caller swallows the failure), and the lines it logged.
type Site = (&'static str, &'static [u64], &'static [&'static str], Option<&'static str>, &'static [&'static str]);

const SITES: &[Site] = &[
    ("grokDiscovery", &[15000], &["grok-oauth discovery timed out after 15000ms"], Some("grok-oauth discovery timed out after 15000ms"), &[]),
    (
        "grokRefresh",
        &[30000, 30000, 30000],
        &["grok-oauth refresh timed out after 30000ms", "grok-oauth refresh timed out after 30000ms", "grok-oauth refresh timed out after 30000ms"],
        Some("grok-oauth refresh timed out after 30000ms"),
        &[],
    ),
    (
        "grokCodeExchange",
        &[30000],
        &["The operation was aborted due to timeout"],
        Some("[grok-oauth] token exchange request failed (timed out). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY."),
        &[],
    ),
    (
        "anthropicRefresh",
        &[30000, 4000],
        &["This operation was aborted", "The operation was aborted due to timeout"],
        Some("Anthropic OAuth token refresh timed out after 30000ms"),
        &[],
    ),
    ("antigravityRefresh", &[30000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("geminiModelList", &[60000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    (
        "mimoProbe",
        &[15000, 15000, 15000],
        &["The operation was aborted due to timeout", "The operation was aborted due to timeout", "The operation was aborted due to timeout"],
        Some("The operation was aborted due to timeout"),
        &[],
    ),
    ("commandCodeIdentity", &[15000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("museKey", &[20000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    (
        "devinExchange",
        &[30000],
        &["The operation was aborted due to timeout"],
        Some(
            "DEVIN_OAUTH_TOKEN_EXCHANGE_FAILED: Devin token exchange request failed (timed out). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY.",
        ),
        &[],
    ),
    ("compatModelList", &[10000], &["groq model list timed out after 10000ms"], Some("groq model list timed out after 10000ms"), &[]),
    ("anthropicModelList", &[10000], &["The operation was aborted due to timeout"], None, &[]),
    (
        "customOpenaiChatListing",
        &[10000, 10000],
        &["custom-listing model list timed out after 10000ms"],
        Some("custom-listing model list timed out after 10000ms"),
        &[],
    ),
    ("customAnthropicListing", &[10000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("customOpenaiChatProbe", &[10000, 60000, 60000], &["This operation was aborted"], None, &[]),
    ("customAnthropicProbe", &[60000, 60000], &["This operation was aborted"], None, &[]),
    ("devinUnary", &[], &["fetch failed"], Some("Devin connection failed: fetch failed"), &[]),
    ("vertexToken", &[], &["fetch failed"], Some("Vertex AI authentication failed: fetch failed"), &[]),
    ("antigravityVersion", &[5000], &["The operation was aborted due to timeout"], None, &[]),
    (
        "modelsDev",
        &[10000],
        &["The operation was aborted due to timeout"],
        None,
        &["[model-catalog] models.dev fetch failed: The operation was aborted due to timeout"],
    ),
    ("cursorRefresh", &[30000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    (
        "openaiRefresh",
        &[30000],
        &["This operation was aborted"],
        Some("OpenAI OAuth token refresh failed (OpenAI OAuth token refresh timed out after 30000ms). Re-authenticate via provider login."),
        &[],
    ),
    ("openaiCatalog", &[4000, 10000], &["The operation was aborted due to timeout", "The operation was aborted due to timeout"], None, &[]),
    ("museDeviceAuth", &[30000], &["The operation was aborted due to timeout"], Some("[muse-code-oauth] request to auth.meta.com timed out"), &[]),
    ("antigravityCodeExchange", &[30000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("antigravityProject", &[30000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("opencodeConsole", &[20000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    (
        "openaiCodeExchange",
        &[30000, 30000],
        &["The operation was aborted due to timeout"],
        Some("[openai-oauth] token exchange request failed (timed out). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY."),
        &[],
    ),
    (
        "openaiCodeExchangeManual",
        &[30000, 30000],
        &["The operation was aborted due to timeout"],
        Some("[openai-oauth] token exchange request failed (timed out). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY."),
        &[],
    ),
    ("opencodeGoUsage", &[6500], &["This operation was aborted"], Some("This operation was aborted"), &[]),
    ("grokModelList", &[10000, 10000, 4000], &["grok-oauth model list timed out after 10000ms"], Some("grok-oauth model list timed out after 10000ms"), &[]),
    (
        "grokProxyList",
        &[10000],
        &[
            "The operation was aborted due to timeout",
            "grok-oauth proxy model list timed out after 10000ms",
            "grok-oauth proxy model list timed out after 10000ms",
        ],
        None,
        &[],
    ),
    (
        "anthropicCodeExchange",
        &[300000, 30000],
        &["The operation was aborted due to timeout"],
        Some("[anthropic-oauth] token exchange request failed (timed out). Check your proxy/VPN: Mixdog uses the system proxy, or HTTPS_PROXY."),
        &[],
    ),
    (
        "geminiCacheCreate",
        &[180000, 120000],
        &["Gemini cachedContents.create total timed out after 180000ms"],
        None,
        &["[gemini] cachedContents.create error: Gemini cachedContents.create total timed out after 180000ms"],
    ),
    ("cursorPoll", &[], &["fetch failed", "fetch failed", "fetch failed"], Some("fetch failed"), &[]),
    ("opencodeConsoleGet", &[20000], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("oauthUsage", &[4500], &["The operation was aborted due to timeout"], Some("The operation was aborted due to timeout"), &[]),
    ("apiUsage", &[6500], &["This operation was aborted"], Some("This operation was aborted"), &[]),
    ("vertexMetadataProbe", &[1000], &["The operation was aborted due to timeout"], None, &[]),
    ("npmVersion", &[4000], &["The operation was aborted due to timeout"], None, &[]),
    ("cursorUsageCall", &[4000, 5000], &["The operation was aborted due to timeout"], Some("Cursor request timed out after 5000ms"), &[]),
    ("cursorModelsCall", &[15000], &[], Some("Cursor request timed out after 15000ms"), &[]),
    ("cursorConnect", &[30000], &[], Some("Cursor stream was aborted"), &[]),
];

fn site(name: &str) -> &'static Site {
    SITES.iter().find(|site| site.0 == name).unwrap_or_else(|| panic!("no site {name}"))
}

fn first(name: &str, transport: &TimingOut) -> Seen {
    transport.seen().into_iter().next().unwrap_or_else(|| panic!("{name}: the site sent no request"))
}

/// The class and window the site chose: its first request reads as one of the texts Node's `fetch` rejected with, and its
/// window is one of the timers Node armed.
pub(crate) fn assert_transport(name: &str, transport: &TimingOut) {
    assert_text(name, transport);
    assert_window(name, transport);
}

/// A site that arms no timer: its request ends at the shared dispatcher's 600 s headers timeout.
pub(crate) fn assert_dispatcher(name: &str, transport: &TimingOut) {
    assert_text(name, transport);
    assert!(site(name).1.is_empty(), "{name}: Node armed a timer");
    assert_eq!(first(name, transport).after, Duration::from_millis(600_000), "{name}");
}

fn assert_text(name: &str, transport: &TimingOut) {
    let seen = first(name, transport);
    assert!(site(name).2.contains(&seen.text.as_str()), "{name}: Rust reads {:?}, Node's fetch rejected {:?}", seen.text, site(name).2);
}

/// The window the site's first request got is one of the timers Node armed.
pub(crate) fn assert_window(name: &str, transport: &TimingOut) {
    let seen = first(name, transport);
    assert!(site(name).1.contains(&(seen.after.as_millis() as u64)), "{name}: window {:?} is not one of Node's timers {:?}", seen.after, site(name).1);
}

/// The text the site throws where Node passes the fetch's text on.
pub(crate) fn assert_thrown(name: &str, message: &str) {
    assert_eq!(Some(message), site(name).3, "{name}");
}

/// The message of a failed login step.
pub(crate) fn login_message(failure: &mixdog_core_api::domain::login::LoginFailure) -> &str {
    match failure {
        mixdog_core_api::domain::login::LoginFailure::Failed { message, .. } => message,
        other => panic!("{other:?}"),
    }
}

/// For a site whose Node caller swallows the failure: the error this port's listing returns carries the text Node's `fetch`
/// rejected with.
pub(crate) fn assert_rejected_as_nodes(name: &str, message: &str) {
    assert!(site(name).2.contains(&message), "{name}: Rust returns {message:?}, Node's fetch rejected {:?}", site(name).2);
}

/// How many timers Node armed at the site.
pub(crate) fn armed_count(name: &str) -> usize {
    site(name).1.len()
}

/// How many fetches Node rejected at the site.
pub(crate) fn rejected_count(name: &str) -> usize {
    site(name).2.len()
}

/// The message Node threw at the site.
pub(crate) fn thrown(name: &str) -> &'static str {
    site(name).3.unwrap_or_else(|| panic!("{name}: Node threw nothing"))
}

/// The code Node threw at the site, where it is a string.
pub(crate) fn thrown_code(name: &str) -> Option<&'static str> {
    match name {
        "grokDiscovery" => Some("EPROVIDERTIMEOUT"),
        "grokRefresh" => Some("EPROVIDERTIMEOUT"),
        "compatModelList" => Some("EPROVIDERTIMEOUT"),
        "customOpenaiChatListing" => Some("EPROVIDERTIMEOUT"),
        "customAnthropicListing" => Some("EPROVIDERTIMEOUT"),
        "devinUnary" => Some("unavailable"),
        "vertexToken" => Some("EVERTEXAUTH"),
        "grokModelList" => Some("EPROVIDERTIMEOUT"),
        "cursorUsageCall" => Some("EPROVIDERTIMEOUT"),
        "cursorModelsCall" => Some("EPROVIDERTIMEOUT"),
        "cursorConnect" => Some("stream_aborted"),
        _ => None,
    }
}

/// The texts Node's `fetch` rejected with at the site.
pub(crate) fn rejected_texts(name: &str) -> Vec<String> {
    site(name).2.iter().map(|text| (*text).to_owned()).collect()
}

/// The lines Node logged at the site.
pub(crate) fn logged(name: &str) -> &'static [&'static str] {
    site(name).4
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::keepalive::TransportKind;

    use super::*;
    use crate::transport::deadlines::CURSOR_RUN;

    /// The Cursor stream's connect timer (`cursorConnect`): a request whose head never comes ends 30 s in, as the stream
    /// being aborted, not as a timeout.
    #[tokio::test(start_paused = true)]
    async fn a_cursor_stream_whose_head_never_comes_ends_at_thirty_seconds_as_aborted() {
        let transport = TimingOut::new();
        let request = WireRequest {
            transport: TransportKind::Http2,
            method: "POST".into(),
            url: "https://api2.cursor.sh/run".into(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let error = transport.send(request, CURSOR_RUN).await.err().expect("never answers");
        let seen = transport.seen();
        assert_eq!(seen[0].after, Duration::from_secs(30));
        assert_eq!((seen[0].text.as_str(), error.message.as_str()), ("Cursor stream was aborted", "Cursor stream was aborted"));
    }
}
