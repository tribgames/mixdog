//! The production wiring of [`ProviderAdmin`]: the OAuth providers' credential modules
//! ([`OAuthProvider`]), the gcloud-login check ([`VertexAdc`]) and [`ProviderAdmin::production`],
//! which builds the admin over the instances the registry, the builder and the host already hold.
//! Each of those exists once: the admin takes the builder, the registry, the vault, the account
//! store and the refresh flow it is given and builds nothing of its own beyond these adapters.
//!
//! What an [`OAuthProvider`] does per provider (`providers/*-oauth*.mjs`):
//! * `describe(account)` is [`describe_oauth`] over the account's credential file as the
//!   provider's loader reads it ([`load_oauth_credentials`]), read on the interactive lane.
//! * `forget(account)` is `forget<Provider>OAuthCredentials`: Anthropic removes only the
//!   `claudeAiOauth` key of the account's file, Antigravity overwrites the file with `{}`, every
//!   other provider deletes the file; `{ removed }` says whether anything was there. Node's
//!   Anthropic candidates are the one file of the bound account, the path variable or the default:
//!   the CLI's own `~/.claude` file is never read or cleared (golden `oauth-forget`).
//! * `login_flow(account)` is the provider's interactive login writing the account's file; Devin's
//!   is the PKCE sign-in of `providers/devin/login.rs` (Node's admin has one: `loginDevinOAuth`).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::client_versions::ClientVersions;
use mixdog_ai::oauth::pace::Pace;
use mixdog_ai::oauth::{CredentialFile, CredentialIo, PkceLoginFlow, Probe};
use mixdog_ai::providers::anthropic::oauth::AnthropicLogin;
use mixdog_ai::providers::compat::login::command_code::{CommandCodeLogin, default_cli_auth_path};
use mixdog_ai::providers::compat::login::mimo::{MimoLogin, key_name_path};
use mixdog_ai::providers::compat::login::muse::MuseCodeLogin;
use mixdog_ai::providers::compat::login::opencode_go::OpenCodeGoLogin;
use mixdog_ai::providers::cursor::login::CursorLogin;
use mixdog_ai::providers::devin::login::DevinLogin;
use mixdog_ai::providers::google::auth::antigravity::{AntigravityLogin, FileTokenStore, Pause};
use mixdog_ai::providers::grok::auth::{DISCOVERY_URL, GrokLogin};
use mixdog_ai::providers::openai::login::OpenAiLogin;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::{Environment, SecretVault};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::oauth_usage::OAuthUsage;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::deadlines::GROK_DISCOVERY;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::login::{LoginError, LoginFailure, LoginFlow, LoginSession, LoginTarget};
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::{CancellationToken, LaneToken};
use mixdog_core_config::config::Config;
use mixdog_protocol::ProviderId;
use serde_json::{Map, Value, json};

use super::admin::ProviderAdmin;
use super::collaborators::{AuthRefresh, OAuthProvider, VertexAdc};
use super::oauth_credentials::load_oauth_credentials;
use super::oauth_status::{PROVIDERS, describe_oauth};

/// The credential file of `(provider, account)`: the account store's, or another file in a test.
pub type FileOf = Arc<dyn Fn(&str, &str) -> Result<CredentialFile, String> + Send + Sync>;

/// What the OAuth providers read of the host.
#[derive(Clone)]
pub struct OAuthWiring {
    /// The account store the registry's builder holds (BuilderEnv.accounts): the credential files, and Command Code's first-sign-in roster check.
    pub accounts: AccountStore,
    /// The chat providers' HTTP (`BuilderEnv.http`), so a login goes the same way a send does.
    pub http: Arc<dyn HttpSend>,
    /// The login pace (`SystemPace`).
    pub pace: Arc<dyn Pace>,
    pub file: FileOf,
    pub io: CredentialIo,
    /// The plugin data folder: MiMo's key-name file lives in it.
    pub plugin_data: PathBuf,
    /// Antigravity's login presents the live client version.
    pub versions: Arc<ClientVersions>,
    /// `Date.now()`.
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `process.env`: `CURSOR_ACCESS_TOKEN` stands in for the default Cursor account's file.
    pub env: Arc<dyn Environment>,
    /// Command Code's CLI login file ([`default_cli_auth_path`]), adopted on a first sign-in.
    pub cli_auth: PathBuf,
}

impl OAuthWiring {
    /// The credential files of `accounts` (`AccountStore::credential_file`).
    pub fn files_of(accounts: AccountStore) -> FileOf {
        Arc::new(move |provider, account| accounts.credential_file(provider, account).map_err(|error| error.to_string()))
    }

    /// The default wiring's CLI login path.
    pub fn default_cli_auth() -> PathBuf {
        default_cli_auth_path()
    }
}

struct FileOAuth {
    id: &'static str,
    wiring: Arc<OAuthWiring>,
}

/// The Pace as the Antigravity login's pause.
struct PaceAsPause(Arc<dyn Pace>);

#[async_trait]
impl Pause for PaceAsPause {
    async fn pause(&self, duration: std::time::Duration) {
        self.0.wait(duration).await;
    }
}

fn target(id: &str) -> LoginTarget {
    LoginTarget::Provider(ProviderId::from(id))
}

fn pkce(id: &str, provider: Arc<dyn mixdog_ai::oauth::PkceProvider>) -> Arc<dyn LoginFlow> {
    Arc::new(PkceLoginFlow::new(target(id), provider))
}

/// Grok's login learns its endpoints from the discovery document, which needs the network: the
/// flow discovers when it is started, then runs the ordinary PKCE login.
struct GrokFlow {
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    target: LoginTarget,
}

fn failed(code: &str, message: impl Into<String>) -> LoginError {
    LoginError::Failed(LoginFailure::Failed { code: code.to_owned(), message: message.into() })
}

impl GrokFlow {
    /// `{ authorization_endpoint, token_endpoint }` of the discovery document.
    async fn endpoints(&self) -> Result<(String, String), LoginError> {
        let response = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http1,
                    method: "GET".to_owned(),
                    url: DISCOVERY_URL.to_owned(),
                    headers: vec![("accept".to_owned(), "application/json".to_owned())],
                    body: Vec::new(),
                },
                GROK_DISCOVERY,
            )
            .await
            .map_err(|error| failed("grok_discovery_failed", error.message))?;
        let success = response.is_success();
        let body = response.read_all().await.map_err(|error| failed("grok_discovery_failed", error.message))?.body;
        let document: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let endpoint = |key: &str| document.get(key).and_then(Value::as_str).map(str::to_owned);
        match (success, endpoint("authorization_endpoint"), endpoint("token_endpoint")) {
            (true, Some(authorization), Some(token)) => Ok((authorization, token)),
            _ => Err(failed("grok_discovery_failed", "[grok-oauth] discovery returned no endpoints")),
        }
    }
}

#[async_trait]
impl LoginFlow for GrokFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let (authorization, token) = self.endpoints().await?;
        let login = GrokLogin::new(Arc::clone(&self.http), self.file.clone(), &authorization, &token)
            .map_err(|error| failed("grok_discovery_failed", error.message))?;
        PkceLoginFlow::new(self.target.clone(), Arc::new(login)).start().await
    }
}

impl FileOAuth {
    fn file(&self, account: &str) -> Result<CredentialFile, String> {
        (self.wiring.file)(self.id, account)
    }
}

#[async_trait]
impl OAuthProvider for FileOAuth {
    fn id(&self) -> &'static str {
        self.id
    }

    async fn describe(&self, account: &str) -> Value {
        let (id, now) = (self.id, (self.wiring.now_ms)());
        // `CURSOR_ACCESS_TOKEN` stands in for the default account's file only.
        let token = (id == "cursor-oauth" && account == "default").then(|| self.wiring.env.key_var("CURSOR_ACCESS_TOKEN")).flatten();
        let path = self.file(account).ok().map(|file| file.path().to_path_buf());
        // The credential file is read on the lane, as the other credential readers do. A read the
        // lane did not run describes the provider as not signed in, as an unreadable file does.
        let loaded = match path {
            Some(path) => match LaneToken::submit_wait(self.wiring.io.read, &CancellationToken::new(), move |_| {
                load_oauth_credentials(id, &path, now, token.as_deref())
            })
            .await
            {
                Ok(job) => job.await.ok().flatten(),
                Err(_) => None,
            },
            None => None,
        };
        describe_oauth(id, loaded.as_ref(), now).unwrap_or_else(|| json!({}))
    }
    async fn forget(&self, account: &str) -> Result<Value, String> {
        forget_file(self.id, &self.file(account)?).await
    }
    async fn renew(&self, account: &str, minimum_validity_ms: u64) -> Result<(), String> {
        if self.id != "anthropic-oauth" {
            return Err(format!("{} credentials cannot be renewed ahead of use", self.id));
        }
        let now = Arc::clone(&self.wiring.now_ms);
        let session = mixdog_ai::providers::anthropic::OAuthSession::new(self.file(account)?, Arc::clone(&self.wiring.http))
            .with_clock(Arc::new(move || u64::try_from(now()).unwrap_or(0)));
        session.ensure_lease(minimum_validity_ms).await.map(drop).map_err(|error| error.message)
    }
    fn login_flow(&self, account: &str) -> Option<Arc<dyn LoginFlow>> {
        let wiring = &self.wiring;
        let file = self.file(account).ok()?;
        let (http, pace, io) = (Arc::clone(&wiring.http), Arc::clone(&wiring.pace), wiring.io);
        Some(match self.id {
            "openai-oauth" => pkce(self.id, Arc::new(OpenAiLogin::new(file, http))),
            "anthropic-oauth" => pkce(self.id, Arc::new(AnthropicLogin::new(file, http))),
            "grok-oauth" => Arc::new(GrokFlow { http, file, target: target(self.id) }),
            "antigravity-oauth" => {
                let now = Arc::clone(&wiring.now_ms);
                let login = AntigravityLogin {
                    http,
                    store: Arc::new(FileTokenStore(file)),
                    client_version: wiring.versions.antigravity(),
                    pause: Arc::new(PaceAsPause(pace)),
                    now_ms: Box::new(move || u64::try_from(now()).unwrap_or(0)),
                };
                pkce(self.id, Arc::new(login))
            }
            "cursor-oauth" => Arc::new(CursorLogin::new(http, file, pace)),
            "devin-oauth" => pkce(self.id, Arc::new(DevinLogin::new(file, http))),
            "muse-code-oauth" => Arc::new(MuseCodeLogin::new(http, pace, file)),
            "opencode-go-oauth" => Arc::new(OpenCodeGoLogin::new(http, pace, file)),
            "mimo-oauth" => {
                let key_name = CredentialFile::new(key_name_path(&wiring.plugin_data), io);
                Arc::new(MimoLogin::new(http, file, key_name))
            }
            "command-code-oauth" => {
                let cli = CredentialFile::new(wiring.cli_auth.clone(), io);
                Arc::new(CommandCodeLogin::new(http, file, cli, wiring.accounts.clone()))
            }
            _ => return None,
        })
    }
}

/// `forget<Provider>OAuthCredentials()` over the account's file: `{ removed }`.
pub async fn forget_file(id: &str, file: &CredentialFile) -> Result<Value, String> {
    let removed = match (id, file.load_document().await) {
        (_, Probe::Absent) => false,
        ("anthropic-oauth", Probe::Present(mut document)) => {
            // Only the sign-in goes: the file's other keys stay.
            let had = document.shift_remove("claudeAiOauth").is_some();
            if had {
                file.replace(document).await.map_err(|error| error.to_string())?;
            }
            had
        }
        ("anthropic-oauth", Probe::Unreadable) => false,
        ("antigravity-oauth", _) => {
            // Overwritten in place with an empty document (the file stays), so the secret does not
            // survive in a freed block.
            file.replace(Map::new()).await.map_err(|error| error.to_string())?;
            true
        }
        _ => {
            file.remove().await.map_err(|error| error.to_string())?;
            true
        }
    };
    Ok(json!({ "removed": removed }))
}
/// The ten OAuth providers, in setup order (`OAUTH_PROVIDERS`).
pub fn oauth_providers(wiring: &Arc<OAuthWiring>) -> Vec<Arc<dyn OAuthProvider>> {
    PROVIDERS.iter().map(|id| Arc::new(FileOAuth { id: *id, wiring: Arc::clone(wiring) }) as Arc<dyn OAuthProvider>).collect()
}

/// `describeVertexAdc` + `probeVertexMetadata`: the check a gcloud-login save makes, over the same
/// ADC read and project order the provider is built with.
pub struct AdcLogin(pub Arc<DefaultProviderBuilder>);

#[async_trait]
impl VertexAdc for AdcLogin {
    async fn login(&self, project_id: &str) -> Result<Option<String>, String> {
        self.0.adc_login(project_id).await
    }
}

/// The instances [`ProviderAdmin::production`] takes; each one is the host's own.
pub struct AdminParts {
    pub oauth: Arc<OAuthWiring>,
    /// The builder the provider registry builds with.
    pub builder: Arc<DefaultProviderBuilder>,
    /// `ProcessServices.vault`.
    pub vault: Arc<dyn SecretVault>,
    pub config: Config,
    /// `ProviderEffects::auth_refresh()`.
    pub refresh: Arc<dyn AuthRefresh>,
    pub registry: Arc<ProviderRegistry>,
    pub oauth_usage: Arc<OAuthUsage>,
    pub io: CredentialIo,
}

impl ProviderAdmin {
    /// The one production admin: the ten OAuth providers and the gcloud check are built here, the
    /// rest is passed in.
    pub fn production(parts: AdminParts) -> Arc<Self> {
        let AdminParts { oauth, builder, vault, config, refresh, registry, oauth_usage, io } = parts;
        let providers = oauth_providers(&oauth);
        let vertex_adc = Arc::new(AdcLogin(Arc::clone(&builder)));
        let accounts = oauth.accounts.clone();
        Self::new(providers, builder, accounts, vault, config, refresh, vertex_adc, registry, oauth_usage, io)
    }
}
