//! The production [`SetupBuilder`]: `providerSetup(displayConfig(), options)` over the machine.
//! [`provider_setup`] builds the rows from a synchronous [`SetupWorld`]; what the rows read is
//! asynchronous (the keychain, the OAuth credential files, the gcloud login, the local runtime), so
//! it is read first, on the lanes, into a [`PrefetchedWorld`], and the rows are built from that.
//!
//! Only what the options ask for is read: with `check_secrets` false no secret and no credential
//! file is touched, and with `detect_local` false the local runtime is not probed. A read that never
//! ran (a vault lane that dropped the job) fails the build instead of reading as "no key".

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::providers::google::auth::vertex::parse_service_account;
use mixdog_ai::providers::google::serving::env_location;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, SecretVault, api_key_account};
use serde_json::Value;

use super::collaborators::OAuthProvider;
use super::custom_admin::CustomFacts;
use super::failure::Failure;
use super::oauth_status::{PROVIDERS, oauth_available};
use super::provider_setup::{KeychainStatus, SetupOptions, SetupWorld, model_proxy_provider_setup, provider_setup};
use super::setup_cache::{KeychainLive, SetupBuilder};

/// The API providers whose keys the rows read, in setup order.
const API_IDS: [&str; 7] = ["openrouter", "openai", "anthropic", "gemini", "vertex-ai", "deepseek", "xai"];

/// `getLocalProviderStatus || localProviderStatus`: the local runtime's status, `None` when it throws.
#[async_trait]
pub trait LocalStatus: Send + Sync {
    async fn status(&self) -> Option<Value>;
}

/// The PC's advertised providers in the model-proxy client mode (`loadModelProxyProviderConfig`).
#[async_trait]
pub trait ProxyProviders: Send + Sync {
    /// `Ok(None)`: no PC is connected (`MODEL_PROXY_UNAVAILABLE`); any other failure is an error.
    async fn providers(&self, force: bool) -> Result<Option<serde_json::Map<String, Value>>, Failure>;
}

/// `displayConfig()`: the config the setup is shown for (providers as the user edits them).
pub type DisplayConfig = Arc<dyn Fn() -> Value + Send + Sync>;

/// Everything the rows read, read.
pub struct PrefetchedWorld {
    env: Arc<dyn Environment>,
    resolved_env: HashMap<String, String>,
    stored: HashSet<String>,
    fallback: HashSet<String>,
    key_present: HashSet<String>,
    keychain: KeychainStatus,
    oauth_ids: HashSet<&'static str>,
    oauth_described: HashMap<&'static str, Value>,
    vertex_adc: Option<Value>,
    vertex_key_project: Option<String>,
    local: Option<Value>,
    key_ids: HashMap<String, Vec<String>>,
    builder: Arc<DefaultProviderBuilder>,
    vertex_project: Option<String>,
}

impl CustomFacts for PrefetchedWorld {
    fn env(&self, name: &str) -> Option<String> {
        self.env.var(name)
    }
    fn has_stored_secret(&self, account: &str) -> bool {
        self.stored.contains(account)
    }
    fn is_fallback_secret(&self, account: &str) -> bool {
        self.fallback.contains(account)
    }
    fn custom_key_ids(&self, id: &str) -> Vec<String> {
        self.key_ids.get(id).cloned().unwrap_or_default()
    }
}

impl SetupWorld for PrefetchedWorld {
    fn resolved_env_name(&self, id: &str) -> Option<String> {
        self.resolved_env.get(id).cloned()
    }
    fn has_agent_api_key(&self, id: &str) -> bool {
        self.key_present.contains(id)
    }
    fn keychain_status(&self) -> KeychainStatus {
        self.keychain.clone()
    }
    fn oauth_available(&self, id: &str) -> bool {
        self.oauth_ids.contains(id)
    }
    fn oauth_describe(&self, id: &str) -> Value {
        self.oauth_described.get(id).cloned().unwrap_or(Value::Null)
    }
    fn vertex_adc(&self, _project_id: Option<&str>) -> Option<Value> {
        self.vertex_adc.clone()
    }
    /// `probeVertexMetadata()`: started in the background; its answer is kept for the next refresh.
    fn probe_vertex_metadata(&self) {
        let (builder, project) = (Arc::clone(&self.builder), self.vertex_project.clone().unwrap_or_default());
        mixdog_rt::spawn("vertex-metadata-probe", mixdog_rt::TaskClass::Work, async move {
            let _ = builder.adc_describe(&project, true).await;
        });
    }
    fn vertex_env_location(&self) -> Option<String> {
        self.vertex_env_location_value()
    }
    fn vertex_key_project(&self) -> Option<String> {
        self.vertex_key_project.clone()
    }
    fn local_status(&self) -> Option<Value> {
        self.local.clone()
    }
}

impl PrefetchedWorld {
    /// `vertexEnvLocation()`.
    fn vertex_env_location_value(&self) -> Option<String> {
        env_location(|name| self.env.var(name), "")
    }
}

/// The inputs of the gatherer; each is the host's own instance.
pub struct SetupGatherer {
    pub config: DisplayConfig,
    /// `readSection('agent').developer`, as stored.
    pub developer: Arc<dyn Fn() -> Value + Send + Sync>,
    pub env: Arc<dyn Environment>,
    pub keys: ApiKeyStore,
    pub vault: Arc<dyn SecretVault>,
    pub accounts: AccountStore,
    pub providers: Vec<Arc<dyn OAuthProvider>>,
    pub builder: Arc<DefaultProviderBuilder>,
    pub keychain: Arc<dyn KeychainLive>,
    pub local: Arc<dyn LocalStatus>,
    pub proxy: Arc<dyn ProxyProviders>,
}

fn vault_failure(error: mixdog_ai::registry::keys::VaultError) -> Failure {
    Failure::error(error.to_string())
}

impl SetupGatherer {
    /// `hasStoredSecret` / `isFallbackSecret` of one account: `(stored, in the private file)`. A read
    /// that ran and failed shows nothing stored; one that never ran is no answer.
    async fn secret(&self, account: &str) -> Result<(bool, bool), Failure> {
        let stored = match self.vault.get(account).await {
            Ok(value) => value.is_some_and(|v| !v.is_empty()),
            Err(error) if error.unrun => return Err(vault_failure(error)),
            Err(_) => false,
        };
        let fallback = self.vault.is_fallback(account).await.map_err(vault_failure)?;
        Ok((stored, fallback))
    }

    pub async fn gather(&self, config: &Value, options: SetupOptions) -> Result<PrefetchedWorld, Failure> {
        let providers = config.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut world = PrefetchedWorld {
            env: Arc::clone(&self.env),
            resolved_env: HashMap::new(),
            stored: HashSet::new(),
            fallback: HashSet::new(),
            key_present: HashSet::new(),
            keychain: KeychainStatus::default(),
            oauth_ids: HashSet::new(),
            oauth_described: HashMap::new(),
            vertex_adc: None,
            vertex_key_project: None,
            local: None,
            key_ids: HashMap::new(),
            builder: Arc::clone(&self.builder),
            vertex_project: providers.get("vertex-ai").and_then(|p| p.get("projectId")).and_then(Value::as_str).map(str::to_owned),
        };
        for id in API_IDS {
            if let Some(name) = self.keys.env_name(id) {
                world.resolved_env.insert(id.to_owned(), name);
            }
        }
        if options.check_secrets {
            world.keychain = self.keychain.status();
            let custom: Vec<&String> = providers.keys().filter(|id| id.starts_with("custom-")).collect();
            for id in API_IDS.iter().copied().chain(custom.iter().map(|id| id.as_str())) {
                let account = api_key_account(id);
                let (stored, fallback) = self.secret(&account).await?;
                if stored {
                    world.stored.insert(account.clone());
                }
                if fallback {
                    world.fallback.insert(account);
                }
            }
            for id in API_IDS {
                if self.keys.has(id).await.map_err(vault_failure)? {
                    world.key_present.insert(id.to_owned());
                }
            }
            for id in custom {
                // Additional keys by id only; a roster that could not be read lists none, as in Node.
                match self.accounts.custom_key_ids(id).await {
                    Ok(ids) => {
                        world.key_ids.insert(id.clone(), ids);
                    }
                    Err(error) if error.unrun() => return Err(Failure::error(error.to_string())),
                    Err(_) => {}
                }
            }
            if let Some(key) = self.keys.get("vertex-ai").await.map_err(vault_failure)? {
                world.vertex_key_project = parse_service_account(&key).ok().map(|c| c.project_id).filter(|p| !p.is_empty());
            }
            let project = world.vertex_project.clone().unwrap_or_default();
            world.vertex_adc = Some(self.builder.adc_describe(&project, false).await);
        }
        let developer = (self.developer)();
        for id in PROVIDERS {
            if !oauth_available(id, &developer) {
                continue;
            }
            world.oauth_ids.insert(id);
            if options.check_secrets {
                if let Some(provider) = self.providers.iter().find(|p| p.id() == id) {
                    let account = self.account_of(id).await?;
                    world.oauth_described.insert(id, provider.describe(&account).await);
                }
            }
        }
        if options.detect_local {
            world.local = self.local.status().await;
        }
        Ok(world)
    }

    /// The account the provider's roster has selected (`currentProviderAccountId`).
    async fn account_of(&self, provider: &str) -> Result<String, Failure> {
        if !mixdog_ai::accounts::ACCOUNT_PROVIDERS.contains(&provider) {
            return Ok("default".to_owned());
        }
        match self.accounts.pool(provider).await {
            Ok(pool) => Ok(pool.selected_id.filter(|id| !id.is_empty()).unwrap_or_else(|| "default".to_owned())),
            Err(error) if error.unrun() => Err(Failure::error(error.to_string())),
            Err(_) => Ok("default".to_owned()),
        }
    }
}

#[async_trait]
impl SetupBuilder for SetupGatherer {
    async fn build(&self, options: SetupOptions) -> Result<Value, Failure> {
        let config = (self.config)();
        let world = self.gather(&config, options).await?;
        Ok(provider_setup(&world, &config, options))
    }

    async fn proxy(&self, force: bool) -> Result<Value, Failure> {
        let providers = self.proxy.providers(force).await?;
        Ok(model_proxy_provider_setup(providers.as_ref()))
    }
}
