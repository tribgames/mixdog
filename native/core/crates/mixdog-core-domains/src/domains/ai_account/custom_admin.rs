//! The custom-provider section of `provider-admin.mjs`: `saveCustomProvider` (:1376),
//! `saveCustomProviderKey` (:1437), `updateCustomProviderModel` (:1506),
//! `removeCustomProvider` (:1650), the row they answer (`customProviderRow`, :622) and the
//! host the connection probes (`custom_probe.rs`) run over.
//!
//! The config document is the agent section of `mixdog-config.json`; every change to it is one
//! `Config::update_agent` transaction, so what Node does "synchronously from here" is atomic
//! here, and an edit another writer landed meanwhile is never reverted.

use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::accounts::MAX_ACCOUNTS;
use mixdog_ai::accounts::rotation::AccountRotation;
use mixdog_ai::accounts::rotation::AccountSender;
use mixdog_ai::accounts::rotation::CooldownPolicy;
use mixdog_ai::accounts::rotation::Failed;
use mixdog_ai::accounts::rotation::PoolError;
use mixdog_ai::accounts::rotation::SendContext;
use mixdog_ai::accounts::rotation::Stage;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::providers::custom::listing::manual_rows;
use mixdog_ai::providers::custom::listing::public_rows;
use mixdog_ai::registry::builder::CustomParts;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::SecretVault;
use mixdog_ai::registry::keys::api_key_account;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use tokio_util::sync::CancellationToken;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::admin::acct;
use super::admin::object_at;
use super::admin::ProviderAdmin;
use super::collaborators::AuthRefresh;
use super::collaborators::CustomProviders;
use super::custom_config::assert_reasoning_patch;
use super::custom_config::canonical_reasoning_level;
use super::custom_config::is_api_key_env;
use super::custom_config::normalize;
use super::custom_probe::CustomEndpoint;
use super::custom_probe::CustomProbeHost;
use super::custom_probe::CustomProbes;
use super::custom_probe::ResolvedCustom;
use super::failure::Failure;
use mixdog_core_config::config::Config;

type Obj = Map<String, Value>;

/// `CUSTOM_API_KEY_MAX`.
const API_KEY_MAX: usize = 65_536;
/// What a test send asks (`Reply with OK.`, `maxTokens: 16`).
const TEST_PROMPT: &str = "Reply with OK.";
const TEST_MAX_TOKENS: u32 = 16;
const MODEL_PATCH_KEYS: [&str; 9] = [
    "manual",
    "hidden",
    "name",
    "contextWindow",
    "maxOutputTokens",
    "supportsVision",
    "reasoning",
    "requestBody",
    "requestHeaders",
];
const REASONING_PATCH_KEYS: [&str; 4] = ["levels", "wireFormat", "wireValues", "replay"];

/// `^<8>-<4>-<4>-<4>-<12>$` of lowercase hex.
fn is_uuid(text: &str) -> bool {
    let dashes = [8, 13, 18, 23];
    text.len() == 36
        && text.char_indices().all(|(at, c)| {
            if dashes.contains(&at) { c == '-' } else { c.is_ascii_digit() || ('a'..='f').contains(&c) }
        })
}

/// `CUSTOM_ID_RE`.
fn is_custom_id(id: &str) -> bool {
    id.strip_prefix("custom-").is_some_and(is_uuid)
}

fn vault_failure(error: mixdog_ai::registry::keys::VaultError) -> Failure {
    Failure::error(error.0)
}

fn config_failure(error: mixdog_core_config::config::ConfigError) -> Failure {
    Failure::error(error.to_string())
}

fn is_custom_entry(entry: Option<&Value>) -> bool {
    entry.is_some_and(|entry| entry.get("type").and_then(Value::as_str) == Some("custom"))
}

/// `existingCustomEntry`.
fn existing_entry(agent: &Obj, id: &str) -> Result<Value, Failure> {
    let entry = agent.get("providers").and_then(|providers| providers.get(id));
    match entry {
        Some(entry) if is_custom_id(id) && is_custom_entry(Some(entry)) => Ok(entry.clone()),
        _ => Err(Failure::error(format!("unknown custom provider \"{id}\""))),
    }
}

fn input_object(input: &Value) -> Result<&Obj, Failure> {
    input.as_object().ok_or_else(|| Failure::type_error("custom provider is invalid"))
}

/// `validateExtraApiKeys`.
fn validate_extra_api_keys(rows: &Value) -> Result<(), Failure> {
    let invalid = || Failure::type_error("custom provider extraApiKeys are invalid");
    let rows = rows.as_array().filter(|rows| rows.len() < MAX_ACCOUNTS).ok_or_else(invalid)?;
    let mut ids: HashSet<&str> = HashSet::new();
    for row in rows {
        let row = row.as_object().ok_or_else(invalid)?;
        if row.keys().any(|key| key != "id" && key != "apiKey") {
            return Err(invalid());
        }
        if let Some(id) = row.get("id") {
            let id = id
                .as_str()
                .filter(|id| is_uuid(id) && !ids.contains(id))
                .ok_or_else(|| Failure::type_error("custom provider extraApiKeys id is invalid"))?;
            ids.insert(id);
        }
        if let Some(key) = row.get("apiKey")
            && key.as_str().is_none_or(|key| utf16_len(key) > API_KEY_MAX)
        {
            return Err(Failure::type_error("custom provider extraApiKeys apiKey is invalid"));
        }
        if !row.contains_key("id") && row.get("apiKey").and_then(Value::as_str).is_none_or(|key| js_trim(key).is_empty())
        {
            return Err(Failure::type_error("custom provider additional API key is empty"));
        }
    }
    Ok(())
}

/// `validateCustomTransportFields`: `id` absent or a generated custom id, `apiKey` absent or a
/// bounded string, `apiKeyEnv` a variable name that excludes a typed key.
fn validate_transport_fields(input: &Obj) -> Result<(), Failure> {
    if let Some(id) = input.get("id")
        && !id.as_str().is_some_and(is_custom_id)
    {
        return Err(Failure::type_error("custom provider id is invalid"));
    }
    if let Some(key) = input.get("apiKey")
        && key.as_str().is_none_or(|key| utf16_len(key) > API_KEY_MAX)
    {
        return Err(Failure::type_error("custom provider apiKey is invalid"));
    }
    if let Some(env) = input.get("apiKeyEnv").filter(|env| !env.is_null()) {
        if !env.as_str().is_some_and(is_api_key_env) {
            return Err(Failure::type_error("custom provider apiKeyEnv is invalid"));
        }
        if input.get("auth").and_then(Value::as_str) == Some("none") {
            return Err(Failure::type_error("custom provider apiKeyEnv requires key auth"));
        }
        if input.get("apiKey").and_then(Value::as_str).is_some_and(|key| !key.is_empty()) {
            return Err(Failure::type_error("custom provider apiKey and apiKeyEnv are mutually exclusive"));
        }
    }
    if let Some(rows) = input.get("extraApiKeys") {
        validate_extra_api_keys(rows)?;
    }
    Ok(())
}

/// An edit that omits a stored setting keeps it: `auth` for every input shape, and the rest
/// for a v2 input (a legacy `models` input states the whole manual model list itself).
fn with_stored_settings(input: &Obj, entry: &Value) -> Obj {
    let mut out = input.clone();
    let Ok(stored) = normalize(entry) else {
        // Fixing an invalid entry still keeps its stated auth mode.
        let kept = entry.get("auth").filter(|auth| matches!(auth.as_str(), Some("key" | "none")));
        if let (None, Some(auth)) = (input.get("auth"), kept) {
            out.insert("auth".into(), auth.clone());
        }
        return out;
    };
    if !out.contains_key("auth") {
        out.insert("auth".into(), stored["auth"].clone());
    }
    if !out.contains_key("apiKeyEnv")
        && let Some(env) = stored.get("apiKeyEnv").filter(|env| env.as_str().is_some_and(|e| !e.is_empty()))
    {
        out.insert("apiKeyEnv".into(), env.clone());
    }
    if out.get("schemaVersion") == stored.get("schemaVersion") {
        for key in ["discovery", "modelOverrides", "headers", "requestBody"] {
            if !out.contains_key(key)
                && let Some(value) = stored.get(key)
            {
                out.insert(key.into(), value.clone());
            }
        }
        let protocol = out.get("protocol").filter(|p| !p.is_null()).or_else(|| stored.get("protocol"));
        if protocol == stored.get("protocol") {
            for key in ["wires", "modelWires"] {
                if !out.contains_key(key)
                    && let Some(value) = stored.get(key)
                {
                    out.insert(key.into(), value.clone());
                }
            }
        }
    }
    out
}

/// A setup input over one config snapshot: the validated config, and the key it resolves to.
struct InputAt {
    id: Option<String>,
    config: Value,
    typed: String,
    api_key: String,
    keyless: bool,
    env_name: String,
}

/// `customInputAt`. `stored_key` is the stored key of an existing provider (empty when none).
fn input_at(agent: &Obj, input: &Obj, stored_key: &str, env: &dyn Environment) -> Result<InputAt, Failure> {
    let id = input.get("id").and_then(Value::as_str).map(str::to_owned);
    // Additional keys are secrets, applied by the save itself.
    let mut settings = input.clone();
    settings.shift_remove("extraApiKeys");
    let merged = match &id {
        Some(id) => with_stored_settings(&settings, &existing_entry(agent, id)?),
        None => settings,
    };
    let config = normalize(&Value::Object(merged.clone())).map_err(Failure::error)?;
    let typed = merged.get("apiKey").and_then(Value::as_str).map(js_trim).unwrap_or_default().to_owned();
    let keyless = config["auth"] == "none";
    let env_name = if keyless { "" } else { config.get("apiKeyEnv").and_then(Value::as_str).unwrap_or_default() }.to_owned();
    let api_key = if !env_name.is_empty() {
        env.var(&env_name).unwrap_or_default()
    } else if keyless {
        String::new()
    } else if !typed.is_empty() {
        typed.clone()
    } else {
        stored_key.to_owned()
    };
    let typed = if keyless || !env_name.is_empty() { String::new() } else { typed };
    Ok(InputAt { id, config, typed, api_key, keyless, env_name })
}

fn require_custom_key(resolved: &InputAt) -> Result<(), Failure> {
    if !resolved.keyless && resolved.env_name.is_empty() && resolved.api_key.is_empty() {
        return Err(Failure::error("API key is required"));
    }
    Ok(())
}

/// The additional-key change a save makes over the `saved` key ids.
struct ExtraPlan {
    saved: Vec<String>,
    ids: Vec<String>,
    added: Vec<(String, String)>,
    removed: Vec<String>,
}

impl ExtraPlan {
    fn changed(&self) -> bool {
        self.ids != self.saved
    }
}

/// `extraKeyPlan`: `rows` absent keeps the saved ids; a typed key is stored under a new id, so a
/// replaced key starts without the old one's cooldown. A keyless provider keeps none.
fn extra_key_plan(saved: Vec<String>, rows: Option<&Value>, keyless: bool) -> Result<ExtraPlan, Failure> {
    if keyless {
        return Ok(ExtraPlan { removed: saved.clone(), saved, ids: Vec::new(), added: Vec::new() });
    }
    let Some(rows) = rows else {
        return Ok(ExtraPlan { ids: saved.clone(), saved, added: Vec::new(), removed: Vec::new() });
    };
    let mut ids = Vec::new();
    let mut added = Vec::new();
    for row in rows.as_array().into_iter().flatten() {
        let id = row.get("id").and_then(Value::as_str);
        if let Some(id) = id
            && !saved.iter().any(|s| s == id)
        {
            return Err(Failure::error("An additional API key is no longer saved."));
        }
        let typed = row.get("apiKey").and_then(Value::as_str).map(js_trim).unwrap_or_default();
        match (typed.is_empty(), id) {
            (true, Some(id)) => ids.push(id.to_owned()),
            _ => {
                let key_id = uuid::Uuid::new_v4().to_string();
                ids.push(key_id.clone());
                added.push((key_id, typed.to_owned()));
            }
        }
    }
    let removed = saved.iter().filter(|key| !ids.contains(key)).cloned().collect();
    Ok(ExtraPlan { saved, ids, added, removed })
}

/// Tri-state merge: absent preserves, `null` deletes the property, a value replaces it.
fn apply_tri_state(base: Option<&Value>, patch: &Obj) -> Obj {
    let mut out = base.and_then(Value::as_object).cloned().unwrap_or_default();
    for (key, value) in patch {
        if value.is_null() {
            out.shift_remove(key);
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `plainPatch`.
fn plain_patch<'a>(value: &'a Value, allowed: &[&str], label: &str) -> Result<&'a Obj, Failure> {
    let object = value.as_object().ok_or_else(|| Failure::type_error(format!("{label} is invalid")))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Failure::type_error(format!("{label} has unsupported field")));
    }
    Ok(object)
}

/// `withoutProviderReferences`: every stored model setting and route that names the provider.
fn drop_references(agent: &mut Obj, id: &str) {
    let names = |route: &Value| route.get("provider").and_then(Value::as_str) == Some(id);
    let prefix = format!("{id}/");
    if let Some(settings) = agent.get_mut("modelSettings").and_then(Value::as_object_mut) {
        settings.retain(|key, _| !key.starts_with(&prefix));
    }
    if let Some(agents) = agent.get_mut("agents").and_then(Value::as_object_mut) {
        agents.retain(|_, route| !names(route));
    }
    if agent.get("webSearchRoute").is_some_and(names) {
        agent.shift_remove("webSearchRoute");
    }
    if let Some(presets) = agent.get("presets").and_then(Value::as_array).cloned() {
        let dropped: HashSet<String> =
            presets.iter().filter(|p| names(p)).filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        agent.insert("presets".into(), Value::Array(presets.into_iter().filter(|p| !names(p)).collect()));
        if agent.get("default").and_then(Value::as_str).is_some_and(|d| dropped.contains(d)) {
            agent.shift_remove("default");
        }
    }
}

/// The collaborators every custom-provider operation reads.
pub struct CustomHost {
    config: Config,
    vault: Arc<dyn SecretVault>,
    keys: ApiKeyStore,
    accounts: AccountStore,
    builder: Arc<DefaultProviderBuilder>,
    env: Arc<dyn Environment>,
    /// The shared send path and key roster rotation: a connection test sends as a request does.
    broker: Arc<ModelBroker>,
    rotation: AccountRotation,
    /// Where Node writes to stderr (`process.stderr.write`); the line carries its own newline.
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

/// What a host supplies beside the stores (`CustomHost::new`).
pub struct CustomSeams {
    pub broker: Arc<ModelBroker>,
    pub rotation: AccountRotation,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl CustomHost {
    pub fn new(
        config: Config,
        vault: Arc<dyn SecretVault>,
        keys: ApiKeyStore,
        accounts: AccountStore,
        builder: Arc<DefaultProviderBuilder>,
        env: Arc<dyn Environment>,
        seams: CustomSeams,
    ) -> Arc<Self> {
        let CustomSeams { broker, rotation, log } = seams;
        Arc::new(Self { config, vault, keys, accounts, builder, env, broker, rotation, log })
    }

    async fn key_ids_of(&self, id: &str) -> Vec<String> {
        self.accounts.custom_key_ids(id).await.unwrap_or_default()
    }

    /// `resolveCustomInput`.
    async fn resolve(&self, raw: &Value) -> Result<InputAt, Failure> {
        let input = input_object(raw)?;
        validate_transport_fields(input)?;
        let stored = match input.get("id").and_then(Value::as_str) {
            Some(id) => self.keys.get(id).await.unwrap_or_default(),
            None => String::new(),
        };
        input_at(&self.config.agent(), input, &stored, self.env.as_ref())
    }

    /// `customProviderRow`: the secret-free public view of a custom provider.
    async fn row(&self, id: &str, entry: &Value) -> Value {
        let (config, config_error) = match normalize(entry) {
            Ok(config) => (Some(config), None),
            Err(message) => (None, Some(message.strip_prefix("[custom-provider] ").unwrap_or(&message).to_owned())),
        };
        let configured_enabled = entry.get("enabled") != Some(&Value::Bool(false));
        let keyless = config.as_ref().and_then(|c| c.get("auth")).or_else(|| entry.get("auth")).and_then(Value::as_str)
            == Some("none");
        let api_key_env = if keyless {
            String::new()
        } else {
            config.as_ref().and_then(|c| c.get("apiKeyEnv")).and_then(Value::as_str).unwrap_or_default().to_owned()
        };
        let env_set = !api_key_env.is_empty() && self.env.var(&api_key_env).is_some_and(|value| !value.is_empty());
        let stored = self.vault.get(&api_key_account(id)).await.ok().flatten().is_some_and(|key| !key.is_empty());
        let unstored_status = if configured_enabled { "No Key" } else { "Off" };
        let mut status = if stored { "Set" } else { unstored_status };
        let located = if self.vault.is_fallback(&api_key_account(id)).await { "stored in private file" } else { "stored in keychain" };
        let mut detail = if stored { located } else { "custom endpoint" }.to_owned();
        if !api_key_env.is_empty() {
            status = if env_set { "Env" } else { unstored_status };
            detail = api_key_env.clone();
        }
        if keyless {
            status = if configured_enabled { "Keyless" } else { "Off" };
            detail = "no API key required".into();
        }
        let key_authenticated = if api_key_env.is_empty() { stored } else { env_set };
        let mut row = Obj::new();
        row.insert("id".into(), json!(id));
        for key in ["name", "protocol", "baseURL"] {
            if let Some(value) = entry.get(key) {
                row.insert(key.into(), value.clone());
            }
        }
        row.insert("models".into(), json!(config.as_ref().map(|c| public_rows(&manual_rows(c))).unwrap_or_default()));
        row.insert("custom".into(), json!(true));
        row.insert("group".into(), json!("api"));
        row.insert("type".into(), json!("api-key"));
        row.insert("enabled".into(), json!(configured_enabled));
        row.insert("authenticated".into(), json!(keyless || key_authenticated));
        row.insert("stored".into(), json!(stored));
        row.insert("env".into(), json!(env_set));
        row.insert("envName".into(), if api_key_env.is_empty() { Value::Null } else { json!(api_key_env) });
        row.insert("status".into(), json!(status));
        row.insert("detail".into(), json!(detail));
        if !api_key_env.is_empty() {
            row.insert("apiKeyEnv".into(), json!(api_key_env));
        }
        let from = |key: &str| config.as_ref().and_then(|c| c.get(key)).or_else(|| entry.get(key));
        if let Some(version) = from("schemaVersion") {
            row.insert("schemaVersion".into(), version.clone());
        }
        row.insert("auth".into(), json!(if keyless { "none" } else { "key" }));
        row.insert("discovery".into(), from("discovery").cloned().unwrap_or_else(|| json!({ "newModelsHidden": false })));
        row.insert("modelOverrides".into(), from("modelOverrides").cloned().unwrap_or_else(|| json!({})));
        for key in ["headers", "requestBody", "wires", "modelWires"] {
            if let Some(value) = config.as_ref().and_then(|c| c.get(key)) {
                row.insert(key.into(), value.clone());
            }
        }
        // Additional API keys by id only; their values never leave the keychain.
        let extra = if keyless { Vec::new() } else { self.key_ids_of(id).await };
        if !extra.is_empty() {
            row.insert("extraApiKeys".into(), json!(extra.iter().map(|key| json!({ "id": key })).collect::<Vec<_>>()));
        }
        // A stored config that does not normalize cannot run: say so instead of listing it as connected.
        if let Some(error) = config_error {
            row.insert("configError".into(), json!(error));
            row.insert("status".into(), json!("Invalid config"));
            row.insert("detail".into(), json!(error));
            row.insert("usable".into(), json!(false));
            row.insert("ready".into(), json!(false));
            row.insert("authenticated".into(), json!(false));
        }
        Value::Object(row)
    }
}

/// One custom provider built from a resolved input, probed by `CustomProbes`.
struct BuiltEndpoint {
    parts: CustomParts,
    keys: ApiKeyStore,
    builder: Arc<DefaultProviderBuilder>,
    id: String,
    config: Value,
    broker: Arc<ModelBroker>,
    rotation: AccountRotation,
}

fn plain_error(message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = message;
    error
}

/// The events of a test send are not shown anywhere.
struct Discard;

impl AttemptSink for Discard {
    fn event(&mut self, _: StreamEvent) {}
    fn discard(&mut self) {}
}

/// The engines of a custom provider's keys: `default` is the primary key's, any other account id
/// an additional key's own (`customKeyEngine`), built when first used.
struct KeyEngines {
    id: String,
    primary: Arc<dyn ProviderAdapter>,
    keys: ApiKeyStore,
    builder: Arc<DefaultProviderBuilder>,
    config: Value,
    broker: Arc<ModelBroker>,
    request: Arc<ModelRequest>,
    built: Mutex<HashMap<String, Arc<dyn ProviderAdapter>>>,
}

impl KeyEngines {
    async fn engine(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        if account == "default" {
            return Ok(self.primary.clone());
        }
        if let Some(built) = self.built.lock().unwrap_or_else(PoisonError::into_inner).get(account) {
            return Ok(built.clone());
        }
        let key = self.keys.read_custom(&self.id, account).await;
        if key.is_empty() {
            return Err(plain_error(format!(
                "An additional API key of {} is not readable; enter it again in its settings.",
                self.id
            )));
        }
        // The key is the only source: an environment variable names the primary key alone.
        let mut config = self.config.clone();
        if let Some(object) = config.as_object_mut() {
            object.shift_remove("apiKeyEnv");
            object.insert("apiKey".into(), json!(key));
        }
        let engine = self.builder.build_custom_parts(&self.id, &config).map_err(plain_error)?.adapter;
        self.built.lock().unwrap_or_else(PoisonError::into_inner).insert(account.to_owned(), engine.clone());
        Ok(engine)
    }
}

#[async_trait]
impl AccountSender<Option<String>> for KeyEngines {
    /// A custom provider's engines declare no cooldown policy.
    fn cooldown_policy(&self, _: &str) -> Option<CooldownPolicy> {
        None
    }

    /// One key's send through the shared broker: the retry rules every request follows.
    async fn send(&self, account: &str, _scoped: bool) -> Result<Option<String>, Failed> {
        let engine = self.engine(account).await.map_err(Failed::new)?;
        let lane = self
            .broker
            .admission()
            .lane(&LaneKey::new(ProviderId::from(self.id.as_str()), account), LaneSettings::default());
        let send = SendRequest { request: self.request.clone(), lane, admission: AdmissionRequest::default() };
        match self.broker.send(engine.as_ref(), send, &mut Discard, &CancellationToken::new()).await {
            Ok(_) => Ok(None),
            Err(SendError::Provider(error) | SendError::Exhausted(error) | SendError::Fallback { last: error, .. }) => {
                Err(Failed::new(error))
            }
            Err(SendError::Admission(error)) => Err(Failed::new(plain_error(format!("{error:?}")))),
            Err(SendError::Cancelled) => Err(Failed::new(plain_error("This operation was aborted".into()))),
        }
    }

    /// The pool names the additional key that served; the primary's answer names none.
    fn stamp(&self, result: &mut Option<String>, account: &str, _binding: &str) {
        *result = (account != "default").then(|| account.to_owned());
    }

    fn notify(&self, _: Stage) {}
}

/// What a pool that ended without an answer throws.
fn pool_failure(error: PoolError) -> ProviderError {
    match error.cause {
        mixdog_ai::accounts::rotation::Cause::Provider(provider) => provider,
        _ => plain_error(error.message()),
    }
}

#[async_trait]
impl CustomEndpoint for BuiltEndpoint {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.parts.listing.list_models().await
    }

    fn discovery_error(&self) -> Option<ProviderError> {
        self.parts.listing.discovery_error()
    }

    /// `Reply with OK.` as a real request is sent: every key's send goes through the shared
    /// broker (its retry rules), and the roster rotation moves an explicit quota refusal on to
    /// the next additional key. The answer names the additional key that served.
    async fn send_test(&self, model: &str, key_ids: &[String]) -> Result<Option<String>, ProviderError> {
        let message = Message::new(Role::User, Content::Text(TEST_PROMPT.into()));
        let options = RequestOptions { max_output_tokens_override: Some(TEST_MAX_TOKENS), ..RequestOptions::default() };
        let request = Arc::new(ModelRequest { model: model.to_owned(), messages: vec![message], tools: Vec::new(), options });
        let engines = KeyEngines {
            id: self.id.clone(),
            primary: self.parts.adapter.clone(),
            keys: self.keys.clone(),
            builder: self.builder.clone(),
            config: self.config.clone(),
            broker: self.broker.clone(),
            request,
            built: Mutex::new(HashMap::new()),
        };
        let context = SendContext {
            model: model.to_owned(),
            session_id: None,
            bound_hint: None,
            cancel: CancellationToken::new(),
            implicit_plan_usage: None,
        };
        // Node builds the pool only for eligible saved keys (`keyIds`, empty for an input that is
        // keyless or reads its key from the environment); otherwise the primary sends alone.
        if key_ids.is_empty() {
            return engines.send("default", false).await.map_err(|failed| failed.error);
        }
        self.rotation.pool_send(&self.id, &context, &engines).await.map_err(pool_failure)
    }
}

#[async_trait]
impl CustomProbeHost for CustomHost {
    fn require_local_provider_management(&self) -> Result<(), Failure> {
        ProviderAdmin::require_local()
    }

    async fn resolve_input(&self, input: &Value) -> Result<ResolvedCustom, Failure> {
        let resolved = self.resolve(input).await?;
        Ok(ResolvedCustom { id: resolved.id, config: resolved.config, api_key: resolved.api_key })
    }

    async fn create(&self, id: &str, config: &Value, api_key: &str) -> Result<Arc<dyn CustomEndpoint>, Failure> {
        if !id.starts_with("custom-") || id == "custom-" {
            return Err(Failure::error(format!("[custom-provider] invalid custom provider id: {id}")));
        }
        let mut full = config.clone();
        if let Some(object) = full.as_object_mut() {
            object.insert("apiKey".into(), json!(api_key));
        }
        let parts = self.builder.build_custom_parts(id, &full).map_err(Failure::error)?;
        let endpoint = BuiltEndpoint {
            parts,
            keys: self.keys.clone(),
            builder: self.builder.clone(),
            id: id.to_owned(),
            config: full,
            broker: self.broker.clone(),
            rotation: self.rotation.clone(),
        };
        Ok(Arc::new(endpoint))
    }

    async fn key_ids(&self, id: &str) -> Vec<String> {
        self.key_ids_of(id).await
    }

    fn env(&self, name: &str) -> Option<String> {
        self.env.var(name)
    }
}

pub struct CustomAdmin {
    host: Arc<CustomHost>,
    probes: CustomProbes,
    refresh: Arc<dyn AuthRefresh>,
    /// One key transaction per provider, from reading the rollback key to the config commit or
    /// rollback: a failed save restores the key the preceding save committed and never one a
    /// newer save wrote. Settings-only saves and other providers never wait.
    queues: Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
}

type Slot<T> = Arc<Mutex<Option<Result<T, Failure>>>>;

impl CustomAdmin {
    pub fn new(host: Arc<CustomHost>, refresh: Arc<dyn AuthRefresh>) -> Arc<Self> {
        let probes = CustomProbes::new(host.clone());
        Arc::new(Self { host, probes, refresh, queues: Mutex::new(HashMap::new()) })
    }

    /// `serializeCustomKeySave`.
    async fn serialized<T>(&self, id: &str, run: impl Future<Output = T>) -> T {
        let lock = self
            .queues
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone();
        let out = {
            // Never closed, so the permit is always granted in turn.
            let _turn = lock.acquire().await;
            run.await
        };
        let mut queues = self.queues.lock().unwrap_or_else(PoisonError::into_inner);
        // The map and this call hold the lock: nobody else is waiting for it.
        if Arc::strong_count(&lock) == 2 {
            queues.remove(id);
        }
        out
    }

    /// Edits the agent section; `change` answers through the slot, and a refusal leaves the
    /// document as it was.
    async fn edit<T: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Obj) -> Result<T, Failure> + Send + 'static,
    ) -> Result<T, Failure> {
        let slot: Slot<T> = Arc::new(Mutex::new(None));
        let answer = slot.clone();
        self.host
            .config
            .update_agent(move |doc| {
                let result = change(doc);
                *answer.lock().unwrap_or_else(PoisonError::into_inner) = Some(result);
                Ok(())
            })
            .await
            .map_err(config_failure)?;
        let answered = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
        answered.unwrap_or_else(|| Err(Failure::error("the config job did not run")))
    }

    async fn apply_extra_keys(&self, id: &str, plan: &ExtraPlan) -> Result<(), Failure> {
        for (key_id, key) in &plan.added {
            self.host.keys.save_custom(id, key_id, key).await.map_err(vault_failure)?;
        }
        if plan.changed() {
            self.host.accounts.set_custom_key_ids(id, plan.ids.clone()).await.map_err(acct)?;
        }
        Ok(())
    }

    /// A failed save puts the saved roster back and drops the keys it added.
    /// Node does not catch here: a failure replaces the error that started the revert.
    async fn revert_extra_keys(&self, id: &str, plan: &ExtraPlan) -> Result<(), Failure> {
        if plan.changed() {
            self.host.accounts.set_custom_key_ids(id, plan.saved.clone()).await.map_err(acct)?;
        }
        for (key_id, _) in &plan.added {
            self.host.keys.forget_custom(id, key_id).await.map_err(vault_failure)?;
        }
        Ok(())
    }

    /// The config write of a save: the entry over the document this transaction sees.
    async fn write_entry(&self, id: &str, input: &Obj, plan: &ExtraPlan) -> Result<Value, Failure> {
        self.apply_extra_keys(id, plan).await?;
        let stored = self.host.keys.get(id).await.unwrap_or_default();
        let (input, env, id) = (input.clone(), self.host.env.clone(), id.to_owned());
        self.edit(move |agent| {
            let latest = input_at(agent, &input, &stored, env.as_ref())?;
            require_custom_key(&latest)?;
            let mut entry = latest.config.as_object().cloned().unwrap_or_default();
            entry.insert("type".into(), json!("custom"));
            entry.insert("enabled".into(), json!(latest.config["enabled"] != Value::Bool(false)));
            let entry = Value::Object(entry);
            object_at(agent, "providers").insert(id, entry.clone());
            Ok(entry)
        })
        .await
    }

    async fn commit_save(&self, id: &str, input: &Obj, resolved: &InputAt) -> Result<Value, Failure> {
        let host = &self.host;
        let existing = resolved.id.is_some();
        let typed = resolved.typed.as_str();
        let previous = if !typed.is_empty() && existing { host.keys.get(id).await } else { None };
        // Auth as of this save's turn in the key queue: a no-auth save queued earlier may have
        // landed since the input was resolved.
        let keyless = if existing { input_at(&host.config.agent(), input, "", host.env.as_ref())?.keyless } else { resolved.keyless };
        let saved = if existing { host.key_ids_of(id).await } else { Vec::new() };
        let plan = extra_key_plan(saved, input.get("extraApiKeys"), keyless)?;
        if !typed.is_empty() {
            host.keys.save(id, typed).await.map_err(vault_failure)?;
        }
        let entry = match self.write_entry(id, input, &plan).await {
            Ok(entry) => entry,
            Err(error) => {
                self.revert_extra_keys(id, &plan).await?;
                if !typed.is_empty() {
                    match previous.filter(|key| !key.is_empty()) {
                        Some(key) => host.keys.save(id, &key).await,
                        None => host.keys.forget(id).await,
                    }
                    .map_err(vault_failure)?;
                }
                return Err(error);
            }
        };
        // A removed key is dropped once the save holds; a keychain refusal then leaves an
        // unused secret behind, never a failed save that did commit.
        for key_id in &plan.removed {
            if let Err(error) = host.keys.forget_custom(id, key_id).await {
                (host.log)(&format!(
                    "[provider-admin] could not delete additional API key {key_id} of {id}: {}\n",
                    error.0
                ));
            }
        }
        Ok(host.row(id, &entry).await)
    }

    async fn save_inner(&self, input: Value) -> Result<Value, Failure> {
        ProviderAdmin::require_local()?;
        // Early verdict: an invalid save never touches the keychain.
        let resolved = self.host.resolve(&input).await?;
        require_custom_key(&resolved)?;
        let object = input_object(&input)?;
        let id = resolved.id.clone().unwrap_or_else(|| format!("custom-{}", uuid::Uuid::new_v4()));
        // Every save that may change the keys runs in the provider's key queue: a typed key, an
        // additional-key list, or a no-auth save (which drops them), decided from the input alone.
        let keys_change =
            !resolved.typed.is_empty() || object.contains_key("extraApiKeys") || (resolved.id.is_some() && resolved.keyless);
        if keys_change {
            self.serialized(&id, self.commit_save(&id, object, &resolved)).await
        } else {
            self.commit_save(&id, object, &resolved).await
        }
    }

    /// `takesStoredKey`.
    fn takes_stored_key(&self, id: &str) -> Result<Value, Failure> {
        let entry = existing_entry(&self.host.config.agent(), id)?;
        let config = normalize(&entry).ok();
        let auth = config.as_ref().and_then(|c| c.get("auth")).or_else(|| entry.get("auth"));
        if auth.and_then(Value::as_str) == Some("none") {
            return Err(Failure::error("this custom provider needs no API key"));
        }
        if let Some(env) = config.as_ref().and_then(|c| c.get("apiKeyEnv")).and_then(Value::as_str).filter(|e| !e.is_empty()) {
            return Err(Failure::error(format!("this custom provider reads its key from {env}")));
        }
        Ok(entry)
    }

    async fn save_key_inner(&self, id: &str, secret: &Value) -> Result<Value, Failure> {
        ProviderAdmin::require_local()?;
        let id = js_trim(id).to_owned();
        let secret = match secret.as_str() {
            Some(secret) if utf16_len(secret) <= API_KEY_MAX => secret,
            _ => return Err(Failure::type_error("custom provider apiKey is invalid")),
        };
        let key = js_trim(secret);
        if key.is_empty() {
            return Err(Failure::error("API key is required"));
        }
        self.takes_stored_key(&id)?;
        // The provider's removal runs in the same queue, so it never lands between the checks
        // and the write below.
        self.serialized(&id, async {
            self.takes_stored_key(&id)?;
            let host = &self.host;
            let previous = host.keys.get(&id).await;
            host.keys.save(&id, key).await.map_err(vault_failure)?;
            match self.takes_stored_key(&id) {
                Ok(entry) => Ok(host.row(&id, &entry).await),
                Err(error) => {
                    // Switched to keyless (or the provider is gone) meanwhile: the key written is
                    // dropped, and the previous one is only put back for a provider that exists.
                    let agent = host.config.agent();
                    let exists = is_custom_entry(agent.get("providers").and_then(|p| p.get(&id)));
                    match previous.filter(|key| exists && !key.is_empty()) {
                        Some(previous) => host.keys.save(&id, &previous).await,
                        None => host.keys.forget(&id).await,
                    }
                    .map_err(vault_failure)?;
                    Err(error)
                }
            }
        })
        .await
    }

    async fn update_model_inner(&self, id: &str, model_id: &str, patch: Option<Value>) -> Result<Value, Failure> {
        ProviderAdmin::require_local()?;
        let id = js_trim(id).to_owned();
        let model = js_trim(model_id).to_owned();
        if model.is_empty() {
            return Err(Failure::type_error("model id is required"));
        }
        // The provider is read, patched and saved in one transaction, so a concurrent update can
        // never be overwritten by a provider object read earlier.
        let at = id.clone();
        let saved = self
            .edit(move |agent| {
                let entry = existing_entry(agent, &at)?;
                let current = normalize(&entry).map_err(Failure::error)?;
                let mut overrides =
                    current.get("modelOverrides").and_then(Value::as_object).cloned().unwrap_or_default();
                if patch.as_ref().is_some_and(Value::is_null) {
                    overrides.shift_remove(&model);
                } else {
                    // An absent patch is `plainPatch(undefined)`.
                    let patch = plain_patch(patch.as_ref().unwrap_or(&Value::Null), &MODEL_PATCH_KEYS, "model patch")?;
                    let mut rest = patch.clone();
                    let reasoning = rest.shift_remove("reasoning");
                    let mut next = apply_tri_state(overrides.get(&model), &rest);
                    // The supplied reasoning values are validated as sent, before any pruning can
                    // hide a malformed mapping.
                    if let Some(supplied) = reasoning.as_ref().filter(|r| !r.is_null()) {
                        plain_patch(supplied, &REASONING_PATCH_KEYS, "reasoning patch")?;
                        assert_reasoning_patch(supplied).map_err(Failure::error)?;
                    }
                    if let Some(reasoning) = &reasoning {
                        let mut merged = if reasoning.is_null() {
                            Obj::new()
                        } else {
                            apply_tri_state(next.get("reasoning"), plain_patch(reasoning, &REASONING_PATCH_KEYS, "reasoning patch")?)
                        };
                        // New levels retire the wire values of levels they no longer list.
                        if let (Some(levels), Some(values)) =
                            (reasoning.get("levels").and_then(Value::as_array), merged.get("wireValues").and_then(Value::as_object))
                        {
                            let kept: HashSet<Option<&str>> = levels.iter().map(canonical_reasoning_level).collect();
                            let wire: Obj = values
                                .iter()
                                .filter(|(level, _)| kept.contains(&mixdog_ai::providers::custom::reasoning::canonical_level(level)))
                                .map(|(level, value)| (level.clone(), value.clone()))
                                .collect();
                            if wire.is_empty() {
                                merged.shift_remove("wireValues");
                            } else {
                                merged.insert("wireValues".into(), Value::Object(wire));
                            }
                        }
                        next.shift_remove("reasoning");
                        if !merged.is_empty() {
                            next.insert("reasoning".into(), Value::Object(merged));
                        }
                    }
                    if next.is_empty() {
                        overrides.shift_remove(&model);
                    } else {
                        overrides.insert(model.clone(), Value::Object(next));
                    }
                }
                let mut next_config = current.as_object().cloned().unwrap_or_default();
                next_config.insert("modelOverrides".into(), Value::Object(overrides));
                let config = normalize(&Value::Object(next_config)).map_err(Failure::error)?;
                let mut saved = config.as_object().cloned().unwrap_or_default();
                saved.insert("type".into(), json!("custom"));
                saved.insert("enabled".into(), json!(entry.get("enabled") != Some(&Value::Bool(false))));
                let saved = Value::Object(saved);
                object_at(agent, "providers").insert(at, saved.clone());
                Ok(saved)
            })
            .await?;
        Ok(self.host.row(&id, &saved).await)
    }

    async fn remove_inner(&self, id: &str) -> Result<Value, Failure> {
        ProviderAdmin::require_local()?;
        let id = js_trim(id).to_owned();
        existing_entry(&self.host.config.agent(), &id)?;
        // In the provider's key queue: a key write in flight finishes first and none starts
        // between the secret's deletion and the config's.
        self.serialized(&id, async {
            existing_entry(&self.host.config.agent(), &id)?;
            let host = &self.host;
            // Secret first: a real keychain failure (locked, permission) leaves the provider
            // registered so the removal can be retried.
            host.vault.delete(&api_key_account(&id)).await.map_err(vault_failure)?;
            let extra = host.key_ids_of(&id).await;
            for key_id in &extra {
                host.keys.forget_custom(&id, key_id).await.map_err(vault_failure)?;
            }
            if !extra.is_empty() {
                host.accounts.set_custom_key_ids(&id, Vec::new()).await.map_err(acct)?;
            }
            let at = id.clone();
            self.edit(move |agent| {
                if let Some(providers) = agent.get_mut("providers").and_then(Value::as_object_mut) {
                    providers.shift_remove(&at);
                }
                drop_references(agent, &at);
                Ok(())
            })
            .await?;
            Ok(json!({ "provider": id, "type": "custom", "removed": true }))
        })
        .await
    }

    /// The `login.mjs` wrapper: the runtime refreshes after a change that succeeded.
    fn refreshed(&self, result: Result<Value, Failure>) -> Result<Value, Failure> {
        if result.is_ok() {
            self.refresh.after_credential_change();
        }
        result
    }
}

#[async_trait]
impl CustomProviders for CustomAdmin {
    async fn save(&self, input: Value) -> Result<Value, Failure> {
        self.refreshed(self.save_inner(input).await)
    }

    async fn save_key(&self, id: &str, secret: &Value) -> Result<Value, Failure> {
        self.refreshed(self.save_key_inner(id, secret).await)
    }

    async fn remove(&self, id: &str) -> Result<Value, Failure> {
        self.refreshed(self.remove_inner(id).await)
    }

    async fn update_model(&self, id: &str, model_id: &str, patch: Option<Value>) -> Result<Value, Failure> {
        self.refreshed(self.update_model_inner(id, model_id, patch).await)
    }

    async fn test(&self, input: Value) -> Result<Value, Failure> {
        self.probes.test(input).await
    }

    async fn discover_models(&self, input: Value) -> Result<Value, Failure> {
        self.probes.discover_models(input).await
    }
}
