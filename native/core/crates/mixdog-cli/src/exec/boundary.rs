//! The pristine execution boundary (`createPristineExecutionBoundary`): a temp root with its own
//! data and runtime root, the selected provider's credentials as Node binds them, the minimal
//! config, and removal on exit. Nothing of the host's personal state reaches the run.
//!
//! The patch-binary cache Node seeded is gone: the core links the patch library.
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

use mixdog_ai::providers::custom::config::normalize as normalize_custom;

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

fn minimal_config(contract: &Value, provider: &str, model: &str, effort: &str, fast: bool, custom: Option<&Value>) -> Value {
    let mut route = Map::new();
    route.insert("provider".into(), json!(provider));
    route.insert("model".into(), json!(model));
    if !effort.is_empty() {
        route.insert("effort".into(), json!(effort));
    }
    if fast {
        route.insert("fast".into(), json!(true));
    }
    let mut provider_config = custom.and_then(Value::as_object).cloned().unwrap_or_default();
    provider_config.insert("enabled".into(), json!(true));
    if provider == "openai-oauth" {
        provider_config.insert("websocket".into(), json!(true));
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
    let mut preset = Map::new();
    preset.insert("id".into(), json!("exec-explicit-route"));
    preset.insert("name".into(), json!("EXEC EXPLICIT ROUTE"));
    preset.insert("type".into(), json!("agent"));
    preset.insert("tools".into(), json!("full"));
    preset.extend(route);
    let mut agent = contract["agentDefaults"].as_object().expect("agentDefaults").clone();
    agent.insert("providers".into(), json!({ provider: Value::Object(provider_config) }));
    agent.insert("presets".into(), json!([Value::Object(preset)]));
    agent.insert("default".into(), json!("exec-explicit-route"));
    agent.insert("workflow".into(), json!({ "active": "headless" }));
    agent.insert("workflowRoutes".into(), json!({}));
    agent.insert("agents".into(), json!({}));
    agent.insert("modelSettings".into(), Value::Object(model_settings));
    agent.insert("mcpServers".into(), json!({}));
    json!({ "agent": Value::Object(agent) })
}

/// `--provider-config` (decision B-8, a deliberate difference from Node): the one custom provider entry the run
/// may use, named by the `--provider` it defines (`{"custom-x": {...}}`, inline JSON or a file). It is validated as
/// the settings validate a custom provider and holds no inline secret: the key is read from the environment
/// variable it names. The default stays pristine; the host's config is never read.
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

fn audit_document(contract: &Value, request: &BoundaryRequest<'_>, effort: &str, config_bytes: &[u8], auth_mode: &str, catalogs: u32) -> Value {
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
fn scrubbed_env(contract: &Value, host_env: &BTreeMap<String, String>, root: &Path, data: &Path, runtime: &Path, key_env: Option<&str>) -> BTreeMap<String, Option<String>> {
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

impl Boundary {
    /// Creates the root and everything the run starts from; a refusal removes the root again.
    pub fn create(request: &BoundaryRequest<'_>) -> Result<Self, String> {
        validate_explicit_route(Some(request.provider), Some(request.model), request.effort)?;
        let contract = contract();
        let provider = clean(Some(request.provider)).to_owned();
        let model = clean(Some(request.model)).to_owned();
        let effort = clean(request.effort).to_lowercase();
        let root_dir = tempfile::Builder::new()
            .prefix("mixdog-headless-pristine-")
            .tempdir_in(request.temp_dir)
            .map_err(|err| err.to_string())?
            .keep();
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
        let api_key_env = contract["apiKeyProviders"].get(provider).and_then(Value::as_str).or_else(|| custom.as_ref().and_then(|entry| entry["apiKeyEnv"].as_str()));
        // Resolved before the environment is scrubbed: the selected provider may use any of its
        // standard names or its one keychain account, and nothing else is scanned.
        let api_key = match &custom {
            Some(_) => api_key_env.and_then(|name| request.host_env.get(name)).map(|key| clean(Some(key)).to_owned()).filter(|key| !key.is_empty()),
            None => api_key_env.and_then(|_| request.credentials.api_key(provider)).map(|key| clean(Some(&key)).to_owned()).filter(|key| !key.is_empty()),
        };
        let env = scrubbed_env(contract, request.host_env, root_dir, &data_dir, &runtime_root, custom.as_ref().and(api_key_env));

        let mut auth_mode = "provider-managed";
        let mut catalogs = 0;
        let mut credential = None;
        if let Some(oauth) = oauth {
            let credential_env = oauth["credentialPathEnv"].as_str().expect("credentialPathEnv");
            let explicit = request.host_env.get(credential_env).filter(|path| !clean(Some(path)).is_empty()).map(|path| std::path::absolute(path).map_err(|err| err.to_string())).transpose()?;
            let legacy = request.host_data_dir.join(oauth["credentialFile"].as_str().expect("credentialFile"));
            let source = explicit.unwrap_or_else(|| {
                request
                    .credentials
                    .pool_credential(provider, request.host_data_dir)
                    .into_iter()
                    .chain([legacy.clone()])
                    .find(|path| path.exists())
                    .unwrap_or(legacy)
            });
            if !source.exists() {
                return Err(format!("required {provider} credentials are unavailable; sign in before using mixdog exec"));
            }
            auth_mode = "in-process-host-oauth-binding";
            credential = Some(CredentialBinding { provider: provider.to_owned(), path: source });
            let catalog = oauth["modelCatalogFile"].as_str().expect("modelCatalogFile");
            let source_catalog = request.host_data_dir.join(catalog);
            if source_catalog.exists() {
                std::fs::copy(&source_catalog, data_dir.join(catalog)).map_err(|err| err.to_string())?;
                catalogs = 1;
            }
        } else if let Some(env_name) = api_key_env {
            if api_key.is_none() {
                return Err(format!("required {provider} authentication is unavailable; set {env_name}"));
            }
            auth_mode = "in-process-api-key";
        }

        let config = minimal_config(contract, provider, model, effort, request.fast, custom.as_ref());
        let config_bytes = format!("{}\n", serde_json::to_string_pretty(&config).expect("a config serializes"));
        write_private(&data_dir.join(contract["configFileName"].as_str().expect("configFileName")), config_bytes.as_bytes()).map_err(|err| err.to_string())?;
        let mut runtime_config = config["agent"].clone();
        let mut selected = runtime_config["providers"][provider].as_object().cloned().unwrap_or_default();
        selected.insert("enabled".into(), json!(true));
        // The key is bound in memory: the variable that held it is gone from the run's environment.
        selected.remove("apiKeyEnv");
        if let Some(key) = &api_key {
            selected.insert("apiKey".into(), json!(key));
        }
        runtime_config["providers"] = json!({ provider: Value::Object(selected) });
        let audit = audit_document(contract, request, effort, config_bytes.as_bytes(), auth_mode, catalogs);
        Ok(Self {
            root_dir: root_dir.to_path_buf(),
            data_dir,
            runtime_root,
            runtime_config,
            credential,
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
