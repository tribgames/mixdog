//! The hub: the set of MCP servers of one daemon. Each server connects, fails and answers
//! calls independently — the hub holds no lock on the call path (an `ArcSwap` snapshot), so a
//! slow or hung server never delays another server's connection or calls.

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

pub struct McpHub {
    /// In insertion order, as Node's server registry lists them: a server kept across `apply`
    /// holds its place; a new or changed one goes after, in configuration order.
    servers: ArcSwap<Vec<Arc<McpServer>>>,
    io: McpIo,
    spiller: Spiller,
    policy: OutputPolicy,
    /// Where sign-ins are stored; none: servers needing a sign-in fail with that fact.
    oauth_env: ArcSwapOption<OAuthEnv>,
    /// The sign-in of each server that has one, kept while its server is kept.
    oauth: Mutex<HashMap<String, Arc<McpOAuth>>>,
    /// The accounts of each connector server (by server name), set by the connector server
    /// that answers for them; dropped with the server.
    accounts: ArcSwap<HashMap<String, Arc<ConnectorAccounts>>>,
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
            servers: ArcSwap::from_pointee(Vec::new()),
            io,
            spiller: Spiller::new(artifact_dir, io.durability),
            policy,
            oauth_env: ArcSwapOption::empty(),
            oauth: Mutex::new(HashMap::new()),
            accounts: ArcSwap::from_pointee(HashMap::new()),
        })
    }

    /// Sets the accounts of connector server `server`; `resolve_tool_account` chooses among them.
    pub fn set_connector_accounts(&self, server: &str, accounts: Arc<ConnectorAccounts>) {
        self.accounts.rcu(|all| {
            let mut next = HashMap::clone(all);
            next.insert(server.to_owned(), Arc::clone(&accounts));
            next
        });
    }

    /// The server and catalog entry a prefixed tool name (`mcp__<server>__<tool>`) refers to.
    /// The name's server part finds it directly; a name shortened to fit provider limits is
    /// found by scanning the servers.
    pub fn tool_target(&self, name: &str) -> Option<ToolTarget> {
        let (server_name, _) = split_mcp_tool_name(name)?;
        let direct = self.server(&server_name);
        let direct_entry = direct.as_ref().and_then(|s| s.catalog()?.entries.iter().find(|e| e.qualified == name).cloned());
        if let (Some(server), Some(entry)) = (&direct, direct_entry) {
            return Some(ToolTarget { server: Arc::clone(server), entry: Some(entry) });
        }
        if let Some((server, entry)) = self.resolve(name) {
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
        let Some(target) = self.tool_target(name) else { return Ok(None) };
        let Some(accounts) = self.accounts.load().get(target.server.name()).cloned() else { return Ok(None) };
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

    /// The sign-in of server `name`, if it has one.
    pub fn oauth(&self, name: &str) -> Option<Arc<McpOAuth>> {
        self.oauth.lock().unwrap_or_else(|e| e.into_inner()).get(name).cloned()
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
        let current = self.servers.load_full();
        let mut kept: Vec<String> = Vec::new();
        let mut started = Vec::new();
        let env = self.oauth_env.load_full();
        let mut previous_oauth = self.oauth.lock().unwrap_or_else(|e| e.into_inner());
        let mut next_oauth: HashMap<String, Arc<McpOAuth>> = HashMap::new();
        for config in configs.into_iter().filter(|c| c.enabled) {
            match current.iter().find(|s| s.name() == config.name) {
                Some(existing) if *existing.config() == config => {
                    kept.push(config.name.clone());
                    if let Some(kept) = previous_oauth.get(&config.name) {
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
                    let authorizer = oauth.clone().map(|o| o as Arc<dyn Authorizer>);
                    if let Some(oauth) = oauth {
                        next_oauth.insert(config.name.clone(), oauth);
                    }
                    let server = McpServer::new(config.clone(), self.io, self.spiller.clone(), self.policy, authorizer);
                    started.push(server);
                }
            }
        }
        *previous_oauth = next_oauth;
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
            live.retain(|name, _| next.iter().any(|s| s.name() == name));
            live
        });
        self.servers.store(Arc::new(next));
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
        self.servers.load().iter().find(|s| s.name() == name).cloned()
    }

    /// The servers in insertion order.
    pub fn servers(&self) -> Vec<Arc<McpServer>> {
        self.servers.load().to_vec()
    }

    /// One row per server, in insertion order.
    pub fn status(&self) -> Vec<ServerStatus> {
        self.servers
            .load()
            .iter()
            .map(|server| ServerStatus {
                name: server.name().to_owned(),
                state: server.state().describe(),
                tool_count: server.catalog().map_or(0, |c| c.entries.len()),
            })
            .collect()
    }

    /// The tools of every ready server.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut out: Vec<Arc<dyn Tool>> = Vec::new();
        for server in self.servers.load().iter() {
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

    /// The server and entry a qualified tool name was published for.
    pub fn resolve(&self, qualified: &str) -> Option<(Arc<McpServer>, Arc<ToolEntry>)> {
        self.servers.load().iter().find_map(|server| {
            let catalog = server.catalog()?;
            let entry = catalog.entries.iter().find(|e| e.qualified == qualified)?;
            Some((Arc::clone(server), Arc::clone(entry)))
        })
    }

    pub async fn close_all(&self) {
        let all = self.servers.swap(Arc::new(Vec::new()));
        futures::future::join_all(all.iter().map(|server| server.close())).await;
    }
}
