//! The Node collaborators of the account service that have no implementation in the Rust crates
//! yet. Each trait is the exact set of missing functions (Node `file:line` in the work report);
//! once its owner lands them the trait is replaced by direct calls.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::failure::Failure;

/// One OAuth provider's credential module (`OAUTH_PROVIDERS` entry), addressed by account id.
#[async_trait]
pub trait OAuthProvider: Send + Sync {
    fn id(&self) -> &'static str;
    /// `describe<Provider>OAuthCredentials()`: `{ authenticated, status, email?, identityId?, ... }`.
    async fn describe(&self, account: &str) -> Value;
    /// `forget<Provider>OAuthCredentials()`: `{ removed }`.
    async fn forget(&self, account: &str) -> Result<Value, String>;
    /// The interactive login writing `account`'s credential file; `None` when the provider
    /// has no login flow in Rust (OpenAI, Devin).
    fn login_flow(&self, account: &str) -> Option<Arc<dyn LoginFlow>>;
}

/// What the runtime refreshes after credentials change (`provider-auth/refresh.mjs`): provider
/// registry sync, caches, admission cooldowns and catalogs. Boot owns these.
pub trait AuthRefresh: Send + Sync {
    fn after_credential_change(&self);
    fn adopt_credentials(&self);
    fn after_usage_auth_change(&self);
    fn release_admission_cooldowns(&self);
    /// The roster's selection changed: drop model caches and warm them again.
    fn account_selection_changed(&self);
}

/// `describeVertexAdc` + the metadata probe (`vertex-ai-auth.mjs`): the gcloud login check.
#[async_trait]
pub trait VertexAdc: Send + Sync {
    /// `Ok(project)` for a usable login (its project, if it names one), `Err(message)` otherwise.
    async fn login(&self, project_id: &str) -> Result<Option<String>, String>;
}

/// The custom-provider section of `provider-admin.mjs`. Each call is the `login.mjs` wrapper:
/// after it succeeds `AuthRefresh::after_credential_change` has run.
#[async_trait]
pub trait CustomProviders: Send + Sync {
    async fn save(&self, input: Value) -> Result<Value, Failure>;
    /// `secret` is the request's value as sent: anything but a string is Node's `TypeError`.
    async fn save_key(&self, id: &str, secret: &Value) -> Result<Value, Failure>;
    async fn remove(&self, id: &str) -> Result<Value, Failure>;
    /// `patch`: `None` is absent (refused), `Some(null)` removes the model's override.
    async fn update_model(&self, id: &str, model_id: &str, patch: Option<Value>) -> Result<Value, Failure>;
    async fn test(&self, input: Value) -> Result<Value, Failure>;
    async fn discover_models(&self, input: Value) -> Result<Value, Failure>;
}

/// `collectWebSearchProviderModels({ force })` (`provider-models/web-search-catalog.mjs`).
#[async_trait]
pub trait WebSearchModels: Send + Sync {
    /// `thread` is the conversation whose runtime asks (Node's `rt`): the Main route the rows follow and the
    /// adopted cache are that thread's. `None`: a request that names none, answered as a fresh runtime would.
    async fn list(&self, thread: Option<&ThreadId>, force: bool) -> Result<Value, Failure>;
}

/// `cachedProviderSetup` (`provider-auth/setup.mjs` over `providerSetup`, `provider-admin.mjs`).
#[async_trait]
pub trait ProviderSetup: Send + Sync {
    async fn get(&self, force: bool, refresh: bool, unlock_keychain: bool, recheck_keychain: bool) -> Result<Value, Failure>;
    /// Ticks each time a complete setup fills the cache, which is what a cold read's background build ends in:
    /// Node's next read answers it, so a pushed section must follow.
    fn filled(&self) -> tokio::sync::watch::Receiver<u64>;
}
