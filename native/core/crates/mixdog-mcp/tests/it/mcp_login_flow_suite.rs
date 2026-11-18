//! An MCP sign-in flow as the caller sees it: what `begin` answers, the steps a pending flow goes through on its `login:<flowId>` feed,
//! how it ends (connected, failed with the reason, cancelled), and what a bad option or an unknown or finished flow is told.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::mock::LiveLoginSession;
use mixdog_core_api::feed_publisher::LoginFeeds;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_mcp::mcp_logins::LoginBackend;
use mixdog_mcp::mcp_logins::McpLogins;
use mixdog_mcp::mcp_logins::Started;
use mixdog_mcp::oauth::account::AccountMode;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

const AUTH_URL: &str = "https://auth.example/authorize?state=s";

struct Scripted {
    session: LiveLoginSession,
    stored: bool,
    started: Notify,
}

#[async_trait]
impl LoginBackend for Scripted {
    async fn start(&self, _: &str, _: AccountMode, _: bool) -> Result<Started, String> {
        self.started.notify_one();
        if self.stored { Ok(Started::Connected) } else { Ok(Started::Browser(Box::new(self.session.clone()))) }
    }
    async fn settle(&self, _: &str, _: AccountMode, _: bool, _: Option<String>) -> (bool, Option<String>) {
        (true, None)
    }
    fn open_browser(&self, _: &str) {}
    async fn completed(&self, _: &str) {}
}

struct Run {
    backend: Arc<Scripted>,
    logins: Arc<McpLogins>,
    scoped: Arc<MockScopedFeeds>,
}

fn run(stored: bool) -> Run {
    let backend = Arc::new(Scripted { session: LiveLoginSession::new(LoginState::Starting), stored, started: Notify::new() });
    let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let logins = Arc::new(McpLogins::new(backend.clone(), Arc::new(LoginFeeds::new(scoped.clone()))));
    Run { backend, logins, scoped }
}

/// Begins a browser sign-in of `remote` and returns it pending with its url, with a tap on its feed.
async fn pending(run: &Run) -> (String, Value, FeedTap) {
    let began = {
        let logins = run.logins.clone();
        tokio::spawn(async move { logins.begin("remote", &json!({"openBrowser": false})).await })
    };
    run.backend.started.notified().await;
    let ids = run.scoped.ids();
    let [feed] = ids.as_slice() else { panic!("one sign-in opened {ids:?}") };
    let flow_id = feed.0.strip_prefix("login:").unwrap().to_owned();
    let tap = FeedTap::attach(&run.scoped.find(feed).unwrap());
    run.backend.session.emit(LoginState::Authorize { url: AUTH_URL.to_owned(), manual_url: None });
    let answer = began.await.unwrap().expect("begin answers once the sign-in page is known");
    (flow_id, answer, tap)
}

async fn until_state(tap: &FeedTap, wanted: &'static str) -> Value {
    let frames = tap.notifications_until(|frames| frames.last().is_some_and(|frame| frame["params"]["state"]["state"] == wanted)).await;
    frames.last().unwrap()["params"]["state"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn stored_credentials_connect_the_server_and_no_login_is_needed() {
    let run = run(true);
    let answer = run.logins.begin("remote", &json!({})).await.unwrap();
    assert_eq!(answer["state"], "complete");
    let flow_id = answer["flowId"].as_str().expect("a flow id");
    assert_eq!(run.logins.status(flow_id, &json!({})).await.unwrap()["state"], "complete");
    assert!(!run.logins.is_pending("remote"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_sign_in_answers_its_url_then_follows_the_callback_to_complete() {
    let run = run(false);
    let (flow_id, answer, tap) = pending(&run).await;
    assert_eq!((answer["state"].as_str(), answer["url"].as_str(), answer["flowId"].as_str()), (Some("pending"), Some(AUTH_URL), Some(flow_id.as_str())));
    assert!(run.logins.is_pending("remote"));
    assert_eq!(run.logins.status(&flow_id, &json!({})).await.unwrap()["step"], "browser");

    run.backend.session.emit(LoginState::Waiting);
    let step = tap.notifications_until(|frames| frames.last().is_some_and(|frame| frame["params"]["state"]["step"] == "connecting")).await;
    assert_eq!(step.last().unwrap()["params"]["flowId"], flow_id.as_str());

    run.backend.session.emit(LoginState::Done { account: None });
    assert_eq!(until_state(&tap, "complete").await["flowId"], flow_id.as_str());
    assert!(!run.logins.is_pending("remote"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_the_provider_refuses_fails_with_the_reason_it_gave() {
    let run = run(false);
    let (flow_id, _, tap) = pending(&run).await;
    run.backend.session.emit(LoginState::Failed(LoginFailure::Failed { code: "denied".into(), message: "The provider refused the sign-in.".into() }));
    let state = until_state(&tap, "failed").await;
    assert_eq!(state["error"], "The provider refused the sign-in.");
    assert!(state.get("step").is_none(), "only a pending flow shows a step");
    assert_eq!(run.logins.status(&flow_id, &json!({})).await.unwrap()["error"], "The provider refused the sign-in.");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_sign_in_is_cancelled_and_can_no_longer_be_completed() {
    let run = run(false);
    let (flow_id, _, tap) = pending(&run).await;
    let cancelled = run.logins.cancel(&flow_id).await.unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(until_state(&tap, "cancelled").await["flowId"], flow_id.as_str());
    assert_eq!(run.logins.complete(&flow_id, "http://127.0.0.1:1/oauth/callback?code=c").await.unwrap_err(), "MCP OAuth sign-in is no longer pending");
    assert!(!run.logins.is_pending("remote"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_option_or_an_unknown_flow_is_refused_in_words() {
    let run = run(true);
    assert_eq!(run.logins.begin("remote", &json!({"openBrowser": "yes"})).await.unwrap_err(), "openBrowser must be a boolean");
    assert_eq!(run.logins.begin("remote", &json!({"mode": "other"})).await.unwrap_err(), "mode must be connect, reauth or switch");
    assert_eq!(run.logins.status("no-such-flow", &json!({})).await.unwrap_err(), "MCP OAuth login not found");
    assert_eq!(run.logins.cancel("no-such-flow").await.unwrap_err(), "MCP OAuth login not found");
}