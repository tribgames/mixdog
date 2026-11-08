//! The `login:<flowId>` feed of the MCP sign-in flows against Node's recorded status answers
//! (`benchmarks/rust-core/recorders/record-login-status.mjs`): the status Node answered after each step of a
//! sign-in is the state the Rust flow publishes on its feed for that step, and the snapshot of a late subscriber
//! is the status the flow ended with.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::mock::LiveLoginSession;
use mixdog_core_api::feed_publisher::LoginFeeds;
use mixdog_core_api::mock::FeedTap;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_mcp::mcp_logins::LOGIN_DEADLINE;
use mixdog_mcp::mcp_logins::LoginBackend;
use mixdog_mcp::mcp_logins::McpLogins;
use mixdog_mcp::mcp_logins::Started;
use mixdog_mcp::oauth::account::AccountMode;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::mpsc;

const GOLDEN: &str = include_str!("../../../../fixtures/login-status/golden.json");

/// The sign-in backend the test drives: its session is `session`, and `settle` answers what the test sends.
struct Scripted {
    session: LiveLoginSession,
    stored: bool,
    started: Notify,
    proceed: Notify,
    settle: Mutex<mpsc::UnboundedReceiver<(bool, Option<String>)>>,
}

#[async_trait]
impl LoginBackend for Scripted {
    async fn start(&self, _: &str, _: AccountMode, _: bool) -> Result<Started, String> {
        self.started.notify_one();
        self.proceed.notified().await;
        if self.stored { Ok(Started::Connected) } else { Ok(Started::Browser(Box::new(self.session.clone()))) }
    }
    async fn settle(&self, _: &str, _: AccountMode, _: bool, _: Option<String>) -> (bool, Option<String>) {
        self.settle.lock().await.recv().await.expect("the test answers the settle")
    }
    fn open_browser(&self, _: &str) {}
    async fn completed(&self, _: &str) {}
}

fn masked(value: &Value, flow_id: &str) -> Value {
    serde_json::from_str(&value.to_string().replace(flow_id, "<flow>")).expect("masking keeps JSON")
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_sign_in_feeds_publish_the_statuses_node_answered() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden is JSON");
    let auth_url = golden["authUrl"].as_str().unwrap().to_owned();
    for case in golden["mcp"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (settle_tx, settle_rx) = mpsc::unbounded_channel();
        let backend = Arc::new(Scripted {
            session: LiveLoginSession::new(LoginState::Starting),
            stored: name == "stored-credentials",
            started: Notify::new(),
            proceed: Notify::new(),
            settle: Mutex::new(settle_rx),
        });
        let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
        let feeds = Arc::new(LoginFeeds::new(scoped.clone()));
        let deadline = if name == "timeout" { Duration::from_millis(1) } else { LOGIN_DEADLINE };
        let logins = Arc::new(McpLogins::with_deadline(backend.clone(), deadline, feeds));
        let began = {
            let logins = logins.clone();
            tokio::spawn(async move { logins.begin("remote", &json!({ "openBrowser": false })).await })
        };
        backend.started.notified().await;
        let ids = scoped.ids();
        let [feed_id] = ids.as_slice() else { panic!("{name}: one sign-in opened {ids:?}") };
        let flow_id = feed_id.0.strip_prefix("login:").unwrap().to_owned();
        let tap = FeedTap::attach(&scoped.find(feed_id).unwrap());
        backend.proceed.notify_one();

        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            match step["do"].as_str().unwrap() {
                "launch" => backend.session.emit(LoginState::Authorize { url: auth_url.clone(), manual_url: None }),
                "callback" => backend.session.emit(LoginState::Waiting),
                "authorized" => backend.session.emit(LoginState::Done { account: None }),
                "resolve" if step["outcome"]["connected"] == json!(true) => settle_tx.send((true, None)).unwrap(),
                "resolve" => backend.session.emit(LoginState::Failed(LoginFailure::Failed {
                    code: "denied".into(),
                    message: step["outcome"]["error"].as_str().unwrap().to_owned(),
                })),
                "cancel" => {
                    logins.cancel(&flow_id).await.unwrap();
                }
                // The deadline runs by itself; a stored sign-in settles by itself.
                "deadline" | "settled" => {}
                other => panic!("{name}: unknown step {other}"),
            }
            let seen = tap.notifications_until(|frames| frames.len() > index + 1).await;
            assert_eq!(seen[0]["method"], "feed/snapshot", "{name}");
            assert_eq!(seen[index + 1]["method"], "login/updated", "{name} step {index}");
            assert_eq!(seen[index + 1]["params"]["flowId"], flow_id.as_str(), "{name}");
            assert_eq!(masked(&seen[index + 1]["params"]["state"], &flow_id), case["statuses"][index], "{name} step {index}");
        }
        let started = began.await.unwrap().unwrap_or_else(|error| panic!("{name}: begin failed: {error}"));
        assert_eq!(masked(&started, &flow_id), case["started"], "{name}: the begin answer");

        let late = FeedTap::attach(&scoped.find(feed_id).unwrap());
        let seen = late.notifications_until(|frames| !frames.is_empty()).await;
        let last = case["statuses"].as_array().unwrap().last().unwrap();
        assert_eq!(seen[0]["method"], "feed/snapshot", "{name}");
        assert_eq!(masked(&seen[0]["params"]["state"], &flow_id), *last, "{name}: a late subscriber sees the final status");
    }
}
