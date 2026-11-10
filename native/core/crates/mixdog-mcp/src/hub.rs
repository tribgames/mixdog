//! The hub: the set of MCP servers of one daemon. Each server connects, fails and answers
//! calls independently — the hub holds no lock on the call path (an `ArcSwap` snapshot), so a
//! slow or hung server never delays another server's connection or calls.
//!
//! The servers are kept per scope, as Node's registry keeps them under `scopeId`
//! (`mcp/client.mjs:72-118`): a session's scope holds the servers connected for it, and a caller
//! that names no scope is the default one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use arc_swap::ArcSwap;
use arc_swap::ArcSwapOption;
use mixdog_core_api::domain::tool::Tool;
use mixdog_js::js_trim;
use mixdog_rt::TaskClass;
use serde_json::Value;

use crate::config::McpServerConfig;
use crate::connector_accounts::AccountError;
use crate::connector_accounts::Chosen;
use crate::connector_accounts::ChooseCall;
use crate::connector_accounts::ConnectorAccounts;
use crate::connector_accounts::split_mcp_tool_name;
use crate::oauth::AccountMode;
use crate::oauth::McpLoginFlow;
use crate::oauth::McpOAuth;
use crate::oauth::OAuthEnv;
use crate::sign_in_notice::NoticingAuthorizer;
use crate::sign_in_notice::SignInNotices;
use crate::transport::Authorizer;
use crate::result::OutputPolicy;
use crate::result::Spiller;
use crate::server::McpIo;
use crate::server::McpServer;
use crate::server::ServerState;
use crate::server::ToolEntry;
use crate::tools::McpTool;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ServerStatus {
    pub name: String,
    pub state: String,
    pub tool_count: usize,
}

/// `DEFAULT_MCP_SCOPE_ID` (`mcp/client.mjs:72`): the scope of a caller that names none.
pub const DEFAULT_SCOPE: &str = "global";

/// `normalizeMcpScopeId` (`mcp/client.mjs:105-109`): a scope id trimmed; none or empty is the
/// default scope.
pub fn normalize_scope(scope: Option<&str>) -> String {
    match scope.map(js_trim) {
        Some(scope) if !scope.is_empty() => scope.to_owned(),
        _ => DEFAULT_SCOPE.to_owned(),
    }
}

/// The scope was released: nothing connects under it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the MCP scope was released")]
pub struct ScopeReleased;

/// A scope's lifecycle: the generation of its latest full connect and whether it was released.
#[derive(Default)]
struct ScopeLife {
    generation: u64,
    released: bool,
}

/// Closes servers a scope gave up ([`McpHub::retire_scope`]).
pub async fn close_retired(servers: Vec<Arc<McpServer>>) {
    futures::future::join_all(servers.iter().map(|server| server.close())).await;
}

/// The servers of every scope, each scope's in insertion order (Node's `servers` registry,
/// keyed `scope\0name`, `mcpServerRegistryKey`).
type Registry = HashMap<String, Vec<Arc<McpServer>>>;
/// A server's name inside a scope.
type ScopedName = (String, String);

pub struct McpHub {
    /// Each scope's servers in insertion order, as Node's server registry lists them: a server
    /// kept across `apply` holds its place; a new or changed one goes after, in configuration
    /// order. A scope with no server has no entry.
    servers: ArcSwap<Registry>,
    io: McpIo,
    spiller: Spiller,
    policy: OutputPolicy,
    /// Where sign-ins are stored; none: servers needing a sign-in fail with that fact.
    oauth_env: ArcSwapOption<OAuthEnv>,
    /// The sign-in of each server that has one, kept while its server is kept.
    oauth: Mutex<HashMap<ScopedName, Arc<McpOAuth>>>,
    /// Where a server's sign-in problem is shown; none: it is not shown.
    sign_in_notices: Mutex<Option<Arc<dyn SignInNotices>>>,
    /// The accounts of each connector server (by scope and server name), set by the connector
    /// server that answers for them; dropped with the server.
    accounts: ArcSwap<HashMap<ScopedName, Arc<ConnectorAccounts>>>,
    /// Generation and release of the scopes that have had either (a scope with neither has no entry).
    lives: Mutex<HashMap<String, ScopeLife>>,
    /// The id of the process's one runtime scope (`rt.mcpScopeId` of the runtime the daemon's own
    /// callers act as, `boot/begin.mjs:24`): minted once with the hub, never claimed or minted again.
    runtime_scope: String,

}

/// The server a prefixed tool name refers to, and its catalog entry when it lists the tool. A
/// known server without the tool still resolves (no entry) so the call reaches the server.
pub struct ToolTarget {
    pub server: Arc<McpServer>,
    pub entry: Option<Arc<ToolEntry>>,
}

impl McpHub {
    /// `artifact_dir` receives the full text of over-cap results (a directory of the data dir).
    pub fn new(io: McpIo, artifact_dir: PathBuf, policy: OutputPolicy) -> Arc<Self> {
        Arc::new(Self {
            servers: ArcSwap::from_pointee(Registry::new()),
            io,
            spiller: Spiller::new(artifact_dir, io.durability),
            policy,
            oauth_env: ArcSwapOption::empty(),
            oauth: Mutex::new(HashMap::new()),
            sign_in_notices: Mutex::new(None),
            accounts: ArcSwap::from_pointee(HashMap::new()),
            lives: Mutex::new(HashMap::new()),
            runtime_scope: uuid::Uuid::new_v4().to_string(),
        })
    }

    /// The id of the runtime scope. Reads with no session behind them (hooks without a session id,
    /// daemon-internal callers, the pre-session preview) are made in it.
    pub fn runtime_scope(&self) -> &str {
        &self.runtime_scope
    }

    /// The scope the argument-less methods (`server`, `tools`, `apply`, ..) read: `global`, which no
    /// runtime connects to. A runtime's own scope is always named (`*_in`).
    fn default_scope(&self) -> String {
        DEFAULT_SCOPE.to_owned()
    }

    /// Sets the accounts of connector server `server` of the default scope.
    pub fn set_connector_accounts(&self, server: &str, accounts: Arc<ConnectorAccounts>) {
        self.set_connector_accounts_in(&self.default_scope(), server, accounts);
    }

    /// Sets the accounts of connector server `server` of `scope`; `resolve_tool_account_in`
    /// chooses among them.
    pub fn set_connector_accounts_in(&self, scope: &str, server: &str, accounts: Arc<ConnectorAccounts>) {
        let key = (normalize_scope(Some(scope)), server.to_owned());
        self.accounts.rcu(|all| {
            let mut next = HashMap::clone(all);
            next.insert(key.clone(), Arc::clone(&accounts));
            next
        });
    }

    /// The servers of `scope` in insertion order (Node's `scopedServerEntries`).
    fn in_scope(&self, scope: &str) -> Vec<Arc<McpServer>> {
        self.servers.load().get(&normalize_scope(Some(scope))).cloned().unwrap_or_default()
    }

    /// Whether `scope` holds a server (connected or not).
    pub fn has_scope(&self, scope: &str) -> bool {
        self.servers.load().contains_key(&normalize_scope(Some(scope)))
    }

    /// The server and catalog entry a prefixed tool name (`mcp__<server>__<tool>`) refers to
    /// in the default scope.
    pub fn tool_target(&self, name: &str) -> Option<ToolTarget> {
        self.tool_target_in(&self.default_scope(), name)
    }

    /// The server and catalog entry a prefixed tool name (`mcp__<server>__<tool>`) refers to
    /// among the servers of `scope` (`resolveMcpToolTarget(scopeId, name)`). The name's server
    /// part finds it directly; a name shortened to fit provider limits is found by scanning the
    /// servers.
    pub fn tool_target_in(&self, scope: &str, name: &str) -> Option<ToolTarget> {
        let (server_name, _) = split_mcp_tool_name(name)?;
        let direct = self.server_in(scope, &server_name);
        let direct_entry = direct.as_ref().and_then(|s| s.catalog()?.entries.iter().find(|e| e.qualified == name).cloned());
        if let (Some(server), Some(entry)) = (&direct, direct_entry) {
            return Some(ToolTarget { server: Arc::clone(server), entry: Some(entry) });
        }
        if let Some((server, entry)) = self.resolve_in(scope, name) {
            return Some(ToolTarget { server, entry: Some(entry) });
        }
        direct.map(|server| ToolTarget { server, entry: None })
    }

    /// The account (`{ name, label }`: its unique name, which binds a call to it, and what it
    /// is shown as) a call of the prefixed tool `name` with `args` would use on its connector
    /// server, made in `conversation`: the one `args.account` names, else the one used last.
    /// `None` when the tool's server holds no accounts. The refusal (usable accounts listed)
    /// when that account cannot be used.
    pub async fn resolve_tool_account(&self, name: &str, args: &Value, conversation: &str) -> Result<Option<Chosen>, AccountError> {
        self.resolve_tool_account_in(&self.default_scope(), name, args, conversation).await
    }

    /// [`resolve_tool_account`](Self::resolve_tool_account) among the servers of `scope`.
    pub async fn resolve_tool_account_in(&self, scope: &str, name: &str, args: &Value, conversation: &str) -> Result<Option<Chosen>, AccountError> {
        let Some(target) = self.tool_target_in(scope, name) else { return Ok(None) };
        let held = (normalize_scope(Some(scope)), target.server.name().to_owned());
        let Some(accounts) = self.accounts.load().get(&held).cloned() else { return Ok(None) };
        let leaf = match &target.entry {
            Some(entry) => entry.tool.clone(),
            None => split_mcp_tool_name(name).map(|(_, tool)| tool).unwrap_or_default(),
        };
        let wanted = args.get("account").and_then(Value::as_str);
        accounts.choose(&ChooseCall { tool: &leaf, wanted, conversation: js_trim(conversation) }).await.map(Some)
    }

    /// Sets where sign-ins are stored; applies to servers `apply` creates afterwards.
    pub fn set_oauth_env(&self, env: OAuthEnv) {
        self.oauth_env.store(Some(Arc::new(env)));
    }

    /// Sets where the sign-in problems of the servers are shown; applies to servers `apply` creates afterwards.
    pub fn set_sign_in_notices(&self, notices: Arc<dyn SignInNotices>) {
        *self.sign_in_notices.lock().unwrap_or_else(|e| e.into_inner()) = Some(notices);
    }

    /// The sign-in of server `name` of the default scope, if it has one.
    pub fn oauth(&self, name: &str) -> Option<Arc<McpOAuth>> {
        self.oauth_in(&self.default_scope(), name)
    }

    /// The sign-in of server `name` of `scope`, if it has one.
    pub fn oauth_in(&self, scope: &str, name: &str) -> Option<Arc<McpOAuth>> {
        let held = (normalize_scope(Some(scope)), name.to_owned());
        self.oauth.lock().unwrap_or_else(|e| e.into_inner()).get(&held).cloned()
    }

    /// The explicit sign-in flow of server `name`.
    pub fn login_flow(&self, name: &str, mode: AccountMode) -> Option<McpLoginFlow> {
        Some(self.oauth(name)?.login_flow(name, mode))
    }

    /// Reconnects server `name` (after a sign-in), now and in the caller's task.
    pub async fn reconnect(&self, name: &str) -> Result<(), crate::server::ConnectError> {
        match self.server(name) {
            Some(server) => server.reconnect().await,
            None => Ok(()),
        }
    }

    /// Makes the running set equal to `configs`: unchanged servers keep their connection, new
    /// or changed ones start connecting in the background, removed or disabled ones close.
    /// Never waits for a connection.
    pub fn apply(self: &Arc<Self>, configs: Vec<McpServerConfig>) {
        self.apply_in(&self.default_scope(), configs);
    }

    /// [`apply`](Self::apply) for the servers of `scope` (`connectMcpServers(config, { scopeId })`):
    /// the other scopes' servers are untouched.
    pub fn apply_in(self: &Arc<Self>, scope: &str, configs: Vec<McpServerConfig>) {
        self.apply_retrying(scope, configs, &|_| true);
    }

    /// [`apply_in`](Self::apply_in) that connects again only the failed servers `retry` names; the
    /// other failed ones stay as they are (a one-server toggle touches only its own server).
    fn apply_retrying(self: &Arc<Self>, scope: &str, configs: Vec<McpServerConfig>, retry: &dyn Fn(&str) -> bool) {
        let scope = normalize_scope(Some(scope));
        let current = self.in_scope(&scope);
        let mut kept: Vec<String> = Vec::new();
        let mut started = Vec::new();
        let env = self.oauth_env.load_full();
        let mut previous_oauth = self.oauth.lock().unwrap_or_else(|e| e.into_inner());
        let mut next_oauth: HashMap<String, Arc<McpOAuth>> = HashMap::new();
        for config in configs.into_iter().filter(|c| c.enabled) {
            match current.iter().find(|s| s.name() == config.name) {
                // A server whose last connect failed (or whose connection died) is connected again
                // although its configuration is unchanged, as Node's reconcile retries its recorded
                // failures (`server-connection.mjs` `reconcileServers`): a fixed command or a sign-in
                // made elsewhere needs no configuration change.
                Some(existing)
                    if *existing.config() == config
                        && !(matches!(&*existing.state(), ServerState::Failed { .. }) && retry(&config.name)) =>
                {
                    kept.push(config.name.clone());
                    if let Some(kept) = previous_oauth.get(&(scope.clone(), config.name.clone())) {
                        next_oauth.insert(config.name.clone(), Arc::clone(kept));
                    }
                }
                _ => {
                    let oauth = match (&config.oauth, &env) {
                        (Some(binding), Some(env)) => match McpOAuth::new(binding.clone(), env) {
                            Ok(oauth) => Some(oauth),
                            Err(error) => {
                                tracing::warn!(server = config.name, %error, "mcp sign-in unavailable");
                                None
                            }
                        },
                        _ => None,
                    };
                    let notices = self.sign_in_notices.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    let authorizer = oauth.clone().map(|o| match &notices {
                        Some(notices) => Arc::new(NoticingAuthorizer::new(o, &config.name, notices.clone())) as Arc<dyn Authorizer>,
                        None => o as Arc<dyn Authorizer>,
                    });
                    if let Some(oauth) = oauth {
                        next_oauth.insert(config.name.clone(), oauth);
                    }
                    let server = McpServer::new(config.clone(), self.io, self.spiller.clone(), self.policy, authorizer);
                    started.push(server);
                }
            }
        }
        previous_oauth.retain(|held, _| held.0 != scope);
        previous_oauth.extend(next_oauth.into_iter().map(|(name, oauth)| ((scope.clone(), name), oauth)));
        drop(previous_oauth);
        let mut next: Vec<Arc<McpServer>> = current.iter().filter(|s| kept.iter().any(|n| n == s.name())).cloned().collect();
        next.extend(started.iter().cloned());
        let retired: Vec<Arc<McpServer>> = current
            .iter()
            .filter(|old| !next.iter().any(|kept| Arc::ptr_eq(kept, old)))
            .cloned()
            .collect();
        self.accounts.rcu(|all| {
            let mut live = HashMap::clone(all);
            live.retain(|held, _| held.0 != scope || next.iter().any(|s| s.name() == held.1));
            live
        });
        self.servers.rcu(|all| {
            let mut registry = Registry::clone(all);
            if next.is_empty() {
                registry.remove(&scope);
            } else {
                registry.insert(scope.clone(), next.clone());
            }
            registry
        });
        for server in retired {
            mixdog_rt::spawn("mcp.hub.close", TaskClass::Work, async move { server.close().await });
        }
        for server in started {
            mixdog_rt::spawn("mcp.hub.connect", TaskClass::Work, async move {
                if let Err(error) = server.connect().await {
                    tracing::warn!(server = server.name(), %error, "mcp server did not start");
                }
            });
        }
    }

    pub fn server(&self, name: &str) -> Option<Arc<McpServer>> {
        self.server_in(&self.default_scope(), name)
    }

    /// Server `name` of `scope` (`scopedServer`).
    pub fn server_in(&self, scope: &str, name: &str) -> Option<Arc<McpServer>> {
        self.in_scope(scope).into_iter().find(|s| s.name() == name)
    }

    /// The default scope's servers in insertion order.
    pub fn servers(&self) -> Vec<Arc<McpServer>> {
        self.servers_in(&self.default_scope())
    }

    /// The servers of `scope` in insertion order.
    pub fn servers_in(&self, scope: &str) -> Vec<Arc<McpServer>> {
        self.in_scope(scope)
    }

    /// One row per server of the default scope, in insertion order.
    pub fn status(&self) -> Vec<ServerStatus> {
        self.in_scope(&self.default_scope())
            .iter()
            .map(|server| ServerStatus {
                name: server.name().to_owned(),
                state: server.state().describe(),
                tool_count: server.catalog().map_or(0, |c| c.entries.len()),
            })
            .collect()
    }

    /// The tools of every ready server of the default scope.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools_in(&self.default_scope())
    }

    /// The tools of every ready server of `scope` (`getMcpTools(scopeId)`).
    pub fn tools_in(&self, scope: &str) -> Vec<Arc<dyn Tool>> {
        let mut out: Vec<Arc<dyn Tool>> = Vec::new();
        for server in self.in_scope(scope).iter() {
            if let ServerState::Ready(ready) = &*server.state() {
                out.extend(
                    ready
                        .catalog
                        .entries
                        .iter()
                        .map(|entry| Arc::new(McpTool::new(Arc::clone(server), Arc::clone(entry))) as Arc<dyn Tool>),
                );
            }
        }
        out
    }

    /// The tool a qualified name was published for, by a ready server; the policy asks it what
    /// a call does outside the machine (`Tool::outbound_kind`).
    pub fn tool(&self, qualified: &str) -> Option<Arc<dyn Tool>> {
        self.tool_in(&self.default_scope(), qualified)
    }

    /// [`tool`](Self::tool) among the servers of `scope`.
    pub fn tool_in(&self, scope: &str, qualified: &str) -> Option<Arc<dyn Tool>> {
        let (server, entry) = self.resolve_in(scope, qualified)?;
        Some(Arc::new(McpTool::new(server, entry)))
    }

    /// The server and entry a qualified tool name was published for in the default scope.
    pub fn resolve(&self, qualified: &str) -> Option<(Arc<McpServer>, Arc<ToolEntry>)> {
        self.resolve_in(&self.default_scope(), qualified)
    }

    /// The server and entry a qualified tool name was published for in `scope`.
    pub fn resolve_in(&self, scope: &str, qualified: &str) -> Option<(Arc<McpServer>, Arc<ToolEntry>)> {
        self.in_scope(scope).into_iter().find_map(|server| {
            let catalog = server.catalog()?;
            let entry = catalog.entries.iter().find(|e| e.qualified == qualified)?;
            Some((Arc::clone(&server), Arc::clone(entry)))
        })
    }

    /// The scope's current generation: what an operation captures when it is requested
    /// (`currentConnectAbortGeneration`, `mcp/client.mjs:138-140`).
    pub fn generation(&self, scope: &str) -> u64 {
        self.lives.lock().unwrap_or_else(|e| e.into_inner()).get(&normalize_scope(Some(scope))).map_or(0, |life| life.generation)
    }

    /// Supersedes every operation requested before: the generation moves on and is returned
    /// (`bumpConnectAbortGeneration`, `:141-146`, which a full connect does first, `connect.mjs:101`).
    pub fn next_generation(&self, scope: &str) -> Result<u64, ScopeReleased> {
        let mut lives = self.lives.lock().unwrap_or_else(|e| e.into_inner());
        let life = lives.entry(normalize_scope(Some(scope))).or_default();
        if life.released {
            return Err(ScopeReleased);
        }
        life.generation += 1;
        Ok(life.generation)
    }

    /// Whether the scope was released: nothing connects under it again, whatever asks.
    pub fn is_released(&self, scope: &str) -> bool {
        self.lives.lock().unwrap_or_else(|e| e.into_inner()).get(&normalize_scope(Some(scope))).is_some_and(|life| life.released)
    }

    /// [`apply_in`](Self::apply_in) for an operation requested at `generation`: applied only while
    /// the scope is unreleased and no newer generation was requested, checked and applied under one
    /// lock, so a release or a newer full connect can neither be overtaken nor resurrected by a late
    /// operation (`connectServer`'s `genAtStart`, `mcp/client.mjs:199,405,447`). Of the failed
    /// servers, those `retry` names connect again. Whether it applied.
    pub fn apply_at(
        self: &Arc<Self>,
        scope: &str,
        generation: u64,
        configs: Vec<McpServerConfig>,
        retry: &dyn Fn(&str) -> bool,
    ) -> bool {
        let key = normalize_scope(Some(scope));
        let lives = self.lives.lock().unwrap_or_else(|e| e.into_inner());
        let (released, current) = lives.get(&key).map_or((false, 0), |life| (life.released, life.generation));
        if released || current != generation {
            return false;
        }
        self.apply_retrying(&key, configs, retry);
        drop(lives);
        true
    }

    /// The first half of `disconnectAll({ scopeId })` (`mcp/client.mjs:1182-1230`), synchronous: the
    /// scope is marked released and its generation moves on (so every operation in flight or queued
    /// for it is void from this instant), its servers leave the registry, and its sign-ins and
    /// accounts are forgotten. The servers are returned to be closed ([`close_retired`]).
    ///
    /// The runtime scope is the daemon's and is never tombstoned: Node's `disconnectAll` only drops the
    /// servers and voids what is in flight, so the runtime stays readable (its servers read `disconnected`)
    /// and a later reset or reconnect connects them again, which is what a reset (`connect.mjs:107`) and MCP
    /// being switched off (`:142`) rely on. Every other scope is released for good.
    pub fn retire_scope(&self, scope: &str) -> Vec<Arc<McpServer>> {
        let scope = normalize_scope(Some(scope));
        let mut lives = self.lives.lock().unwrap_or_else(|e| e.into_inner());
        let life = lives.entry(scope.clone()).or_default();
        life.released = life.released || scope != self.runtime_scope();
        life.generation += 1;
        let closing = self.in_scope(&scope);
        self.servers.rcu(|all| {
            let mut registry = Registry::clone(all);
            registry.remove(&scope);
            registry
        });
        self.oauth.lock().unwrap_or_else(|e| e.into_inner()).retain(|held, _| held.0 != scope);
        self.accounts.rcu(|all| {
            let mut live = HashMap::clone(all);
            live.retain(|held, _| held.0 != scope);
            live
        });
        drop(lives);
        closing
    }

    /// `disconnectAll({ scopeId })`: [`retire_scope`](Self::retire_scope), then every server of the
    /// scope closes; the other scopes are untouched.
    pub async fn release_scope(&self, scope: &str) {
        close_retired(self.retire_scope(scope)).await;
    }

    /// Every scope's servers close.
    pub async fn close_all(&self) {
        let all = self.servers.swap(Arc::new(Registry::new()));
        futures::future::join_all(all.values().flatten().map(|server| server.close())).await;
    }
}
