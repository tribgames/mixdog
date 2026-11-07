//! What the media lanes take from the chat providers (`media/auth.mjs` `resolveXaiAuth('grok-oauth')`,
//! `resolveAntigravityAuth`, `resolveCodexAuth` and the Codex / Antigravity model lists): the
//! production [`ProviderAuth`] and [`CodexSession`].
//!
//! Nothing here refreshes a token itself. The Grok login is the chat provider's `GrokCredential`,
//! the Antigravity login its `AntigravityAuth` over the same `FileTokenStore`, the ChatGPT login its
//! `OpenAiOAuth`, so a refresh the media lane makes is the one the chat provider would make
//! (single flight, rotation published only over the pair that was exchanged). The Codex identity
//! (User-Agent, `version`) is the chat provider's `CodexIdentity`, read per request.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::client_versions::{ClientVersions, Clock, Dialect, Live};
use mixdog_ai::oauth::scrub::scrub_oauth_secrets;
use mixdog_ai::oauth::{CredentialFile, CredentialIo};
use mixdog_ai::providers::connect::rewrite::Credential as _;
use mixdog_ai::providers::openai::adapter::Credential;
use mixdog_ai::providers::google::auth::RequestAuth;
use mixdog_ai::providers::google::auth::antigravity::{AntigravityAuth, FileTokenStore, ENDPOINT as ANTIGRAVITY_ENDPOINT};

/// `CONTENT_ENDPOINTS[0]`: the gateway the image adapter posts to.
pub const ANTIGRAVITY_GATEWAY: &str = ANTIGRAVITY_ENDPOINT;
use mixdog_ai::providers::grok::auth::GrokCredential;
use mixdog_ai::providers::openai::adapter::CredentialSource;
use mixdog_ai::providers::openai::oauth::OpenAiOAuth;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::{ModelRecord, ProviderError};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::accounts::AccountProbe;
use super::catalog_fetch::{Auth, FetchError};
use super::download::AdapterError;
use super::antigravity_image::{AntigravityAuth as MediaLogin, AntigravitySession};
use super::codex_image::{CodexAuth, CodexSession, chatgpt_limit_reset_at};
use super::probe::{AgentKeys, AgentSettings, ProviderAuth};
use super::adapter_http::JsonPost;

const XAI_BASE_URL: &str = "https://api.x.ai/v1";
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";
/// `FETCH_MODELS_TIMEOUT_MS`.
const FETCH_MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// How much of a refused answer the message keeps (`.slice(0, 300)`).
const ERROR_TEXT_LIMIT: usize = 300;

/// The default account's credential file of a provider (`AccountStore::credential_file(provider, "default")`).

/// The label of the late cell startup verifies (`late::Bound::cell`).
pub const PROBE_CELL: &str = "media account probe";

/// What a read of the unbound probe answers: the check cannot run, and saying "no login" or skipping it
/// would hide a startup that never bound it.
pub const PROBE_UNBOUND: &str = "the media account probe was not bound at startup: the ChatGPT login cannot be checked";

/// The media account probe, bound once after the probe that holds the layer is built (it is a cycle:
/// probe -> `ProbeParts.provider_auth` -> layer -> probe). Sessions share the cell, so one built
/// before the bind sees it once bound; startup verifies it is bound (`ProviderLayer::probe_attached`,
/// the daemon's `LateMediaProbe`).
#[derive(Clone, Default)]
pub struct LateProbe(Arc<OnceLock<Arc<dyn AccountProbe>>>);

impl LateProbe {
    /// The bound probe; reading it unbound is an error that says so, never an absent check.
    pub fn bound(&self) -> Result<&Arc<dyn AccountProbe>, AdapterError> {
        self.0.get().ok_or_else(|| AdapterError::plain(PROBE_UNBOUND))
    }

    /// Binds the probe once; a second bind is refused.
    pub fn bind(&self, probe: Arc<dyn AccountProbe>) -> Result<(), Arc<dyn AccountProbe>> {
        self.0.set(probe)
    }
}
/// The default account's credential file of a provider (`AccountStore::credential_file(provider, "default")`).
pub type DefaultFile = Arc<dyn Fn(&str) -> Result<CredentialFile, String> + Send + Sync>;

pub struct ProviderLayer {
    pub http: Arc<dyn HttpSend>,
    pub post: Arc<dyn JsonPost>,
    /// A bound account's file is opened on these lanes.
    pub io: CredentialIo,
    pub default_file: DefaultFile,
    pub versions: Arc<ClientVersions>,
    pub registry: Arc<ProviderRegistry>,
    pub now: Clock,
    /// What the Codex image adapter presents (see `CodexProviderSession::for_account`).
    pub codex: CodexClient,
    /// laneAuthenticated, attached once the probe that holds this layer has been built.
    probe: LateProbe,
    grok: Mutex<HashMap<PathBuf, Arc<GrokCredential>>>,
    antigravity: Mutex<HashMap<PathBuf, Arc<AntigravityAuth>>>,
}

impl ProviderLayer {
    pub fn new(
        http: Arc<dyn HttpSend>,
        post: Arc<dyn JsonPost>,
        io: CredentialIo,
        default_file: DefaultFile,
        versions: Arc<ClientVersions>,
        registry: Arc<ProviderRegistry>,
        now: Clock,
        codex: CodexClient,
    ) -> Self {
        Self { http, post, io, default_file, versions, registry, now, codex, probe: LateProbe::default(), grok: Mutex::default(), antigravity: Mutex::default() }
    }

    /// The media lanes' credential probe, which is built over this layer (ProbeParts.provider_auth):
    /// attached once after it, so `CodexProviderSession::for_account` can ask it whether a login exists.
    pub fn attach_probe(&self, probe: Arc<dyn AccountProbe>) {
        let _ = self.probe.bind(probe);
    }

    /// Whether the probe has been attached: the late cell startup verifies.
    pub fn probe_attached(&self) -> bool {
        self.probe.0.get().is_some()
    }

    /// The default file of `accounts` for every provider.
    pub fn default_file_of(accounts: AccountStore) -> DefaultFile {
        Arc::new(move |provider| accounts.credential_file(provider, "default").map_err(|error| error.to_string()))
    }

    fn file(&self, provider: &str, account: Option<&Path>) -> Result<CredentialFile, FetchError> {
        match account {
            Some(path) => Ok(CredentialFile::new(path.to_path_buf(), self.io)),
            None => (self.default_file)(provider).map_err(plain),
        }
    }

    /// One instance per credential file, so the in-process refresh gate is shared by every caller.
    fn grok_credential(&self, account: Option<&Path>) -> Result<Arc<GrokCredential>, FetchError> {
        let file = self.file("grok-oauth", account)?;
        let mut held = self.grok.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(Arc::clone(held.entry(file.path().to_path_buf()).or_insert_with(|| Arc::new(GrokCredential::new(Arc::clone(&self.http), file)))))
    }

    fn antigravity_auth(&self, account: Option<&Path>) -> Result<Arc<AntigravityAuth>, FetchError> {
        let file = self.file("antigravity-oauth", account)?;
        let mut held = self.antigravity.lock().unwrap_or_else(PoisonError::into_inner);
        let (now, path) = (Arc::clone(&self.now), file.path().to_path_buf());
        Ok(Arc::clone(held.entry(path).or_insert_with(|| {
            Arc::new(AntigravityAuth::new(Arc::clone(&self.http), Arc::new(FileTokenStore(file)), Box::new(move || now())))
        })))
    }

    /// `resolveXaiAuth('grok-oauth')`: the bearer rotates on every refresh, so the account id
    /// (`user_id`) is what identifies the credential.
    async fn grok(&self, account: Option<&Path>) -> Result<Auth, FetchError> {
        let credential = self.grok_credential(account)?;
        let header = credential.header(false).await.map_err(from_provider)?;
        let token = header.and_then(|(_, value)| value.strip_prefix("Bearer ").map(str::to_owned)).unwrap_or_default();
        Ok(Auth { token, base_url: XAI_BASE_URL.to_owned(), project_id: None, account_id: Some(credential.user_id().unwrap_or_default()) })
    }

    /// `resolveAntigravityAuth()`: the client version is warmed first, so discovery and generation
    /// present the same hub identity the gateway version-gates on.
    async fn antigravity(&self, account: Option<&Path>) -> Result<Auth, FetchError> {
        self.versions.warm(Dialect::Antigravity).await;
        let authorization = self.antigravity_auth(account)?.authorize().await.map_err(from_provider)?;
        let token = authorization.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).and_then(|(_, value)| value.strip_prefix("Bearer ")).unwrap_or_default().to_owned();
        Ok(Auth { token, base_url: String::new(), project_id: Some(authorization.identity), account_id: None })
    }

    /// `provider.listModels()` of the ChatGPT-subscription provider. Like Node's, a failed fetch is
    /// the empty list (the caller turns that into `Codex catalog unavailable`), never an error.
    async fn codex_rows(&self) -> Value {
        let adapter = self.registry.get("openai-oauth").await;
        let records = match adapter.as_ref().and_then(|adapter| adapter.models()) {
            Some(listing) => listing.list_models().await.unwrap_or_default(),
            None => Vec::new(),
        };
        Value::Array(records.iter().map(codex_row).collect())
    }
}

/// A Codex row as `_normalizeCodexModel` returns it, with the keys the media catalog reads: `id`, `name`,
/// `display`, and the catalog's own statements about the image tool (`supportsImageGeneration` when
/// boolean, `supportedTools` as bare type names from strings or `{ type }` records), which the record
/// keeps in the catalog row it holds verbatim.
pub fn codex_row(record: &ModelRecord) -> Value {
    let mut row = Map::new();
    row.insert("id".to_owned(), json!(record.id));
    if let Some(name) = &record.name {
        row.insert("name".to_owned(), json!(name));
    }
    if let Some(display) = &record.display_name {
        row.insert("display".to_owned(), json!(display));
    }
    if let Some(raw) = &record.raw {
        if let Some(flag) = raw.get("supports_image_generation").and_then(Value::as_bool) {
            row.insert("supportsImageGeneration".to_owned(), json!(flag));
        }
        if let Some(tools) = raw.get("supported_tools").and_then(Value::as_array) {
            let names: Vec<&str> = tools.iter().filter_map(|tool| tool.as_str().or_else(|| tool.get("type").and_then(Value::as_str))).filter(|name| !name.is_empty()).collect();
            row.insert("supportedTools".to_owned(), json!(names));
        }
    }
    Value::Object(row)
}

/// `fetchAvailableModels` as `catalog.mjs` reads it: the gateway's rows with their wire id as `id`.
pub async fn antigravity_rows(post: &dyn JsonPost, client_version: &str, auth: &Auth) -> Result<Value, FetchError> {
    let project = auth.project_id.clone().unwrap_or_default();
    let url = format!("{ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels");
    let mut headers = vec![("Authorization".to_owned(), format!("Bearer {}", auth.token)), ("Content-Type".to_owned(), "application/json".to_owned())];
    headers.extend(antigravity_headers(client_version));
    let body = if project.is_empty() { json!({}) } else { json!({ "project": project }) };
    let reply = post
        .post(&url, &headers, &body, FETCH_MODELS_TIMEOUT, &CancellationToken::new())
        .await
        .map_err(|failure| FetchError { message: failure.message, code: None, status: None, timed_out: failure.timed_out })?;
    if !(200..300).contains(&reply.status) {
        let text = mixdog_js::slice_utf16(&scrub_oauth_secrets(&reply.body, &[]), ERROR_TEXT_LIMIT);
        return Err(plain(format!("[antigravity-oauth] fetchAvailableModels failed: {} {text}", reply.status)));
    }
    // `res.json()` rejects with V8's own message (`v8_json_parse_error`: wp-svc-misc-21).
    let parsed: Value = mixdog_js::json_parse(&reply.body).map_err(|error| plain(mixdog_js::v8_json_parse_error(&reply.body).unwrap_or_else(|| error.to_string())))?;
    let Some(models) = parsed.get("models").and_then(Value::as_object) else {
        return Err(plain("[antigravity-oauth] fetchAvailableModels returned no models"));
    };
    // `{ ...row, id }`: a row that is not an object contributes only the id.
    Ok(Value::Array(
        models
            .iter()
            .map(|(id, row)| {
                let mut out: Map<String, Value> = row.as_object().cloned().unwrap_or_default();
                out.insert("id".to_owned(), Value::String(id.clone()));
                Value::Object(out)
            })
            .collect(),
    ))
}

fn plain(message: impl Into<String>) -> FetchError {
    FetchError { message: message.into(), code: None, status: None, timed_out: false }
}

/// A provider's refusal as the `Error` Node's token store threw.
fn from_provider(error: ProviderError) -> FetchError {
    FetchError { message: error.message, code: error.code, status: error.status, timed_out: false }
}

/// `antigravityHeaders()`: the hub client identity, whatever the platform the process runs on.
pub fn antigravity_headers(version: &str) -> Vec<(String, String)> {
    vec![("User-Agent".to_owned(), format!("antigravity/hub/{version} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)"))]
}

#[async_trait]
impl ProviderAuth for ProviderLayer {
    async fn oauth(&self, lane: &str, account: Option<&Path>) -> Result<Auth, FetchError> {
        match lane {
            "grok-oauth" => self.grok(account).await,
            "antigravity-oauth" => self.antigravity(account).await,
            other => Err(plain(format!("{other} has no OAuth token store"))),
        }
    }

    async fn provider_rows(&self, lane: &str, auth: &Auth) -> Result<Value, FetchError> {
        match lane {
            "openai-oauth" => Ok(self.codex_rows().await),
            "antigravity-oauth" => antigravity_rows(self.post.as_ref(), &self.versions.antigravity(), auth).await,
            other => Err(plain(format!("{other} has no provider catalog"))),
        }
    }
}

/// The client identity the Codex image adapter presents: the chat provider's own CodexIdentity
/// values (read per request) and the random request id.
#[derive(Clone)]
pub struct CodexClient {
    pub user_agent: Live,
    pub version: Live,
    /// MIXDOG_CODEX_ORIGINATOR, else codex_cli_rs (see [CodexProviderSession::originator_of]).
    pub originator: Live,
    /// Node's `randomBytes(16).toString('hex')`.
    pub random_hex: Arc<dyn Fn() -> String + Send + Sync>,
}

/// Node's text when no ChatGPT login is usable (`openai-oauth.mjs` `ensureAuth`).
pub const CODEX_NOT_AUTHENTICATED: &str = "OpenAI OAuth not authenticated. Open /providers in mixdog to sign in.";

/// The ChatGPT-subscription side of the Codex image adapter.
pub struct CodexProviderSession {
    pub oauth: Arc<OpenAiOAuth>,
    pub versions: Arc<ClientVersions>,
    pub user_agent: Live,
    pub version: Live,
    /// `MIXDOG_CODEX_ORIGINATOR`, else `codex_cli_rs` (read per call, as Node does).
    pub originator: Live,
    pub post: Arc<dyn JsonPost>,
    pub random_hex: Arc<dyn Fn() -> String + Send + Sync>,
    /// Fails `auth()` with Node's text when the account holds no usable login (see `for_account`).
    pub login: Option<(LateProbe, PathBuf)>,
}

impl CodexProviderSession {
    /// The session of the account whose credential file is `file`: it logs in with that file (the
    /// chat provider's `OpenAiOAuth`, so a refresh is the chat provider's), and `auth()` answers Node's
    /// `OpenAI OAuth not authenticated. ...` when the file holds no usable login, which is how a
    /// missing default file is reported. The client identity is the layer's `CodexClient`.
    pub fn for_account(layer: &ProviderLayer, file: CredentialFile) -> Self {
        let path = file.path().to_path_buf();
        Self {
            oauth: Arc::new(OpenAiOAuth::new(file, Arc::clone(&layer.http))),
            versions: Arc::clone(&layer.versions),
            user_agent: layer.codex.user_agent.clone(),
            version: layer.codex.version.clone(),
            originator: layer.codex.originator.clone(),
            post: Arc::clone(&layer.post),
            random_hex: Arc::clone(&layer.codex.random_hex),
            login: Some((layer.probe.clone(), path)),
        }
    }

    /// `originator` as `codexOriginator()` reads it from the environment.
    pub fn originator_of(env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>) -> Live {
        Live::new(move || env("MIXDOG_CODEX_ORIGINATOR").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()).unwrap_or_else(|| CODEX_ORIGINATOR.to_owned()))
    }
}

#[async_trait]
impl CodexSession for CodexProviderSession {
    async fn auth(&self) -> Result<CodexAuth, AdapterError> {
        if let Some((late, path)) = &self.login {
            // The probe is a late cell startup verifies; a read of an unbound one is an error, never a skipped check.
            let probe = late.bound()?;
            if !probe.authenticated("openai-oauth", Some(path)).await {
                return Err(AdapterError::plain(CODEX_NOT_AUTHENTICATED));
            }
        }
        let Credential { bearer, account_id } = self.oauth.current().await.map_err(|error| AdapterError::plain(error.message))?;
        Ok(CodexAuth { access_token: bearer, account_id })
    }

    async fn warm_version(&self) {
        self.versions.warm(Dialect::Codex).await;
    }

    fn user_agent(&self) -> String {
        self.user_agent.get()
    }

    fn version_header(&self) -> String {
        self.version.get()
    }

    fn originator(&self) -> String {
        self.originator.get()
    }

    fn responses_url(&self) -> String {
        CODEX_RESPONSES_URL.to_owned()
    }

    fn request_id(&self) -> String {
        (self.random_hex)()
    }

    async fn lookup_reset(&self, auth: &CodexAuth, limit_id: &str, cancel: &CancellationToken) -> Option<i64> {
        chatgpt_limit_reset_at(self.post.as_ref(), &self.user_agent.get(), auth, limit_id, cancel).await
    }
}

/// The Antigravity image adapter's world: the login of the account the scope uses, the client
/// identity header, the gateway and the random ids of a request.
pub struct AntigravityProviderSession {
    pub layer: Arc<ProviderLayer>,
    /// The bound account's credential file; `None` is the default account.
    pub account: Option<PathBuf>,
    /// `randomUUID()`.
    pub random_uuid: Arc<dyn Fn() -> String + Send + Sync>,
}

#[async_trait]
impl AntigravitySession for AntigravityProviderSession {
    async fn auth(&self) -> Result<MediaLogin, AdapterError> {
        let login = self.layer.antigravity(self.account.as_deref()).await.map_err(|error| AdapterError::plain(error.message))?;
        Ok(MediaLogin { token: login.token, project_id: login.project_id.unwrap_or_default() })
    }

    fn headers(&self) -> Vec<(String, String)> {
        antigravity_headers(&self.layer.versions.antigravity())
    }

    fn endpoint(&self) -> String {
        ANTIGRAVITY_ENDPOINT.to_owned()
    }

    fn uuid(&self) -> String {
        (self.random_uuid)()
    }
}

/// `getAgentApiKey` / `hasAgentApiKey` for the media lanes: the environment first, then the keychain,
/// over the registry's `ApiKeyStore` (so a key is read the way the chat providers read it; the
/// remote-client mode holds none). A keychain read that never ran answers "no key", as Node's
/// `catch` does: the lane probes have no error to carry it.
pub struct StoreKeys(pub ApiKeyStore);

#[async_trait]
impl AgentKeys for StoreKeys {
    async fn has(&self, provider: &str) -> bool {
        self.0.has(provider).await.unwrap_or(false)
    }

    async fn get(&self, provider: &str) -> Option<String> {
        self.0.get(provider).await.ok().flatten()
    }
}

/// The agent settings the lanes read: `readSection('agent').providers` and the Developer option
/// that gates a dev-only OAuth provider.
pub struct ConfigSettings {
    /// `readSection('agent')` as an object (the config's `agent()`).
    pub agent: Arc<dyn Fn() -> Value + Send + Sync>,
    /// `developerOptionEnabled` of the option gating the provider (`oauth_status::oauth_available`
    /// over the stored `agent.developer`): true for a provider no option gates.
    pub developer: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl AgentSettings for ConfigSettings {
    fn providers(&self) -> Value {
        // `readSection('agent')?.providers || {}`.
        (self.agent)().get("providers").filter(|providers| !providers.is_null()).cloned().unwrap_or_else(|| json!({}))
    }

    fn developer_enabled(&self, provider: &str) -> bool {
        (self.developer)(provider)
    }
}

/// `providerCatalogRevision()`: the registry's catalog revision, the counter the chat path bumps
/// when a provider appears, goes or finishes a catalog refresh. The media loader only compares it
/// for equality, so its text form is enough.
pub fn catalog_revision(registry: Arc<ProviderRegistry>) -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(move || registry.catalog_revision().to_string())
}