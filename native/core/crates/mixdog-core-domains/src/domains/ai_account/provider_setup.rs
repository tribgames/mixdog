//! The provider setup snapshot: `providerSetup(config, options)` of
//! `session-runtime/services/provider-admin.mjs`, the API, OAuth and local rows. The rows are
//! built here; everything they read of the machine (environment, stored secrets, OAuth
//! credential files, the keychain, the gcloud login, the local runtime) comes through
//! [`SetupWorld`], so each reader can be ported and tested on its own.
//!
//! The custom-provider rows are [`custom_provider_rows`] (the same builder the custom-provider
//! admin answers with). Not here: the `catalogError` overlay, the model-proxy client projection
//! (`modelProxyProviderSetup`) and the caches and keychain overlay of `getProviderSetup`.

use super::custom_admin::{CustomFacts, custom_provider_rows, is_custom_id};
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `API_PROVIDERS`: the id, the display name, the standard environment variable (`AGENT_PROVIDER_ENV`
/// or the row's own) and the page that issues keys.
struct ApiProvider {
    id: &'static str,
    name: &'static str,
    env: Option<&'static str>,
    url: Option<&'static str>,
}

const API_PROVIDERS: [ApiProvider; 7] = [
    ApiProvider { id: "openrouter", name: "OpenRouter", env: Some("OPENROUTER_API_KEY"), url: Some("https://openrouter.ai/keys") },
    ApiProvider { id: "openai", name: "OpenAI API", env: Some("OPENAI_API_KEY"), url: Some("https://platform.openai.com/api-keys") },
    ApiProvider { id: "anthropic", name: "Anthropic API", env: Some("ANTHROPIC_API_KEY"), url: Some("https://console.anthropic.com/settings/keys") },
    ApiProvider { id: "gemini", name: "Gemini API", env: Some("GEMINI_API_KEY"), url: Some("https://aistudio.google.com/apikey") },
    ApiProvider { id: "vertex-ai", name: "Vertex AI", env: None, url: None },
    ApiProvider { id: "deepseek", name: "DeepSeek API", env: Some("DEEPSEEK_API_KEY"), url: Some("https://platform.deepseek.com/api_keys") },
    ApiProvider { id: "xai", name: "xAI API", env: Some("XAI_API_KEY"), url: Some("https://console.x.ai") },
];

/// `AGENT_PROVIDER_ENV` (`shared/provider-api-key.mjs`): the variable each key-based provider
/// declares; Vertex AI declares none.
fn declared_env(id: &str) -> Option<&'static str> {
    match id {
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "gemini" => Some("GEMINI_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        _ => None,
    }
}

/// `OAUTH_PROVIDERS`: id, name and description, in the order the setup lists them.
const OAUTH_PROVIDERS: [(&str, &str, &str); 10] = [
    ("openai-oauth", "OpenAI OAuth", "Mixdog OAuth credentials"),
    ("anthropic-oauth", "Anthropic OAuth", "Mixdog OAuth credentials"),
    ("grok-oauth", "Grok OAuth", "Mixdog OAuth credentials (Grok Build)"),
    ("muse-code-oauth", "Muse Code", "Sign in with your Meta account (Muse Code subscription)"),
    ("command-code-oauth", "Command Code", "Sign in with your Command Code account"),
    ("opencode-go-oauth", "OpenCode Go OAuth", "Sign in with your OpenCode account (OpenCode Go subscription)"),
    ("mimo-oauth", "MiMo", "Sign in with your Xiaomi MiMo account"),
    ("cursor-oauth", "Cursor OAuth", "Sign in with your Cursor account"),
    ("devin-oauth", "Devin", "Sign in with your Devin account"),
    ("antigravity-oauth", "Antigravity OAuth", "Sign in with Google (Gemini + Claude)"),
];

const VERTEX_ADC_MODE: &str = "adc";
const VERTEX_API_KEY_MODE: &str = "api-key";

/// `getKeychainStatus()`: `{ state, fallback, unsafeStore }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeychainStatus {
    /// `ok`, `locked`, `missing`, `unreachable`, `error` or `unknown`.
    pub state: String,
    /// No keychain provider exists on this host: secrets live in the private secrets file.
    pub fallback: bool,
    /// The private file store is ignored: what is wrong (`permissions`, `owner`, `type`) and the folder.
    pub unsafe_store: Option<UnsafeStore>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsafeStore {
    pub kind: String,
    pub path: String,
}

/// What the rows read of the machine.
///
/// The environment (`process.env[name]`; empty counts as unset where Node tests truthiness), the
/// keychain (`hasStoredSecret`, `isFallbackSecret`) and the custom providers' key roster are
/// [`CustomFacts`], which the custom-provider rows read too.
pub trait SetupWorld: CustomFacts + Send + Sync {
    /// `agentApiKeyEnvName(id)`: the variable that supplies the provider's key, in the
    /// resolver's precedence; `None` when none is set.
    fn resolved_env_name(&self, id: &str) -> Option<String>;
    /// `Boolean(getAgentApiKey(id))`.
    fn has_agent_api_key(&self, id: &str) -> bool;
    fn keychain_status(&self) -> KeychainStatus;
    /// `isOAuthProviderAvailable(id)`: a developer-only provider is hidden while its option is off.
    fn oauth_available(&self, id: &str) -> bool;
    /// What the provider's `describe()` says of its own credential.
    fn oauth_describe(&self, id: &str) -> Value;
    /// `describeVertexAdc({ projectId })`.
    fn vertex_adc(&self, project_id: Option<&str>) -> Option<Value>;
    /// `probeVertexMetadata()`: started in the background, its answer is for the next refresh.
    fn probe_vertex_metadata(&self);
    /// `vertexEnvLocation()`.
    fn vertex_env_location(&self) -> Option<String>;
    /// `parseVertexServiceAccount(getAgentApiKey('vertex-ai')).projectId`; `None` for an
    /// unreadable key or one without a project.
    fn vertex_key_project(&self) -> Option<String>;
    /// `(options.getLocalProviderStatus || localProviderStatus)()`; `None` when it throws.
    fn local_status(&self) -> Option<Value>;
}

/// `providerSetup`'s second argument.
#[derive(Clone, Copy, Debug)]
pub struct SetupOptions {
    /// `checkSecrets !== false`.
    pub check_secrets: bool,
    /// `detectLocal !== false`.
    pub detect_local: bool,
}

impl Default for SetupOptions {
    fn default() -> Self {
        Self { check_secrets: true, detect_local: true }
    }
}

/// JavaScript truthiness of a config value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` for the scalars a config can hold; `None` for what is not truthy.
fn text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) if truthy(value) => Some(number.to_string()),
        Some(Value::Bool(true)) => Some("true".to_owned()),
        _ => None,
    }
}

fn enabled(configured: &Value) -> bool {
    configured.get("enabled") == Some(&Value::Bool(true))
}

const UNSAFE_PERMISSIONS: &str = "The private secrets folder has unsafe permissions, so its keys are ignored — run chmod 700 on the folder and chmod 600 on its files, or save the key again.";
const UNSAFE_OWNER: &str = "The private secrets folder or one of its files belongs to another user, so its keys are ignored — change its owner to the current user (chown).";
const UNSAFE_TYPE: &str = "The private secrets folder or one of its files is a symlink or not a regular file, so its keys are ignored — remove it and save the key again.";

fn keychain_hint(state: &str) -> Option<&'static str> {
    match state {
        "unreachable" => Some("The keyring is not reachable — make sure it is running, then press Unlock keyring."),
        "locked" => Some("Keyring is locked — unlock it (log in again or open Passwords and Keys)."),
        "missing" => Some("Install libsecret-tools (sudo apt install libsecret-tools) to use the system keyring."),
        "error" => Some("The system keyring could not be read — check that it is running and unlocked."),
        _ => None,
    }
}

/// `keychainIssueFor(true)`: why stored keys may read as absent, or `None`.
pub fn keychain_issue(world: &dyn SetupWorld) -> Option<Value> {
    keychain_issue_of(world.keychain_status())
}

/// [`keychain_issue`] for a status read on its own (the live overlay of a cached setup).
pub fn keychain_issue_of(status: KeychainStatus) -> Option<Value> {
    if status.fallback {
        // The private file works unless its permissions make reads ignore it.
        let store = status.unsafe_store?;
        let message = match store.kind.as_str() {
            "owner" => UNSAFE_OWNER,
            "type" => UNSAFE_TYPE,
            _ => UNSAFE_PERMISSIONS,
        };
        return Some(json!({ "state": "unsafe-store", "kind": store.kind, "message": message, "path": store.path }));
    }
    keychain_hint(&status.state).map(|message| json!({ "state": status.state, "message": message }))
}

fn stored_secret_detail(world: &dyn SetupWorld, account: &str) -> &'static str {
    if world.is_fallback_secret(account) { "stored in private file" } else { "stored in keychain" }
}

fn vertex_adc_detail(adc: Option<&Value>, location: &str) -> String {
    let Some(adc) = adc else { return format!("gcloud login · {location}") };
    if adc.get("state").and_then(Value::as_str) != Some("ready") {
        return adc.get("message").and_then(Value::as_str).unwrap_or_default().to_owned();
    }
    let account = text(adc.get("account")).unwrap_or_else(|| {
        if adc.get("type").and_then(Value::as_str) == Some("metadata") { "metadata server" } else { "gcloud user login" }.to_owned()
    });
    let project = text(adc.get("projectId")).unwrap_or_else(|| "no project".to_owned());
    [account, project, location.to_owned()].join(" · ")
}

/// The location a row shows and where it comes from.
fn vertex_row_location(world: &dyn SetupWorld, configured: &Value) -> (String, &'static str) {
    if let Some(location) = text(configured.get("location")) {
        return (location, "config");
    }
    match world.vertex_env_location() {
        Some(location) => (location, "environment"),
        None => ("global".to_owned(), "default"),
    }
}

/// `{ ...p, <fields> }`: the provider's own fields first, a redefined one keeping its place.
fn api_row(p: &ApiProvider, fields: Vec<(&'static str, Value)>) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), json!(p.id));
    row.insert("name".into(), json!(p.name));
    row.insert("env".into(), json!(p.env));
    row.insert("url".into(), json!(p.url));
    for (key, value) in fields {
        row.insert(key.into(), value);
    }
    Value::Object(row)
}

fn push_source(fields: &mut Vec<(&'static str, Value)>, source: Option<&str>) {
    if let Some(source) = source {
        fields.push(("credentialSource", json!(source)));
    }
}

fn api_provider_setup(world: &dyn SetupWorld, p: &ApiProvider, providers: &Value, check_secrets: bool, keychain: Option<&Value>) -> Value {
    let null = Value::Null;
    let configured = providers.get(p.id).filter(|value| truthy(Some(value))).unwrap_or(&null);
    let resolved_env = world.resolved_env_name(p.id);
    let declared = declared_env(p.id).or(p.env);
    let env_name = resolved_env.clone().or_else(|| declared.map(str::to_owned));
    let env = resolved_env.is_some() || declared.is_some_and(|name| world.env(name).is_some_and(|value| !value.is_empty()));
    let configured_enabled = enabled(configured);
    let account = format!("agent.{}.apiKey", p.id);
    let stored = check_secrets && world.has_stored_secret(&account);
    let authenticated = env || stored || if check_secrets { world.has_agent_api_key(p.id) } else { configured_enabled };
    let status = if env {
        "Env"
    } else if stored || authenticated {
        "Set"
    } else if configured_enabled {
        "No Key"
    } else {
        "Off"
    };
    let mut credential_source = None;
    let mut detail = env_name.clone().map_or(Value::Null, Value::String);
    if env {
        credential_source = Some("environment");
    } else if stored {
        let kept = stored_secret_detail(world, &account);
        credential_source = Some(if kept == "stored in private file" { "private-file" } else { "keychain" });
        detail = json!(kept);
    } else if authenticated {
        detail = json!("runtime credential");
    }
    let row_issue = if authenticated { None } else { keychain };
    if let Some(issue) = row_issue {
        detail = issue["message"].clone();
    }


    if p.id == "vertex-ai" && configured.get("authMode").and_then(Value::as_str) == Some(VERTEX_ADC_MODE) {
        // gcloud login: nothing is stored; connected while enabled and the login is readable.
        let (location, location_source) = vertex_row_location(world, configured);
        let project = text(configured.get("projectId"));
        let adc = if check_secrets { world.vertex_adc(project.as_deref()) } else { None };
        if adc.as_ref().and_then(|adc| adc.get("state")).and_then(Value::as_str) == Some("missing") {
            world.probe_vertex_metadata();
        }
        let ready = configured_enabled && adc.as_ref().is_none_or(|adc| adc.get("state").and_then(Value::as_str) == Some("ready"));
        let adc_status = if ready {
            "Set"
        } else if configured_enabled {
            "Not connected"
        } else {
            "Off"
        };
        let project_id = adc.as_ref().and_then(|adc| text(adc.get("projectId"))).or(project);
        let mut fields = vec![
            ("group", json!("api")),
            ("type", json!("api-key")),
            ("authKind", json!("adc")),
            ("authMode", json!(VERTEX_ADC_MODE)),
            ("enabled", json!(configured_enabled)),
            ("authenticated", json!(ready)),
            ("stored", json!(false)),
            ("env", json!(false)),
            ("envName", Value::Null),
            ("status", json!(adc_status)),
            ("detail", json!(vertex_adc_detail(adc.as_ref(), &location))),
            ("location", json!(location)),
            ("locationSource", json!(location_source)),
            ("projectId", json!(project_id)),
        ];
        if let Some(adc) = adc {
            fields.push(("adc", adc));
        }
        return api_row(p, fields);
    }

    if p.id == "vertex-ai" {
        let (location, location_source) = vertex_row_location(world, configured);
        // An express-mode API key, or the service-account key.
        let express = configured.get("authMode").and_then(Value::as_str) == Some(VERTEX_API_KEY_MODE);
        let project = text(configured.get("projectId"));
        // The connect form offers the gcloud login too; its status line reads this.
        let adc = if check_secrets && !authenticated { world.vertex_adc(project.as_deref()) } else { None };
        let mut project_id = project.unwrap_or_default();
        if project_id.is_empty() && authenticated && check_secrets && !express {
            project_id = world.vertex_key_project().unwrap_or_default();
        }
        if row_issue.is_none() {
            detail = json!(if express {
                format!("API key (express mode) · {location}")
            } else if !project_id.is_empty() {
                format!("{project_id} · {location}")
            } else {
                format!("Location: {location}")
            });
        }
        let kind = if express { "api-key" } else { "service-account" };
        let mut fields = Vec::new();
        if let Some(issue) = row_issue {
            fields.push(("keychainIssue", issue.clone()));
        }
        fields.extend([("group", json!("api")), ("type", json!("api-key")), ("authKind", json!(kind)), ("authMode", json!(kind))]);
        if let Some(adc) = adc {
            fields.push(("adc", adc));
        }
        fields.extend([
            ("enabled", json!(configured_enabled || authenticated)),
            ("authenticated", json!(authenticated)),
            ("stored", json!(stored)),
            ("env", json!(false)),
            ("envName", Value::Null),
            ("status", json!(status)),
            ("detail", detail),
            ("location", json!(location)),
            ("locationSource", json!(location_source)),
            ("projectId", if project_id.is_empty() { Value::Null } else { json!(project_id) }),
        ]);
        push_source(&mut fields, credential_source);
        return api_row(p, fields);
    }

    let mut fields = Vec::new();
    if let Some(issue) = row_issue {
        fields.push(("keychainIssue", issue.clone()));
    }
    fields.extend([
        ("group", json!("api")),
        ("type", json!("api-key")),
        ("enabled", json!(configured_enabled || authenticated)),
        ("authenticated", json!(authenticated)),
        ("stored", json!(stored)),
        ("env", json!(env)),
        ("envName", env_name.map_or(Value::Null, Value::String)),
        ("status", json!(status)),
        ("detail", detail),
    ]);
    push_source(&mut fields, credential_source);
    api_row(p, fields)
}

/// `oauthProviderSetup`.
fn oauth_provider_setup(world: &dyn SetupWorld, id: &str, name: &str, desc: &str, providers: &Value, check_secrets: bool) -> Value {
    let null = Value::Null;
    let configured = providers.get(id).filter(|value| truthy(Some(value))).unwrap_or(&null);
    let configured_enabled = enabled(configured);
    let auth = if check_secrets {
        world.oauth_describe(id)
    } else {
        json!({
            "authenticated": configured_enabled,
            "status": if configured_enabled { "Enabled" } else { "Not Set" },
            "detail": desc,
        })
    };
    // `oauthAuthFields`
    let authenticated = truthy(auth.get("authenticated"));
    let status = text(auth.get("status")).unwrap_or_else(|| if authenticated { "Set" } else { "Not Set" }.to_owned());
    let detail = text(auth.get("detail")).unwrap_or_else(|| desc.to_owned());
    let usable = auth.get("usable") == Some(&Value::Bool(true))
        || (matches!(auth.get("usable"), None | Some(Value::Null)) && authenticated);
    json!({
        "id": id,
        "name": name,
        "desc": desc,
        "group": "oauth",
        "type": "oauth",
        "enabled": configured_enabled || authenticated,
        "authenticated": authenticated,
        "status": status,
        "detail": detail,
        "expiresAt": if truthy(auth.get("expiresAt")) { auth["expiresAt"].clone() } else { Value::Null },
        "plan": if truthy(auth.get("plan")) { auth["plan"].clone() } else { Value::Null },
        "usable": usable,
        "refreshable": auth.get("refreshable") == Some(&Value::Bool(true)),
        "reauthRequired": auth.get("reauthRequired") == Some(&Value::Bool(true)),
    })
}

/// `builtInLocalProviderSetup`.
fn local_provider_setup(world: &dyn SetupWorld, config: &Value, detect_local: bool) -> Value {
    let provider = config.get("providers").and_then(|providers| providers.get("mixdog-local"));
    let installed = config.pointer("/builtins/localProvider/installed") == Some(&Value::Bool(true));
    let module_off = config.pointer("/modules/localProvider/enabled") == Some(&Value::Bool(false));
    let enabled = provider.is_some_and(enabled) && installed && !module_off;
    let runtime = if detect_local { world.local_status() } else { None };
    let installed_models = runtime
        .as_ref()
        .and_then(|runtime| runtime.get("models"))
        .and_then(Value::as_array)
        .map_or(0, |models| models.iter().filter(|model| model.get("installed") == Some(&Value::Bool(true))).count());
    let detected = runtime.as_ref().and_then(|runtime| runtime.pointer("/runtime/installed")) == Some(&Value::Bool(true)) && installed_models > 0;
    let status = if detected {
        if enabled { "Ready" } else { "Off" }
    } else if installed {
        "No Model"
    } else {
        "Not Installed"
    };
    let detail = if detected {
        format!("{installed_models} installed model{}", if installed_models == 1 { "" } else { "s" })
    } else {
        "Install a recommended model from Built-in".to_owned()
    };
    json!({
        "id": "mixdog-local",
        "name": "Local Provider",
        "desc": "Models managed on this PC by Mixdog",
        "group": "local",
        "type": "local",
        "enabled": enabled,
        "detected": detected,
        "authenticated": detected,
        "usable": detected && enabled,
        "status": status,
        "detail": detail,
    })
}

/// `providerSetup(config, options)` outside the model-proxy client mode.
pub fn provider_setup(world: &dyn SetupWorld, config: &Value, options: SetupOptions) -> Value {
    let empty = Value::Object(Map::new());
    let providers = config.get("providers").filter(|value| truthy(Some(value))).unwrap_or(&empty);
    let keychain = if options.check_secrets { keychain_issue(world) } else { None };
    let mut api: Vec<Value> =
        API_PROVIDERS.iter().map(|p| api_provider_setup(world, p, providers, options.check_secrets, keychain.as_ref())).collect();
    if let Some(entries) = providers.as_object() {
        api.extend(custom_provider_rows(world, entries, options.check_secrets));
    }
    let oauth: Vec<Value> = OAUTH_PROVIDERS
        .iter()
        .filter(|(id, _, _)| world.oauth_available(id))
        .map(|(id, name, desc)| oauth_provider_setup(world, id, name, desc, providers, options.check_secrets))
        .collect();
    let mut out = Map::new();
    if let Some(keychain) = keychain {
        out.insert("keychain".into(), keychain);
    }
    out.insert("api".into(), Value::Array(api));
    out.insert("oauth".into(), Value::Array(oauth));
    out.insert("local".into(), json!([local_provider_setup(world, config, options.detect_local)]));
    Value::Object(out)
}

/// `modelProxyProviderSetup(options)`: an SSH server holds no model credentials, so the setup projects
/// only the availability the PC advertised (`providers`, from its `providerConfig`); account
/// identities and credential management stay on the PC. `None` is no PC connected (the read gave up
/// after its second): the setup says so and lists nothing.
pub fn model_proxy_provider_setup(providers: Option<&Map<String, Value>>) -> Value {
    let Some(providers) = providers else {
        return json!({ "managedByClient": true, "unavailable": true, "api": [], "oauth": [], "local": [] });
    };
    let project = |definitions: &[(String, String)], group: &str, kind: &str| -> Vec<Value> {
        definitions
            .iter()
            .filter(|(id, _)| providers.contains_key(id.as_str()))
            .map(|(id, name)| {
                let entry = &providers[id.as_str()];
                let enabled = entry.get("enabled") == Some(&Value::Bool(true));
                let auth_state = entry.get("authState").filter(|state| !state.is_null());
                let state = auth_state.and_then(Value::as_str);
                // Older desktops advertise only `enabled`; new ones tell a missing credential from a
                // transiently unreadable, preserved adapter.
                let authenticated = if auth_state.is_none() { enabled } else { state == Some("present") };
                let usable = enabled && state != Some("absent");
                let mut status = if usable { "Connected" } else { "Not connected" };
                if enabled && state == Some("unreadable") {
                    status = "Checking…";
                } else if !enabled && state == Some("present") {
                    // Signed in but switched off on the desktop.
                    status = "Off";
                }
                let mut row = Map::new();
                row.insert("id".into(), json!(id));
                row.insert("name".into(), json!(name));
                row.insert("group".into(), json!(group));
                row.insert("type".into(), json!(kind));
                row.insert("enabled".into(), json!(enabled));
                row.insert("authenticated".into(), json!(authenticated));
                row.insert("usable".into(), json!(usable));
                if group == "local" {
                    row.insert("detected".into(), json!(enabled));
                }
                if kind == "custom" {
                    row.insert("custom".into(), json!(true));
                    row.insert("modelOverrides".into(), hidden_model_overrides(entry));
                }
                row.insert("status".into(), json!(status));
                Value::Object(row)
            })
            .collect()
    };
    let api: Vec<(String, String)> = API_PROVIDERS.iter().map(|p| (p.id.to_owned(), p.name.to_owned())).collect();
    let oauth: Vec<(String, String)> = OAUTH_PROVIDERS.iter().map(|(id, name, _)| ((*id).to_owned(), (*name).to_owned())).collect();
    // Older desktops advertise no name: the id is the fallback.
    let custom: Vec<(String, String)> = providers
        .iter()
        .filter(|(id, entry)| is_custom_id(id) && entry.get("type").and_then(Value::as_str) == Some("custom"))
        .map(|(id, entry)| {
            let name = entry.get("name").and_then(Value::as_str).map(mixdog_js::js_trim).filter(|name| !name.is_empty()).unwrap_or(id);
            (id.clone(), name.to_owned())
        })
        .collect();
    let mut api_rows = project(&api, "api", "api-key");
    api_rows.extend(project(&custom, "api", "custom"));
    json!({
        "managedByClient": true,
        "api": api_rows,
        "oauth": project(&oauth, "oauth", "oauth"),
        "local": project(&[("mixdog-local".to_owned(), "Local Provider".to_owned())], "local", "local"),
    })
}

/// `hiddenModelOverrides(entry)`: the desktop's hidden custom models, in the override shape pickers read.
fn hidden_model_overrides(entry: &Value) -> Value {
    let mut hidden = Map::new();
    for id in entry.get("hiddenModels").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        hidden.insert(id.to_owned(), json!({ "hidden": true }));
    }
    // A JavaScript object lists integer-like keys first, ascending.
    let ordered: Map<String, Value> = mixdog_js::js_object_keys(&hidden).into_iter().map(|key| (key.clone(), hidden[key].clone())).collect();
    Value::Object(ordered)
}
