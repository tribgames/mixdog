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
use mixdog_rt::TaskClass;

use crate::config::McpServerConfig;
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
    servers: ArcSwap<HashMap<String, Arc<McpServer>>>,
    io: McpIo,
    spiller: Spiller,
    policy: OutputPolicy,
    /// Where sign-ins are stored; none: servers needing a sign-in fail with that fact.
    oauth_env: ArcSwapOption<OAuthEnv>,
    /// The sign-in of each server that has one, kept while its server is kept.
    oauth: Mutex<HashMap<String, Arc<McpOAuth>>>,
}

impl McpHub {
    /// `artifact_dir` receives the full text of over-cap results (a directory of the data dir).
    pub fn new(io: McpIo, artifact_dir: PathBuf, policy: OutputPolicy) -> Arc<Self> {
        Arc::new(Self {
            servers: ArcSwap::from_pointee(HashMap::new()),
            io,
            spiller: Spiller::new(artifact_dir, io.durability),
            policy,
            oauth_env: ArcSwapOption::empty(),
            oauth: Mutex::new(HashMap::new()),
        })
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
        let mut next: HashMap<String, Arc<McpServer>> = HashMap::new();
        let mut started = Vec::new();
        let env = self.oauth_env.load_full();
        let mut previous_oauth = self.oauth.lock().unwrap_or_else(|e| e.into_inner());
        let mut next_oauth: HashMap<String, Arc<McpOAuth>> = HashMap::new();
        for config in configs.into_iter().filter(|c| c.enabled) {
            match current.get(&config.name) {
                Some(existing) if *existing.config() == config => {
                    next.insert(config.name.clone(), Arc::clone(existing));
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
                    next.insert(config.name, Arc::clone(&server));
                    started.push(server);
                }
            }
        }
        *previous_oauth = next_oauth;
        drop(previous_oauth);
        let retired: Vec<Arc<McpServer>> = current
            .iter()
            .filter(|(name, old)| next.get(*name).is_none_or(|kept| !Arc::ptr_eq(kept, old)))
            .map(|(_, old)| Arc::clone(old))
            .collect();
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
        self.servers.load().get(name).cloned()
    }

    pub fn servers(&self) -> Vec<Arc<McpServer>> {
        self.servers.load().values().cloned().collect()
    }

    pub fn status(&self) -> Vec<ServerStatus> {
        let mut out: Vec<ServerStatus> = self
            .servers
            .load()
            .values()
            .map(|server| ServerStatus {
                name: server.name().to_owned(),
                state: server.state().describe(),
                tool_count: server.catalog().map_or(0, |c| c.entries.len()),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// The tools of every ready server.
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut out: Vec<Arc<dyn Tool>> = Vec::new();
        for server in self.servers.load().values() {
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
        self.servers.load().values().find_map(|server| {
            let catalog = server.catalog()?;
            let entry = catalog.entries.iter().find(|e| e.qualified == qualified)?;
            Some((Arc::clone(server), Arc::clone(entry)))
        })
    }

    pub async fn close_all(&self) {
        let all = self.servers.swap(Arc::new(HashMap::new()));
        futures::future::join_all(all.values().map(|server| server.close())).await;
    }
}
