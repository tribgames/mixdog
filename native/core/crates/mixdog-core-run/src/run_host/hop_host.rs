//! The `hop_host` seam of `SessionSeams`: [`HopHost`] over the route facts and the wires,
//! the way Node's `advanceAgentRoute` (`session/loop/route-fallback.mjs`) resolves the next
//! provider.
//!
//! What it reads: the next provider comes from the route facts after `initProviders(
//! ensureProviderEnabled(config, name))`; a model's window from `resolveSessionContextMeta`; its
//! name in a notice from `displayModelName`. What it writes goes through [`HopSession`], the
//! session's own side (WP-SESSION): one header update carrying the new route and the four
//! `routeFallback*` fields, then the wire pin (`pinSessionWireRoute`) and, for a Lead-class
//! session, the tool surface rebuild, in Node's order.
//!
//! `error_text` (`presentErrorText`) and `wiring` (`prepareTurnEffortConfiguration` and the
//! text-only input) have no Rust implementation of their own yet; they are the two seams of
//! [`HopDeps`], and `wiring` must be the very factory the turn start uses for `RunSettings`.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use mixdog_agent::effort::EffortWiring;
use mixdog_agent::text_only::TextOnlyInput;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::oauth::Probe;
use mixdog_ai::providers::google::auth::vertex;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, KeyConfig, MemoryVault, ProcessEnv};
use mixdog_ai::registry::providers::OAUTH_PROVIDER_NAMES;
use mixdog_ai::registry::vertex_metadata;
use mixdog_ai::service::admin_models::model_proxy_client_mode;
use mixdog_ai::service::admin_route::{ensure_provider_enabled, provider_switched_off};
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::link::ReqwestLink;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::{ProviderAdapter, ProviderError, WireRouteContext};
use mixdog_core_api::ids::ThreadId;
use mixdog_store::paths::Paths;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

use super::model_display::display_model_name;
use super::route_chain::BotRoutes;
use super::route_fallback::{HopHost, HopWrite, RouteEligibility, Runner};
use super::session_context_meta::session_context_meta;
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_ports::ports::route_facts::{RouteFacts, RouteSender};

/// The session side of a hop, bound to one thread. Owner: WP-SESSION.
#[async_trait]
pub trait HopSession: Send + Sync {
    /// The session's latest acked header; `None` once the session is closed.
    fn header(&self) -> Option<Arc<Header>>;
    /// `updateSessionRoute(id, route, { crossProvider: true, session })` followed by the hop's
    /// fields (`routeFallbacks`, `routeFallbackPrimary` when `write.primary` is set,
    /// `routeFallbackIndex`, `routeFallbackFailures`) and `activeTurnCheckpoint.routeChanged =
    /// true` when `write.checkpoint_route_changed`, all in the one header update. The route
    /// change leaves `wireRoute` null. Returns the updated header, `None` when the session is
    /// closed or gone.
    async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError>;
    /// Sets `wireRoute` on the header.
    async fn write_wire_pin(&self, pin: Value) -> Result<(), PortError>;
    /// `rebuildToolSurfaceForProviderWithMigration(session, provider, liveMessages)`: the
    /// session re-derives its deferred tool surface from its header, which names the new provider.
    async fn rebuild_tool_surface(&self, provider: &str) -> Result<(), PortError>;
    /// Restores the session header to `previous` when a post-write hop step (wire pin or tool surface rebuild) fails,
    /// so an uncommitted destination is never left advertised on the session.
    async fn restore_header(&self, _previous: Header) -> Result<(), PortError> {
        Ok(())
    }
    /// Writes a hop keyed by a unique per-hop rollback `token`. Default delegates to [`Self::write_hop`].
    async fn write_hop_with_token(&self, _token: u64, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError> {
        self.write_hop(route, write).await
    }
    /// Marks hop `token` committed so its rollback snapshot is discarded and can never be consumed by a later hop.
    fn commit_hop(&self, _token: u64) {}
    /// Restores the header keys written by hop `token` (no-op if `token` never committed on the actor or was already
    /// committed). Default delegates to [`Self::restore_header`].
    async fn restore_hop(&self, _token: u64, previous: Header) -> Result<(), PortError> {
        self.restore_header(previous).await
    }
}

/// The sessions a hop can write: one handle per open thread.
pub trait HopSessions: Send + Sync {
    fn open(&self, thread: &ThreadId) -> Option<Arc<dyn HopSession>>;
}

/// The route's effort projection inputs and text-only input handling (`wiring`).
pub trait HopWiring: Send + Sync {
    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>);
}

/// `getConfigSnapshot({ secrets: false })`.
pub type ConfigSnapshot = Arc<dyn Fn() -> Obj + Send + Sync>;
/// `presentErrorText(error)`.
pub type ErrorText = Arc<dyn Fn(&ProviderError) -> String + Send + Sync>;
/// Probes the GCE metadata server for Vertex AI ADC when no local ADC file exists.
pub type VertexMetadataProbe = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<String>> + Send>> + Send + Sync>;

/// Everything a hop reads that is not the session.
#[derive(Clone)]
pub struct HopDeps {
    /// What a route's provider is, an agent's route included: the hop reaches no provider but through these.
    pub facts: Arc<dyn RouteFacts>,
    pub catalog: Arc<CatalogService>,
    pub config: ConfigSnapshot,
    pub bots: Arc<dyn BotRoutes + Send + Sync>,
    pub errors: ErrorText,
    pub wiring: Arc<dyn HopWiring>,
}

/// Whether a route can be sent on now. Owner: the quota, admission and dispatch layer, which holds the accounts,
/// credentials and quota readings; the hop asks it and keeps none of that evidence itself.
#[async_trait]
pub trait RouteEligibilitySource: Send + Sync {
    async fn eligibility(&self, provider: &str, model: &str) -> RouteEligibility;
}

/// Read the same adapter and account selection policy that would send the route. A cold or
/// superseded registration is not evidence about the configured destination, and a route an agent
/// serves has no adapter to read.
pub struct RegisteredEligibility(pub Arc<dyn RouteFacts>);

#[async_trait]
impl RouteEligibilitySource for RegisteredEligibility {
    async fn eligibility(&self, provider: &str, model: &str) -> RouteEligibility {
        let Some(adapter) = self.0.registered(provider) else {
            return RouteEligibility::Unknown;
        };
        let verdict = adapter.quota_eligibility(model).await;
        if !self.0.registered(provider).is_some_and(|current| Arc::ptr_eq(&current, &adapter)) {
            return RouteEligibility::Unknown;
        }
        match verdict {
            Some(true) => RouteEligibility::Eligible,
            Some(false) => RouteEligibility::Exhausted,
            None => RouteEligibility::Unknown,
        }
    }
}

/// `SessionSeams::hop_host`.
pub struct HopFactory {
    deps: HopDeps,
    sessions: Arc<dyn HopSessions>,
    eligibility: Option<Arc<dyn RouteEligibilitySource>>,
    keys: Option<ApiKeyStore>,
    env: Arc<dyn Environment>,
    accounts: Option<Arc<AccountStore>>,
    vertex_metadata_probe: Option<VertexMetadataProbe>,
}

impl HopFactory {
    pub fn new(deps: HopDeps, sessions: Arc<dyn HopSessions>) -> Self {
        Self { deps, sessions, eligibility: None, keys: None, env: Arc::new(ProcessEnv), accounts: None, vertex_metadata_probe: None }
    }

    /// The source of route eligibility the hops of this factory ask; without one a hop reconsiders nothing.
    pub fn with_eligibility(mut self, source: Arc<dyn RouteEligibilitySource>) -> Self {
        self.eligibility = Some(source);
        self
    }

    /// The API-key store (environment + OS keychain) used to verify credentials before lazily enabling an unregistered
    /// fallback provider.
    pub fn with_key_store(mut self, keys: ApiKeyStore) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Environment reader for model-proxy client mode, Vertex ADC paths, and data directory lookup.
    pub fn with_env(mut self, env: Arc<dyn Environment>) -> Self {
        self.env = env;
        self
    }

    /// Account roster store used to read custom providers' additional API key IDs (matching `ProviderRegistry`).
    pub fn with_accounts(mut self, accounts: Arc<AccountStore>) -> Self {
        self.accounts = Some(accounts);
        self
    }

    /// Custom probe for the GCE metadata server when no local Vertex ADC file exists.
    pub fn with_vertex_metadata_probe(mut self, probe: VertexMetadataProbe) -> Self {
        self.vertex_metadata_probe = Some(probe);
        self
    }

    /// The hop host of `thread`; `None` when the thread has no open session.
    pub fn hop_host(&self, thread: &ThreadId, _header: &Header) -> Option<Arc<dyn HopHost>> {
        let session = self.sessions.open(thread)?;
        Some(Arc::new(RegistryHopHost {
            deps: self.deps.clone(),
            session,
            eligibility: self.eligibility.clone(),
            keys: self.keys.clone(),
            env: self.env.clone(),
            accounts: self.accounts.clone(),
            vertex_metadata_probe: self.vertex_metadata_probe.clone(),
            metadata_project: Arc::new(OnceCell::new()),
        }))
    }
}

pub struct RegistryHopHost {
    deps: HopDeps,
    session: Arc<dyn HopSession>,
    eligibility: Option<Arc<dyn RouteEligibilitySource>>,
    keys: Option<ApiKeyStore>,
    env: Arc<dyn Environment>,
    accounts: Option<Arc<AccountStore>>,
    vertex_metadata_probe: Option<VertexMetadataProbe>,
    metadata_project: Arc<OnceCell<Option<String>>>,
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => mixdog_js::value_to_string(v),
    }
}

/// The message of the `Error` a failed port step stands for.
pub fn port_message(error: &PortError) -> String {
    match error {
        PortError::Invalid { reason, .. } => reason.clone(),
        PortError::Denied(message)
        | PortError::Refused { message, .. }
        | PortError::Unavailable { message, .. }
        | PortError::NotFound { message, .. }
        | PortError::Failed { message, .. } => message.clone(),
        PortError::Cancelled => "cancelled".to_owned(),
    }
}

/// `isAgentOwner(session)`.
fn is_agent_owner(session: &Value) -> bool {
    session.get("owner").is_some_and(|o| mixdog_js::js_trim(&mixdog_js::value_to_string(o)).to_lowercase() == "agent")
}

fn str_field(map: &Obj, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| map.get(*key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
}

fn canonical_oauth_provider(provider: &str) -> Option<&'static str> {
    let lower = provider.trim().to_ascii_lowercase();
    if lower == "opencode-go" {
        return Some("opencode-go-oauth");
    }
    OAUTH_PROVIDER_NAMES.iter().copied().find(|name| *name == lower)
}

fn is_oauth_provider(provider: &str) -> bool {
    canonical_oauth_provider(provider).is_some()
}

fn key_config_of(entry: Option<&Obj>) -> KeyConfig {
    let Some(entry) = entry else { return KeyConfig::default() };
    KeyConfig { api_key: str_field(entry, &["apiKey", "api_key"]), api_key_env: str_field(entry, &["apiKeyEnv", "api_key_env"]) }
}

enum VertexAdcStatus {
    ValidFile { path: PathBuf, raw: String, credential: vertex::Credential },
    InvalidFile,
    NoLogin,
}

fn home_dir_from_env(env: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> Option<PathBuf> {
    let var = |name: &str| env(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if let Some(home) = var("HOME").or_else(|| var("USERPROFILE")) {
        return Some(PathBuf::from(home));
    }
    if cfg!(windows)
        && let (Some(drive), Some(path)) = (var("HOMEDRIVE"), var("HOMEPATH"))
    {
        return Some(PathBuf::from(format!("{drive}{path}")));
    }
    None
}

fn gcloud_dir_from_env(env: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> Option<PathBuf> {
    let var = |name: &str| env(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if let Some(dir) = var("CLOUDSDK_CONFIG") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows)
        && let Some(appdata) = var("APPDATA")
    {
        return Some(PathBuf::from(appdata).join("gcloud"));
    }
    home_dir_from_env(env).map(|home| home.join(".config").join("gcloud"))
}

/// The `project =` of the `[core]` section of gcloud's active configuration, matching `registry/builder.rs`.
fn read_gcloud_project(dir: &Path, named: &str) -> Option<String> {
    let mut name = named.trim().to_owned();
    if name.is_empty() {
        name = std::fs::read_to_string(dir.join("active_config")).map(|s| s.trim().to_owned()).unwrap_or_default();
    }
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        name = "default".into();
    }
    let raw = std::fs::read_to_string(dir.join("configurations").join(format!("config_{name}"))).ok()?;
    let mut section = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(inner) = trimmed.strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
            section = inner.trim().to_lowercase();
        }
        if section == "core"
            && let Some(value) = trimmed.strip_prefix("project").map(str::trim_start).and_then(|t| t.strip_prefix('='))
        {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn valid_vertex_project_override(project: &str) -> bool {
    !project.is_empty() && project.len() <= 128 && project.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

/// Resolves the Vertex AI Cloud project matching `mixdog-ai/src/registry/builder.rs::build_vertex`:
/// explicit valid `projectId` override, else `vertex::resolve_project` (env / quota project / service-account project),
/// else for ADC mode gcloud's active configuration `[core] project = ...`.
fn resolve_vertex_project(
    entry: Option<&Obj>,
    credential: &vertex::Credential,
    is_adc: bool,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
) -> Option<String> {
    if let Some(override_id) = entry.and_then(|e| str_field(e, &["projectId"])) {
        return valid_vertex_project_override(&override_id).then_some(override_id);
    }
    if let Some(project) = vertex::resolve_project(credential, env) {
        return Some(project);
    }
    if is_adc && let Some(dir) = gcloud_dir_from_env(env) {
        let named = env("CLOUDSDK_ACTIVE_CONFIG_NAME").unwrap_or_default();
        return read_gcloud_project(&dir, &named);
    }
    None
}

/// Evaluates Vertex ADC credential file state matching `mixdog-ai/src/registry/builder.rs` (`adc_text` + `parse_adc`):
/// - Explicit `GOOGLE_APPLICATION_CREDENTIALS` must exist, be readable, and parse cleanly as ADC (never falls back).
/// - Otherwise `<gcloud_dir>/application_default_credentials.json`: if present, must be readable and parse cleanly as
///   ADC (never falls back to metadata server on malformed/unreadable files); if missing, returns [`VertexAdcStatus::NoLogin`]
///   so metadata-server ADC may be used.
fn vertex_adc_status(env: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> VertexAdcStatus {
    let var = |name: &str| env(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    let explicit = var("GOOGLE_APPLICATION_CREDENTIALS");
    let path = match &explicit {
        Some(path) => PathBuf::from(path),
        None => {
            let Some(dir) = gcloud_dir_from_env(env) else {
                return VertexAdcStatus::NoLogin;
            };
            dir.join("application_default_credentials.json")
        }
    };
    let shown = path.display().to_string();
    match std::fs::read_to_string(&path) {
        Ok(raw) => match vertex::parse_adc(&raw, &shown) {
            Ok(credential) => VertexAdcStatus::ValidFile { path, raw, credential },
            Err(_) => VertexAdcStatus::InvalidFile,
        },
        Err(err) if matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            if explicit.is_some() {
                VertexAdcStatus::InvalidFile
            } else {
                VertexAdcStatus::NoLogin
            }
        }
        Err(_) => VertexAdcStatus::InvalidFile,
    }
}

enum RosterRead {
    Valid(Value),
    Unsupported,
    Damaged,
}

fn parse_validated_roster(raw: &str) -> RosterRead {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return RosterRead::Damaged;
    };
    if let Some(version) = value.get("version").and_then(Value::as_u64)
        && version > 1
    {
        return RosterRead::Unsupported;
    }
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return RosterRead::Damaged;
    }
    if !value.get("providers").is_some_and(Value::is_object) {
        return RosterRead::Damaged;
    }
    RosterRead::Valid(value)
}

fn extract_custom_key_ids(roster: &Value, provider: &str) -> Vec<String> {
    let Some(accounts) = roster.get("providers").and_then(|providers| providers.get(provider)).and_then(|pool| pool.get("accounts")).and_then(Value::as_array)
    else {
        return Vec::new();
    };
    accounts.iter().filter_map(|account| account.get("id").and_then(Value::as_str)).filter(|id| !id.is_empty() && *id != "default").map(str::to_owned).collect()
}

/// Fallback roster reader used only when an `AccountStore` was not injected: matches `AccountStore`'s validation and
/// `<file>.bak` backup-recovery semantics (never falls back over a newer `version > 1` roster).
fn read_custom_key_ids_from_roster(path: &Path, provider: &str) -> Result<Vec<String>, String> {
    let read_backup = || {
        let mut bak = path.as_os_str().to_os_string();
        bak.push(".bak");
        let bak_path = PathBuf::from(bak);
        match std::fs::read_to_string(&bak_path) {
            Ok(raw) => match parse_validated_roster(&raw) {
                RosterRead::Valid(roster) => Ok(extract_custom_key_ids(&roster, provider)),
                RosterRead::Unsupported | RosterRead::Damaged => Ok(Vec::new()),
            },
            Err(_) => Ok(Vec::new()),
        }
    };
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Ok(Vec::new()),
        Err(_) => return read_backup(),
    };
    match parse_validated_roster(&raw) {
        RosterRead::Valid(roster) => Ok(extract_custom_key_ids(&roster, provider)),
        RosterRead::Unsupported => Ok(Vec::new()),
        RosterRead::Damaged => read_backup(),
    }
}

async fn custom_key_ids(provider: &str, accounts: Option<&AccountStore>, env: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> Result<Vec<String>, String> {
    if let Some(store) = accounts {
        return match store.custom_key_ids(provider).await {
            Ok(ids) => Ok(ids),
            Err(error) if error.unrun() => Err(format!("The additional API keys of {provider} could not be read: {error}.")),
            Err(_) => Ok(Vec::new()),
        };
    }
    let Some(paths) = Paths::resolve(Path::new("."), &|name| env(name).map(OsString::from), home_dir_from_env(env)) else {
        return Ok(Vec::new());
    };
    read_custom_key_ids_from_roster(&paths.data_dir.join("provider-accounts.json"), provider)
}

async fn custom_additional_keys(
    provider: &str,
    key_cfg: &KeyConfig,
    keys: &ApiKeyStore,
    accounts: Option<&AccountStore>,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
) -> Result<Vec<String>, String> {
    if key_cfg.api_key_env.is_some() {
        return Ok(Vec::new());
    }
    let ids = custom_key_ids(provider, accounts, env).await?;
    let mut found = Vec::new();
    for id in ids {
        let extra = keys.read_custom(provider, &id).await.map_err(|error| error.message)?;
        if !extra.trim().is_empty() {
            found.push(extra);
        }
    }
    Ok(found)
}

fn provider_entry<'a>(config: &'a Obj, provider: &str, lower: &str) -> Option<&'a Obj> {
    config.get("providers").and_then(Value::as_object).and_then(|providers| providers.get(provider).or_else(|| providers.get(lower))).and_then(Value::as_object)
}

type MetadataProbe<'a> = &'a (dyn Fn() -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>> + Send + Sync);

async fn provider_has_credentials_detailed(
    config: &Obj,
    provider: &str,
    keys: &ApiKeyStore,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
    accounts: Option<&AccountStore>,
    already_registered: bool,
    metadata_probe: Option<MetadataProbe<'_>>,
) -> Result<bool, String> {
    let lower = provider.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.starts_with("acp-") || is_oauth_provider(&lower) {
        return Ok(false);
    }
    let entry = provider_entry(config, provider, &lower);
    if entry.is_some_and(|e| e.get("enabled").and_then(Value::as_bool) == Some(false)) {
        return Ok(false);
    }
    let key_cfg = key_config_of(entry);
    match lower.as_str() {
        "openai" | "anthropic" | "gemini" | "google" | "deepseek" | "xai" | "openrouter" | "cursor-api" => {
            let store_id = if lower == "google" { "gemini" } else { lower.as_str() };
            let resolved = keys.resolve(store_id, &key_cfg).await.map_err(|error| error.message)?;
            Ok(!resolved.trim().is_empty())
        }
        "vertex-ai" => {
            let auth_mode = entry.and_then(|e| str_field(e, &["authMode", "auth_mode"])).unwrap_or_default().to_ascii_lowercase();
            if auth_mode == "api-key" {
                let resolved = keys.resolve("vertex-ai", &key_cfg).await.map_err(|error| error.message)?;
                return Ok(!resolved.trim().is_empty());
            }
            if auth_mode == "adc" {
                return match vertex_adc_status(env) {
                    VertexAdcStatus::ValidFile { credential, .. } => Ok(resolve_vertex_project(entry, &credential, true, env).is_some()),
                    VertexAdcStatus::InvalidFile => Ok(false),
                    VertexAdcStatus::NoLogin => {
                        if let Some(override_id) = entry.and_then(|e| str_field(e, &["projectId"]))
                            && !valid_vertex_project_override(&override_id)
                        {
                            return Ok(false);
                        }
                        if already_registered {
                            Ok(true)
                        } else if let Some(probe) = metadata_probe {
                            Ok(probe().await.is_some())
                        } else {
                            Ok(false)
                        }
                    }
                };
            }
            let resolved = keys.resolve("vertex-ai", &key_cfg).await.map_err(|error| error.message)?;
            if resolved.trim().is_empty() {
                return Ok(false);
            }
            let Ok(credential) = vertex::parse_service_account(&resolved) else {
                return Ok(false);
            };
            Ok(resolve_vertex_project(entry, &credential, false, env).is_some())
        }
        "mixdog-local" => Ok(entry.is_some_and(|e| e.get("enabled").and_then(Value::as_bool) == Some(true))),
        name if name.starts_with("custom-") => {
            let Some(entry) = entry else { return Ok(false) };
            if entry.get("type").and_then(Value::as_str) != Some("custom") {
                return Ok(false);
            }
            if entry.get("auth").and_then(Value::as_str).is_some_and(|auth| auth.eq_ignore_ascii_case("none")) {
                return Ok(true);
            }
            let trimmed = provider.trim();
            let resolved = keys.resolve(trimmed, &key_cfg).await.map_err(|error| error.message)?;
            if !resolved.trim().is_empty() {
                return Ok(true);
            }
            Ok(!custom_additional_keys(trimmed, &key_cfg, keys, accounts, env).await?.is_empty())
        }
        // Unrecognized test stub providers remain eligible for test registries.
        _ => Ok(true),
    }
}

#[cfg(test)]
pub(crate) async fn provider_has_credentials_with_env(
    config: &Obj,
    provider: &str,
    keys: &ApiKeyStore,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
) -> Result<bool, String> {
    provider_has_credentials_detailed(config, provider, keys, env, None, false, None).await
}

fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    fn write_canonical(value: &Value, out: &mut Vec<u8>) {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<(&str, &Value)> = map.iter().map(|(k, v)| (k.as_str(), v)).collect();
                entries.sort_by_key(|(k, _)| *k);
                out.push(b'{');
                for (index, (k, v)) in entries.into_iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    let _ = serde_json::to_writer(&mut *out, k);
                    out.push(b':');
                    write_canonical(v, out);
                }
                out.push(b'}');
            }
            Value::Array(items) => {
                out.push(b'[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    write_canonical(item, out);
                }
                out.push(b']');
            }
            other => {
                let _ = serde_json::to_writer(out, other);
            }
        }
    }
    let mut out = Vec::new();
    write_canonical(value, &mut out);
    out
}

const OAUTH_OWN_FILES: [(&str, &str, &str); 10] = [
    ("openai-oauth", "openai-oauth.json", "OPENAI_OAUTH_CREDENTIALS_PATH"),
    ("anthropic-oauth", "anthropic-oauth-credentials.json", "ANTHROPIC_OAUTH_CREDENTIALS_PATH"),
    ("grok-oauth", "grok-oauth.json", "GROK_OAUTH_CREDENTIALS_PATH"),
    ("muse-code-oauth", "muse-code-oauth.json", "MUSE_CODE_OAUTH_CREDENTIALS_PATH"),
    ("command-code-oauth", "command-code-oauth.json", "COMMAND_CODE_OAUTH_CREDENTIALS_PATH"),
    ("opencode-go-oauth", "opencode-go-oauth.json", "OPENCODE_GO_OAUTH_CREDENTIALS_PATH"),
    ("mimo-oauth", "mimo-oauth.json", "MIMO_OAUTH_CREDENTIALS_PATH"),
    ("cursor-oauth", "cursor-oauth.json", "CURSOR_OAUTH_CREDENTIALS_PATH"),
    ("devin-oauth", "devin-oauth.json", "DEVIN_OAUTH_CREDENTIALS_PATH"),
    ("antigravity-oauth", "antigravity-oauth.json", "ANTIGRAVITY_OAUTH_CREDENTIALS_PATH"),
];

/// Non-secret SHA-256 fingerprint of the active OAuth credential material/slot, never a coarse presence flag.
/// Returns `"oauth:absent"` when logged out/missing, `"oauth:unreadable"` when the credential file cannot be read,
/// or `"sha256:..."` over the active account slot and canonical credential document.
pub(crate) async fn oauth_credential_fingerprint(
    provider: &str,
    accounts: Option<&AccountStore>,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
) -> Option<String> {
    let canonical = canonical_oauth_provider(provider)?;
    if let Some(store) = accounts {
        let slot = store.current_slot(canonical).await;
        if canonical == "cursor-oauth"
            && slot == "default"
            && let Some(token) = env("CURSOR_ACCESS_TOKEN").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
        {
            return Some(sha256_hex(&[b"oauth-override", canonical.as_bytes(), slot.as_bytes(), token.as_bytes()]));
        }
        let Ok(file) = store.current_credential_file(canonical) else {
            return Some("oauth:absent".to_owned());
        };
        return Some(match file.load_document().await {
            Probe::Present(doc) if !doc.is_empty() => {
                let bytes = canonical_json_bytes(&Value::Object(doc));
                sha256_hex(&[b"oauth-doc", canonical.as_bytes(), slot.as_bytes(), &bytes])
            }
            Probe::Present(_) | Probe::Absent => "oauth:absent".to_owned(),
            Probe::Unreadable => "oauth:unreadable".to_owned(),
        });
    }
    if canonical == "cursor-oauth"
        && let Some(token) = env("CURSOR_ACCESS_TOKEN").map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
    {
        return Some(sha256_hex(&[b"oauth-override", canonical.as_bytes(), b"default", token.as_bytes()]));
    }
    let path = OAUTH_OWN_FILES.iter().find(|(id, _, _)| *id == canonical).and_then(|(_, file, var_name)| {
        if let Some(explicit) = env(var_name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(explicit));
        }
        let paths = Paths::resolve(Path::new("."), &|name| env(name).map(OsString::from), home_dir_from_env(env))?;
        Some(paths.data_dir.join(file))
    });
    let Some(path) = path else {
        return Some("oauth:absent".to_owned());
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if matches!(err.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            return Some("oauth:absent".to_owned());
        }
        Err(_) => return Some("oauth:unreadable".to_owned()),
    };
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(&raw) else {
        return Some("oauth:unreadable".to_owned());
    };
    if doc.is_empty() {
        return Some("oauth:absent".to_owned());
    }
    let bytes = canonical_json_bytes(&Value::Object(doc));
    Some(sha256_hex(&[b"oauth-doc", canonical.as_bytes(), b"default", &bytes]))
}

fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(7 + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Non-secret fingerprint of the currently configured credential for an HTTP provider, used to detect whether
/// credentials changed after an `auth` diversion without ever recording secret material.
pub(crate) async fn provider_credential_fingerprint(
    config: &Obj,
    provider: &str,
    keys: &ApiKeyStore,
    env: &(dyn Fn(&str) -> Option<String> + Send + Sync),
    accounts: Option<&AccountStore>,
    metadata_probe: Option<MetadataProbe<'_>>,
) -> Option<String> {
    let lower = provider.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.starts_with("acp-") || is_oauth_provider(&lower) || lower == "mixdog-local" {
        return None;
    }
    let entry = provider_entry(config, provider, &lower);
    let key_cfg = key_config_of(entry);
    match lower.as_str() {
        "openai" | "anthropic" | "gemini" | "google" | "deepseek" | "xai" | "openrouter" | "cursor-api" => {
            let store_id = if lower == "google" { "gemini" } else { lower.as_str() };
            let resolved = keys.resolve(store_id, &key_cfg).await.ok()?;
            let trimmed = resolved.trim();
            Some(if trimmed.is_empty() { "absent".to_owned() } else { sha256_hex(&[trimmed.as_bytes()]) })
        }
        "vertex-ai" => {
            let auth_mode = entry.and_then(|e| str_field(e, &["authMode", "auth_mode"])).unwrap_or_default().to_ascii_lowercase();
            if auth_mode == "adc" {
                return match vertex_adc_status(env) {
                    VertexAdcStatus::ValidFile { path, raw, credential } => {
                        let project = resolve_vertex_project(entry, &credential, true, env).unwrap_or_default();
                        Some(sha256_hex(&[path.to_string_lossy().as_bytes(), raw.as_bytes(), project.as_bytes()]))
                    }
                    VertexAdcStatus::InvalidFile => Some("invalid".to_owned()),
                    VertexAdcStatus::NoLogin => {
                        if let Some(probe) = metadata_probe
                            && let Some(project) = probe().await
                        {
                            return Some(sha256_hex(&[b"metadata", project.as_bytes()]));
                        }
                        Some("absent".to_owned())
                    }
                };
            }
            let resolved = keys.resolve("vertex-ai", &key_cfg).await.ok()?;
            let trimmed = resolved.trim();
            Some(if trimmed.is_empty() { "absent".to_owned() } else { sha256_hex(&[auth_mode.as_bytes(), trimmed.as_bytes()]) })
        }
        name if name.starts_with("custom-") => {
            let entry = entry?;
            if entry.get("type").and_then(Value::as_str) != Some("custom") {
                return Some("absent".to_owned());
            }
            if entry.get("auth").and_then(Value::as_str).is_some_and(|auth| auth.eq_ignore_ascii_case("none")) {
                return Some("none".to_owned());
            }
            let trimmed = provider.trim();
            let primary = keys.resolve(trimmed, &key_cfg).await.ok()?;
            let extras = custom_additional_keys(trimmed, &key_cfg, keys, accounts, env).await.ok()?;
            if primary.trim().is_empty() && extras.is_empty() {
                return Some("absent".to_owned());
            }
            let mut hasher = Sha256::new();
            hasher.update(primary.trim().as_bytes());
            for extra in extras {
                hasher.update([0u8]);
                hasher.update(extra.trim().as_bytes());
            }
            let digest = hasher.finalize();
            let mut out = String::with_capacity(7 + digest.len() * 2);
            out.push_str("sha256:");
            for byte in digest {
                use std::fmt::Write;
                let _ = write!(&mut out, "{byte:02x}");
            }
            Some(out)
        }
        _ => None,
    }
}

impl RegistryHopHost {
    fn key_store(&self) -> ApiKeyStore {
        self.keys
            .clone()
            .unwrap_or_else(|| ApiKeyStore::new(Arc::new(MemoryVault::default()), self.env.clone(), model_proxy_client_mode(&|name| self.env.var(name))))
    }

    async fn vertex_metadata_project(&self) -> Option<String> {
        self.metadata_project
            .get_or_init(|| async {
                if let Some(probe) = &self.vertex_metadata_probe {
                    return probe().await;
                }
                let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).ok()?;
                let http: Arc<dyn HttpSend> = Arc::new(link);
                vertex_metadata::probe_project(&http).await
            })
            .await
            .clone()
    }

    async fn has_credentials(&self, config: &Obj, provider: &str, keys: &ApiKeyStore, already_registered: bool) -> Result<bool, String> {
        let probe = || Box::pin(self.vertex_metadata_project()) as Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
        provider_has_credentials_detailed(config, provider, keys, &|name| self.env.var(name), self.accounts.as_deref(), already_registered, Some(&probe)).await
    }
    /// `pinSessionWireRoute` for the session a hop just routed: the wire the new provider reaches
    /// the model on, `None` when the session is already pinned to this route, the provider has a
    /// single wire, the model has no wire (or an unknown one), resolving failed, or the route
    /// moved while resolving. The hop's route change always leaves `wireRoute` null, so the
    /// session is never a legacy one.
    async fn wire_pin(&self, updated: &Value, adapter: &dyn ProviderAdapter) -> Option<Value> {
        let (provider, model) = (text(updated.get("provider")), text(updated.get("model")));
        if provider.is_empty() || model.is_empty() {
            return None;
        }
        let pin = resolve_pin(adapter, updated.get("wireRoute"), &provider, &model, false).await?;
        let live = self.session.header()?;
        if text(live.get("provider")) != provider || text(live.get("model")) != model {
            return None;
        }
        Some(pin)
    }
}

/// The part of `pinSessionWireRoute` before its last check: `None` when `current` already pins this route, the
/// provider has a single wire, resolving failed, or the model has no known wire. `legacy` is a session that
/// predates the wire table and already talked to its model.
pub async fn resolve_pin(adapter: &dyn ProviderAdapter, current: Option<&Value>, provider: &str, model: &str, legacy: bool) -> Option<Value> {
    if let Some(current) = current.filter(|c| c.is_object())
        && text(current.get("provider")) == provider
        && text(current.get("model")) == model
    {
        return None;
    }
    let routing = adapter.wire_routing()?;
    let context = WireRouteContext { agent: true, legacy, ..WireRouteContext::default() };
    let route = routing.resolve_wire_route(model, &context).await.ok()??;
    if route.source == "unknown" {
        return None;
    }
    Some(json!({
        "provider": provider, "model": model,
        "wire": route.wire, "source": route.source, "profileId": route.profile_id,
    }))
}

#[async_trait]
impl HopHost for RegistryHopHost {
    async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
        match &self.eligibility {
            Some(source) => source.eligibility(&text(route.get("provider")), &text(route.get("model"))).await,
            None => RouteEligibility::Unknown,
        }
    }

    fn session(&self) -> Option<Value> {
        self.session.header().map(|h| Value::Object((*h).clone()))
    }

    fn config(&self) -> Obj {
        (self.deps.config)()
    }

    fn bots(&self) -> &dyn BotRoutes {
        &*self.deps.bots
    }

    fn model_label(&self, _provider: &str, model: &str) -> String {
        display_model_name(model, "")
    }

    fn provider_label(&self, provider: &str) -> String {
        let meta = self.deps.facts.model_meta(provider, "");
        if let Some(label) = meta.get("agentLabel").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return label.to_owned();
        }
        if meta.get("runner").and_then(Value::as_str) == Some("acp")
            && let Some(display) = meta.get("display").and_then(Value::as_str).filter(|s| !s.is_empty())
        {
            return display.split(" · ").next().unwrap_or(display).to_owned();
        }
        mixdog_ai::service::error_text::provider_display_name(provider)
    }

    fn error_text(&self, error: &ProviderError) -> String {
        (self.deps.errors)(error)
    }

    async fn credential_fingerprint(&self, provider: &str) -> Option<String> {
        let proxy_client = model_proxy_client_mode(&|name| self.env.var(name));
        if is_oauth_provider(provider) {
            if proxy_client {
                return Some(
                    if matches!(self.deps.facts.sender(None, provider).await, Ok(Some(RouteSender::Provider(_)))) { "oauth:remote" } else { "oauth:absent" }
                        .to_owned(),
                );
            }
            let local = oauth_credential_fingerprint(provider, self.accounts.as_deref(), &|name| self.env.var(name)).await;
            if local.as_deref() == Some("oauth:absent") && matches!(self.deps.facts.sender(None, provider).await, Ok(Some(RouteSender::Provider(_)))) {
                return Some("oauth:remote".to_owned());
            }
            return local;
        }
        let config = self.config();
        let keys = self.key_store();
        let probe = || Box::pin(self.vertex_metadata_project()) as Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
        let local = provider_credential_fingerprint(&config, provider, &keys, &|name| self.env.var(name), self.accounts.as_deref(), Some(&probe)).await;
        if proxy_client && matches!(self.deps.facts.sender(None, provider).await, Ok(Some(RouteSender::Provider(_)))) {
            return Some("remote".to_owned());
        }
        local
    }

    /// Resolves who runs a turn on `provider` without admitting unauthenticated providers:
    /// - Switched-off providers return `Ok(None)`.
    /// - ACP agent routes, OAuth providers, and already-registered model-proxy client adapters resolve directly through
    ///   `facts.sender(None, ...)`.
    /// - Local non-OAuth HTTP providers always verify real credentials first so keyless enabled adapters are never
    ///   selected or counted as usable fallbacks.
    async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
        let config = self.config();
        if provider_switched_off(&config, provider) {
            return Ok(None);
        }
        let keys = self.key_store();
        let proxy_client = model_proxy_client_mode(&|name| self.env.var(name));
        match self.deps.facts.sender(None, provider).await {
            Ok(Some(RouteSender::Agent(_))) => return Ok(Some(Runner::Agent)),
            Ok(Some(RouteSender::Provider(adapter))) => {
                if !proxy_client && !is_oauth_provider(provider) && !self.has_credentials(&config, provider, &keys, true).await? {
                    return Ok(None);
                }
                return Ok(Some(Runner::Loop(adapter)));
            }
            Ok(None) => {}
            Err(_) if provider.starts_with("acp-") => return Ok(None),
            Err(error) => return Err(error),
        }
        if !self.has_credentials(&config, provider, &keys, false).await? {
            return Ok(None);
        }
        let providers = ensure_provider_enabled(&config, provider);
        Ok(self.deps.facts.sender(Some(&providers), provider).await?.map(|sender| match sender {
            RouteSender::Provider(adapter) => Runner::Loop(adapter),
            RouteSender::Agent(_) => Runner::Agent,
        }))
    }

    /// The agent's readiness as a pick of its route reads it: model admission, and once the check of its program that
    /// runs, or that this starts, has ended, whether a turn on it can start, and in the agent's words why not.
    async fn agent_ready(&self, provider: &str, model: &str) -> Result<(), String> {
        self.deps.facts.ensure_route_ready(&self.config(), provider, model).await
    }

    async fn unavailable_cause(&self, provider: &str) -> (Option<String>, bool) {
        (self.deps.facts.init_error(provider), mixdog_ai::service::admin_route::provider_switched_off(&self.config(), provider))
    }

    fn raw_context_window(&self, provider: &str, model: &str, route: &Value) -> Option<u64> {
        let model_meta = self.deps.facts.model_meta(provider, model);
        let mut seed = route.clone();
        if let Some(window_meta) = self.deps.facts.window_meta(provider, model, &model_meta) {
            let reported = ["maxContextWindow", "contextWindow", "max_context_window", "context_window"]
                .iter()
                .find_map(|key| window_meta.get(*key).and_then(Value::as_f64).filter(|w| w.is_finite() && *w >= 1.0).map(|w| w.floor() as u64));
            if let Some(reported) = reported
                && let Some(obj) = seed.as_object_mut()
                && obj.get("rawContextWindow").and_then(Value::as_f64).is_none_or(|w| !w.is_finite() || w < 1.0)
            {
                obj.insert("rawContextWindow".into(), json!(reported));
            }
        }
        let meta = session_context_meta(&self.deps.catalog, provider, model, &seed)?;
        meta.raw_context_window.as_f64().filter(|w| *w > 0.0).map(|w| w as u64)
    }

    /// `None` is `updateSessionRoute` answering nothing (`route-fallback.mjs:147` throws "agent
    /// session closed during model fallback" for it). If wire-pin persistence or tool-surface
    /// rebuild fails or the future is cancelled/dropped mid-flight after the header write, rolls
    /// back the hop-owned header fields so the session never advertises an uncommitted destination.
    async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
        static NEXT_HOP_TOKEN: AtomicU64 = AtomicU64::new(1);

        struct HopRollbackGuard {
            session: Arc<dyn HopSession>,
            token: u64,
            previous: Option<Arc<Header>>,
            armed: bool,
        }
        impl HopRollbackGuard {
            fn disarm(&mut self) {
                self.armed = false;
            }
        }
        impl Drop for HopRollbackGuard {
            fn drop(&mut self) {
                if self.armed
                    && let Some(prev) = self.previous.take()
                    && let Ok(handle) = tokio::runtime::Handle::try_current()
                {
                    let session = self.session.clone();
                    let token = self.token;
                    handle.spawn(async move {
                        if let Err(err) = session.restore_hop(token, (*prev).clone()).await {
                            tracing::warn!("[route] cancelled hop rollback failed: {}", port_message(&err));
                        }
                    });
                }
            }
        }

        let token = NEXT_HOP_TOKEN.fetch_add(1, Ordering::Relaxed);
        let previous = self.session.header();
        let provider = text(route.get("provider"));
        let mut rollback = HopRollbackGuard { session: self.session.clone(), token, previous: previous.clone(), armed: true };
        let written = match self.session.write_hop_with_token(token, route, &write).await {
            Ok(Some(written)) => written,
            Ok(None) => {
                self.session.commit_hop(token);
                rollback.disarm();
                return Ok(None);
            }
            Err(error) => {
                self.session.commit_hop(token);
                rollback.disarm();
                return Err(port_message(&error));
            }
        };
        let mut updated = Value::Object(written);
        let post_write: Result<(), String> = async {
            if let Some(adapter) = self.deps.facts.registered(&provider)
                && let Some(pin) = self.wire_pin(&updated, &*adapter).await
            {
                self.session.write_wire_pin(pin.clone()).await.map_err(|e| port_message(&e))?;
                updated["wireRoute"] = pin;
            }
            if !is_agent_owner(&updated) {
                self.session.rebuild_tool_surface(&provider).await.map_err(|e| port_message(&e))?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = post_write {
            if let Some(prev) = previous {
                let restored = self.session.restore_hop(token, (*prev).clone()).await;
                rollback.disarm();
                if let Err(restore_err) = restored {
                    return Err(format!("{err}; rollback failed: {}", port_message(&restore_err)));
                }
            } else {
                self.session.commit_hop(token);
                rollback.disarm();
            }
            return Err(err);
        }
        self.session.commit_hop(token);
        rollback.disarm();
        Ok(Some(self.session().unwrap_or(updated)))
    }

    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
        self.deps.wiring.wiring(updated, provider)
    }
}

#[cfg(test)]
#[path = "hop_host_tests.rs"]
mod tests;
