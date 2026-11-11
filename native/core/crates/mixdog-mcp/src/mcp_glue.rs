//! The process side of MCP management (Node `session-runtime/mcp-glue/*`, the connect half of
//! `resource-extension-sync.mjs` and `resource-mcp-oauth-api.mjs`): resolving the effective server
//! set, connecting it on the [`McpHub`], the status rows, the sign-in flows over the hub's
//! sign-ins, and the [`ExtensionHost`] operations. [`McpGlue`] is the [`McpRuntime`] of the
//! [`McpService`](crate::mcp_service::McpService), [`GlueHost`] its [`ExtensionHost`] and
//! [`GlueSecretOps`] its [`SecretOps`].
//!
//! The in-process runtime is single: every session shares the one hub, so Node's fan-out to
//! "the other session runtimes of this process" has no receiver and only the surface refresh and
//! the cross-process announcement remain. The management operations below act on the hub's
//! default scope; a session's own scope (Node's `rt.mcpScopeId`) is a key into the same hub that
//! [`McpScopes`] opens and releases.
//!
//! The accounts of a catalog connector connect as one hub server each, named by the account;
//! Node's single connector server that merges their tools behind an `account` argument is not
//! ported, so the connector's status row is built from its account servers.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::config::Env;
use crate::config::McpServerConfig;
use crate::config::TransportKind;
use crate::config::normalize_url;
use crate::config::expand_env;
use crate::config::transport_kind;
use crate::connector_accounts::AccountHealth;
use crate::connector_accounts::Health;
use crate::connector_accounts::in_use_account;
use crate::connector_model::account_enabled;
use crate::connector_model::account_server;
use crate::connector_model::account_servers;
use crate::connector_model::account_target;
use crate::connector_model::accounts_of;
use crate::connector_model::connector_of_server;
use crate::connector_model::gmail_app_password_account;
use crate::connector_model::live_account_servers;
use crate::connector_model::server_settings;
use crate::connectors::google_client;
use crate::declaration_cache::DeclarationCache;
use crate::extension_service::ExtensionConfig;
use crate::extension_service::ExtensionHost;
use crate::hub::McpHub;
use crate::hub::ScopeReleased;
use crate::mcp_logins::LoginBackend;
use crate::mcp_logins::McpLogins;
use crate::mcp_logins::Started;
use crate::mcp_secrets::GmailVerifier;
use crate::mcp_secrets::KeychainOps;
use crate::mcp_secrets::SecretOps;
use crate::mcp_secrets::oauth_credential_of;
use crate::mcp_service::McpRuntime;
use crate::mcp_service::OAuthState;
use crate::mcp_service::has_configured_auth;
use crate::oauth::AccountMode;
use crate::oauth::McpOAuth;
use crate::oauth::OAuthEnv;
use crate::oauth::protocol::Protocol;
use crate::oauth::protocol::parse_challenge;
use crate::plugin_admin::PluginAdmin;
use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;
use crate::plugin_servers::Catalog;
use crate::plugin_servers::declarations_of;
use crate::plugin_servers::resolve_mcp_server_catalog;
use crate::scope_runtime::Op;
use crate::scope_runtime::Resolved;
use crate::scope_runtime::ScopeConfigs;
use crate::scope_runtime::ScopeRuntime;
use crate::scope_runtime::request_scope;
use crate::server::McpServer;
use crate::server::ServerState;
use crate::skill_catalog::SkillCatalog;
use crate::skills_service::SkillsService;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const INITIALIZE_PROBE: &str = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"mixdog-auth-probe","version":"1"}}}"#;

/// What the session layer answers the MCP side (Node's `getCurrentCwd`, `invalidatePreSessionToolSurface`,
/// `getTools`, `openInBrowser`, `announceStoredStateChange('plugins')`, `flushSkillsSave`).
#[async_trait]
pub trait McpSurface: Send + Sync {
    /// The folder the caller's session works in.
    async fn current_cwd(&self, thread: Option<&str>) -> Result<PathBuf, String>;
    /// The MCP scope the thread's session holds: the `mcpScopeId` of its stored header, which a spawned
    /// child takes from the session that spawned it (`spawn-plan.mjs:108`) and a session takes from its
    /// own seed. `Ok(None)`: no such thread, or it holds none; an `Err` read never ran.
    async fn thread_scope(&self, thread: &str) -> Result<Option<String>, String>;
    /// Rebuilds what new sessions see of the tool surface.
    async fn refresh_surface(&self);
    /// The names of the tools the session offers; a surface that cannot be read is the error.
    async fn tool_names(&self) -> Result<Vec<String>, String>;
    /// Opens the authorization URL in the host browser.
    fn open_browser(&self, url: &str);
    /// Tells the other processes the plugin registry changed.
    fn announce_plugins(&self);
    /// Writes the debounced skill-state save now.
    async fn flush_skills_save(&self);
}

/// Everything the glue is built from.
pub struct GlueInputs {
    pub hub: Arc<McpHub>,
    pub config: Arc<dyn ExtensionConfig>,
    pub admin: Arc<PluginAdmin>,
    pub declarations: Arc<DeclarationCache>,
    pub maintenance: MaintenanceIo,
    /// Where sign-ins are stored; the hub signs its servers in with it.
    pub oauth_env: OAuthEnv,
    pub env: Env,
    pub surface: Arc<dyn McpSurface>,
    pub health: Arc<AccountHealth>,
    /// Where the sign-in flows publish their `login:<flowId>` feeds.
    pub login_feeds: Arc<mixdog_core_api::feed_publisher::LoginFeeds>,
}

/// The name Node gives a connect failure that names no server (connect.mjs:124).
pub const GENERIC_FAILURE: &str = "mcp";

/// A server that did not connect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub msg: String,
    pub auth_required: bool,
}

/// A connected server, as the status rows list it.
#[derive(Clone, Debug)]
pub struct LiveServer {
    pub tools: Vec<(String, String)>,
    pub capabilities: Value,
}

/// The owner of the runtime's own scope: the daemon, which closes it by exiting.

pub struct McpGlue {
    hub: Arc<McpHub>,
    config: Arc<dyn ExtensionConfig>,
    admin: Arc<PluginAdmin>,
    declarations: Arc<DeclarationCache>,
    maintenance: MaintenanceIo,
    oauth_env: OAuthEnv,
    env: Env,
    surface: Arc<dyn McpSurface>,
    health: Arc<AccountHealth>,
    logins: McpLogins,
    oauths: Mutex<HashMap<String, Arc<McpOAuth>>>,
    /// The plugin servers of the last catalog (`SecretOps::configured_servers` is synchronous).
    plugin_servers: Mutex<Map<String, Value>>,
    /// One chain per server for its toggles (`mcpToggleChains`, `resource-extension-sync.mjs:56`).
    toggle_chains: Mutex<HashMap<String, ToggleChain>>,
    /// The scopes' connection lifecycle (serialization, generations, readiness, ownership).
    scopes: Arc<ScopeRuntime>,
}

/// The MCP scope of a session as the session layer opens and releases it. Node creates the
/// scope id at boot (`rt.mcpScopeId = randomUUID()`, `boot/begin.mjs:24`), connects the
/// effective servers under it (`connectMcpServers(servers, { scopeId })`, `mcp-glue/connect.mjs:18,120`)
/// and disconnects them when the runtime closes (`disconnectAll({ scopeId })`,
/// `lifecycle/teardown/runtime-stops.mjs:24`).
#[async_trait]
pub trait McpScopes: Send + Sync {
    /// Opens `scope`, which `owner` holds, for the servers configured for `cwd`, and returns once
    /// the scope's first connect settled (a second opener waits for the first's). `Err`: the scope
    /// or the owner was released, so nothing is opened.
    async fn open(&self, scope: &str, owner: &str, cwd: &Path) -> Result<(), ScopeReleased>;
    /// Releases every scope `owner` holds, exactly once: its servers close. Not awaited.
    fn release(&self, owner: &str);
    /// The runtime scope (the one `rt.mcpScopeId` of the runtime the daemon's own callers act as,
    /// `begin.mjs:24`): opened once, for `cwd`, and returned once its first connect settled. The
    /// pre-session preview reads it, as Node's preview reads its serving runtime's scope
    /// (`tool-surface.mjs:100,109,142`). It is never handed to a session: each session is created with a
    /// scope of its own, as each Node `createSession` boots a runtime of its own.
    async fn open_runtime(&self, cwd: &Path) -> Result<String, ScopeReleased>;
}

/// A server's toggle chain: the state last asked (`desired`) and the run in flight (`running`), which every
/// toggle asked while it runs returns.
struct ToggleChain {
    desired: bool,
    running: Option<futures::future::Shared<futures::future::BoxFuture<'static, Value>>>,
}

/// The chain's run: connects the state last asked until a connect ends with it still asked, then refreshes the
/// surface once; the chain is free again when it ends.
async fn run_toggle_chain(glue: Arc<McpGlue>, name: String) -> Value {
    let desired = |glue: &McpGlue| lock(&glue.toggle_chains).get(&name).map(|chain| chain.desired);
    let status = loop {
        let want = desired(&glue).expect("the chain is registered while it runs");
        let status = glue.connect_configured(Op::Only(name.clone(), want)).await;
        if desired(&glue) == Some(want) {
            break status;
        }
    };
    glue.surface.refresh_surface().await;
    if let Some(chain) = lock(&glue.toggle_chains).get_mut(&name) {
        chain.running = None;
    }
    status
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// `envFlag('MIXDOG_DISABLE_MCP')`.
fn mcp_disabled() -> bool {
    let value = std::env::var("MIXDOG_DISABLE_MCP").unwrap_or_default().to_ascii_lowercase();
    matches!(value.as_str(), "1" | "true" | "yes" | "on")
}

fn empty_catalog() -> Catalog {
    Catalog { servers: Map::new(), sources: Map::new(), entries: Map::new(), plugins: Map::new(), warnings: Vec::new(), adoption: None }
}

struct Bridge(std::sync::Weak<McpGlue>);

impl McpGlue {
    pub fn new(inputs: GlueInputs) -> Arc<Self> {
        inputs.hub.set_oauth_env(inputs.oauth_env.clone());
        Arc::new_cyclic(|me| Self {
            logins: McpLogins::new(Arc::new(Bridge(me.clone())), inputs.login_feeds),
            scopes: ScopeRuntime::new(inputs.hub.clone(), Arc::new(GlueConfigs { glue: me.clone() })),
            hub: inputs.hub,
            config: inputs.config,
            admin: inputs.admin,
            declarations: inputs.declarations,
            maintenance: inputs.maintenance,
            oauth_env: inputs.oauth_env,
            env: inputs.env,
            surface: inputs.surface,
            health: inputs.health,
            oauths: Mutex::default(),
            plugin_servers: Mutex::default(),
            toggle_chains: Mutex::default(),
        })
    }

    pub fn hub(&self) -> &Arc<McpHub> {
        &self.hub
    }

    /// The scopes' connection lifecycle, for a test's watch of its operations.
    #[cfg(feature = "test-support")]
    pub fn scope_runtime(&self) -> &Arc<ScopeRuntime> {
        &self.scopes
    }

    /// Connects the runtime scope, the one scope the daemon's own callers read, and returns once its
    /// first connect settled.
    pub async fn connect_runtime_scope(&self) -> Result<(), String> {
        let cwd = self.surface.current_cwd(None).await?;
        self.scopes.open_runtime(&cwd.to_string_lossy()).await.map(drop).map_err(|error| error.to_string())
    }

    /// Starts [`connect_runtime_scope`](Self::connect_runtime_scope) in the background and does not wait
    /// for it, as Node starts `void boot.connectConfiguredMcp()` while it boots (`boot/tools.mjs:57`); a
    /// failure is logged, as Node's `mcp:failed` profile line. The daemon calls this once at boot.
    pub fn start_runtime_scope(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let glue = Arc::clone(self);
        mixdog_rt::spawn("mcp-runtime-scope", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = glue.connect_runtime_scope().await {
                tracing::warn!(%error, "[mcp] the runtime scope did not connect");
            }
        })
    }

    /// The scope the request being served addresses (`McpRuntime::scope_of_request`, resolved when the
    /// request began), as Node's management calls read the calling runtime's own `getMcpScopeId()`
    /// (`mcp-glue/server-catalog.mjs:150`). `None`: nothing is connected for it, so nothing live is read.
    fn request_scope(&self) -> Option<String> {
        request_scope()
    }

    fn live_server(&self, name: &str) -> Option<Arc<McpServer>> {
        self.hub.server_in(&self.request_scope()?, name)
    }

    fn live_servers(&self) -> Vec<Arc<McpServer>> {
        self.request_scope().map(|scope| self.hub.servers_in(&scope)).unwrap_or_default()
    }

    fn live_oauth(&self, name: &str) -> Option<Arc<McpOAuth>> {
        self.hub.oauth_in(&self.request_scope()?, name)
    }
    /// `collectSkills`'s roots: the global `skills` folder, the skill folders of each enabled
/// registered plugin, and the package's own bundle (`defaults/`, a plugin root outside the
/// registry), in that precedence. An unreadable registry contributes no plugin root, as in Node.
pub fn skill_roots(admin: Arc<PluginAdmin>, builtin_plugin_root: PathBuf) -> crate::skill_catalog::SkillRoots {
    use crate::skills::SkillRoot;
    use crate::skills::SkillSource;
    fn present(lane: &mixdog_rt::InLane<MaintenanceIo>, path: &std::path::Path) -> bool {
        mixdog_statefile::metadata(lane, path).is_ok()
    }
    fn existing(lane: &mixdog_rt::InLane<MaintenanceIo>, root: &std::path::Path) -> Vec<PathBuf> {
        crate::plugins::skills_roots(lane, root).into_iter().filter(|dir| present(lane, dir)).collect()
    }
    Arc::new(move |lane| {
        let mut roots = vec![SkillRoot { dir: admin.data_dir().join("skills"), source: SkillSource::Global, plugin: None }];
        for plugin in admin.list_registered_plugins(lane).unwrap_or_default() {
            if plugin.get("enabled") == Some(&Value::Bool(false)) {
                continue;
            }
            let root = PathBuf::from(clean(&plugin["root"]));
            if root.as_os_str().is_empty() || !present(lane, &root) {
                continue;
            }
            let id = [clean(&plugin["id"]), clean(&plugin["name"])].into_iter().find(|s| !s.is_empty());
            roots.extend(existing(lane, &root).into_iter().map(|dir| SkillRoot { dir, source: SkillSource::Plugin, plugin: id.clone() }));
        }
        roots.extend(existing(lane, &builtin_plugin_root).into_iter().map(|dir| SkillRoot { dir, source: SkillSource::Builtin, plugin: None }));
        roots
    })
}

// ── The effective server set ──────────────────────────────────────────────────────────

    /// `resolveCatalog()`: nothing while MCP is switched off.
    async fn resolve_catalog(&self) -> Catalog {
        if mcp_disabled() { empty_catalog() } else { self.resolve_configured_catalog().await }
    }

    /// `resolveConfiguredCatalog()`: user and plugin servers, disabled included.
    async fn resolve_configured_catalog(&self) -> Catalog {
        let cwd = self.surface.current_cwd(None).await.map(|cwd| cwd.to_string_lossy().into_owned());
        let catalog = self.catalog_at(cwd).await;
        *lock(&self.plugin_servers) =
            catalog.servers.iter().filter(|(name, _)| catalog.sources.get(*name) == Some(&json!("plugin"))).map(|(k, v)| (k.clone(), v.clone())).collect();
        catalog
    }

    /// The configured servers for a working folder (`resolveMcpServerCatalog` at `cwd`).
    async fn catalog_at(&self, cwd: Result<String, String>) -> Catalog {
        let config = Value::Object(self.config.agent());
        let (admin, declarations) = (Arc::clone(&self.admin), Arc::clone(&self.declarations));
        // A working folder that cannot be read is reported as the registry failing to load is: the
        // catalog is empty and says why.
        let ran = match cwd {
            Ok(cwd) => {
                let config = config.clone();
                let job = move |lane: &mixdog_rt::InLane<MaintenanceIo>| {
                    let data = admin.data_dir().to_string_lossy().into_owned();
                    match admin.list_registered_plugins(lane) {
                        Ok(rows) => {
                            let declared = declarations_of(&rows, &|root| declarations.load(lane, root));
                            (resolve_mcp_server_catalog(&config, &declared, &cwd, &data), None)
                        }
                        Err(error) => (resolve_mcp_server_catalog(&config, &[], &cwd, &data), Some(error.0)),
                    }
                };
                match self.maintenance.submit_wait(&CancellationToken::new(), job).await {
                    Ok(handle) => handle.await.map_err(|e| e.to_string()),
                    Err(error) => Err(error.to_string()),
                }
            }
            Err(message) => Err(format!("the working folder could not be read: {message}")),
        };
        let (mut catalog, registry_error) = match ran {
            Ok(done) => done,
            Err(message) => (empty_catalog(), Some(message)),
        };
        if let Some(message) = registry_error {
            catalog.warnings.insert(0, json!({"message": format!("plugin MCP servers unavailable: {message}")}));
        }
        catalog
    }

    /// The hub servers a configured server or an account name stands for.
    fn targets_of(catalog: &Catalog, name: &str) -> Vec<String> {
        if let Some(target) = account_target(&catalog.servers, name) {
            return vec![clean(&target.account["name"])];
        }
        match catalog.servers.get(name) {
            Some(cfg) if !accounts_of(cfg).is_empty() => account_servers(cfg).iter().map(|a| clean(&a["name"])).collect(),
            _ => vec![name.to_owned()],
        }
    }

    /// The connections the catalog asks for, and the servers whose configuration could not be
    /// turned into one.
    fn configs_of(&self, catalog: &Catalog) -> (Vec<McpServerConfig>, HashMap<String, String>) {
        let mut out = Vec::new();
        let mut bad = HashMap::new();
        for (name, cfg) in &catalog.servers {
            let entries: Vec<(String, Value)> = if !accounts_of(cfg).is_empty() {
                let settings = server_settings(cfg);
                let off = cfg.get("enabled") == Some(&Value::Bool(false));
                live_account_servers(cfg)
                    .into_iter()
                    .map(|account| {
                        let mut entry = settings.clone();
                        entry.extend(account.as_object().cloned().unwrap_or_default());
                        entry.insert("enabled".to_owned(), json!(!off));
                        (clean(&account["name"]), Value::Object(entry))
                    })
                    .collect()
            } else {
                vec![(name.clone(), cfg.clone())]
            };
            for (server, entry) in entries {
                match McpServerConfig::from_entry(&server, &entry, &self.env) {
                    Ok(config) => out.push(config),
                    Err(error) => {
                        if entry.get("enabled") != Some(&Value::Bool(false)) {
                            bad.insert(server, error.to_string());
                        }
                    }
                }
            }
        }
        (out, bad)
    }

    /// `connectConfiguredMcp`: every open scope runs `op` behind its own earlier operations, each
    /// resolving its configuration in its own turn (the caller's runtime and Node's fan-out to the
    /// process's other runtimes, `resource-extension-sync.mjs`, alike). With no scope open nothing
    /// connects: the change is configuration only, and the next scope opened reads it. The answer
    /// is the status now.
    async fn connect_configured(&self, op: Op) -> Value {
        for task in self.scopes.fan_out(&op) {
            let _ = task.await;
        }
        self.runtime_scoped(self.status_now()).await
    }

    /// Runs `work` for the scope a read with no request in flight uses: the runtime's own (Node's
    /// `getMcpScopeId()` of the runtime serving the call), never nothing. Inside a request the request's
    /// scope stands.
    async fn runtime_scoped<F: std::future::Future>(&self, work: F) -> F::Output {
        if crate::scope_runtime::in_request() {
            return work.await;
        }
        let scope = match self.scope_of_request(None).await {
            Ok(scope) => scope,
            Err(error) => {
                tracing::warn!(%error, "the runtime's MCP scope is not connected");
                None
            }
        };
        crate::scope_runtime::with_request_scope(scope, work).await
    }
    // ── Sign-in state ─────────────────────────────────────────────────────────────────────

    fn binding_of(&self, cfg: &Value) -> Option<crate::config::OAuthBinding> {
        let name = cfg.get("name").and_then(Value::as_str).unwrap_or("server");
        McpServerConfig::from_entry(name, cfg, &self.env).ok()?.oauth
    }

    /// The sign-in object of the configured server or account `name`.
    fn oauth_for(&self, catalog: &Catalog, name: &str) -> Option<Arc<McpOAuth>> {
        let mut cfg = match account_target(&catalog.servers, name) {
            Some(target) => target.account_cfg.clone(),
            None => catalog.servers.get(name)?.clone(),
        };
        cfg.as_object_mut()?.insert("name".to_owned(), json!(name));
        self.oauth_of(&cfg)
    }

    /// The sign-in object of `cfg`: the live server's own, else one shared by credential key.
    fn oauth_of(&self, cfg: &Value) -> Option<Arc<McpOAuth>> {
        let binding = self.binding_of(cfg)?;
        if let Some(name) = cfg.get("name").and_then(Value::as_str)
            && let Some(live) = self.live_oauth(name)
            && live.binding().credential_key == binding.credential_key
        {
            return Some(live);
        }
        let mut all = lock(&self.oauths);
        if let Some(found) = all.get(&binding.credential_key) {
            return Some(Arc::clone(found));
        }
        let key = binding.credential_key.clone();
        let made = McpOAuth::new(binding, &self.oauth_env).ok()?;
        all.insert(key, Arc::clone(&made));
        Some(made)
    }

    /// `getMcpServerOAuthState(cfg)`.
    async fn oauth_value(&self, cfg: &Value) -> Option<Value> {
        oauth_credential_of(cfg, &self.env)?;
        if has_configured_auth(cfg) {
            return None;
        }
        let oauth = self.oauth_of(cfg)?;
        // A marker read that did not run is not "signed out": report the error, no sign-in state.
        let signed_in = match oauth.has_stored_tokens().await {
            Ok(signed_in) => signed_in,
            Err(_) => return Some(json!({"error": "sign-in state unavailable: the lane did not run the read"})),
        };
        if !signed_in {
            return Some(json!({"signedIn": false}));
        }
        let who = match oauth.stored_identity().await {
            Ok(who) => who,
            Err(_) => return Some(json!({"error": "sign-in state unavailable: the lane did not run the read"})),
        };
        Some(json!({
            "signedIn": true,
            "account": who.as_ref().map(|w| w.account.clone()).unwrap_or_default(),
            "workspace": who.as_ref().map(|w| w.workspace.clone()).unwrap_or_default(),
            "forcedAccountChoice": who.is_some_and(|w| w.forced_choice),
        }))
    }

    // ── Status ────────────────────────────────────────────────────────────────────────────

    /// What the hub says per server name: the connected ones and the failed ones.
    fn hub_view(&self, catalog: &Catalog) -> (HashMap<String, LiveServer>, HashMap<String, Failure>, HashSet<String>) {
        let mut live = HashMap::new();
        let mut failures = HashMap::new();
        let mut account_names = HashSet::new();
        let one = |server: &Arc<crate::server::McpServer>| -> (Option<LiveServer>, Option<Failure>) {
            let oauth_needed = self.live_oauth(server.name()).is_some_and(|o| o.sign_in_required());
            match &*server.state() {
                ServerState::Ready(ready) => {
                    let tools = ready.catalog.entries.iter().map(|e| (e.qualified.clone(), e.description.clone())).collect();
                    (Some(LiveServer { tools, capabilities: ready.capabilities.clone() }), None)
                }
                ServerState::Failed { cause } => (None, Some(Failure { msg: cause.clone(), auth_required: oauth_needed })),
                _ => (None, None),
            }
        };
        for (name, cfg) in &catalog.servers {
            let accounts = account_servers(cfg);
            if accounts.is_empty() {
                if let Some(server) = self.live_server(name) {
                    let (l, f) = one(&server);
                    live.extend(l.map(|l| (name.clone(), l)));
                    failures.extend(f.map(|f| (name.clone(), f)));
                }
                continue;
            }
            let mut merged: Option<LiveServer> = None;
            let mut failed = Vec::new();
            for account in &accounts {
                let account_name = clean(&account["name"]);
                account_names.insert(account_name.clone());
                let Some(server) = self.live_server(&account_name) else { continue };
                let (l, f) = one(&server);
                if let Some(l) = l {
                    let slot = merged.get_or_insert(LiveServer { tools: Vec::new(), capabilities: l.capabilities.clone() });
                    for tool in l.tools {
                        if !slot.tools.iter().any(|t| t.0 == tool.0) {
                            slot.tools.push(tool);
                        }
                    }
                }
                if let Some(f) = f {
                    failures.insert(account_name.clone(), f.clone());
                    failed.push(f);
                }
            }
            if let Some(m) = merged {
                live.insert(name.clone(), m);
            } else if let Some(first) = failed.first() {
                let all_auth = failed.iter().all(|f| f.auth_required);
                failures.insert(name.clone(), Failure { msg: first.msg.clone(), auth_required: all_auth });
            }
        }
        for (name, msg) in self.configs_of(catalog).1.iter() {
            failures.entry(name.clone()).or_insert(Failure { msg: msg.clone(), auth_required: false });
        }
        // A scope whose first connect did not return carries one generic failure named `mcp`
        // (`connect.mjs:121-124`: `[{ name: 'mcp', msg }]`), which the status matches by server name
        // (`server-catalog.mjs:151,159`): an ordinary unconnected server stays `disconnected`, and only a
        // server literally named `mcp` shows `failed`. A reset, reconnect or reconcile that applies clears it.
        record_scope_failure(&mut failures, self.request_scope().and_then(|scope| self.scopes.failure_of(&scope)));
        // Servers the catalog does not name (and that are no connector account): listed as connected.
        for server in self.live_servers() {
            if catalog.servers.contains_key(server.name()) || account_names.contains(server.name()) {
                continue;
            }
            if let (Some(l), _) = one(&server) {
                live.insert(server.name().to_owned(), l);
            }
        }
        (live, failures, account_names)
    }

    async fn status_now(&self) -> Value {
        self.status_with_catalog().await.1
    }

    /// `pluginMcpSummary()` (`server-catalog.mjs`): per plugin id the declaration format and errors and
    /// the status rows of the servers it declares, from the catalog the rows were built over. Read in
    /// the scope the request addresses, as [`status_now`](Self::status_now) is.
    async fn plugin_mcp_summary(&self) -> Value {
        let (catalog, status) = self.status_with_catalog().await;
        let rows: HashMap<&str, &Value> = status["servers"].as_array().into_iter().flatten().filter_map(|row| Some((row["name"].as_str()?, row))).collect();
        let plugins = catalog.plugins.iter().map(|(id, plugin)| {
            let servers: Vec<Value> = plugin["servers"].as_array().into_iter().flatten().map(|name| name.as_str().and_then(|name| rows.get(name)).map_or(Value::Null, |row| (*row).clone())).collect();
            (id.clone(), json!({"format": plugin["format"], "errors": plugin["errors"], "servers": servers}))
        });
        Value::Object(plugins.collect())
    }

    /// The MCP status with the catalog its rows were built over.
    async fn status_with_catalog(&self) -> (Catalog, Value) {
        if mcp_disabled() {
            return (
                empty_catalog(),
                json!({
                    "servers": [], "configuredCount": 0, "connectedCount": 0, "failedCount": 0,
                    "googleClient": google_client().is_some(),
                }),
            );
        }
        let catalog = self.resolve_configured_catalog().await;
        let (live, failures, _) = self.hub_view(&catalog);
        let mut oauth: HashMap<String, Value> = HashMap::new();
        let mut in_use: HashMap<String, (String, String)> = HashMap::new();
        for (name, cfg) in &catalog.servers {
            let mut named = cfg.clone();
            if let Some(map) = named.as_object_mut() {
                map.insert("name".to_owned(), json!(name));
            }
            if let Some(state) = self.oauth_value(&named).await {
                oauth.insert(name.clone(), state);
            }
            for account in account_servers(cfg) {
                if let Some(state) = self.oauth_value(&account).await {
                    oauth.insert(clean(&account["name"]), state);
                }
            }
            if !accounts_of(cfg).is_empty()
                && let Some(connector) = connector_of_server(cfg)
            {
                let (dir, id) = (self.admin.data_dir().to_path_buf(), connector.id.to_owned());
                let job = move |lane: &mixdog_rt::InLane<MaintenanceIo>| in_use_account(lane, &dir, &id);
                let read = match self.maintenance.submit_wait(&CancellationToken::new(), job).await {
                    Ok(handle) => handle.await.ok().and_then(Result::ok).flatten(),
                    Err(_) => None,
                };
                if let Some(record) = read {
                    in_use.insert(connector.id.to_owned(), record);
                }
            }
        }
        let health: HashMap<String, Health> = catalog
            .servers
            .values()
            .flat_map(account_servers)
            .filter_map(|a| {
                let name = clean(&a["name"]);
                self.health.get(&name).map(|h| (name, h))
            })
            .collect();
        let pending: HashSet<String> =
            catalog.servers.keys().cloned().chain(live.keys().cloned()).filter(|n| self.logins.is_pending(n)).collect();
        let status = status_value(&StatusInput {
            catalog: &catalog,
            live: &live,
            failures: &failures,
            login_pending: &pending,
            oauth: &oauth,
            health: &health,
            in_use: &in_use,
            google_client: google_client().is_some(),
        });
        (catalog, status)
    }

    fn account_error(&self, catalog: &Catalog, name: &str) -> String {
        let _ = catalog;
        let Some(server) = self.live_server(name) else { return String::new() };
        match &*server.state() {
            ServerState::Failed { cause } => {
                if self.live_oauth(name).is_some_and(|o| o.sign_in_required()) { "Sign-in required".to_owned() } else { cause.clone() }
            }
            _ => String::new(),
        }
    }

    /// `reconnectOne`: the server (or the accounts of the connector) connects again.
    async fn reconnect_one(&self, name: &str) -> (bool, Option<String>) {
        self.connect_configured(Op::Only(name.to_owned(), true)).await;
        let catalog = self.resolve_configured_catalog().await;
        let mut error = None;
        for target in Self::targets_of(&catalog, name) {
            let Some(server) = self.live_server(&target) else { continue };
            match &*server.state() {
                ServerState::Ready(_) => return (true, None),
                ServerState::Failed { cause } => error = error.or(Some(cause.clone())),
                _ => {}
            }
        }
        (false, error)
    }
}

#[async_trait]
impl McpScopes for McpGlue {
    async fn open(&self, scope: &str, owner: &str, cwd: &Path) -> Result<(), ScopeReleased> {
        self.scopes.open(scope, owner, &cwd.to_string_lossy()).await
    }

    fn release(&self, owner: &str) {
        self.scopes.release(owner);
    }

    async fn open_runtime(&self, cwd: &Path) -> Result<String, ScopeReleased> {
        self.scopes.open_runtime(&cwd.to_string_lossy()).await
    }
}

/// The configuration a scope connects: the catalog at the folder the scope works in.
struct GlueConfigs {
    glue: std::sync::Weak<McpGlue>,
}

#[async_trait]
impl ScopeConfigs for GlueConfigs {
    async fn resolve(&self, _scope: &str, cwd: &str, only: Option<&str>) -> Resolved {
        let Some(glue) = self.glue.upgrade() else { return Resolved { configs: Vec::new(), targets: Vec::new() } };
        let catalog = if mcp_disabled() { empty_catalog() } else { glue.catalog_at(Ok(cwd.to_owned())).await };
        let (configs, _) = glue.configs_of(&catalog);
        let targets = only.map(|name| McpGlue::targets_of(&catalog, name)).unwrap_or_default();
        Resolved { configs, targets }
    }
}
#[async_trait]
impl LoginBackend for Bridge {
    async fn start(&self, name: &str, mode: AccountMode, beside: bool) -> Result<Started, String> {
        let glue = self.0.upgrade().ok_or("the MCP runtime is gone")?;
        let catalog = glue.resolve_catalog().await;
        let account = account_target(&catalog.servers, name);
        let cfg = match &account {
            Some(target) => target.account_cfg.clone(),
            None => catalog.servers.get(name).cloned().ok_or_else(|| format!("MCP server not configured: {name}"))?,
        };
        let mut named = cfg.clone();
        if let Some(map) = named.as_object_mut() {
            map.insert("name".to_owned(), json!(name));
        }
        // 연결 / 다시 인증 of a signed-in server: its stored sign-in (refreshed as needed) is tried first.
        let signed_in = glue.oauth_value(&named).await.is_some_and(|s| s["signedIn"] == json!(true));
        if signed_in && mode != AccountMode::Switch {
            let (connected, _) = glue.reconnect_one(name).await;
            if connected && (account.is_none() || glue.account_error(&catalog, name).is_empty()) {
                return Ok(Started::Connected);
            }
        }
        // The server need not be connected: its sign-in is the one its credential key names (Node reads it from the config too).
        let oauth = glue.oauth_of(&named).ok_or_else(|| format!("MCP server \"{name}\" does not use OAuth sign-in"))?;
        let started = if beside || mode == AccountMode::Switch { oauth.login_flow_beside(name, mode).start().await } else { oauth.login_flow(name, mode).start().await };
        match started {
            Ok(session) => Ok(Started::Browser(session)),
            Err(mixdog_core_api::domain::login::LoginError::Failed(LoginFailure::Failed { message, .. })) => Err(message),
            Err(_) => Err("MCP OAuth sign-in could not start".to_owned()),
        }
    }

    async fn settle(&self, name: &str, mode: AccountMode, beside: bool, account: Option<String>) -> (bool, Option<String>) {
        let Some(glue) = self.0.upgrade() else { return (false, Some("the MCP runtime is gone".to_owned())) };
        let catalog = glue.resolve_catalog().await;
        let target = account_target(&catalog.servers, name);
        let transactional = beside || mode == AccountMode::Switch;
        let rollback = || async {
            if transactional && let Some(oauth) = glue.oauth_for(&catalog, name) {
                // No Node step to compare (the transactional switch is Rust's own); a sign-in that is not
                // put back stays the new account, so the failure is logged rather than lost.
                if let Err(error) = oauth.rollback_switch().await {
                    tracing::warn!(server = name, "the previous sign-in was not restored: {error:?}");
                }
            }
        };
        // The same account twice would leave `account` ambiguous.
        if let (Some(target), Some(address)) = (&target, account.as_deref().filter(|a| !a.is_empty())) {
            for other in account_servers(&target.cfg) {
                if clean(&other["name"]) == name {
                    continue;
                }
                let theirs = glue.oauth_value(&other).await.and_then(|s| s["account"].as_str().map(str::to_lowercase)).unwrap_or_default();
                if theirs == address.to_lowercase() {
                    rollback().await;
                    glue.reconnect_one(name).await;
                    return (false, Some(format!("{address} is already connected")));
                }
            }
        }
        let (connected, error) = glue.reconnect_one(name).await;
        let account_error = if target.is_some() { glue.account_error(&catalog, name) } else { String::new() };
        if connected && account_error.is_empty() {
            return (true, None);
        }
        if transactional {
            rollback().await;
            glue.reconnect_one(name).await;
            return (false, Some(if !account_error.is_empty() { account_error } else { error.unwrap_or_else(|| "The new sign-in could not connect".to_owned()) }));
        }
        (false, error)
    }

    fn open_browser(&self, url: &str) {
        if let Some(glue) = self.0.upgrade() {
            glue.surface.open_browser(url);
        }
    }

    async fn completed(&self, _name: &str) {
        if let Some(glue) = self.0.upgrade() {
            glue.surface.refresh_surface().await;
        }
    }
}

// ── The status rows ───────────────────────────────────────────────────────────────────────

pub struct StatusInput<'a> {
    pub catalog: &'a Catalog,
    /// Connected servers by name (a connector by its own name, merged over its accounts).
    pub live: &'a HashMap<String, LiveServer>,
    pub failures: &'a HashMap<String, Failure>,
    pub login_pending: &'a HashSet<String>,
    /// `getMcpServerOAuthState` by server or account name; absent for a server with no OAuth.
    pub oauth: &'a HashMap<String, Value>,
    pub health: &'a HashMap<String, Health>,
    /// The account a connector used last, `(name, id)`, by connector id.
    pub in_use: &'a HashMap<String, (String, String)>,
    pub google_client: bool,
}

fn transport_label(cfg: &Value) -> String {
    if let Some(detect) = cfg.get("autoDetect").filter(|d| truthy(d)) {
        return format!("autoDetect:{}", mixdog_js::value_to_string(detect));
    }
    match transport_kind(cfg) {
        Ok(TransportKind::Stdio) => "stdio",
        Ok(TransportKind::Http) => "http",
        Ok(TransportKind::Sse) => "sse",
        Ok(TransportKind::WebSocket) => "ws",
        Err(_) => "unknown",
    }
    .to_owned()
}

fn server_status(cfg: &Value, live: bool, fail: Option<&Failure>, login_pending: bool) -> &'static str {
    if cfg.get("enabled") == Some(&Value::Bool(false)) {
        "disabled"
    } else if live {
        "connected"
    } else if login_pending || fail.is_some_and(|f| f.auth_required) {
        "sign-in required"
    } else if fail.is_some() {
        "failed"
    } else {
        "disconnected"
    }
}

fn account_row(input: &StatusInput<'_>, account_cfg: &Value, enabled: bool, in_use: bool) -> Value {
    let name = clean(&account_cfg["name"]);
    let address = gmail_app_password_account(account_cfg);
    let oauth = if address.is_empty() { input.oauth.get(&name) } else { None };
    let health = input.health.get(&name).cloned().or_else(|| {
        input.failures.get(&name).map(|f| Health { email: String::new(), error: f.msg.clone(), auth_required: f.auth_required })
    });
    let auth_required = oauth.is_some_and(|o| o["signedIn"] != json!(true)) || health.as_ref().is_some_and(|h| h.auth_required);
    let mut row = Map::new();
    row.insert("name".to_owned(), json!(name));
    if !enabled {
        row.insert("enabled".to_owned(), json!(false));
    }
    if in_use {
        row.insert("inUse".to_owned(), json!(true));
    }
    let who = oauth.and_then(|o| o["account"].as_str()).filter(|a| !a.is_empty()).map(str::to_owned);
    let email = if !address.is_empty() { address.clone() } else { who.or_else(|| health.as_ref().map(|h| h.email.clone())).unwrap_or_default() };
    row.insert("email".to_owned(), json!(email));
    if !address.is_empty() {
        row.insert("appPassword".to_owned(), json!({"account": address}));
    }
    if let Some(oauth) = oauth {
        row.insert("oauth".to_owned(), oauth.clone());
    }
    if account_cfg.get("oauthClientId").and_then(Value::as_str).is_some_and(|s| !mixdog_js::js_trim(s).is_empty()) {
        row.insert("ownClient".to_owned(), json!(true));
    }
    if auth_required {
        row.insert("authRequired".to_owned(), json!(true));
    } else if let Some(error) = health.as_ref().map(|h| h.error.clone()).filter(|e| !e.is_empty()) {
        row.insert("error".to_owned(), json!(error));
    }
    Value::Object(row)
}

/// A scope's recorded connect failure as the failure list Node keeps (`connect.mjs:121-124`): one row named
/// [`GENERIC_FAILURE`], which the status then matches by server name like any other.
pub fn record_scope_failure(failures: &mut HashMap<String, Failure>, recorded: Option<String>) {
    if let Some(msg) = recorded {
        failures.entry(GENERIC_FAILURE.to_owned()).or_insert(Failure { msg, auth_required: false });
    }
}

/// `statusRows` and `mcpStatus` of `server-catalog.mjs`.
pub fn status_value(input: &StatusInput<'_>) -> Value {
    let catalog = input.catalog;
    let mut servers: Vec<Value> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (name, cfg) in &catalog.servers {
        seen.insert(name);
        let live = input.live.get(name);
        let fail = input.failures.get(name);
        let entry = catalog.entries.get(name).cloned().unwrap_or(Value::Null);
        let owner = entry.get("owner").filter(|o| !o.is_null());
        let pending = live.is_none() && input.login_pending.contains(name);
        let stored = if owner.is_some() { Vec::new() } else { accounts_of(cfg) };
        let connector = if owner.is_some() { None } else { connector_of_server(cfg) };
        let record = if stored.is_empty() { None } else { connector.and_then(|c| input.in_use.get(c.id)) };
        let recorded = record.and_then(|(rname, rid)| {
            stored.iter().find(|a| clean(&a["name"]) == *rname && !rid.is_empty() && a.get("id").and_then(Value::as_str) == Some(rid.as_str())).map(|a| clean(&a["name"]))
        });
        let in_use = if record.is_some() { recorded } else { stored.iter().find(|a| account_enabled(a)).map(|a| clean(&a["name"])) };
        let accounts: Vec<Value> = stored
            .iter()
            .map(|a| account_row(input, &account_server(cfg, a), account_enabled(a), in_use.as_deref() == Some(clean(&a["name"]).as_str())))
            .collect();
        let accounts_sign_in = !accounts.is_empty() && accounts.iter().all(|a| a["authRequired"] == json!(true));
        let fail_sign_in = fail.map(|f| Failure { msg: f.msg.clone(), auth_required: f.auth_required || accounts_sign_in });
        let status = server_status(cfg, live.is_some(), fail_sign_in.as_ref(), pending);
        let auth_required = status == "sign-in required";
        let mut row = Map::new();
        row.insert("name".to_owned(), json!(name));
        row.insert("configured".to_owned(), json!(true));
        row.insert("enabled".to_owned(), json!(cfg.get("enabled") != Some(&Value::Bool(false))));
        row.insert("connected".to_owned(), json!(live.is_some()));
        row.insert("status".to_owned(), json!(status));
        row.insert("transport".to_owned(), json!(transport_label(cfg)));
        row.insert("toolCount".to_owned(), json!(live.map_or(0, |l| l.tools.len())));
        row.insert(
            "tools".to_owned(),
            Value::Array(live.map(|l| l.tools.iter().map(|(n, d)| json!({"name": n, "description": d})).collect()).unwrap_or_default()),
        );
        let caps = live.map(|l| &l.capabilities);
        let cap = |key: &str| caps.and_then(|c| c.get(key)).is_some_and(truthy);
        row.insert("capabilities".to_owned(), json!({"tools": cap("tools"), "prompts": cap("prompts"), "resources": cap("resources")}));
        row.insert("error".to_owned(), if auth_required { Value::Null } else { fail.map_or(Value::Null, |f| json!(f.msg)) });
        row.insert("warnings".to_owned(), entry.get("warnings").cloned().unwrap_or(json!([])));
        row.insert("source".to_owned(), catalog.sources.get(name).cloned().unwrap_or(json!("config")));
        if auth_required {
            row.insert("authRequired".to_owned(), json!(true));
        }
        if let Some(connector) = connector {
            row.insert("connector".to_owned(), json!(connector.id));
        }
        let oauth = input.oauth.get(name);
        if let Some(oauth) = oauth {
            let mut state = oauth.clone();
            if auth_required && let Some(f) = fail {
                state["lastError"] = json!(f.msg);
            }
            row.insert("oauth".to_owned(), state);
        }
        let address = gmail_app_password_account(cfg);
        if !address.is_empty() {
            row.insert("appPassword".to_owned(), json!({"account": address}));
        }
        if connector.is_some() && cfg.get("oauthClientId").and_then(Value::as_str).is_some_and(|s| !mixdog_js::js_trim(s).is_empty()) {
            row.insert("ownClient".to_owned(), json!(true));
        }
        if !accounts.is_empty() {
            if accounts.iter().any(|a| a["ownClient"] == json!(true)) {
                row.insert("ownClient".to_owned(), json!(true));
            }
            if accounts.len() == 1 {
                if let Some(o) = accounts[0].get("oauth") {
                    row.insert("oauth".to_owned(), o.clone());
                }
                if let Some(p) = accounts[0].get("appPassword") {
                    row.insert("appPassword".to_owned(), p.clone());
                }
            }
            row.insert("accounts".to_owned(), Value::Array(accounts));
        }
        if let Some(owner) = owner {
            row.insert("owner".to_owned(), owner.clone());
            row.insert("pluginEnabled".to_owned(), entry["pluginEnabled"].clone());
            row.insert("serverEnabled".to_owned(), entry["serverEnabled"].clone());
            if entry["pluginEnabled"] != json!(true) {
                row.insert("disabledReason".to_owned(), json!("plugin disabled"));
            } else if entry["serverEnabled"] != json!(true) {
                row.insert("disabledReason".to_owned(), json!("server disabled"));
            }
        }
        servers.push(Value::Object(row));
    }
    for (name, live) in input.live {
        if seen.contains(name.as_str()) {
            continue;
        }
        servers.push(json!({
            "name": name, "connected": true, "warnings": [], "toolCount": live.tools.len(),
            "tools": live.tools.iter().map(|(n, d)| json!({"name": n, "description": d})).collect::<Vec<_>>(),
            "capabilities": {
                "tools": live.capabilities.get("tools").is_some_and(truthy),
                "prompts": live.capabilities.get("prompts").is_some_and(truthy),
                "resources": live.capabilities.get("resources").is_some_and(truthy),
            },
            "configured": false, "status": "connected",
        }));
    }
    servers.sort_by(|a, b| mixdog_js::locale_compare(a["name"].as_str().unwrap_or_default(), b["name"].as_str().unwrap_or_default()));
    let declaration_errors: Vec<Value> = catalog
        .plugins
        .values()
        .flat_map(|plugin| {
            plugin["errors"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|error| {
                    let mut row = Map::new();
                    row.insert("plugin".to_owned(), plugin["id"].clone());
                    row.extend(error.as_object().cloned().unwrap_or_default());
                    Value::Object(row)
                })
                .collect::<Vec<_>>()
        })
        .collect();
    json!({
        "servers": servers,
        "configuredCount": catalog.servers.len(),
        "connectedCount": servers.iter().filter(|r| r["connected"] == json!(true)).count(),
        "failedCount": servers.iter().filter(|r| r["status"] == json!("failed")).count(),
        "warnings": catalog.warnings,
        "declarationErrors": declaration_errors,
        "googleClient": input.google_client,
    })
}

// ── McpRuntime ────────────────────────────────────────────────────────────────────────────

fn without_markers(cfg: &Value) -> Map<String, Value> {
    let mut map = cfg.as_object().cloned().unwrap_or_default();
    for key in ["_mixdogStrictEnv", "_mixdogRootsFollowScope", "_mixdogPlugin"] {
        map.shift_remove(key);
    }
    map
}

#[async_trait]
impl McpRuntime for McpGlue {
    /// A thread addresses the scope its header names while that scope is open (a child names its
    /// parent's, so it reads the parent's servers); no thread is a read of the runtime's own scope, the
    /// one connected at boot ([`McpGlue::connect_runtime_scope`]) and started here if the boot has not yet.
    async fn scope_of_request(&self, thread: Option<&str>) -> Result<Option<String>, String> {
        match thread {
            Some(thread) => Ok(self.surface.thread_scope(thread).await?.filter(|scope| self.scopes.is_open(scope))),
            // Before the boot's spawn has run, this request starts the connect itself; it never waits for it
            // here. What Node waits for waits on the scope's own barrier: a status read (`mcpStatus()`,
            // `server-catalog.mjs:239`) and a config, sign-in or flow read answer from the state of the
            // moment while `connectConfiguredMcp()` runs in the background (`boot/tools.mjs:56`), and
            // `reconnectMcp`, `setMcpServerEnabled` and the other writes queue behind the in-flight connect
            // (`connect.mjs:70-88`: they run in the scope's fan-out, `ScopeRuntime::fan_out`). A tool call is
            // not this request: it names its session's scope and finds the server absent (`client.mjs:499`).
            None => {
                let cwd = self.surface.current_cwd(None).await?;
                self.scopes.start_runtime(&cwd.to_string_lossy()).map(Some).map_err(|error| format!("the runtime's MCP scope: {error}"))
            }
        }
    }

    async fn catalog(&self) -> Catalog {
        self.resolve_catalog().await
    }

    async fn status(&self) -> Value {
        self.status_now().await
    }

    async fn server_config(&self, name: &str) -> Result<Value, String> {
        let server_name = clean(&json!(name));
        if server_name.is_empty() {
            return Err("MCP server name is required".to_owned());
        }
        let catalog = self.resolve_catalog().await;
        let effective = catalog.servers.get(&server_name).ok_or_else(|| format!("MCP server not configured: {server_name}"))?;
        let enabled = effective.get("enabled") != Some(&Value::Bool(false));
        let owner = if catalog.sources.get(&server_name) == Some(&json!("plugin")) {
            catalog.entries.get(&server_name).and_then(|e| e.get("owner")).filter(|o| !o.is_null()).cloned()
        } else {
            None
        };
        if let Some(owner) = owner {
            let mut config = without_markers(effective);
            config.shift_remove("enabled");
            return Ok(json!({"name": server_name, "source": "plugin", "enabled": enabled, "owner": owner, "readOnly": true, "config": config}));
        }
        let raw = self.config.agent().get("mcpServers").and_then(|s| s.get(&server_name)).filter(|r| r.is_object()).cloned();
        let raw = raw.ok_or_else(|| format!("MCP server config is unavailable: {server_name}"))?;
        Ok(json!({"name": server_name, "source": catalog.sources.get(&server_name).cloned().unwrap_or(Value::Null), "enabled": enabled, "config": raw}))
    }

    async fn plugins_status(&self) -> Value {
        let admin = Arc::clone(&self.admin);
        let ran = match self.maintenance.submit_wait(&CancellationToken::new(), move |lane| admin.status(lane)).await {
            Ok(handle) => handle.await.map_err(|e| e.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match ran {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => json!({"plugins": [], "error": error.0}),
            Err(message) => json!({"plugins": [], "error": message}),
        }
    }

    /// The stored credentials live in the OS store, read per use: there is nothing to warm.
    async fn await_keychain_prewarm(&self) {}

    /// The config is the live actor's: it already carries every edit, this process's and the file's.
    async fn reload_full_config(&self) {}

    async fn oauth_state(&self, cfg: &Value) -> Option<OAuthState> {
        let state = self.oauth_value(cfg).await?;
        Some(OAuthState { signed_in: state["signedIn"] == json!(true), account: state["account"].as_str().unwrap_or_default().to_owned() })
    }

    async fn begin_login(&self, name: &str, options: &Value) -> Result<Value, String> {
        self.logins.begin(name, options).await
    }

    async fn login_status(&self, flow_id: &str, options: &Value) -> Result<Value, String> {
        self.logins.status(flow_id, options).await
    }

    async fn cancel_login(&self, flow_id: &str) -> Result<Value, String> {
        self.logins.cancel(flow_id).await
    }

    async fn complete_login(&self, flow_id: &str, callback_url: &str) -> Result<Value, String> {
        self.logins.complete(flow_id, callback_url).await
    }

    async fn guard_sign_out(&self, name: &str) -> Box<dyn Send> {
        Box::new(self.logins.cancel_server(name).await)
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        self.runtime_scoped(async {
            let Some(oauth) = self.oauth_of(cfg) else { return Ok(false) };
            oauth.sign_out(true).await.map_err(|e| e.to_string())
        })
        .await
    }

    fn forget_account_health(&self, name: &str) {
        self.health.forget(name);
    }

    async fn probe_auth(&self, probe: &Value) -> Result<Value, String> {
        probe_auth(probe, &self.env).await
    }

    fn tools(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for server in self.live_servers() {
            let ServerState::Ready(ready) = &*server.state() else { continue };
            for entry in &ready.catalog.entries {
                let a = &entry.annotations;
                let mut annotations = Map::new();
                if let Some(v) = &a.title {
                    annotations.insert("title".to_owned(), json!(v));
                }
                for (key, v) in [("readOnlyHint", a.read_only_hint), ("destructiveHint", a.destructive_hint), ("idempotentHint", a.idempotent_hint), ("openWorldHint", a.open_world_hint)] {
                    if let Some(v) = v {
                        annotations.insert(key.to_owned(), json!(v));
                    }
                }
                out.push(json!({
                    "name": entry.qualified, "description": entry.description, "inputSchema": entry.input_schema,
                    "annotations": annotations, "mcpServerName": server.name(), "mcpToolName": entry.tool,
                }));
            }
        }
        out
    }
}

/// `probeMcpServerAuth`: what authentication an HTTP/SSE server needs, decided without
/// credentials and without a browser (one anonymous request, then OAuth discovery on a 401).
async fn probe_auth(probe: &Value, env: &Env) -> Result<Value, String> {
    let kind = probe.get("type").and_then(Value::as_str).unwrap_or_default();
    let raw = probe.get("url").filter(|u| !u.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
    let url = normalize_url(&expand_env(&raw, env, &mut Vec::new()), false).map_err(|e| e.to_string())?;
    if has_configured_auth(probe) {
        return Ok(json!({"auth": "configured"}));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| e.without_url().to_string())?;
    let request = if kind == "http" {
        client
            .post(url.clone())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(INITIALIZE_PROBE)
    } else {
        client.get(url.clone()).header("Accept", "text/event-stream")
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => return Ok(json!({"auth": "unreachable", "error": format!("no answer within {}ms", PROBE_TIMEOUT.as_millis())})),
        Err(error) => return Ok(json!({"auth": "unreachable", "error": error.without_url().to_string()})),
    };
    let status = response.status().as_u16();
    if status == 404 || status >= 500 {
        return Ok(json!({"auth": "unreachable", "error": format!("HTTP {status}")}));
    }
    if status != 401 {
        return Ok(json!({"auth": "none"}));
    }
    let header = response.headers().get("www-authenticate").and_then(|h| h.to_str().ok()).map(str::to_owned);
    let challenge = parse_challenge(header.as_deref());
    let discovery = Protocol::new()?.discover(&url, challenge.resource_metadata_url.as_deref()).await;
    if discovery.authorization_server_metadata.is_some() {
        return Ok(json!({"auth": "oauth"}));
    }
    Ok(json!({"auth": "none", "error": "HTTP 401: the server requires authentication but offers no OAuth sign-in"}))
}

// ── ExtensionHost ─────────────────────────────────────────────────────────────────────────

/// The [`ExtensionHost`] of the process (`resource-extension-sync.mjs`).
pub struct GlueHost {
    glue: Arc<McpGlue>,
    catalog: Arc<SkillCatalog>,
    skills: OnceLock<Arc<SkillsService>>,
}

impl GlueHost {
    pub fn new(glue: Arc<McpGlue>, catalog: Arc<SkillCatalog>) -> Self {
        Self { glue, catalog, skills: OnceLock::new() }
    }

    /// The skills service answers `skills_status`; it is built after the host it uses.
    pub fn bind_skills(&self, skills: Arc<SkillsService>) {
        let _ = self.skills.set(skills);
    }

    async fn apply_changes(&self, changes: &[(String, bool)]) -> Value {
        for (name, enabled) in changes {
            self.glue.connect_configured(Op::Only(name.clone(), *enabled)).await;
        }
        self.glue.connect_configured(Op::Reconcile).await
    }

    async fn do_announce(&self, kind: &str, invalidate: bool) {
        if invalidate {
            self.catalog.invalidate();
        }
        self.glue.surface.refresh_surface().await;
        if kind == "plugins" {
            self.glue.surface.announce_plugins();
        }
    }
}

#[async_trait]
impl ExtensionHost for GlueHost {
    async fn reconcile_plugins_and_announce(&self) {
        self.glue.connect_configured(Op::Reconcile).await;
        self.announce("plugins").await;
    }

    async fn announce(&self, kind: &str) {
        self.do_announce(kind, kind != "mcp").await;
    }

    async fn announce_without_invalidating(&self, kind: &str) {
        self.do_announce(kind, false).await;
    }

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        self.glue.surface.tool_names().await
    }

    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, drop: &[String]) -> Value {
        if only.is_some() || !drop.is_empty() {
            let mut changes: Vec<(String, bool)> = drop.iter().map(|n| (n.clone(), false)).collect();
            if let Some(name) = only {
                changes.push((name.to_owned(), enabled));
            }
            let status = self.apply_changes(&changes).await;
            self.do_announce("mcp", false).await;
            return status;
        }
        self.reconnect_all_mcp_and_announce().await
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        let status = self.glue.connect_configured(Op::Reset).await;
        self.do_announce("mcp", false).await;
        status
    }

    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value {
        use futures::FutureExt;
        // Node's `scheduleMcpToggle` (`resource-extension-sync.mjs:56`): the state asked is recorded and a toggle
        // asked while the server's chain runs returns that run, which connects again only when the state asked
        // changed by the end of a connect.
        let run = {
            let mut chains = lock(&self.glue.toggle_chains);
            let chain = chains.entry(name.to_owned()).or_insert(ToggleChain { desired: enabled, running: None });
            chain.desired = enabled;
            chain.running.get_or_insert_with(|| run_toggle_chain(self.glue.clone(), name.to_owned()).boxed().shared()).clone()
        };
        // A disable would otherwise wait out an explicit sign-in of this server still in flight.
        if !enabled {
            #[cfg(feature = "test-support")]
            self.glue.scopes.cancelling_login(name);
            drop(self.glue.logins.cancel_server(name).await);
        }
        run.await
    }

    /// There is no other runtime in this process to tell.
    async fn publish_mcp_changes(&self, _changes: &[(String, bool)]) {}

    async fn announce_mcp_changes(&self, _changes: &[(String, bool)]) {
        self.do_announce("mcp", false).await;
    }

    async fn connect_configured_mcp(&self, only: &str, enabled: bool) -> Value {
        self.glue.connect_configured(Op::Only(only.to_owned(), enabled)).await
    }

    fn invalidate_skills(&self) {
        self.catalog.invalidate();
    }

    async fn flush_skills_save(&self) {
        self.glue.surface.flush_skills_save().await;
    }

    async fn current_cwd(&self, thread_id: Option<&str>) -> Result<PathBuf, String> {
        self.glue.surface.current_cwd(thread_id).await
    }

    async fn skills_status(&self, thread_id: Option<&str>) -> Value {
        let Some(skills) = self.skills.get() else { return json!({"skills": [], "error": "the skills service is not bound"}) };
        let cwd = match self.glue.surface.current_cwd(thread_id).await {
            Ok(cwd) => cwd,
            Err(error) => return json!({"skills": [], "error": error}),
        };
        match skills.status(&cwd).await {
            Ok(status) => status,
            Err(error) => json!({"skills": [], "error": error}),
        }
    }

    /// Read in the scope the caller's thread addresses: its header's, while open, else none (a session whose
    /// scope was released reads nothing live); no thread is the runtime's scope, once it is connected.
    async fn plugin_mcp_summary(&self, thread_id: Option<&str>) -> Result<Value, String> {
        let scope = self.glue.scope_of_request(thread_id).await?;
        Ok(crate::scope_runtime::with_request_scope(scope, self.glue.plugin_mcp_summary()).await)
    }
}

// ── SecretOps ─────────────────────────────────────────────────────────────────────────────

/// The [`SecretOps`] of the process: the keychain, Gmail's app-password check and the hub's sign-ins.
pub struct GlueSecretOps {
    keychain: KeychainOps,
    glue: Arc<McpGlue>,
}

impl GlueSecretOps {
    pub fn new(store: Arc<dyn mixdog_secrets::SecretStore>, verifier: Arc<dyn GmailVerifier>, glue: Arc<McpGlue>) -> Self {
        Self { keychain: KeychainOps { store, verifier }, glue }
    }
}

#[async_trait]
impl SecretOps for GlueSecretOps {
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String> {
        self.keychain.save_gmail(email, password).await
    }

    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String> {
        self.keychain.forget_gmail(email).await
    }

    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        self.keychain.save_client_secret(url, secret).await
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        self.glue.clear_oauth(cfg).await
    }

    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        self.keychain.read_secret(account).await
    }

    async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        self.keychain.write_secret(account, value).await
    }

    fn forget_account_health(&self, name: &str) {
        self.glue.health.forget(name);
    }

    /// The user's servers as the config holds them now, plus the plugin servers of the last catalog.
    fn configured_servers(&self) -> Map<String, Value> {
        let mut servers = self.glue.config.agent().get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default();
        for (name, cfg) in lock(&self.glue.plugin_servers).iter() {
            servers.entry(name.clone()).or_insert_with(|| cfg.clone());
        }
        servers
    }
}
