use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::oauth_usage::GrokClient;
use mixdog_ai::service::oauth_usage::OAuthUsage;
use mixdog_ai::service::oauth_usage::QuotaHistory;
use mixdog_ai::service::oauth_usage::QuotaSample;
use mixdog_ai::service::oauth_usage::UsageDeps;
use mixdog_ai::service::oauth_usage::UsageError;
use mixdog_ai::service::oauth_usage::UsageHttp;
use mixdog_ai::service::oauth_usage::UsageResponse;
use mixdog_ai::service::oauth_usage::UsageSource;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_core_api::domain::mock::LiveLoginSession;
use serde_json::Value;
use serde_json::json;

use super::admin::ProviderAdmin;
use super::collaborators::OAuthProvider;
use super::collaborators::VertexAdc;
use super::custom_admin_tests::World;
use super::custom_admin_tests::world;

struct Offline;

#[async_trait]
impl UsageHttp for Offline {
    async fn get(&self, _: &str, _: &[(String, String)], _: Duration) -> Result<UsageResponse, UsageError> {
        Err(UsageError::new("offline"))
    }
    async fn post_json(&self, _: &str, _: &[(String, String)], _: &Value, _: Duration) -> Result<UsageResponse, UsageError> {
        Err(UsageError::new("offline"))
    }
}

#[async_trait]
impl UsageSource for Offline {
    async fn ensure_auth(
        &self,
        _: &str,
        _: &str,
        _: Option<&mixdog_ai::service::oauth_usage::UsageAuth>,
    ) -> Result<Option<mixdog_ai::service::oauth_usage::UsageAuth>, UsageError> {
        Ok(None)
    }
    async fn provider_snapshot(&self, _: &str, _: &str) -> Result<Option<Value>, UsageError> {
        Ok(None)
    }
}

#[async_trait]
impl GrokClient for Offline {
    async fn warm(&self) {}
    fn headers(&self) -> Vec<(String, String)> {
        Vec::new()
    }
}

#[async_trait]
impl QuotaHistory for Offline {
    async fn record(&self, _: Vec<QuotaSample>) -> Result<(), String> {
        Ok(())
    }
}

struct FakeAdc(Result<Option<String>, String>);

#[async_trait]
impl VertexAdc for FakeAdc {
    async fn login(&self, _: &str) -> Result<Option<String>, String> {
        self.0.clone()
    }
}

/// Records which account each started flow was for, prefixed `device:` when it was asked for without a browser.
struct FakeFlow {
    prefix: &'static str,
    account: String,
    started: Arc<Mutex<Vec<String>>>,
    target: LoginTarget,
}

#[async_trait]
impl LoginFlow for FakeFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }
    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        self.started.lock().unwrap().push(format!("{}{}", self.prefix, self.account));
        Ok(Box::new(LiveLoginSession::new(LoginState::Starting)))
    }
}

struct FakeOAuth {
    has_flow: bool,
    started: Arc<Mutex<Vec<String>>>,
}

impl FakeOAuth {
    fn flow(&self, prefix: &'static str, account: &str) -> Option<Arc<dyn LoginFlow>> {
        self.has_flow.then(|| {
            Arc::new(FakeFlow { prefix, account: account.to_owned(), started: self.started.clone(), target: LoginTarget::Github }) as Arc<dyn LoginFlow>
        })
    }
}

#[async_trait]
impl OAuthProvider for FakeOAuth {
    fn id(&self) -> &'static str {
        "openai-oauth"
    }
    async fn describe(&self, _: &str) -> Value {
        json!({ "authenticated": false })
    }
    async fn forget(&self, _: &str) -> Result<Value, String> {
        Ok(json!({ "removed": false }))
    }
    fn login_flow(&self, account: &str) -> Option<Arc<dyn LoginFlow>> {
        self.flow("", account)
    }
    fn login_flow_without_browser(&self, account: &str) -> Option<Arc<dyn LoginFlow>> {
        self.flow("device:", account)
    }
}

struct Rig {
    admin: Arc<ProviderAdmin>,
    world: World,
    started: Arc<Mutex<Vec<String>>>,
}

async fn rig(has_flow: bool, adc: Result<Option<String>, String>) -> Rig {
    let world = world(Default::default()).await;
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let usage = OAuthUsage::new(UsageDeps {
        http: Arc::new(Offline),
        source: Arc::new(Offline),
        grok: Arc::new(Offline),
        history: Arc::new(Offline),
        store: world.accounts.clone(),
        io: io(),
        log: Arc::new(|_: &str| {}),
        data_dir: world._dir.path().to_path_buf(),
    });
    let started = Arc::new(Mutex::new(Vec::new()));
    let admin = ProviderAdmin::new(
        vec![Arc::new(FakeOAuth { has_flow, started: started.clone() })],
        world.builder.clone(),
        world.accounts.clone(),
        world.vault.clone(),
        world.config.clone(),
        world.refresh.clone(),
        Arc::new(FakeAdc(adc)),
        Arc::new(ProviderRegistry::new(world.builder.clone())),
        usage,
        io(),
    );
    Rig { admin, world, started }
}

fn stored(rig: &Rig, provider: &str) -> Value {
    rig.world.config.agent().get("providers").and_then(|providers| providers.get(provider)).cloned().unwrap_or(Value::Null)
}

fn refreshes(rig: &Rig) -> usize {
    rig.world.refresh.0.load(Ordering::SeqCst)
}

fn secret(rig: &Rig, account: &str) -> Option<String> {
    rig.world.vault.secrets.lock().unwrap().get(account).cloned()
}

async fn begin(rig: &Rig, provider: &str, options: Value) -> Result<(), String> {
    rig.admin.begin_oauth_provider_login(provider, &options, false).await.map(|_| ()).map_err(|failure| failure.message().to_owned())
}

#[tokio::test]
async fn a_sign_in_starts_for_the_selected_account_a_new_one_or_a_connected_one_it_was_asked_for() {
    let rig = rig(true, Ok(None)).await;
    begin(&rig, "openai-oauth", json!({})).await.unwrap();
    begin(&rig, " openai-oauth ", json!({ "openBrowser": false })).await.unwrap();
    begin(&rig, "openai-oauth", json!({ "addAccount": true })).await.unwrap();
    let started = rig.started.lock().unwrap().clone();
    assert_eq!(started[..2], ["default", "device:default"]);
    assert!(!started[2].is_empty() && started[2] != "default", "a new account gets its own id: {started:?}");
    assert_eq!(started.len(), 3);
}

#[tokio::test]
async fn a_sign_in_that_cannot_start_names_why() {
    let rig = rig(true, Ok(None)).await;
    assert_eq!(begin(&rig, "nope", json!({})).await.unwrap_err(), "unknown OAuth provider \"nope\"");
    assert_eq!(begin(&rig, "openai-oauth", json!({ "accountId": "ghost" })).await.unwrap_err(), "Account is no longer connected.");
    assert_eq!(begin(&rig, "openai-oauth", json!({ "addAccount": true, "accountId": "x" })).await.unwrap_err(), "Account is no longer connected.");
    assert!(rig.started.lock().unwrap().is_empty());
    let without = self::rig(false, Ok(None)).await;
    assert_eq!(begin(&without, "openai-oauth", json!({})).await.unwrap_err(), "openai-oauth does not support interactive code login");
}

#[tokio::test]
async fn a_gcloud_login_replaces_a_stored_vertex_key_and_stores_nothing_secret() {
    let rig = rig(true, Ok(Some("p1".into()))).await;
    rig.world.vault.secrets.lock().unwrap().insert("agent.vertex-ai.apiKey".into(), "old".into());
    let answer = rig.admin.save_provider_api_key("vertex-ai", "", &json!({ "authMode": "adc", "projectId": "p1" })).await.unwrap();
    assert_eq!(answer, json!({ "provider": "vertex-ai", "type": "adc", "authenticated": true }));
    assert_eq!(secret(&rig, "agent.vertex-ai.apiKey"), None);
    let entry = stored(&rig, "vertex-ai");
    assert_eq!((entry["enabled"].clone(), entry["authMode"].clone(), entry["projectId"].clone()), (json!(true), json!("adc"), json!("p1")));
    assert!(entry.get("location").is_none());
    assert_eq!(refreshes(&rig), 1);
}

#[tokio::test]
async fn a_gcloud_login_that_cannot_be_used_changes_nothing() {
    let none = rig(true, Ok(None)).await;
    none.world.vault.secrets.lock().unwrap().insert("agent.vertex-ai.apiKey".into(), "old".into());
    let failure = none.admin.save_provider_api_key("vertex-ai", "", &json!({ "authMode": "adc" })).await.unwrap_err();
    assert!(failure.message().starts_with("No Google Cloud project found for the gcloud login."), "{}", failure.message());
    assert_eq!(secret(&none, "agent.vertex-ai.apiKey").as_deref(), Some("old"));
    assert_eq!(stored(&none, "vertex-ai"), Value::Null);
    assert_eq!(refreshes(&none), 0);

    let unread = rig(true, Ok(Some("p1".into()))).await;
    unread.world.vault.unrun_reads.store(true, Ordering::SeqCst);
    assert!(unread.admin.save_provider_api_key("vertex-ai", "", &json!({ "authMode": "adc" })).await.is_err());
    assert_eq!(stored(&unread, "vertex-ai"), Value::Null);
}

#[tokio::test]
async fn an_express_vertex_key_and_a_plain_provider_key_are_stored_in_the_vault_and_enable_the_provider() {
    let rig = rig(true, Ok(None)).await;
    let express = rig.admin.save_provider_api_key("vertex-ai", " AIza-key ", &json!({ "authMode": "api-key", "location": "global" })).await.unwrap();
    assert_eq!(express, json!({ "provider": "vertex-ai", "type": "api-key", "authenticated": true }));
    assert_eq!(secret(&rig, "agent.vertex-ai.apiKey").as_deref(), Some("AIza-key"));
    let entry = stored(&rig, "vertex-ai");
    assert_eq!((entry["authMode"].clone(), entry["location"].clone(), entry["enabled"].clone()), (json!("api-key"), json!("global"), json!(true)));

    let plain = rig.admin.save_provider_api_key("openai", " sk-1 ", &Value::Null).await.unwrap();
    assert_eq!(plain, json!({ "provider": "openai", "type": "api-key", "authenticated": true }));
    assert_eq!(secret(&rig, "agent.openai.apiKey").as_deref(), Some("sk-1"));
    assert_eq!(stored(&rig, "openai")["enabled"], json!(true));
    assert_eq!(refreshes(&rig), 2);

    let refused = |provider: &'static str, key: &'static str| {
        let admin = rig.admin.clone();
        async move { admin.save_provider_api_key(provider, key, &Value::Null).await.unwrap_err().message().to_owned() }
    };
    assert_eq!(refused("nope", "k").await, "unknown API-key provider \"nope\"");
    assert_eq!(refused("openai", "  ").await, "API key is required for openai");
}
