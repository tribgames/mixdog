//! The account flows: sign-in pages, login deadlines, device logins, the default account and the dashboard cache.

#![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded goldens on the test thread")]

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use serde_json::Value;

/// A session that began as a device code and is already `Waiting` when it is registered.
struct DeviceSession;

#[async_trait::async_trait]
impl mixdog_core_api::domain::login::LoginSession for DeviceSession {
    fn state(&self) -> mixdog_core_api::domain::login::LoginState {
        mixdog_core_api::domain::login::LoginState::Waiting
    }
    async fn next(&self) -> Option<mixdog_core_api::domain::login::LoginState> {
        std::future::pending().await
    }
    async fn provide(&self, _: mixdog_core_api::domain::login::LoginInput) -> Result<(), mixdog_core_api::domain::login::LoginError> {
        Err(mixdog_core_api::domain::login::LoginError::InputNotExpected)
    }
    fn cancel(&self) {}
    fn device_code(&self) -> bool {
        true
    }
}

struct EmptySetup;

#[async_trait::async_trait]
impl super::dashboards::SetupSource for EmptySetup {
    async fn setup(&self, _: bool, _: bool) -> Result<Value, String> {
        Ok(serde_json::json!({}))
    }

    async fn display_config(&self) -> Result<Value, String> {
        Ok(serde_json::json!({}))
    }
}

struct NoQuotas;

#[async_trait::async_trait]
impl super::usage::dashboard::UsageSources for NoQuotas {
    async fn cached_oauth(&self, _: &str, _: bool) -> Option<Value> {
        None
    }

    fn oauth_provider_ready(&self, _: &str) -> bool {
        false
    }

    async fn fetch_oauth(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        Ok(None)
    }

    async fn cached_api(&self, _: &str) -> Option<Value> {
        None
    }

    async fn fetch_api(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        Ok(None)
    }
}
struct Opened(std::sync::Mutex<Vec<String>>);

impl super::collaborators::LoginBrowser for Opened {
    fn open(&self, url: &str) {
        self.0.lock().unwrap().push(url.to_owned());
    }
}

/// Node's providers open the sign-in page unless `openBrowser` is false; a local "+" sends no option and so must
/// reach the browser through the core. A client of another machine (SSH, relay) never opens this host's browser.
#[test]
fn a_started_sign_in_opens_its_page_for_a_local_request_unless_it_asks_for_none() {
    use mixdog_core_api::domain::login::LoginState;
    let authorize = LoginState::Authorize { url: "https://auth.example/a".into(), manual_url: Some("https://auth.example/m".into()) };
    let device = LoginState::DeviceCode { user_code: "ABCD".into(), verification_uri: "https://auth.example/d".into(), expires_at: None };
    let opened = Opened(Default::default());
    for options in [serde_json::json!({}), serde_json::json!({ "addAccount": true }), serde_json::json!({ "openBrowser": true })] {
        super::admin::open_sign_in_page(&opened, true, &options, &authorize);
        super::admin::open_sign_in_page(&opened, false, &options, &authorize);
    }
    super::admin::open_sign_in_page(&opened, true, &serde_json::json!({}), &device);
    super::admin::open_sign_in_page(&opened, true, &serde_json::json!({}), &LoginState::Waiting);
    super::admin::open_sign_in_page(&opened, true, &serde_json::json!({ "openBrowser": false }), &authorize);
    super::admin::open_sign_in_page(&opened, false, &serde_json::json!({ "openBrowser": false }), &device);
    assert_eq!(*opened.0.lock().unwrap(), ["https://auth.example/a", "https://auth.example/a", "https://auth.example/a", "https://auth.example/d"]);
}

/// A provider's own login deadline (`LOGIN_TIMEOUT_MS`: two minutes for Command Code) ends the flow with that
/// provider's text before the registry's ten-minute expiry, and a newer login supersedes a pending one.
#[tokio::test(start_paused = true)]
async fn a_providers_login_deadline_ends_its_flow_before_the_registry_expiry() {
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::domain::mock::LiveLoginSession;
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    let scoped = std::sync::Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let flows =
        super::flows::OAuthFlows::new(std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS), std::sync::Arc::new(LoginFeeds::new(scoped)));
    let settle = || -> super::flows::Settle { Box::new(move |_| Box::pin(async move { Ok(true) })) };
    let started = flows.register("command-code-oauth", Box::new(LiveLoginSession::new(LoginState::Starting)), settle()).unwrap();
    let id = started["flowId"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_secs(119)).await;
    assert_eq!(flows.cancel(&id).await.unwrap()["state"], "cancelled", "still pending before the deadline: the cancel lands");

    let started = flows.register("command-code-oauth", Box::new(LiveLoginSession::new(LoginState::Starting)), settle()).unwrap();
    let id = started["flowId"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_secs(121)).await;
    let status = flows.cancel(&id).await.unwrap();
    assert_eq!(status["state"], "failed");
    assert_eq!(status["error"], "[command-code-oauth] login timed out after 120s");
    flows.cancel_all();
}
/// The flow's kind is fixed when it was created: a device login registered after its first state moved on still has
/// no 5-minute browser deadline (OpenAI's runs 15 min, openai-oauth-login.mjs:29), and a newer login supersedes it
/// by handing back the cancelled session to wait on.
#[tokio::test(start_paused = true)]
async fn a_device_login_keeps_its_kind_after_its_state_moves_on_and_a_newer_login_gets_the_prior_session() {
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    let scoped = std::sync::Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let flows =
        super::flows::OAuthFlows::new(std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS), std::sync::Arc::new(LoginFeeds::new(scoped)));
    let settle = || -> super::flows::Settle { Box::new(move |_| Box::pin(async move { Ok(true) })) };
    let started = flows.register("openai-oauth", Box::new(DeviceSession), settle()).unwrap();
    let id = started["flowId"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_secs(301)).await;
    let prior = flows.supersede("openai-oauth").expect("still pending after the browser deadline: the prior session");
    prior.released().await;
    assert_eq!(flows.cancel(&id).await.unwrap()["state"], "cancelled");
    assert!(flows.supersede("openai-oauth").is_none(), "nothing pending is left to supersede");
    flows.cancel_all();
}

/// A manual code whose `provide` fails ends the flow as `failed` and cancels the underlying session so its process,
/// listener and guards tear down instead of leaking.
#[tokio::test]
async fn a_failed_code_completion_cancels_the_login_session() {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::login::LoginError;
    use mixdog_core_api::domain::login::LoginFailure;
    use mixdog_core_api::domain::login::LoginInput;
    use mixdog_core_api::domain::login::LoginSession;
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;

    struct FailingPaste {
        cancelled: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl LoginSession for FailingPaste {
        fn state(&self) -> LoginState {
            LoginState::Authorize { url: "https://auth.example/a".into(), manual_url: Some("https://auth.example/a".into()) }
        }
        async fn next(&self) -> Option<LoginState> {
            std::future::pending().await
        }
        async fn provide(&self, _: LoginInput) -> Result<(), LoginError> {
            Err(LoginError::Failed(LoginFailure::Failed { code: "agentLogin".into(), message: "wrong state".into() }))
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }

    let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let flows = super::flows::OAuthFlows::new(std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS), Arc::new(LoginFeeds::new(scoped)));
    let settle: super::flows::Settle = Box::new(move |_| Box::pin(async move { Ok(true) }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let started = flows.register("acp-antigravity", Box::new(FailingPaste { cancelled: cancelled.clone() }), settle).unwrap();
    let id = started["flowId"].as_str().unwrap().to_owned();
    let err = flows.complete(&id, "http://localhost:1/oauth2callback?state=wrong&code=c").await.unwrap_err();
    assert_eq!(err.message(), "wrong state");
    assert_eq!(flows.status(&id).unwrap()["state"], "failed");
    assert!(cancelled.load(Ordering::SeqCst), "the underlying session was cancelled when complete failed");
}

/// A roster read that never ran is not the "default" account: a login, a forget or a credit
/// redemption on "default" would act on a different account than the selected one.
#[tokio::test]
async fn an_unread_roster_is_not_the_default_account() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    {
        let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
        let error = super::admin::selected_of(store.pool("openai-oauth").await).unwrap_err();
        assert!(error.unrun(), "{error}");
    }
    // A roster that was read and has no selection is "default".
    assert_eq!(super::admin::selected_of(store.pool("openai-oauth").await).unwrap(), "default");
}
/// Node's dashboard cache is filled by a client's question only. The core's own reading for the `usage` section must not fill
/// it: a client's first plain question builds and answers without `cached`, and only the next one is the cached answer.
#[tokio::test]
async fn the_producers_reading_does_not_seed_the_dashboard_cache() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let accounts = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let dashboards = super::dashboards::Dashboards::new(std::sync::Arc::new(EmptySetup));
    let question = serde_json::json!({ "refresh": true, "refreshSetup": false });

    let produced = dashboards.read_at(&question, &NoQuotas, &accounts, 1_000).await.unwrap();
    assert!(produced.get("cached").is_none(), "{produced}");
    let first = dashboards.get_at(&serde_json::json!({}), &NoQuotas, &accounts, 2_000).await.unwrap();
    assert!(first.get("cached").is_none(), "the producer's reading answered the client's first question: {first}");
    let second = dashboards.get_at(&serde_json::json!({}), &NoQuotas, &accounts, 3_000).await.unwrap();
    assert_eq!(second["cached"], true);
    assert_eq!(second["cachedAt"], 2_000);
}
/// The page is the start's, not the flow's current state: a login that is already waiting still opens it.
#[tokio::test]
async fn the_page_opens_although_the_flow_has_already_moved_past_authorize() {
    use mixdog_ai::oauth::session::{FlowGuard, start_session};
    use mixdog_core_api::domain::login::LoginState;
    mixdog_rt::testing::tokens();
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let session = start_session(
        FlowGuard::claim(&flag).unwrap(),
        LoginState::Authorize { url: "https://auth.example/a".into(), manual_url: None },
        true,
        |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            std::future::pending().await
        },
    );
    while session.state() != LoginState::Waiting {
        tokio::task::yield_now().await;
    }
    let opened = Opened(Default::default());
    super::admin::open_sign_in_page(&opened, true, &serde_json::json!({}), &session.started());
    assert_eq!(*opened.0.lock().unwrap(), ["https://auth.example/a"]);
    session.cancel();
}

/// A registered login answers a pasted code only while it is pending, takes a code only from a provider that accepts one,
/// and a newer login of the same provider ends the older one as superseded.
#[tokio::test(start_paused = true)]
async fn a_pasted_code_is_refused_unless_the_login_is_pending_and_takes_one_and_a_newer_login_supersedes() {
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::domain::mock::LiveLoginSession;
    use mixdog_core_api::feed_publisher::LoginFeeds;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    let scoped = std::sync::Arc::new(MockScopedFeeds::new(MockLimits::default()));
    let flows =
        super::flows::OAuthFlows::new(std::time::Duration::from_millis(super::flows::DEFAULT_FLOW_TTL_MS), std::sync::Arc::new(LoginFeeds::new(scoped)));
    let settle = || -> super::flows::Settle { Box::new(move |_| Box::pin(async move { Ok(true) })) };
    assert_eq!(flows.complete("bad id", "code").await.unwrap_err().message(), "OAuth flow id is invalid.");
    let first = flows.register("openai-oauth", Box::new(DeviceSession), settle()).unwrap();
    let first_id = first["flowId"].as_str().unwrap().to_owned();
    assert_eq!(flows.complete(&first_id, "code").await.unwrap_err().message(), "This OAuth provider does not accept a manual code.");
    assert!(flows.register("", Box::new(DeviceSession), settle()).is_err(), "a login without a provider id is refused");
    let second = flows.register("openai-oauth", Box::new(LiveLoginSession::new(LoginState::Starting)), settle()).unwrap();
    assert_eq!(flows.status(&first_id).unwrap()["state"], "cancelled");
    assert_eq!(flows.status(&first_id).unwrap()["error"], "Superseded by a newer OAuth login.");
    assert_eq!(flows.complete(&first_id, "code").await.unwrap_err().message(), "OAuth login flow is no longer pending.");
    assert_eq!(second["state"], "pending");
    flows.cancel_all();
}
