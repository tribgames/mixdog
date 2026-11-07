//! The MCP server methods of the runtime API (Node `session-runtime/resource-mcp-api.mjs` with
//! `resource-mcp-store.mjs`, `resource-mcp-connector-accounts.mjs` and
//! `resource-mcp-oauth-api.mjs`), served as one [`DomainService`]: add, edit, remove and toggle
//! the user's servers, the accounts of catalog connectors, and sign in and out.
//!
//! The user's `mcpServers` hold one server per catalog connector with its accounts inside
//! (`connector_model`); servers stored in the older one-account form are converted by the
//! one-time data migration, never here. Servers a plugin declares are derived live and are never
//! written into `mcpServers`; ordinary edits refuse them, and their enabled flag is a per-server
//! intent of the plugin.
//!
//! What the process does about a change (connecting, announcing, the sign-in flows and the status
//! rows) is the host's: [`ExtensionHost`] and [`McpRuntime`]; the config is [`ExtensionConfig`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::connector_model::AccountTarget;
use crate::connector_model::account_enabled;
use crate::connector_model::account_entry;
use crate::connector_model::account_server;
use crate::connector_model::account_servers;
use crate::connector_model::account_target;
use crate::connector_model::accounts_of;
use crate::connector_model::accounts_url;
use crate::connector_model::connector_of_server;
use crate::connector_model::connector_server_input;
use crate::connector_model::gmail_app_password_account;
use crate::connector_model::gmail_app_password_server_input;
use crate::connector_model::name_taken_message;
use crate::connector_model::server_settings;
use crate::connector_model::with_account_enabled;
use crate::connectors::connector;
use crate::extension_service::ExtensionConfig;
use crate::extension_service::ExtensionHost;
use crate::extension_service::decorate_mcp;
use crate::extension_service::find_registered_plugin;
use crate::mcp_secrets::McpServerSecrets;
use crate::mcp_secrets::oauth_credential_of;
use crate::mcp_server_input::TIMEOUT_FIELD_GROUPS;
use crate::mcp_server_input::merge_mcp_server_config;
use crate::mcp_server_input::merged_server_input;
use crate::mcp_server_input::normalize_mcp_server_input;
use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;
use crate::plugin_servers::Catalog;
use crate::plugin_servers::with_adopted_copies;
use crate::plugin_servers::with_pinned_collision_names;
use crate::plugin_servers::with_plugin_server_intent;
use crate::scopes::ExtensionScopes;

const METHODS: &[&str] = &[
    "mcp/getMcpServerConfig",
    "mcp/getMcpOAuthLoginStatus",
    "mcp/mcpStatus",
    "mcp/addMcpServer",
    "mcp/saveMcpServer",
    "mcp/removeMcpServer",
    "mcp/setMcpServerEnabled",
    "mcp/reconnectMcp",
    "mcp/beginMcpOAuthLogin",
    "mcp/cancelMcpOAuthLogin",
    "mcp/completeMcpOAuthLogin",
    "mcp/signOutMcpServer",
    "mcp/probeMcpServerAuth",
    "mcp/enablePluginMcp",
    "connector/addConnectorAccount",
    "connector/listConnectorTools",
];

/// The self-plugin surfaces mixdog's own tools through an MCP prefix; they are not connectors.
const SELF_MCP_SERVER: &str = "plugin_mixdog_mixdog";

/// `parseMcpToolName`: `(server, tool)` of an MCP tool definition: its `mcpServerName` and
/// `mcpToolName` metadata win, else the `mcp__<server>__<tool>` form of its name.
fn parse_mcp_tool(tool: &Value) -> Option<(String, String)> {
    static NAMED: std::sync::LazyLock<mixdog_js::JsRegex> =
        std::sync::LazyLock::new(|| mixdog_js::JsRegex::new_static(r"^mcp__(.+?)__(.+)$", ""));
    let from_name = || {
        let name = tool.get("name").filter(|n| !n.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
        NAMED.captures(&name).map(|c| (c.get(1).unwrap_or_default().to_owned(), c.get(2).unwrap_or_default().to_owned()))
    };
    let server = clean(field(tool, "mcpServerName"));
    if server.is_empty() {
        return from_name();
    }
    let tool_name = field(tool, "mcpToolName");
    let named = if truthy(tool_name) { mixdog_js::value_to_string(tool_name) } else { from_name().map(|p| p.1).unwrap_or_default() };
    Some((server, named))
}

/// A server's sign-in state: whether it is signed in and as whom.
pub struct OAuthState {
    pub signed_in: bool,
    pub account: String,
}

/// What the MCP side of the process answers (`mcp-glue` and the MCP client of Node).
#[async_trait]
pub trait McpRuntime: Send + Sync {
    /// `resolveMcpCatalog()`: the servers this runtime would connect, now.
    async fn catalog(&self) -> Catalog;
    ///`mcpStatus()`, undecorated.
    async fn status(&self) -> Value;
    /// `getMcpServerConfig(name)`.
    async fn server_config(&self, name: &str) -> Result<Value, String>;
    /// `pluginsStatus()`.
    async fn plugins_status(&self) -> Value;
    async fn await_keychain_prewarm(&self);
    /// `reloadFullConfig()`.
    async fn reload_full_config(&self);
    /// `getMcpServerOAuthState(cfg)`; `None` for a server that does not use OAuth sign-in.
    async fn oauth_state(&self, cfg: &Value) -> Option<OAuthState>;
    /// The interactive login flows (`mcp-oauth-login.mjs`).
    async fn begin_login(&self, name: &str, options: &Value) -> Result<Value, String>;
    async fn login_status(&self, flow_id: &str, options: &Value) -> Result<Value, String>;
    async fn cancel_login(&self, flow_id: &str) -> Result<Value, String>;
    async fn complete_login(&self, flow_id: &str, callback_url: &str) -> Result<Value, String>;
    /// `oauthLogins.cancelServer(name, work)`: cancels the logins in flight for `name`; the guard
    /// holds off a new one until it is dropped.
    async fn guard_sign_out(&self, name: &str) -> Box<dyn Send>;
    /// `clearMcpServerOAuth(cfg, { revoke: true })`: whether the provider confirmed the revocation.
    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String>;
    /// `forgetConnectorAccountHealth`.
    fn forget_account_health(&self, name: &str);
    /// `probeMcpServerAuth(probe)`.
    async fn probe_auth(&self, probe: &Value) -> Result<Value, String>;
    /// `getMcpTools()`: the MCP tool definitions of this runtime (`name`, `description`,
    /// `annotations`, and `mcpServerName` / `mcpToolName` when it knows them).
    fn tools(&self) -> Vec<Value>;
}

type Failure = String;

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn domain_error(message: String) -> CoreError {
    CoreError::DomainError { domain: "mcp".into(), code: None, message: Some(message.into()), detail: None }
}

/// A server a registered plugin provides.
struct PluginServer {
    owner_id: String,
    owner_key: String,
    plugin_enabled: bool,
    declared_enabled: Option<bool>,
}

fn plugin_server(catalog: &Catalog, name: &str) -> Option<PluginServer> {
    let entry = catalog.entries.get(&clean(&json!(name)))?;
    let owner = entry.get("owner").filter(|o| o.is_object())?;
    Some(PluginServer {
        owner_id: clean(field(owner, "id")),
        owner_key: clean(field(owner, "key")),
        plugin_enabled: truthy(field(entry, "pluginEnabled")),
        declared_enabled: field(entry, "declaredEnabled").as_bool(),
    })
}

fn enabled_flag(cfg: &Value) -> bool {
    cfg.get("enabled") != Some(&Value::Bool(false))
}

fn text(value: &Value) -> String {
    clean(value)
}

pub struct McpService {
    config: Arc<dyn ExtensionConfig>,
    host: Arc<dyn ExtensionHost>,
    runtime: Arc<dyn McpRuntime>,
    secrets: Arc<McpServerSecrets>,
    home: PathBuf,
    /// One account addition of a connector at a time, each reading the servers the one before it
    /// saved: two at once never take the same name, nor does one's save drop the other's account.
    #[allow(clippy::disallowed_types, reason = "held across the awaits of one account addition on purpose: the next addition waits for the save of the one before")]
    adds: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl McpService {
    pub fn new(
        config: Arc<dyn ExtensionConfig>,
        host: Arc<dyn ExtensionHost>,
        runtime: Arc<dyn McpRuntime>,
        secrets: Arc<McpServerSecrets>,
        home: PathBuf,
    ) -> Self {
        Self { config, host, runtime, secrets, home, adds: Mutex::default() }
    }

    fn agent(&self) -> Value {
        Value::Object(self.config.agent())
    }

    async fn save_config(&self, before: &Value, after: Value) -> Result<(), Failure> {
        let before = before.as_object().cloned().unwrap_or_default();
        let after = after.as_object().cloned().unwrap_or_default();
        self.config.save_agent(&before, &after).await
    }

    /// The config with any adoptable plugin server copies already adopted, so every write also
    /// persists the adoption and never re-adds a copy.
    async fn adopted_config(&self) -> Value {
        with_adopted_copies(&self.agent(), self.runtime.catalog().await.adoption.as_ref())
    }

    /// Persists a new `mcpServers` map; project overrides never survive a global edit. A plugin
    /// server pushed off its name by the edit keeps the collision name it gets.
    async fn save_servers(&self, servers: Map<String, Value>) -> Result<(), Failure> {
        let before = self.agent();
        let mut next = self.adopted_config().await.as_object().cloned().unwrap_or_default();
        next.shift_remove("mcpProjectOverrides");
        next.insert("mcpServers".to_owned(), Value::Object(servers));
        self.save_config(&before, Value::Object(next)).await?;
        let saved = self.agent();
        let pinned = with_pinned_collision_names(&saved, &self.runtime.catalog().await);
        if pinned != saved {
            self.save_config(&saved, pinned).await?;
        }
        Ok(())
    }

    /// The user's `mcpServers`, plugin copies adopted.
    async fn user_servers(&self) -> Map<String, Value> {
        self.adopted_config().await.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default()
    }

    /// A name no server, plugin server or account has yet: `base`, else `base-2`…
    async fn free_name(&self, servers: &Map<String, Value>, base: &str) -> String {
        let catalog = self.runtime.catalog().await;
        let taken: Vec<String> = servers
            .iter()
            .flat_map(|(name, cfg)| {
                std::iter::once(name.clone()).chain(accounts_of(cfg).into_iter().map(|a| text(field(&a, "name"))))
            })
            .collect();
        let free = |name: &str| !taken.iter().any(|t| t == name) && plugin_server(&catalog, name).is_none();
        if free(base) {
            return base.to_owned();
        }
        (2..).map(|n| format!("{base}-{n}")).find(|name| free(name)).unwrap_or_default()
    }

    async fn refuse_plugin_server(&self, name: &str) -> Result<(), Failure> {
        if name.is_empty() {
            return Ok(());
        }
        match plugin_server(&self.runtime.catalog().await, name) {
            Some(owner) => Err(format!(
                "MCP server \"{name}\" is provided by plugin \"{}\" (server \"{}\"); enable or disable it with set_mcp_enabled, or manage the plugin instead",
                owner.owner_id, owner.owner_key
            )),
            None => Ok(()),
        }
    }

    fn scopes(&self) -> ExtensionScopes {
        ExtensionScopes::from_config(self.config.agent().get("extensionScopes").unwrap_or(&Value::Null))
    }

    #[allow(clippy::disallowed_types, reason = "the per-connector addition lock is held across awaits on purpose (see `adds`)")]
    fn connector_lock(&self, connector: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut adds = self.adds.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(adds.entry(connector.to_owned()).or_default())
    }

    async fn mcp_status(&self, params: &Value) -> Result<Value, Failure> {
        let cwd = self.host.current_cwd(params.get("threadId").and_then(Value::as_str)).await?;
        Ok(decorate_mcp(&self.runtime.status().await, &self.scopes(), &cwd))
    }

    async fn reconnect_mcp(&self, name: Option<&str>) -> Result<Value, Failure> {
        self.runtime.await_keychain_prewarm().await;
        self.runtime.reload_full_config().await;
        let requested = name.map(|n| clean(&json!(n))).unwrap_or_default();
        // An account reconnects with its server.
        let catalog = self.runtime.catalog().await;
        let server_name = account_target(&catalog.servers, &requested).map_or(requested, |t| t.server_name);
        if server_name.is_empty() {
            return Ok(self.host.reconnect_all_mcp_and_announce().await);
        }
        let config = self.runtime.server_config(&server_name).await?;
        Ok(self.host.reconnect_mcp_and_announce(Some(&server_name), config.get("enabled").and_then(Value::as_bool).unwrap_or(true), &[]).await)
    }

    // ── Adding ────────────────────────────────────────────────────────────────────────────

    async fn add_mcp_server(&self, input: &Value) -> Result<Value, Failure> {
        // A catalog connector's account (as its own server config) joins that connector's one server.
        let connector = text(field(input, "connector"));
        if !connector.is_empty() && !field(input, "accounts").is_array() {
            let lock = self.connector_lock(&connector);
            let _turn = lock.lock().await;
            return self.add_server_now(input).await;
        }
        self.add_server_now(input).await
    }

    /// One more account of catalog connector `input.connector`, connected as its catalog entry
    /// says: `key` for an API-key service, `email` and `appPassword` for Gmail, nothing more for a
    /// sign-in service; the user's own OAuth client rides on `oauthClientId` / `oauthClientSecret`.
    /// The account gets a free name (`notion`, `notion-2`…) and joins the connector's one server,
    /// which is made when there is none. Resolves `{ name, account, status }`.
    async fn add_connector_account(&self, input: &Value) -> Result<Value, Failure> {
        let wanted = text(field(input, "connector"));
        let Some(entry) = connector(&wanted) else { return Err(format!("Unknown connector: {wanted}")) };
        let lock = self.connector_lock(entry.id);
        let _turn = lock.lock().await;
        // Its name is picked from the servers the additions before it saved.
        let name = self.free_name(&self.user_servers().await, entry.id).await;
        let mut account = if entry.app_password_only {
            gmail_app_password_server_input(&name, field(input, "email"), field(input, "appPassword"))?
        } else {
            connector_server_input(entry, &name, field(input, "key"))?
        };
        let own_client = text(field(input, "oauthClientId"));
        if !own_client.is_empty() {
            account["oauthClientId"] = json!(own_client);
            account["oauthClientSecret"] = field(input, "oauthClientSecret").clone();
        }
        self.add_server_now(&account).await
    }

    /// `listConnectorTools`: the tools connector `connector_id` offers, with the server's own
    /// `readOnlyHint` (null when it gives none).
    fn list_connector_tools(&self, connector_id: &str) -> Value {
        let rows: Vec<Value> = self
            .runtime
            .tools()
            .iter()
            .filter_map(|tool| {
                let (server, name) = parse_mcp_tool(tool)?;
                if server == SELF_MCP_SERVER || server != connector_id {
                    return None;
                }
                let annotations = field(tool, "annotations").as_object().cloned().unwrap_or_default();
                let read_only = annotations.get("readOnlyHint").and_then(Value::as_bool);
                let description = field(tool, "description");
                Some(json!({
                    "name": name,
                    "description": if truthy(description) { description.clone() } else { json!("") },
                    "annotations": annotations,
                    "readOnly": read_only,
                }))
            })
            .collect();
        Value::Array(rows)
    }

    async fn add_server_now(&self, input: &Value) -> Result<Value, Failure> {
        let cwd = self.host.current_cwd(None).await?;
        let (name, mut server_config) = normalize_mcp_server_input(input, &cwd, &self.home)?;
        // A catalog connector's server keeps its catalog id.
        let connector_id = text(field(input, "connector"));
        if !connector_id.is_empty() {
            if connector(&connector_id).is_none() {
                return Err(format!("Unknown connector: {connector_id}"));
            }
            server_config["connector"] = json!(connector_id);
        }
        let mut servers = self.user_servers().await;
        if !connector_id.is_empty() && !field(input, "accounts").is_array() {
            return self.join_connector_account(servers, &connector_id, &name, server_config, input).await;
        }
        if servers.contains_key(&name) || account_target(&servers, &name).is_some() {
            return Err(name_taken_message(&servers, &name));
        }
        if let Some(owned) = plugin_server(&self.runtime.catalog().await, &name) {
            return Err(format!("MCP server already exists: {name} (provided by plugin \"{}\")", owned.owner_id));
        }
        self.secrets.store_oauth_client_secret(input, &server_config, &json!({})).await?;
        self.secrets.store_gmail_app_password(input, &server_config, true).await?;
        let enabled = enabled_flag(&server_config);
        servers.insert(name.clone(), server_config);
        self.save_servers(servers).await?;
        let status = self.host.reconnect_mcp_and_announce(Some(&name), enabled, &[]).await;
        Ok(json!({"name": name, "status": status}))
    }

    /// One more account of connector `connector` (one-account config `account_cfg` as normalized
    /// from `input`): into its server, or a new server named `name` holding it. The same Gmail
    /// address again takes the new app password.
    async fn join_connector_account(
        &self,
        mut servers: Map<String, Value>,
        connector_id: &str,
        name: &str,
        account_cfg: Value,
        input: &Value,
    ) -> Result<Value, Failure> {
        let server_name = servers
            .iter()
            .find(|(_, cfg)| connector_of_server(cfg).is_some_and(|c| c.id == connector_id) && !accounts_of(cfg).is_empty())
            .map(|(n, _)| n.clone())
            .unwrap_or_default();
        let address = gmail_app_password_account(&account_cfg);
        let cfg = (!server_name.is_empty()).then(|| servers[&server_name].clone());
        let same = match (&cfg, address.is_empty()) {
            (Some(cfg), false) => accounts_of(cfg).into_iter().find(|account| gmail_app_password_account(&account_server(cfg, account)) == address),
            _ => None,
        };
        if let (Some(same), Some(cfg)) = (&same, &cfg) {
            self.secrets.store_gmail_app_password(input, &account_cfg, true).await?;
            let status = self.host.reconnect_mcp_and_announce(Some(&server_name), enabled_flag(cfg), &[]).await;
            return Ok(json!({"name": server_name, "account": field(same, "name"), "status": status}));
        }
        if server_name.is_empty()
            && (servers.contains_key(name) || plugin_server(&self.runtime.catalog().await, name).is_some() || account_target(&servers, name).is_some())
        {
            return Err(name_taken_message(&servers, name));
        }
        let account_name = if server_name.is_empty() { name.to_owned() } else { self.free_name(&servers, name).await };
        // A fresh identity: a conversation that used a removed account of this name never takes
        // this one for it.
        let mut account = account_entry(&account_name, &account_cfg);
        account["id"] = json!(uuid::Uuid::new_v4().to_string());
        // A sign-in is stored per exact URL: another account signing in at the same URL gets its
        // own key, so the two never share tokens.
        let as_server = account_server(&json!({"connector": connector_id}), &account);
        let env = process_env();
        let sign_in = if has_configured_auth(&as_server) { None } else { oauth_credential_of(&as_server, &env) };
        if let (Some(sign_in), Some(cfg)) = (&sign_in, &cfg)
            && account_servers(cfg).iter().any(|other| oauth_credential_of(other, &env).as_deref() == Some(sign_in.as_str()))
        {
            account["oauthKey"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let stored_cfg = account_server(&json!({"connector": connector_id}), &account);
        let mut target = server_name.clone();
        let attempt: Result<(), Failure> = async {
            self.secrets.store_oauth_client_secret(input, &stored_cfg, &json!({})).await?;
            self.secrets.store_gmail_app_password(input, &stored_cfg, true).await?;
            if let Some(cfg) = &cfg {
                let mut list = accounts_of(cfg);
                list.push(account.clone());
                let mut next = cfg.as_object().cloned().unwrap_or_default();
                next.insert("accounts".to_owned(), Value::Array(list));
                servers.insert(server_name.clone(), Value::Object(next));
            } else {
                // The server's own settings (timeouts, enabled) ride on the input.
                target = name.to_owned();
                let mut next = server_settings(&account_cfg);
                next.insert("type".to_owned(), json!("http"));
                next.insert("url".to_owned(), json!(accounts_url(connector_id)));
                next.insert("connector".to_owned(), json!(connector_id));
                next.insert("accounts".to_owned(), json!([account]));
                servers.insert(name.to_owned(), Value::Object(next));
            }
            self.save_servers(servers.clone()).await
        }
        .await;
        if let Err(error) = attempt {
            // As in Node, a failed rollback is the failure the caller gets.
            self.secrets.forget_stored_secrets(&stored_cfg).await?;
            return Err(error);
        }
        self.runtime.forget_account_health(&account_name);
        let status = self.host.reconnect_mcp_and_announce(Some(&target), enabled_flag(&servers[&target]), &[]).await;
        Ok(json!({"name": target, "account": account_name, "status": status}))
    }

    // ── Editing ───────────────────────────────────────────────────────────────────────────

    /// Whether `input` edits the server `target` belongs to rather than the account: the account
    /// carries the server's name and the input the server's own address.
    fn edits_server_itself(target: &AccountTarget, input: &Value) -> bool {
        if target.server_name != text(field(&target.account, "name")) || text(field(input, "url")).is_empty() {
            return false;
        }
        let env = process_env();
        let kind = if truthy(field(input, "type")) { field(input, "type").clone() } else { json!("http") };
        let probe = json!({"type": kind, "url": field(input, "url")});
        match (oauth_credential_of(&probe, &env), oauth_credential_of(&target.cfg, &env)) {
            (Some(a), Some(b)) => a == b,
            (None, None) => true,
            _ => false,
        }
    }

    async fn save_mcp_server(&self, input: &Value) -> Result<Value, Failure> {
        let mut servers = self.user_servers().await;
        // A name of a multi-account connector's account edits that account.
        let wanted = { let o = text(field(input, "originalName")); if o.is_empty() { text(field(input, "name")) } else { o } };
        if let Some(account_of) = account_target(&servers, &wanted)
            && !Self::edits_server_itself(&account_of, input)
        {
            return self.save_connector_account(servers, account_of, input).await;
        }
        // An explicit originalName must exist; a bare name edits a matching server and otherwise
        // creates a new one. Plugin servers are never edited, renamed or shadowed here.
        let explicit = text(field(input, "originalName"));
        if !explicit.is_empty() && !servers.contains_key(&explicit) {
            self.refuse_plugin_server(&explicit).await?;
            return Err(format!("MCP server not configured: {explicit}"));
        }
        let bare = text(field(input, "name"));
        if explicit.is_empty() && !servers.contains_key(&bare) {
            self.refuse_plugin_server(&bare).await?;
        }
        let original = if !explicit.is_empty() { explicit } else if servers.contains_key(&bare) { bare } else { String::new() };
        let existing = if original.is_empty() { json!({}) } else { servers[&original].clone() };
        let cwd = self.host.current_cwd(None).await?;
        let (normalized_name, normalized_config) =
            normalize_mcp_server_input(&merged_server_input(input, &existing, &original), &cwd, &self.home)?;
        let name = if !original.is_empty() && text(field(input, "name")) == original { original.clone() } else { normalized_name };
        if name != original
            && (servers.contains_key(&name) || plugin_server(&self.runtime.catalog().await, &name).is_some() || account_target(&servers, &name).is_some())
        {
            return Err(name_taken_message(&servers, &name));
        }
        if !original.is_empty() && original != name {
            servers.shift_remove(&original);
        }
        let merged = merge_mcp_server_config(&existing, &normalized_config);
        servers.insert(name.clone(), merged.clone());
        // A failure anywhere before the config is saved leaves the keychain as it was: the saved
        // client id never pairs with a secret of another save (Node left the new secret behind).
        let snapshot = self.secrets.snapshot(input, &merged, &existing).await?;
        let attempt: Result<(), Failure> = async {
            self.secrets.store_oauth_client_secret(input, &merged, &existing).await?;
            self.secrets.store_gmail_app_password(input, &merged, false).await?;
            self.save_servers(servers).await
        }
        .await;
        if let Err(error) = attempt {
            self.secrets.restore(snapshot).await?;
            return Err(error);
        }
        let enabled = enabled_flag(&merged);
        let previous_account = gmail_app_password_account(&existing);
        let account = gmail_app_password_account(&merged);
        if previous_account != account {
            self.secrets.forget_unused_gmail_app_password(&previous_account).await?;
        }
        // Gmail switched from the Google sign-in to an app password keeps no sign-in.
        if !account.is_empty() && previous_account.is_empty() {
            self.secrets.release_oauth(&existing).await?;
        }
        let drop: Vec<String> = if !original.is_empty() && original != name { vec![original.clone()] } else { Vec::new() };
        let status = self.host.reconnect_mcp_and_announce(Some(&name), enabled, &drop).await;
        Ok(json!({"name": name, "source": "config", "status": status}))
    }

    /// An edit of one account: its transport, app password or own client, as an edit of its
    /// one-account server was.
    async fn save_connector_account(&self, mut servers: Map<String, Value>, target: AccountTarget, input: &Value) -> Result<Value, Failure> {
        let AccountTarget { server_name, cfg, account, account_cfg } = target;
        let account_name = text(field(&account, "name"));
        let cwd = self.host.current_cwd(None).await?;
        let mut patch = input.as_object().cloned().unwrap_or_default();
        patch.insert("name".to_owned(), json!(account_name));
        let (_, config) = normalize_mcp_server_input(&merged_server_input(&Value::Object(patch), &account_cfg, &account_name), &cwd, &self.home)?;
        let mut next = merge_mcp_server_config(&account_cfg, &config);
        next["connector"] = field(&cfg, "connector").clone();
        // Settings that are not the account's transport (timeouts) are the server's.
        let server_fields = server_settings(&config);
        let mut server = cfg.as_object().cloned().unwrap_or_default();
        for group in TIMEOUT_FIELD_GROUPS {
            if group.iter().any(|f| server_fields.contains_key(*f)) {
                for f in group {
                    server.shift_remove(*f);
                }
            }
        }
        server.extend(server_fields);
        let accounts: Vec<Value> = accounts_of(&cfg)
            .into_iter()
            .map(|entry| {
                if text(field(&entry, "name")) != account_name {
                    return entry;
                }
                let mut out = account_entry(&account_name, &next).as_object().cloned().unwrap_or_default();
                // An edit keeps the account's identity.
                if truthy(field(&entry, "id")) {
                    out.insert("id".to_owned(), field(&entry, "id").clone());
                }
                if !account_enabled(&entry) {
                    out.insert("enabled".to_owned(), json!(false));
                }
                Value::Object(out)
            })
            .collect();
        server.insert("accounts".to_owned(), Value::Array(accounts));
        servers.insert(server_name.clone(), Value::Object(server));
        // As in `save_mcp_server`: a failed save leaves the keychain as it was.
        let snapshot = self.secrets.snapshot(input, &next, &account_cfg).await?;
        let attempt: Result<(), Failure> = async {
            self.secrets.store_oauth_client_secret(input, &next, &account_cfg).await?;
            self.secrets.store_gmail_app_password(input, &next, false).await?;
            self.save_servers(servers).await
        }
        .await;
        if let Err(error) = attempt {
            self.secrets.restore(snapshot).await?;
            return Err(error);
        }
        self.runtime.forget_account_health(&account_name);
        let previous_address = gmail_app_password_account(&account_cfg);
        let address = gmail_app_password_account(&next);
        if previous_address != address {
            self.secrets.forget_unused_gmail_app_password(&previous_address).await?;
        }
        // An account switched from the Google sign-in to an app password keeps no sign-in.
        if !address.is_empty() && previous_address.is_empty() {
            self.secrets.release_oauth(&account_cfg).await?;
        }
        let status = self.host.reconnect_mcp_and_announce(Some(&server_name), enabled_flag(&cfg), &[]).await;
        Ok(json!({"name": server_name, "account": account_name, "source": "config", "status": status}))
    }

    // ── Removing ──────────────────────────────────────────────────────────────────────────

    async fn remove_mcp_server(&self, name: &str) -> Result<Value, Failure> {
        let server_name = text(&json!(name));
        if server_name.is_empty() {
            return Err("MCP server name is required".to_owned());
        }
        let mut servers = self.user_servers().await;
        // A name of a multi-account connector's account removes that account; the server goes
        // with its last one.
        if let Some(target) = account_target(&servers, &server_name) {
            let rest: Vec<Value> = accounts_of(&target.cfg).into_iter().filter(|e| text(field(e, "name")) != server_name).collect();
            if rest.is_empty() {
                servers.shift_remove(&target.server_name);
            } else {
                let mut next = target.cfg.as_object().cloned().unwrap_or_default();
                next.insert("accounts".to_owned(), Value::Array(rest.clone()));
                servers.insert(target.server_name.clone(), Value::Object(next));
            }
            self.save_servers(servers).await?;
            let status = if rest.is_empty() {
                self.host.reconnect_mcp_and_announce(None, true, std::slice::from_ref(&target.server_name)).await
            } else {
                self.host.reconnect_mcp_and_announce(Some(&target.server_name), enabled_flag(&target.cfg), &[]).await
            };
            let released = self.secrets.release_account(&target.account_cfg).await?;
            return Ok(with_release(status, released.into_iter().collect()));
        }
        if !servers.contains_key(&server_name) {
            self.refuse_plugin_server(&server_name).await?;
            return Err(format!("MCP server not configured: {server_name}"));
        }
        let removed = servers.shift_remove(&server_name).unwrap_or(Value::Null);
        self.save_servers(servers).await?;
        let status = self.host.reconnect_mcp_and_announce(None, true, std::slice::from_ref(&server_name)).await;
        // The server of a multi-account connector takes every account's sign-in with it.
        let account_cfgs = account_servers(&removed);
        if !account_cfgs.is_empty() {
            // `Promise.all`: every release starts at once; the first to fail is the failure
            // returned at once, while the others keep running in their tasks (dropping a join
            // handle detaches its task, it does not cancel it).
            let mut pending: futures::stream::FuturesUnordered<_> = account_cfgs
                .iter()
                .map(|cfg| {
                    let (secrets, cfg) = (Arc::clone(&self.secrets), cfg.clone());
                    tokio::spawn(async move { secrets.release_account(&cfg).await })
                })
                .collect();
            let mut released = Vec::new();
            while let Some(outcome) = futures::StreamExt::next(&mut pending).await {
                released.extend(outcome.map_err(|e| e.to_string())??);
            }
            if released.is_empty() {
                return Ok(status);
            }
            let mut out = status.as_object().cloned().unwrap_or_default();
            out.insert("signIn".to_owned(), json!(if released.iter().all(|r| r.removed) { "removed" } else { "shared" }));
            out.insert("revoked".to_owned(), json!(released.iter().all(|r| r.revoked)));
            return Ok(Value::Object(out));
        }
        // A removed server keeps no sign-in another server does not share: an app password leaves
        // the keychain (it is revoked at Google only).
        let account = gmail_app_password_account(&removed);
        if !account.is_empty() {
            let forgotten = self.secrets.forget_unused_gmail_app_password(&account).await?;
            let mut out = status.as_object().cloned().unwrap_or_default();
            out.insert("signIn".to_owned(), json!(if forgotten { "removed" } else { "shared" }));
            out.insert("revoked".to_owned(), json!(false));
            return Ok(Value::Object(out));
        }
        let released = self.secrets.release_oauth(&removed).await?;
        Ok(with_release(status, released.into_iter().collect()))
    }

    // ── Toggling ──────────────────────────────────────────────────────────────────────────

    async fn set_mcp_server_enabled(&self, name: &str, enabled: &Value) -> Result<Value, Failure> {
        // A name a multi-account connector holds as an account switches that account (and, on, its
        // server) rather than the whole server.
        let requested = text(&json!(name));
        let mut servers = self.user_servers().await;
        let held = account_target(&servers, &requested);
        let server_name = held.as_ref().map_or(requested.clone(), |h| h.server_name.clone());
        if server_name.is_empty() {
            return Err("MCP server name is required".to_owned());
        }
        let want = enabled != &Value::Bool(false);
        let catalog = self.runtime.catalog().await;
        if let Some(owned) = plugin_server(&catalog, &server_name) {
            // Server intent only: the effective state still requires the plugin. Only a choice
            // that differs from the declared default is stored.
            let stored = want == owned.declared_enabled.unwrap_or(true);
            let next = with_plugin_server_intent(&self.adopted_config().await,&owned.owner_id, &owned.owner_key, |mut intent| {
                if stored {
                    intent.shift_remove("enabled");
                } else {
                    intent.insert("enabled".to_owned(), json!(want));
                }
                intent
            });
            let before = self.agent();
            self.save_config(&before, next).await?;
            self.host.flush_skills_save().await;
            let effective = want && owned.plugin_enabled;
            let status = self.host.schedule_mcp_toggle(&server_name, effective).await;
            self.host.publish_mcp_changes(&[(server_name, effective)]).await;
            return Ok(status);
        }
        let known = self.runtime.status().await.get("servers").and_then(Value::as_array).is_some_and(|rows| rows.iter().any(|s| field(s, "name") == &json!(server_name)));
        if !known {
            return Err(format!("MCP server not configured: {server_name}"));
        }
        let current = servers.get(&server_name).filter(|c| c.is_object()).cloned();
        let Some(current) = current else { return Err(format!("MCP server not configured: {server_name}")) };
        if let Some(held) = &held
            && (want || server_name != requested)
        {
            let next = with_account_enabled(&held.cfg, &text(field(&held.account, "name")), want);
            let server_on = enabled_flag(&next);
            servers.insert(held.server_name.clone(), next);
            self.save_servers(servers).await?;
            self.runtime.forget_account_health(&text(field(&held.account, "name")));
            let status = self.host.schedule_mcp_toggle(&held.server_name, server_on).await;
            self.host.publish_mcp_changes(&[(held.server_name.clone(), server_on)]).await;
            return Ok(status);
        }
        let mut next = current.as_object().cloned().unwrap_or_default();
        next.insert("enabled".to_owned(), json!(want));
        servers.insert(server_name.clone(), Value::Object(next));
        self.save_servers(servers).await?;
        let status = self.host.schedule_mcp_toggle(&server_name, want).await;
        self.host.publish_mcp_changes(&[(server_name, want)]).await;
        Ok(status)
    }

    /// Kept for older callers: plugin servers appear on their own once the plugin is registered
    /// and enabled. This clears any per-server "off" intent of the plugin's servers and reconnects
    /// them; a disabled plugin stays disabled.
    async fn enable_plugin_mcp(&self, plugin: &Value) -> Result<Value, Failure> {
        let status = self.runtime.plugins_status().await;
        let registered = find_registered_plugin(&status, plugin).map_err(|m| m)?.cloned().unwrap_or_else(|| plugin.clone());
        let id = text(if truthy(field(&registered, "id")) { field(&registered, "id") } else { field(&registered, "name") });
        let catalog = self.runtime.catalog().await;
        let Some(row) = catalog.plugins.get(&id) else {
            let shown = clean(if truthy(field(plugin, "id")) { field(plugin, "id") } else if truthy(field(plugin, "name")) { field(plugin, "name") } else { plugin });
            return Err(format!("plugin not registered: {}", if shown.is_empty() { id } else { shown }));
        };
        let servers: Vec<String> = field(row, "servers").as_array().map(|l| l.iter().map(text).collect()).unwrap_or_default();
        if servers.is_empty() {
            let detail: Vec<String> = field(row, "errors").as_array().map(|l| l.iter().map(|e| text(field(e, "message"))).collect()).unwrap_or_default();
            let detail = detail.join("; ");
            return Err(format!("plugin declares no MCP servers{}", if detail.is_empty() { String::new() } else { format!(": {detail}") }));
        }
        let mut next = with_adopted_copies(&self.agent(), catalog.adoption.as_ref());
        for name in &servers {
            let entry = catalog.entries.get(name).cloned().unwrap_or(Value::Null);
            let owner_key = text(field(field(&entry, "owner"), "key"));
            let declared_off = field(&entry, "declaredEnabled") == &Value::Bool(false);
            next = with_plugin_server_intent(&next, &id, &owner_key, |mut intent| {
                if declared_off {
                    intent.insert("enabled".to_owned(), json!(true));
                } else {
                    intent.shift_remove("enabled");
                }
                intent
            });
        }
        let before = self.agent();
        self.save_config(&before, next).await?;
        self.host.flush_skills_save().await;
        let row_enabled = truthy(field(row, "enabled"));
        let changes: Vec<(String, bool)> = servers.iter().map(|n| (n.clone(), row_enabled)).collect();
        let mut last = Value::Null;
        for (name, enabled) in &changes {
            last = self.host.connect_configured_mcp(name, *enabled).await;
        }
        self.host.announce_mcp_changes(&changes).await;
        Ok(json!({"serverName": servers[0], "serverNames": servers, "status": last}))
    }

    // ── Sign-in and sign-out ──────────────────────────────────────────────────────────────

    /// The effective config of a server that signs in with MCP OAuth.
    async fn oauth_server_config(&self, name: &str) -> Result<(String, Value), Failure> {
        let server_name = text(&json!(name));
        if server_name.is_empty() {
            return Err("MCP server name is required".to_owned());
        }
        self.runtime.await_keychain_prewarm().await;
        self.runtime.reload_full_config().await;
        let catalog = self.runtime.catalog().await;
        let Some(cfg) = catalog.servers.get(&server_name) else { return Err(format!("MCP server not configured: {server_name}")) };
        if self.runtime.oauth_state(cfg).await.is_none() {
            return Err(format!("MCP server \"{server_name}\" does not use OAuth sign-in"));
        }
        Ok((server_name, cfg.clone()))
    }

    /// The sign-in account `name` addresses on a multi-account connector server (`every`: all of
    /// them, for a sign-out); `None` for any other server.
    async fn sign_in_account(&self, name: &str, every: bool) -> Result<Option<SignIn>, Failure> {
        let wanted = text(&json!(name));
        if wanted.is_empty() {
            return Err("MCP server name is required".to_owned());
        }
        self.runtime.await_keychain_prewarm().await;
        self.runtime.reload_full_config().await;
        let servers = self.runtime.catalog().await.servers;
        if let Some(target) = account_target(&servers, &wanted) {
            if self.runtime.oauth_state(&target.account_cfg).await.is_none() {
                return Err(format!("MCP server \"{wanted}\" does not use OAuth sign-in"));
            }
            let sign_out = vec![target.account_cfg.clone()];
            return Ok(Some(SignIn { server_name: target.server_name, cfg: target.cfg, account: Some(target.account), sign_out }));
        }
        let cfg = servers.get(&wanted).cloned().unwrap_or(Value::Null);
        if accounts_of(&cfg).is_empty() {
            return Ok(None);
        }
        let mut sign_ins: Vec<Value> = Vec::new();
        for account in account_servers(&cfg) {
            if self.runtime.oauth_state(&account).await.is_some() {
                sign_ins.push(account);
            }
        }
        if every && !sign_ins.is_empty() {
            return Ok(Some(SignIn { server_name: wanted, cfg, account: None, sign_out: sign_ins }));
        }
        if sign_ins.len() == 1 {
            let account = accounts_of(&cfg).into_iter().find(|e| field(e, "name") == field(&sign_ins[0], "name"));
            return Ok(Some(SignIn { server_name: wanted, cfg, account, sign_out: sign_ins }));
        }
        Err(if sign_ins.is_empty() {
            format!("MCP server \"{wanted}\" does not use OAuth sign-in")
        } else {
            format!("MCP server \"{wanted}\" has several accounts; name the account to sign in")
        })
    }

    async fn begin_oauth_login(&self, name: &str, options: &Value) -> Result<Value, Failure> {
        let mut options = options.as_object().cloned().unwrap_or_default();
        if let Some(account) = self.sign_in_account(name, false).await? {
            if account.cfg.get("enabled") == Some(&Value::Bool(false)) {
                return Err(format!("MCP server is disabled: {}", account.server_name));
            }
            // Beside the stored sign-in, whatever the mode: the account's server keeps running meanwhile.
            options.insert("beside".to_owned(), json!(true));
            let account_name = account.account.as_ref().map(|a| text(field(a, "name"))).unwrap_or_default();
            return self.runtime.begin_login(&account_name, &Value::Object(options)).await;
        }
        options.shift_remove("beside");
        let (server_name, cfg) = self.oauth_server_config(name).await?;
        if cfg.get("enabled") == Some(&Value::Bool(false)) {
            return Err(format!("MCP server is disabled: {server_name}"));
        }
        // `mode`: `connect`, `reauth` (repair the same connection) or `switch` (change account).
        if options.get("mode") == Some(&json!("switch")) && !self.runtime.oauth_state(&cfg).await.is_some_and(|s| s.signed_in) {
            return Err(format!("MCP server \"{server_name}\" is not signed in"));
        }
        self.runtime.begin_login(&server_name, &Value::Object(options)).await
    }

    /// Forget the server's stored OAuth credentials (shared by every server with the same exact
    /// URL) and reconnect without a login, so it reports sign-in required.
    async fn sign_out_mcp_server(&self, name: &str) -> Result<Value, Failure> {
        if let Some(account) = self.sign_in_account(name, true).await? {
            let account_name = account.account.as_ref().map(|a| text(field(a, "name"))).filter(|n| !n.is_empty()).unwrap_or_else(|| text(&json!(name)));
            let _guard = self.runtime.guard_sign_out(&account_name).await;
            let mut revoked = true;
            for account_cfg in &account.sign_out {
                self.runtime.forget_account_health(&text(field(account_cfg, "name")));
                revoked = self.runtime.clear_oauth(account_cfg).await? && revoked;
            }
            let status = self.host.reconnect_mcp_and_announce(Some(&account.server_name), enabled_flag(&account.cfg), &[]).await;
            return Ok(with_flag(status, "revoked", revoked));
        }
        let (server_name, cfg) = self.oauth_server_config(name).await?;
        let _guard = self.runtime.guard_sign_out(&server_name).await;
        let revoked = self.runtime.clear_oauth(&cfg).await?;
        let status = self.host.reconnect_mcp_and_announce(Some(&server_name), enabled_flag(&cfg), &[]).await;
        Ok(with_flag(status, "revoked", revoked))
    }

    async fn probe_mcp_server_auth(&self, cfg: &Value) -> Result<Value, Failure> {
        if !cfg.is_object() {
            return Err("MCP server config is required".to_owned());
        }
        let mut probe = Map::new();
        for key in ["type", "url", "headers", "bearer_token_env_var", "env_http_headers"] {
            if let Some(value) = cfg.get(key) {
                probe.insert(key.to_owned(), value.clone());
            }
        }
        if !matches!(probe.get("type").and_then(Value::as_str), Some("http" | "sse")) {
            return Err("type must be 'http' or 'sse'".to_owned());
        }
        self.runtime.probe_auth(&Value::Object(probe)).await
    }
}

struct SignIn {
    server_name: String,
    cfg: Value,
    account: Option<Value>,
    sign_out: Vec<Value>,
}

/// `{ ...status, ...released }`.
fn with_release(status: Value, released: Vec<crate::mcp_secrets::Release>) -> Value {
    match released.first() {
        Some(release) => {
            let mut out = status.as_object().cloned().unwrap_or_default();
            out.extend(release.to_value().as_object().cloned().unwrap_or_default());
            Value::Object(out)
        }
        None => status,
    }
}

fn with_flag(status: Value, key: &str, value: bool) -> Value {
    let mut out = status.as_object().cloned().unwrap_or_default();
    out.insert(key.to_owned(), json!(value));
    Value::Object(out)
}

fn process_env() -> crate::config::Env {
    std::env::vars().collect()
}

/// `hasConfiguredMcpAuth(cfg)`: the config carries its own authentication.
pub(crate) fn has_configured_auth(cfg: &Value) -> bool {
    let configured = |key: &str| cfg.get(key).and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let bearer = if truthy(field(cfg, "bearer_token_env_var")) { clean(field(cfg, "bearer_token_env_var")) } else { String::new() };
    !bearer.is_empty() || configured("headers") || configured("env_http_headers") || !accounts_of(cfg).is_empty()
}

#[async_trait]
impl DomainService for McpService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let p = &req.params;
        let value = match req.method.as_str() {
            "mcp/mcpStatus" => self.mcp_status(p).await,
            "mcp/getMcpServerConfig" => self.runtime.server_config(&text(field(p, "name"))).await,
            "mcp/reconnectMcp" => self.reconnect_mcp(p.get("name").and_then(Value::as_str)).await,
            "mcp/addMcpServer" => self.add_mcp_server(field(p, "input")).await,
            "mcp/saveMcpServer" => self.save_mcp_server(field(p, "input")).await,
            "mcp/removeMcpServer" => self.remove_mcp_server(&text(field(p, "name"))).await,
            "mcp/setMcpServerEnabled" => self.set_mcp_server_enabled(&text(field(p, "name")), field(p, "enabled")).await,
            "mcp/enablePluginMcp" => self.enable_plugin_mcp(field(p, "plugin")).await,
            "mcp/beginMcpOAuthLogin" => self.begin_oauth_login(&text(field(p, "name")), field(p, "options")).await,
            "mcp/getMcpOAuthLoginStatus" => self.runtime.login_status(&text(field(p, "flowId")), field(p, "options")).await,
            "mcp/cancelMcpOAuthLogin" => self.runtime.cancel_login(&text(field(p, "flowId"))).await,
            "mcp/completeMcpOAuthLogin" => self.runtime.complete_login(&text(field(p, "flowId")), &text(field(p, "callbackUrl"))).await,
            "mcp/signOutMcpServer" => self.sign_out_mcp_server(&text(field(p, "name"))).await,
            "mcp/probeMcpServerAuth" => self.probe_mcp_server_auth(field(p, "cfg")).await,
            "connector/addConnectorAccount" => self.add_connector_account(field(p, "input")).await,
            "connector/listConnectorTools" => Ok(self.list_connector_tools(&text(field(p, "connectorId")))),
            other => {
                return Err(CoreError::CapabilityUnavailable { capability: other.into(), detail: "not served by the MCP service".into() });
            }
        };
        value.map(Reply::Value).map_err(domain_error)
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
