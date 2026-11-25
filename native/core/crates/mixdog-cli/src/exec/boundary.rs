#![allow(
    clippy::disallowed_methods,
    reason = "the boundary is created before the core starts and removed after it stopped; the exec process owns the temp root"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use mixdog_acp::agents::Refusal;
use mixdog_acp::preset::AgentPreset;
use mixdog_ai::catalog::is_known_provider;
use mixdog_ai::providers::custom::config::normalize as normalize_custom;
use mixdog_ai::service::admin_models::model_proxy_client_mode;
use mixdog_ai::service::admin_models::provider_available;
use mixdog_ai::service::admin_route::workflow_preset_id;
use mixdog_core_config::tool_modules::builtin_feature_active;

use super::profile;
use super::profile::LeadRoute;
use super::profile::RouteProfile;
use super::route::clean;
use super::route::validate_explicit_route;

const CONTRACT: &str = include_str!("pristine-contract.json");
/// `AGENT_PROVIDER_ENV_ALIASES`.
const KEY_ALIASES: [(&str, &[&str]); 1] = [("xai", &["GROK_API_KEY"])];
const REMOVAL_RETRY_DELAY_MS: u64 = 100;

/// The host's credential lookups that need the keychain and the account pool.
pub trait HostCredentials {
    /// The provider's API key: its environment names, then its keychain entry.
    fn api_key(&self, provider: &str) -> Option<String>;
    /// The credential file of the account the host's pool has selected for `provider`.
    fn pool_credential(&self, provider: &str, host_data_dir: &Path) -> Option<PathBuf>;
}

pub struct BoundaryRequest<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub fast: bool,
    /// `--provider-config`: the file or JSON of the one custom provider entry the run may use.
    pub provider_config: Option<&'a str>,
    /// `--route-profile`: the file or JSON of the agent roles' routes and the Lead's fallback.
    pub route_profile: Option<&'a str>,
    /// The shipped agent definitions (`<package>/src/agents`): the roles a route profile may name.
    pub agents_dir: &'a Path,
    /// The ACP agents the run's core holds (`CoreLauncher::agent_presets`): the Lead's route may be one's.
    pub agent_presets: &'a [AgentPreset],
    pub host_env: &'a BTreeMap<String, String>,
    pub host_data_dir: &'a Path,
    pub temp_dir: &'a Path,
    pub credentials: &'a dyn HostCredentials,
}

/// The one credential file the core reads for the run, bound in process and never named in the
/// environment tools can see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialBinding {
    pub provider: String,
    pub path: PathBuf,
}

pub struct Boundary {
    pub root_dir: PathBuf,
    pub data_dir: PathBuf,
    pub runtime_root: PathBuf,
    /// The selected provider's config the core starts from (the in-memory API key included).
    pub runtime_config: Value,
    pub credential: Option<CredentialBinding>,
    /// The OAuth credentials of the other providers a route profile's roles and Lead fallback run on.
    pub role_credentials: Vec<CredentialBinding>,
    /// The process environment the run sees: `None` removes the variable.
    pub env: BTreeMap<String, Option<String>>,
    pub audit: Value,
    cleaned: AtomicBool,
}

/// How hard the root is removed.
#[derive(Debug, Clone, Copy)]
pub struct Cleanup {
    pub preserve_root: bool,
    pub tolerate_removal_failure: bool,
    pub removal_retries: u32,
}

impl Cleanup {
    /// A finished answer never waits the full retry budget on a straggling root.
    pub const AFTER_ANSWER: Self = Self { preserve_root: false, tolerate_removal_failure: true, removal_retries: 10 };
    pub const PRESERVE: Self = Self { preserve_root: true, tolerate_removal_failure: true, removal_retries: 10 };
}

fn contract() -> Value {
    serde_json::from_str(CONTRACT).expect("the pristine contract is valid JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("a contract list").iter().map(|item| item.as_str().expect("a contract string").to_owned()).collect()
}

fn provider_entry(provider: &str, base: Option<&Value>) -> Value {
    let mut entry = base.and_then(Value::as_object).cloned().unwrap_or_default();
    entry.insert("enabled".into(), json!(true));
    if provider == "openai-oauth" {
        entry.insert("websocket".into(), json!(true));
    }
    Value::Object(entry)
}

/// `on_agent`: the Lead's route is an ACP agent's, which is no provider of the registry: the run's config switches the
/// agents on instead.
#[allow(clippy::too_many_arguments, reason = "the route's parts, each one field of the config")]
fn minimal_config(
    contract: &Value,
    provider: &str,
    model: &str,
    effort: &str,
    fast: bool,
    custom: Option<&Value>,
    profile: &RouteProfile,
    on_agent: bool,
) -> Value {
    let mut route = Map::new();
    route.insert("provider".into(), json!(provider));
    route.insert("model".into(), json!(model));
    if !effort.is_empty() {
        route.insert("effort".into(), json!(effort));
    }
    if fast {
        route.insert("fast".into(), json!(true));
    }
    let mut providers = Map::new();
    if !on_agent {
        providers.insert(provider.into(), provider_entry(provider, custom));
    }
    for other in profile.providers() {
        if !providers.contains_key(&other) {
            providers.insert(other.clone(), provider_entry(&other, None));
        }
    }
    let mut model_settings = Map::new();
    if !effort.is_empty() || fast {
        let mut settings = Map::new();
        if !effort.is_empty() {
            settings.insert("effort".into(), json!(effort));
        }
        if fast {
            settings.insert("fast".into(), json!(true));
        }
        model_settings.insert(format!("{provider}/{model}"), Value::Object(settings));
    }
    // The Lead preset (`workflow-lead`): the started thread's route adoption keeps the chain that preset holds, and its
    // Lead falls back along it.
    let lead_preset = workflow_preset_id("lead");
    let mut preset = Map::new();
    preset.insert("id".into(), json!(lead_preset));
    preset.insert("name".into(), json!("WORKFLOW LEAD"));
    preset.insert("type".into(), json!("agent"));
    preset.insert("tools".into(), json!("full"));
    preset.extend(route);
    if let Some(fallback) = &profile.lead_fallback {
        preset.insert("fallbacks".into(), json!([fallback]));
    }
    let mut agent = contract["agentDefaults"].as_object().expect("agentDefaults").clone();
    // The run's own switch of the ACP agents, which are on by default: on only for a Lead that is one.
    agent.insert("modules".into(), json!({ "acpAgents": { "enabled": on_agent } }));
    agent.insert("providers".into(), Value::Object(providers));
    agent.insert("presets".into(), json!([Value::Object(preset)]));
    agent.insert("default".into(), json!(lead_preset));
    agent.insert("workflow".into(), json!({ "active": "headless" }));
    agent.insert("workflowRoutes".into(), json!({}));
    agent.insert("agents".into(), Value::Object(profile.agents.clone()));
    // A role the profile routes is switched on: the shipped roster starts some roles off (`advisor`, `explore`).
    if !profile.agents.is_empty() {
        agent.insert("enabledAgents".into(), json!(profile.agents.keys().collect::<Vec<_>>()));
    }
    agent.insert("modelSettings".into(), Value::Object(model_settings));
    agent.insert("mcpServers".into(), json!({}));
    json!({ "agent": Value::Object(agent) })
}

/// `--provider-config`: the one custom provider entry the run may use, named by the `--provider` it defines
/// (`{"custom-x": {...}}`, inline JSON or a file). It holds no inline secret: the key is read from the environment
/// variable it names.
fn explicit_provider_entry(provider: &str, raw: &str) -> Result<Value, String> {
    let raw = clean(Some(raw));
    let text = if raw.starts_with('{') { raw.to_owned() } else { std::fs::read_to_string(raw).map_err(|err| format!("--provider-config {raw}: {err}"))? };
    let document: Value = serde_json::from_str(&text).map_err(|err| format!("--provider-config is not valid JSON: {err}"))?;
    let entry = document.as_object().filter(|map| map.len() == 1).and_then(|map| map.get(provider));
    let Some(entry) = entry.filter(|_| provider.starts_with("custom-")) else {
        return Err(format!("--provider-config must define exactly the custom provider named by --provider as {{\"{provider}\": {{...}}}}"));
    };
    if entry.get("apiKey").is_some() {
        return Err("--provider-config must not hold an inline apiKey; name the environment variable in apiKeyEnv".into());
    }
    let normalized = normalize_custom(entry)?;
    if normalized["enabled"] == json!(false) {
        return Err("--provider-config defines a disabled provider".into());
    }
    if normalized["auth"] == json!("key") && normalized.get("apiKeyEnv").is_none() {
        return Err("--provider-config must name the environment variable of the key in apiKeyEnv".into());
    }
    Ok(normalized)
}

fn audit_document(
    contract: &Value,
    request: &BoundaryRequest<'_>,
    effort: &str,
    config_bytes: &[u8],
    auth_mode: &str,
    catalogs: u32,
    profile: &RouteProfile,
) -> Value {
    let mut personal = Map::new();
    personal.insert("hostConfigRead".into(), json!(false));
    for name in strings(&contract["personalStateCounters"]) {
        personal.insert(name, json!(0));
    }
    let features: Map<String, Value> = strings(&contract["disabledFeatures"]).into_iter().map(|name| (name, json!(false))).collect();
    let mut audit = json!({
        "schemaVersion": contract["schemaVersion"],
        "mode": "headless-exec-pristine",
        "provider": clean(Some(request.provider)),
        "model": clean(Some(request.model)),
        "effort": if effort.is_empty() { Value::Null } else { json!(effort) },
        "fast": request.fast,
        "configSha256": format!("{:x}", Sha256::digest(config_bytes)),
        "authMode": auth_mode,
        "authArtifactFilesCopied": 0,
        "injectedModelCatalogFileCount": catalogs,
        "personalState": Value::Object(personal),
        "featuresEnabled": Value::Object(features),
    });
    if request.provider_config.is_some() {
        audit["providerConfigSource"] = json!("explicit");
    }
    if !profile.is_empty() {
        audit["routeProfile"] = json!({ "agents": profile.agents, "leadFallback": profile.lead_fallback });
    }
    audit
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The environment the run sees: every `MIXDOG_*` and credential variable of the host removed, the
/// root's own paths, the contract's operational controls inherited, the guard variables forced.
fn scrubbed_env(
    contract: &Value,
    host_env: &BTreeMap<String, String>,
    root: &Path,
    data: &Path,
    runtime: &Path,
    key_env: Option<&str>,
) -> BTreeMap<String, Option<String>> {
    let mut env: BTreeMap<String, Option<String>> = BTreeMap::new();
    for name in host_env.keys().filter(|name| name.starts_with("MIXDOG_")) {
        env.insert(name.clone(), None);
    }
    for entry in contract["oauthProviders"].as_object().expect("oauthProviders").values() {
        env.insert(entry["credentialPathEnv"].as_str().expect("credentialPathEnv").to_owned(), None);
    }
    for name in contract["apiKeyProviders"].as_object().expect("apiKeyProviders").values() {
        env.insert(name.as_str().expect("an env name").to_owned(), None);
    }
    if let Some(name) = key_env {
        env.insert(name.to_owned(), None);
    }
    for (_, aliases) in KEY_ALIASES {
        for alias in aliases {
            env.insert((*alias).to_owned(), None);
        }
    }
    env.insert("MIXDOG_HOME".into(), Some(root.to_string_lossy().into_owned()));
    env.insert("MIXDOG_DATA_DIR".into(), Some(data.to_string_lossy().into_owned()));
    env.insert("MIXDOG_RUNTIME_ROOT".into(), Some(runtime.to_string_lossy().into_owned()));
    for name in strings(&contract["approvedExecutionEnv"]) {
        if let Some(value) = host_env.get(&name) {
            env.insert(name, Some(value.clone()));
        }
    }
    for (name, value) in contract["guardEnv"].as_object().expect("guardEnv") {
        env.insert(name.clone(), Some(value.as_str().expect("a guard value").to_owned()));
    }
    env
}

/// The host's switch of the built-in feature `id`, as the app reads it from the environment's override and the stored config.
fn host_feature_active(request: &BoundaryRequest<'_>, contract: &Value, id: &str) -> bool {
    let stored = std::fs::read_to_string(request.host_data_dir.join(contract["configFileName"].as_str().expect("configFileName")))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let agent = stored.as_ref().and_then(|stored| stored["agent"].as_object()).cloned().unwrap_or_default();
    builtin_feature_active(&agent, id, &|name| request.host_env.get(name).cloned(), false)
}

/// Binds the host's OAuth credential for `provider` and copies its model catalog into `data_dir`; answers the binding and how many
/// catalogs were copied.
fn bind_oauth(request: &BoundaryRequest<'_>, oauth: &Value, provider: &str, data_dir: &Path) -> Result<(CredentialBinding, u32), String> {
    let credential_env = oauth["credentialPathEnv"].as_str().expect("credentialPathEnv");
    let explicit = request
        .host_env
        .get(credential_env)
        .filter(|path| !clean(Some(path)).is_empty())
        .map(|path| std::path::absolute(path).map_err(|err| err.to_string()))
        .transpose()?;
    let legacy = request.host_data_dir.join(oauth["credentialFile"].as_str().expect("credentialFile"));
    let source = explicit.unwrap_or_else(|| {
        request.credentials.pool_credential(provider, request.host_data_dir).into_iter().chain([legacy.clone()]).find(|path| path.exists()).unwrap_or(legacy)
    });
    if !source.exists() {
        return Err(format!("required {provider} credentials are unavailable; sign in before using mixdog exec"));
    }
    let catalog = oauth["modelCatalogFile"].as_str().expect("modelCatalogFile");
    let source_catalog = request.host_data_dir.join(catalog);
    let mut catalogs = 0;
    if source_catalog.exists() {
        std::fs::copy(&source_catalog, data_dir.join(catalog)).map_err(|err| err.to_string())?;
        catalogs = 1;
    }
    Ok((CredentialBinding { provider: provider.to_owned(), path: source }, catalogs))
}

impl Boundary {
    /// Creates the root and everything the run starts from; a refusal removes the root again.
    pub fn create(request: &BoundaryRequest<'_>) -> Result<Self, String> {
        validate_explicit_route(Some(request.provider), Some(request.model), request.effort)?;
        let contract = contract();
        let provider = clean(Some(request.provider)).to_owned();
        let model = clean(Some(request.model)).to_owned();
        let effort = clean(request.effort).to_lowercase();
        let root_dir = tempfile::Builder::new().prefix("mixdog-headless-pristine-").tempdir_in(request.temp_dir).map_err(|err| err.to_string())?.keep();
        let built = Self::populate(request, &contract, &provider, &model, &effort, &root_dir);
        if built.is_err() {
            // The root holds nothing but what this call wrote.
            let _ = std::fs::remove_dir_all(&root_dir);
        }
        built
    }

    fn populate(request: &BoundaryRequest<'_>, contract: &Value, provider: &str, model: &str, effort: &str, root_dir: &Path) -> Result<Self, String> {
        let data_dir = root_dir.join("data");
        let runtime_root = root_dir.join("runtime-root");
        create_private_dir(&data_dir).map_err(|err| err.to_string())?;
        create_private_dir(&runtime_root).map_err(|err| err.to_string())?;

        let oauth = contract["oauthProviders"].get(provider);
        let custom = request.provider_config.map(|raw| explicit_provider_entry(provider, raw)).transpose()?;
        if custom.is_none() && provider.starts_with("custom-") {
            return Err(format!("{provider} is a custom provider with no endpoint in a pristine run; pass --provider-config <file-or-json> to define it"));
        }
        let api_key_env =
            contract["apiKeyProviders"].get(provider).and_then(Value::as_str).or_else(|| custom.as_ref().and_then(|entry| entry["apiKeyEnv"].as_str()));
        // Resolved before the environment is scrubbed: the selected provider may use any of its
        // standard names or its one keychain account, and nothing else is scanned.
        let api_key = match &custom {
            Some(_) => api_key_env.and_then(|name| request.host_env.get(name)).map(|key| clean(Some(key)).to_owned()).filter(|key| !key.is_empty()),
            None => api_key_env.and_then(|_| request.credentials.api_key(provider)).map(|key| clean(Some(&key)).to_owned()).filter(|key| !key.is_empty()),
        };
        let env = scrubbed_env(contract, request.host_env, root_dir, &data_dir, &runtime_root, custom.as_ref().and(api_key_env));
        let lead = LeadRoute { provider, model, effort, fast: request.fast };
        let profile = request.route_profile.map(|raw| profile::parse(raw, &lead, request.agents_dir)).transpose()?.unwrap_or_default();
        let agent_of = |on: &str| request.agent_presets.iter().find(|preset| preset.provider == on);
        // An ACP agent signs in with its own CLI and runs behind the feature's switch, which is the host's, as in the app.
        let agent = agent_of(provider);
        if let Some(agent) = agent
            && !host_feature_active(request, contract, mixdog_acp::FEATURE)
        {
            return Err(format!("route \"lead\" provider \"{provider}\" is the ACP agent {}: {}", agent.label, Refusal::Off.message(agent)));
        }
        let config = minimal_config(contract, provider, model, effort, request.fast, custom.as_ref(), &profile, agent.is_some());

        // Every route, the Lead's first, runs on a provider the core knows on the run's own config (`CatalogFacts::is_known`:
        // its config load drops a route on any other, the retired local `ollama` and `lmstudio` among them, and a provider
        // behind a Developer option is unavailable while that option is off, as the run's config leaves every one). A role
        // or the fallback also needs a provider the exec authenticates: an OAuth or API-key one, or the Lead's own custom one.
        // The custom provider `--provider-config` defines is the run's own, whatever its id.
        let client_mode = model_proxy_client_mode(&|name| env.get(name).cloned().flatten());
        let developer = config["agent"].get("developer").cloned().unwrap_or(Value::Null);
        let known = |on: &str| {
            (on == provider && custom.is_some()) || is_known_provider(on, &config["agent"], &|name| provider_available(name, client_mode, &developer))
        };
        if agent.is_none() && !known(provider) {
            return Err(format!("route \"lead\" provider \"{provider}\" is not one mixdog exec can run"));
        }
        for (name, route) in profile.routes() {
            let on = clean(route["provider"].as_str());
            if let Some(other) = agent_of(on) {
                return Err(format!(
                    "--route-profile route \"{name}\" provider \"{on}\" is the ACP agent {}; mixdog exec runs an ACP agent only on the Lead's route",
                    other.label
                ));
            }
            if on.starts_with("custom-") && on != provider {
                return Err(format!("--route-profile provider \"{on}\" is a custom provider; mixdog exec defines only the --provider one"));
            }
            let authenticated =
                contract["oauthProviders"].get(on).is_some() || contract["apiKeyProviders"].get(on).is_some() || (on == provider && custom.is_some());
            if !authenticated || !known(on) {
                return Err(format!("--route-profile route \"{name}\" provider \"{on}\" is not one mixdog exec can run"));
            }
        }

        let (auth_mode, mut catalogs, credential) = match oauth {
            _ if agent.is_some() => ("agent-cli-sign-in", 0, None),
            Some(oauth) => {
                let (credential, catalogs) = bind_oauth(request, oauth, provider, &data_dir)?;
                ("in-process-host-oauth-binding", catalogs, Some(credential))
            }
            None => match api_key_env {
                Some(env_name) if api_key.is_none() => return Err(format!("required {provider} authentication is unavailable; set {env_name}")),
                Some(_) => ("in-process-api-key", 0, None),
                None => ("provider-managed", 0, None),
            },
        };

        // The other providers the profile's roles and fallback run on, each authenticated as the Lead's is.
        let mut role_credentials = Vec::new();
        let mut role_keys = Map::new();
        for other in profile.providers().into_iter().filter(|other| other != provider) {
            if let Some(oauth) = contract["oauthProviders"].get(&other) {
                let (binding, copied) = bind_oauth(request, oauth, &other, &data_dir)?;
                role_credentials.push(binding);
                catalogs += copied;
            } else if let Some(env_name) = contract["apiKeyProviders"].get(&other).and_then(Value::as_str) {
                let key = request.credentials.api_key(&other).map(|key| clean(Some(&key)).to_owned()).filter(|key| !key.is_empty());
                let Some(key) = key else { return Err(format!("required {other} authentication is unavailable; set {env_name}")) };
                role_keys.insert(other, json!(key));
            }
        }

        let config_bytes = format!("{}\n", serde_json::to_string_pretty(&config).expect("a config serializes"));
        write_private(&data_dir.join(contract["configFileName"].as_str().expect("configFileName")), config_bytes.as_bytes()).map_err(|err| err.to_string())?;
        let mut runtime_config = config["agent"].clone();
        if agent.is_none() {
            let mut selected = runtime_config["providers"][provider].as_object().cloned().unwrap_or_default();
            selected.insert("enabled".into(), json!(true));
            // The key is bound in memory: the variable that held it is gone from the run's environment.
            selected.remove("apiKeyEnv");
            if let Some(key) = &api_key {
                selected.insert("apiKey".into(), json!(key));
            }
            runtime_config["providers"][provider] = Value::Object(selected);
        }
        for (other, key) in role_keys {
            runtime_config["providers"][&other]["apiKey"] = key;
        }
        let mut audit = audit_document(contract, request, effort, config_bytes.as_bytes(), auth_mode, catalogs, &profile);
        if agent.is_some() {
            audit["personalState"]["hostConfigRead"] = json!(true);
        }
        Ok(Self {
            root_dir: root_dir.to_path_buf(),
            data_dir,
            runtime_root,
            runtime_config,
            credential,
            role_credentials,
            env,
            audit,
            cleaned: AtomicBool::new(false),
        })
    }

    /// Removes the root (once). Windows releases file handles a beat after the owner exits, so a
    /// refused removal is retried with a linear backoff.
    pub async fn cleanup(&self, how: Cleanup) -> Result<Option<std::io::Error>, std::io::Error> {
        if self.cleaned.swap(true, Ordering::SeqCst) || how.preserve_root {
            return Ok(None);
        }
        let mut attempt = 0;
        loop {
            match std::fs::remove_dir_all(&self.root_dir) {
                Ok(()) => return Ok(None),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(err) if attempt >= how.removal_retries => {
                    return if how.tolerate_removal_failure { Ok(Some(err)) } else { Err(err) };
                }
                Err(_) => {
                    attempt += 1;
                    mixdog_rt::time::sleep(Duration::from_millis(REMOVAL_RETRY_DELAY_MS * u64::from(attempt))).await;
                }
            }
        }
    }
}
