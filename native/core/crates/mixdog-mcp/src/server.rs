//! One MCP server connection (T §4 target 1). The state machine
//! `Starting → Ready{catalog} → Failed{cause} → Closed` moves only on transport facts and
//! explicit commands (`connect`, `reconnect`, `close`); nothing retries on a timer. The call path
//! reads the published state and takes this server's own admission gate (on a connection the scopes
//! share, the calling scope's) — no lock is shared with any other server.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;

use arc_swap::ArcSwapOption;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_rt::CpuBulk;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::admission::AdmissionError;
use crate::admission::AdmissionGate;
use crate::config::McpServerConfig;
use crate::config::TransportConfig;
use crate::config::scrub;
use crate::http::HttpTransport;
use crate::naming::PROVIDER_TOOL_NAME_MAX;
use crate::naming::qualified_tool_name;
use crate::output_schema::OutputValidators;
use crate::plugin_admin::truthy;
use crate::result::OutputPolicy;
use crate::result::ReportedError;
use crate::result::Spiller;
use crate::result::map_call_result;
use crate::rpc::RequestOptions;
use crate::rpc::RpcClient;
use crate::rpc::RpcError;
use crate::sse::SseTransport;
use crate::stdio::StdioSpec;
use crate::tools::Feature;
use crate::transport::Authorizer;
use crate::transport::append_stderr_tail;
use crate::ws::WebSocketTransport;
use crate::stdio::StdioTransport;
use crate::transport::IncomingRx;
use crate::transport::Transport;
use crate::transport::TransportError;

/// The protocol revision this client speaks; a server answers with the one it settles on.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Lane tokens the connection layer needs.
#[derive(Clone, Copy, Debug)]
pub struct McpIo {
    pub spawn: SpawnIo,
    pub durability: DurabilityIo,
    /// Where a result is checked against its tool's output schema.
    pub cpu: CpuBulk,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ToolEntry {
    /// `mcp__<server>__<tool>`, cut with a hash suffix only when the provider limit forces it.
    pub qualified: String,
    /// The server's own name for the tool; what `tools/call` carries. A feature's: the name's leaf.
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: ToolAnnotations,
    /// The tool's `outboundHint: true` annotation: it opts in as an outbound message.
    pub outbound_hint: bool,
    /// The resources or prompts request the entry stands for (`mcpOperation`); `None`: a tool of the server.
    pub feature: Option<Feature>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct ToolCatalog {
    /// Digest of the server-reported list; an equal digest means nothing changed.
    pub digest: String,
    pub entries: Vec<Arc<ToolEntry>>,
}

pub struct Ready {
    pub client: Arc<RpcClient>,
    pub catalog: Arc<ToolCatalog>,
    /// The listed tools' `outputSchema` validators, which every `tools/call` result passes.
    pub outputs: Arc<OutputValidators>,
    pub capabilities: Value,
    pub instructions: Option<String>,
}

/// What a call sends the server.
#[derive(Clone, Copy)]
enum Request<'a> {
    /// `tools/call` of the server's tool.
    Tool(&'a str),
    /// A resources or prompts request (`_callMcpFeatureWithTimeout`, mcp/client.mjs).
    Feature(Feature),
}

/// What a call of the catalog's `tool` sends; `None`: the catalog lists no such tool.
fn listed<'a>(ready: &Ready, tool: &'a str) -> Option<Request<'a>> {
    let entry = ready.catalog.entries.iter().find(|entry| entry.tool == tool)?;
    Some(entry.feature.map_or(Request::Tool(tool), Request::Feature))
}

pub enum ServerState {
    Starting,
    Ready(Arc<Ready>),
    Failed { cause: String },
    Closed,
}

impl ServerState {
    pub fn describe(&self) -> String {
        match self {
            Self::Starting => "starting".to_owned(),
            Self::Ready(_) => "ready".to_owned(),
            Self::Failed { cause } => format!("failed: {cause}"),
            Self::Closed => "closed".to_owned(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
    /// The attempt failed; the text is the one the server row shows (scrubbed, with the stderr tail).
    #[error("{0}")]
    Failed(String),
    #[error(
        "MCP server \"{name}\" startup exceeded {ms}ms budget — raise per-server \"startupTimeoutSec\"/\"startupTimeoutMs\" or env MIXDOG_MCP_STARTUP_TIMEOUT_MS"
    )]
    StartupTimeout { name: String, ms: u128 },
    #[error("server was closed")]
    Closed,
}

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("MCP server {server} is {state}")]
    NotReady { server: String, state: String },
    #[error("MCP server {server} has no tool {tool}")]
    UnknownTool { server: String, tool: String },
    #[error(transparent)]
    Admission(#[from] AdmissionError),
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("{}", .0.text)]
    Reported(ReportedError),
    /// The result could not be checked against its output schema: the lane that checks it is full.
    #[error("{0}; retry after running work completes")]
    Overloaded(String),
    /// A call its connection failed, after the reconnect that followed (`executeMcpTool`, mcp/client.mjs:536-594): the
    /// reconnect failed too, the call was not replayed because it may have reached the server, or its one replay failed.
    /// `outcome_unknown`: the call may have run.
    #[error("{message}")]
    Recovery { message: String, outcome_unknown: bool },
}

pub struct McpServer {
    config: McpServerConfig,
    state: watch::Sender<Arc<ServerState>>,
    gate: Arc<AdmissionGate>,
    /// The admission gate of each scope holding a connection the scopes share ([`Self::gate_in`]).
    holder_gates: Mutex<HashMap<String, Arc<AdmissionGate>>>,
    spiller: Spiller,
    policy: OutputPolicy,
    secrets: Vec<String>,
    io: McpIo,
    authorizer: Option<Arc<dyn Authorizer>>,
    generation: AtomicU64,
    connecting: AtomicBool,
    shutdown: CancellationToken,
    /// The folder of the server's scope now, which a server that follows its scope advertises as its root
    /// (`_scopeRoots`, mcp/client.mjs:79); empty: none set.
    scope_root: Arc<Mutex<String>>,
    /// The connection the server was ready on, once that connection ended by itself (Node keeps such a server registered
    /// with `liveness.alive === false`, with the tools, capabilities and instructions it had): a call finds no connection
    /// to send on, and reconnects. Cleared when a connect settles.
    died: ArcSwapOption<Ready>,
    /// One failure-driven reconnect at a time (`reconnects.run(registryKey, …)`).
    reconnecting: tokio::sync::Mutex<()>,
    /// Test seam: the transport that serves a server whose identity (`config`) is a remote one, so a replay can drive the real
    /// call path of a server the core never reaches over the network.
    #[cfg(feature = "test-support")]
    stand_in: Option<TransportConfig>,
}

struct ConnectingGuard<'a>(&'a AtomicBool);

impl Drop for ConnectingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn sanitize_schema(schema: Option<&Value>) -> Value {
    match schema {
        Some(Value::Object(map)) if map.get("type").is_some() => Value::Object(map.clone()),
        Some(Value::Object(map)) => {
            let mut map = map.clone();
            map.insert("type".to_owned(), json!("object"));
            Value::Object(map)
        }
        _ => json!({"type": "object", "properties": {}}),
    }
}

fn annotations_of(tool: &Value) -> ToolAnnotations {
    let hints = tool.get("annotations");
    let flag = |key: &str| hints.and_then(|h| h.get(key)).and_then(Value::as_bool);
    ToolAnnotations {
        title: hints.and_then(|h| h.get("title")).and_then(Value::as_str).map(str::to_owned),
        read_only_hint: flag("readOnlyHint"),
        destructive_hint: flag("destructiveHint"),
        idempotent_hint: flag("idempotentHint"),
        open_world_hint: flag("openWorldHint"),
        ..ToolAnnotations::default()
    }
}

/// The server's listed tools, then the resources and prompts requests its `capabilities` advertise (`mcpServerTools`,
/// mcp/client.mjs).
pub(crate) fn build_catalog(server: &str, tools: &[Value], capabilities: &Value) -> ToolCatalog {
    let digest = Sha256::digest(serde_json::to_vec(tools).unwrap_or_default());
    let mut entries: Vec<Arc<ToolEntry>> = tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?;
            Some(Arc::new(ToolEntry {
                qualified: qualified_tool_name(server, name, PROVIDER_TOOL_NAME_MAX),
                tool: name.to_owned(),
                description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_owned(),
                input_schema: sanitize_schema(tool.get("inputSchema")),
                annotations: annotations_of(tool),
                outbound_hint: tool.get("annotations").and_then(|h| h.get("outboundHint")) == Some(&Value::Bool(true)),
                feature: None,
            }))
        })
        .collect();
    // `mcpFeatureTools`: each request under a name none of the entries holds, `_` appended until one is free.
    let mut used: HashSet<String> = entries.iter().map(|entry| entry.qualified.clone()).collect();
    for feature in Feature::ALL.into_iter().filter(|feature| capabilities.get(feature.capability()).is_some_and(truthy)) {
        let mut leaf = feature.name().to_owned();
        let mut qualified = qualified_tool_name(server, &leaf, PROVIDER_TOOL_NAME_MAX);
        while used.contains(&qualified) {
            leaf.push('_');
            qualified = qualified_tool_name(server, &leaf, PROVIDER_TOOL_NAME_MAX);
        }
        used.insert(qualified.clone());
        entries.push(Arc::new(ToolEntry {
            qualified,
            tool: leaf,
            description: feature.description().to_owned(),
            input_schema: feature.schema(),
            annotations: ToolAnnotations::default(),
            outbound_hint: false,
            feature: Some(feature),
        }));
    }
    ToolCatalog { digest: digest.iter().map(|b| format!("{b:02x}")).collect(), entries }
}

/// Why a page of `tools/list` is no page.
enum PageError {
    Rpc(RpcError),
    /// The result has no `tools` array: the text is the one Node's SDK throws for it.
    Shape(String),
}

impl From<RpcError> for PageError {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

impl From<PageError> for ConnectError {
    fn from(error: PageError) -> Self {
        match error {
            PageError::Rpc(error) => Self::Rpc(error),
            PageError::Shape(text) => Self::Failed(text),
        }
    }
}

/// The SDK's `Client.listTools` checks each result against `ListToolsResultSchema` before `listAllMcpTools` sees it, so
/// a `tools` that is no array throws Zod's issue list, whichever page it is on (Node's own "invalid shape" checks
/// never see such a result). Zod names the kind of what it received.
fn tools_shape_error(page: &Value) -> Option<String> {
    let received = match page.get("tools") {
        Some(Value::Array(_)) => return None,
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Object(_)) => "object",
    };
    Some(format!(
        "[\n  {{\n    \"expected\": \"array\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"tools\"\n    ],\n    \"message\": \"Invalid input: expected array, received {received}\"\n  }}\n]"
    ))
}

/// One page of `tools/list`, and the cursor of the next one when there is one.
async fn list_page(client: &RpcClient, cursor: Option<&str>) -> Result<(Vec<Value>, Option<String>), PageError> {
    let params = match cursor {
        Some(c) => json!({"cursor": c}),
        None => json!({}),
    };
    let page = client.request("tools/list", params, RequestOptions::default()).await?;
    if let Some(text) = tools_shape_error(&page) {
        return Err(PageError::Shape(text));
    }
    let tools = page.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let next = page.get("nextCursor").and_then(Value::as_str).filter(|next| !next.is_empty()).map(str::to_owned);
    Ok((tools, next))
}

/// Node's `MAX_MCP_TOOL_PAGES`.
const MAX_TOOL_PAGES: usize = 100;

/// One walk over the pages of `tools/list` (`listAllMcpTools`): it ends when a page names no next cursor, names one
/// it already followed, or `MAX_TOOL_PAGES` pages were read, so a server that never ends its cursor chain cannot
/// keep the client listing. The tools gathered until then are the listing.
#[derive(Default)]
struct ToolPages {
    tools: Vec<Value>,
    cursor: Option<String>,
    followed: std::collections::HashSet<String>,
    pages: usize,
}

impl ToolPages {
    /// Takes a page in; false when the walk is over.
    fn take(&mut self, (tools, next): (Vec<Value>, Option<String>)) -> bool {
        self.tools.extend(tools);
        self.pages += 1;
        match next {
            Some(next) if self.pages < MAX_TOOL_PAGES && self.followed.insert(next.clone()) => {
                self.cursor = Some(next);
                true
            }
            _ => false,
        }
    }
}

/// Every tool of the server, page by page.
async fn list_tools(client: &RpcClient) -> Result<Vec<Value>, ConnectError> {
    let mut walk = ToolPages::default();
    loop {
        let page = list_page(client, walk.cursor.as_deref()).await?;
        if !walk.take(page) {
            return Ok(walk.tools);
        }
    }
}

/// The result of `roots/list` (`createMcpClient`'s handler, mcp/client.mjs:1581-1596): the scope's folder for a server
/// that follows its scope (`follow`), else or failing that the fixed root, as `{ uri: pathToFileURL(resolve(root)), name:
/// basename(root) || root }`; no root at all is an empty list.
fn roots_result(follow: bool, fixed: Option<&str>, scope_root: &Mutex<String>) -> Value {
    let scoped = follow.then(|| scope_root.lock().unwrap_or_else(|e| e.into_inner()).clone()).filter(|root| !root.is_empty());
    let Some(root) = scoped.or_else(|| fixed.map(str::to_owned)) else {
        return json!({"roots": []});
    };
    let path = std::path::absolute(&root).unwrap_or_else(|_| std::path::PathBuf::from(&root));
    let shown = path.to_string_lossy().into_owned();
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| !name.is_empty()).unwrap_or_else(|| shown.clone());
    let uri = url::Url::from_file_path(&path).map_or(shown, String::from);
    json!({"roots": [{"uri": uri, "name": name}]})
}

impl McpServer {
    pub fn new(
        config: McpServerConfig,
        io: McpIo,
        spiller: Spiller,
        policy: OutputPolicy,
        authorizer: Option<Arc<dyn Authorizer>>,
    ) -> Arc<Self> {
        let gate = AdmissionGate::new(config.max_concurrency, config.max_queue, config.min_owner_queue);
        let secrets = config.secret_values();
        let (state, _) = watch::channel(Arc::new(ServerState::Starting));
        Arc::new(Self {
            config,
            state,
            gate,
            holder_gates: Mutex::new(HashMap::new()),
            spiller,
            policy,
            secrets,
            io,
            authorizer,
            generation: AtomicU64::new(0),
            connecting: AtomicBool::new(false),
            shutdown: CancellationToken::new(),
            scope_root: Arc::default(),
            died: ArcSwapOption::empty(),
            reconnecting: tokio::sync::Mutex::new(()),
            #[cfg(feature = "test-support")]
            stand_in: None,
        })
    }

    /// [`McpServer::new`] for a server that is `config` to every check but is served over `served_by`'s transport.
    #[cfg(feature = "test-support")]
    pub fn standing_in(config: McpServerConfig, served_by: TransportConfig, io: McpIo, spiller: Spiller, policy: OutputPolicy) -> Arc<Self> {
        let server = Self::new(config, io, spiller, policy, None);
        Arc::new(Self { stand_in: Some(served_by), ..Arc::try_unwrap(server).unwrap_or_else(|_| unreachable!("a new server has one owner")) })
    }

    pub fn name(&self) -> &str {
        &self.config.name
    }

    pub fn config(&self) -> &McpServerConfig {
        &self.config
    }

    pub fn gate(&self) -> &Arc<AdmissionGate> {
        &self.gate
    }

    /// The admission gate of the calls `scope` makes: the server's own, unless the scopes share its connection
    /// ([`crate::hub::shares_process`]), where each scope holding it has its own, as Node keys `callAdmissionFor` by scope
    /// and server name (mcp/client.mjs:340-361): one session's backlog never queues another's, and a cap is per session.
    pub fn gate_in(&self, scope: &str) -> Arc<AdmissionGate> {
        // A closed server's calls are refused by its own gate, closed with it.
        if !crate::hub::shares_process(&self.config) || self.shutdown.is_cancelled() {
            return Arc::clone(&self.gate);
        }
        let mut gates = self.holder_gates.lock().unwrap_or_else(|e| e.into_inner());
        let gate = gates
            .entry(scope.to_owned())
            .or_insert_with(|| AdmissionGate::new(self.config.max_concurrency, self.config.max_queue, self.config.min_owner_queue));
        Arc::clone(gate)
    }

    /// `closeCallAdmission(scopeId, name)` (mcp/client.mjs:364-370) for a scope that let the shared connection go while
    /// other scopes keep it: the calls it still has waiting for admission are refused.
    pub fn release_gate(&self, scope: &str) {
        let gate = self.holder_gates.lock().unwrap_or_else(|e| e.into_inner()).remove(scope);
        if let Some(gate) = gate {
            gate.close(&format!("MCP {} disconnected", self.name()));
        }
    }

    pub fn state(&self) -> Arc<ServerState> {
        Arc::clone(&self.state.borrow())
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<ServerState>> {
        self.state.subscribe()
    }

    /// The tool catalog while the server is ready, and while the connection that listed it has ended by itself and is
    /// not yet replaced: `getMcpTools` and `resolveMcpToolTarget` (mcp/client.mjs:232-238, 1622-1633) list a dead
    /// server's tools, and a call of one reconnects it ([`Self::call_tool`]).
    pub fn catalog(&self) -> Option<Arc<ToolCatalog>> {
        self.connection().map(|connection| Arc::clone(&connection.catalog))
    }

    /// The connection the server is ready on, or the one that ended by itself and is not yet replaced, whose tools,
    /// capabilities and instructions Node keeps on the registered entry (`getMcpServerStatus`,
    /// `getMcpServerInstructionsMap`, mcp/client.mjs:307-320, 384-391); none once the server is closed.
    pub fn connection(&self) -> Option<Arc<Ready>> {
        match &*self.state() {
            ServerState::Ready(ready) => Some(Arc::clone(ready)),
            ServerState::Closed => None,
            _ => self.died.load_full(),
        }
    }

    /// Whether the connection the server was ready on ended by itself and no connect has settled since.
    pub fn is_dead(&self) -> bool {
        self.died.load().is_some()
    }

    fn publish(&self, generation: u64, state: ServerState) {
        if self.generation.load(Ordering::Acquire) == generation {
            self.state.send_replace(Arc::new(state));
        }
    }

    /// Connects, handshakes and lists tools. Concurrent callers share one attempt.
    pub async fn connect(self: &Arc<Self>) -> Result<(), ConnectError> {
        if self.shutdown.is_cancelled() {
            return Err(ConnectError::Closed);
        }
        if self.connecting.swap(true, Ordering::AcqRel) {
            let mut rx = self.subscribe();
            let settled = match rx.wait_for(|s| !matches!(**s, ServerState::Starting)).await {
                Ok(state) => Arc::clone(&*state),
                Err(_) => return Err(ConnectError::Closed),
            };
            return match &*settled {
                ServerState::Ready(_) => Ok(()),
                ServerState::Failed { cause } => Err(ConnectError::Failed(cause.clone())),
                _ => Err(ConnectError::Closed),
            };
        }
        // Clears the single-flight flag on every exit, including this future being dropped.
        let _attempt = ConnectingGuard(&self.connecting);
        // `missingEnvWarnings` logs what the configuration could not resolve at every connect.
        for warning in &self.config.warnings {
            crate::config::mcp_log(&format!("[mcp-client] \"{}\": {warning}", self.config.name));
        }
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.state.send_replace(Arc::new(ServerState::Starting));
        let opened: Mutex<Option<Arc<RpcClient>>> = Mutex::new(None);
        let outcome = match self.config.startup_timeout {
            Some(budget) => match mixdog_rt::time::timeout(budget, self.handshake(&opened)).await {
                Ok(result) => result,
                Err(_) => Err(ConnectError::StartupTimeout { name: self.config.name.clone(), ms: budget.as_millis() }),
            },
            // The budget is disabled: the handshake is not bounded, as Node arms no deadline for it.
            None => self.handshake(&opened).await,
        };
        // The connect settled: whatever connection died before it is replaced or given up, and its tools with it (a failed
        // replacement is unregistered, `replaceServerConnection`). Until here a call still finds the dead one and waits
        // for this connect with the others (`died`).
        self.died.store(None);
        match outcome {
            Ok(ready) => {
                let client = Arc::clone(&ready.client);
                // `connectServer` (mcp/client.mjs:1501) follows `list_changed` only from a server that advertised it.
                let follows = ready.capabilities.pointer("/tools/listChanged").is_some_and(truthy);
                self.publish(generation, ServerState::Ready(Arc::new(ready)));
                self.watch(generation, client, follows);
                Ok(())
            }
            Err(error) => {
                let client = opened.lock().unwrap_or_else(|e| e.into_inner()).take();
                // A failed handshake carries what the server wrote to stderr (`runBoundedHandshake`).
                let mut message = error.to_string();
                if let Some(client) = client {
                    message = append_stderr_tail(&message, &client.transport().stderr_tail());
                    client.close().await;
                }
                let cause = scrub(&message, &self.secrets);
                self.publish(generation, ServerState::Failed { cause: cause.clone() });
                Err(ConnectError::Failed(cause))
            }
        }
    }

    async fn open_transport(&self) -> Result<(Arc<dyn Transport>, IncomingRx), TransportError> {
        #[cfg(feature = "test-support")]
        let transport = self.stand_in.as_ref().unwrap_or(&self.config.transport);
        #[cfg(not(feature = "test-support"))]
        let transport = &self.config.transport;
        match transport {
            TransportConfig::Stdio { command, args, env, cwd } => {
                let (transport, rx) = StdioTransport::spawn(
                    self.io.spawn,
                    StdioSpec {
                        command,
                        args,
                        env,
                        cwd: cwd.as_deref(),
                        shutdown_grace: self.config.shutdown_grace,
                    },
                )
                .await?;
                Ok((Arc::new(transport), rx))
            }
            TransportConfig::Http { url, headers } => {
                self.check_sign_in_client()?;
                let (transport, rx) = HttpTransport::new(url.clone(), headers, self.authorizer.clone())?;
                Ok((Arc::new(transport), rx))
            }
            TransportConfig::Sse { url, headers } => {
                self.check_sign_in_client()?;
                let (transport, rx) = SseTransport::connect(url.clone(), headers, self.authorizer.clone()).await?;
                Ok((Arc::new(transport), rx))
            }
            TransportConfig::WebSocket { url, headers } => {
                let (transport, rx) = WebSocketTransport::connect(url, headers).await?;
                Ok((Arc::new(transport), rx))
            }
        }
    }

    /// A catalog connector that needs a built-in sign-in client this build has none of fails
    /// with that fact, never with a fallback to dynamic registration.
    fn check_sign_in_client(&self) -> Result<(), TransportError> {
        match self.config.oauth.as_ref().and_then(|o| o.client_unavailable.as_deref()) {
            Some(client) => Err(TransportError::Other(format!(
                "MCP OAuth clientUnavailable: this build has no built-in {client} sign-in client; use your own {client} client."
            ))),
            None => Ok(()),
        }
    }

    async fn handshake(&self, opened: &Mutex<Option<Arc<RpcClient>>>) -> Result<Ready, ConnectError> {
        let (transport, incoming) = self.open_transport().await?;
        let client = RpcClient::start(transport, incoming);
        *opened.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&client));
        // `createMcpClient` (mcp/client.mjs:1569): a server with a root (its scope's, or a fixed one) is told the client
        // has roots, and that they change when they follow the scope; its `roots/list` is answered with the root now.
        let (follow, fixed) = (self.config.roots_follow_scope, self.config.project_root.clone());
        let capabilities = if follow || fixed.is_some() { json!({"roots": {"listChanged": follow}}) } else { json!({}) };
        if follow || fixed.is_some() {
            let scope_root = Arc::clone(&self.scope_root);
            client.serve_roots(Arc::new(move || roots_result(follow, fixed.as_deref(), &scope_root)));
        }
        let init = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": capabilities,
                    "clientInfo": {"name": "mixdog", "version": env!("CARGO_PKG_VERSION")},
                }),
                RequestOptions::default(),
            )
            .await?;
        if let Some(version) = init.get("protocolVersion").and_then(Value::as_str) {
            client.transport().set_protocol_version(version);
        }
        client
            .notify_and_wait("notifications/initialized", json!({}))
            .await?;
        client.transport().initialized();
        let capabilities = init.get("capabilities").cloned().unwrap_or(Value::Null);
        let tools = if capabilities.get("tools").is_some_and(Value::is_object) {
            list_tools(&client).await?
        } else {
            Vec::new()
        };
        let outputs = OutputValidators::of(&tools).map_err(ConnectError::Failed)?;
        Ok(Ready {
            catalog: Arc::new(build_catalog(&self.config.name, &tools, &capabilities)),
            outputs: Arc::new(outputs),
            client,
            capabilities,
            instructions: init.get("instructions").and_then(Value::as_str).map(str::to_owned),
        })
    }

    /// Follows one connection: its end is the `Failed` transition; when it `follows` the tool list, `list_changed`
    /// re-lists (a notification no handler subscribed to is dropped).
    fn watch(self: &Arc<Self>, generation: u64, client: Arc<RpcClient>, follows: bool) {
        let server = Arc::clone(self);
        mixdog_rt::spawn("mcp.server.watch", TaskClass::Work, async move {
            let mut closed = client.closed();
            loop {
                tokio::select! {
                    () = async { let _ = closed.wait_for(Option::is_some).await; } => break,
                    () = client.tools_changed(), if follows => server.relist(generation, &client).await,
                }
            }
            // `getMcpServerStatus`: a dead connection reads `MCP server "<name>" closed` and the stderr tail.
            let tail = closed.borrow().as_ref().map(|c| c.stderr_tail.clone()).unwrap_or_default();
            let cause = append_stderr_tail(&format!("MCP server \"{}\" closed", server.name()), &tail);
            let cause = scrub(&cause, &server.secrets);
            if server.generation.load(Ordering::Acquire) == generation {
                server.died.store(server.connection());
            }
            server.publish(generation, ServerState::Failed { cause });
        });
    }

    async fn relist(&self, generation: u64, client: &Arc<RpcClient>) {
        // Node's refresh gives each page's request the call timeout (`runToolRefresh`, `listAllMcpTools`), whatever the
        // startup budget is; with the call timeout disabled a page is not bounded.
        let mut walk = ToolPages::default();
        loop {
            let page = list_page(client, walk.cursor.as_deref());
            let page = match self.config.call_timeout {
                Some(bound) => match mixdog_rt::time::timeout(bound, page).await {
                    Ok(page) => page,
                    Err(_) => return tracing::warn!(server = self.name(), "tools/list timed out after list_changed"),
                },
                None => page.await,
            };
            match page {
                Ok(page) => {
                    if !walk.take(page) {
                        break;
                    }
                }
                // `runToolRefresh` keeps the listing it had and logs this line.
                Err(PageError::Shape(text)) => {
                    return crate::config::mcp_log(&format!("[mcp-client] Failed to refresh tools for \"{}\": {}", self.name(), scrub(&text, &self.secrets)));
                }
                Err(PageError::Rpc(error)) => return tracing::warn!(server = self.name(), %error, "tools/list failed after list_changed"),
            }
        }
        let tools = walk.tools;
        let current = self.state();
        let ServerState::Ready(ready) = &*current else { return };
        let catalog = build_catalog(&self.config.name, &tools, &ready.capabilities);
        if ready.catalog.digest == catalog.digest {
            return;
        }
        // The SDK's `listTools` throws on schemas that do not resolve: the previous listing stays.
        let outputs = match OutputValidators::of(&tools) {
            Ok(outputs) => outputs,
            Err(error) => return tracing::warn!(server = self.name(), %error, "tools/list failed after list_changed"),
        };
        self.publish(
            generation,
            ServerState::Ready(Arc::new(Ready {
                client: Arc::clone(&ready.client),
                catalog: Arc::new(catalog),
                outputs: Arc::new(outputs),
                capabilities: ready.capabilities.clone(),
                instructions: ready.instructions.clone(),
            })),
        );
    }

    /// Ends the current connection and connects again — an explicit command, never a timer.
    pub async fn reconnect(self: &Arc<Self>) -> Result<(), ConnectError> {
        if let ServerState::Ready(ready) = &*self.state() {
            let client = Arc::clone(&ready.client);
            // Bumping the generation retires the old watcher before the close lands.
            self.generation.fetch_add(1, Ordering::AcqRel);
            client.close().await;
        }
        self.connect().await
    }

    pub async fn close(&self) {
        self.shutdown.cancel();
        self.generation.fetch_add(1, Ordering::AcqRel);
        let previous = self.state.send_replace(Arc::new(ServerState::Closed));
        // A closed server lists nothing: the connection that ended by itself goes too.
        self.died.store(None);
        let reason = format!("MCP {} closed", self.name());
        self.gate.close(&reason);
        let holders: Vec<Arc<AdmissionGate>> = self.holder_gates.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, gate)| gate).collect();
        for gate in holders {
            gate.close(&reason);
        }
        if let ServerState::Ready(ready) = &*previous {
            ready.client.close().await;
        }
    }

    fn ready(&self) -> Result<Arc<Ready>, CallError> {
        match &*self.state() {
            ServerState::Ready(ready) => Ok(Arc::clone(ready)),
            other => Err(CallError::NotReady { server: self.name().to_owned(), state: other.describe() }),
        }
    }

    /// `setMcpScopeRoot` (mcp/client.mjs:1603) for this server: the folder its scope works in now. A server that
    /// follows its scope advertises it as its root and, while connected, is told when it changed
    /// (`notifications/roots/list_changed`); the connection and its tools stay as they are. Any other server ignores it.
    pub fn set_scope_root(&self, root: &str) {
        if !self.config.roots_follow_scope {
            return;
        }
        let next = mixdog_js::js_trim(root);
        {
            let mut current = self.scope_root.lock().unwrap_or_else(|e| e.into_inner());
            if *current == next {
                return;
            }
            *current = next.to_owned();
        }
        if let ServerState::Ready(ready) = &*self.state() {
            // A server that rejects the notification keeps its previous roots.
            let _ = ready.client.notify_bare("notifications/roots/list_changed");
        }
    }

    /// Calls `tool` (the server's own name, or a feature's leaf: its request is sent on the same path, `executeMcpTool`).
    /// `owner` identifies the caller for fair admission.
    ///
    /// A call its connection fails is answered as `executeMcpTool` answers it (mcp/client.mjs:536-594): the server is
    /// reconnected, one reconnect shared by every call that failed on the same connection, and the call is replayed
    /// once only when it provably never left this process (there was no live connection to send it on). A cancelled
    /// call, a timed-out one and one the server answered with an error are not transport failures.
    pub async fn call_tool(
        self: &Arc<Self>,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        self.call_tool_through(&self.gate, owner, tool, arguments, cancel, deadline).await
    }

    /// [`Self::call_tool`] made in `scope`, admitted by that scope's gate ([`Self::gate_in`]).
    pub async fn call_tool_in(
        self: &Arc<Self>,
        scope: &str,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let gate = self.gate_in(scope);
        self.call_tool_through(&gate, owner, tool, arguments, cancel, deadline).await
    }

    async fn call_tool_through(
        self: &Arc<Self>,
        gate: &Arc<AdmissionGate>,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let ready = match self.ready() {
            Ok(ready) if !ready.client.is_closed() => ready,
            // The connection ended before the call: nothing to send on (the SDK's `Not connected`).
            Ok(ready) => {
                let tail = ready.client.transport().stderr_tail();
                return self.recover_call(gate, Some(Arc::clone(&ready.client)), None, tail, owner, tool, arguments, cancel, deadline).await;
            }
            Err(_) if self.is_dead() && !self.shutdown.is_cancelled() => {
                return self.recover_call(gate, None, None, String::new(), owner, tool, arguments, cancel, deadline).await;
            }
            Err(not_ready) => return Err(not_ready),
        };
        let Some(request) = listed(&ready, tool) else {
            return Err(CallError::UnknownTool { server: self.name().to_owned(), tool: tool.to_owned() });
        };
        let first = match self.call_ready(gate, &ready, owner, request, arguments.clone(), cancel, deadline).await {
            Ok(output) => return Ok(output),
            Err(error) => error,
        };
        let tail = match &first {
            CallError::Rpc(RpcError::Closed(tail)) => Some(tail.clone()),
            CallError::Rpc(RpcError::Transport(_)) => Some(String::new()),
            _ => None,
        };
        let Some(tail) = tail.filter(|_| !cancel.is_cancelled()) else {
            return Err(first);
        };
        self.recover_call(gate, Some(Arc::clone(&ready.client)), Some(first.to_string()), tail, owner, tool, arguments, cancel, deadline).await
    }

    /// The reconnect after a call's connection failed, and what follows it. `sent`: the failure of a call that was
    /// handed to the connection (it may have reached the server, so it is never replayed); `None`: the call found no
    /// connection and is replayed once on the new one. `tail`: what the dead server wrote to stderr.
    #[allow(clippy::too_many_arguments)]
    async fn recover_call(
        self: &Arc<Self>,
        gate: &Arc<AdmissionGate>,
        failed: Option<Arc<RpcClient>>,
        sent: Option<String>,
        tail: String,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let undelivered = sent.is_none();
        let first = sent.unwrap_or_else(|| "Not connected".to_owned());
        crate::config::mcp_log("[mcp-client] Tool call failed, attempting shared reconnect...");
        // The reconnect is shared: this caller's cancel only stops it from waiting; the reconnect keeps running for
        // its other waiters.
        let reconnect = {
            let server = Arc::clone(self);
            mixdog_rt::spawn("mcp.server.reconnect", TaskClass::Work, async move { server.reconnect_after(failed).await })
        };
        let reconnected = tokio::select! {
            joined = reconnect => joined.unwrap_or_else(|error| Err(error.to_string())),
            () = cancel.cancelled() => return Err(RpcError::Cancelled.into()),
        };
        if let Err(reason) = reconnected {
            let message = append_stderr_tail(&format!("Tool call failed: {first}; reconnect also failed: {reason}"), &tail);
            return Err(CallError::Recovery { message: scrub(&message, &self.secrets), outcome_unknown: !undelivered });
        }
        if !undelivered {
            let message = append_stderr_tail(
                &format!(
                    "Tool call failed: {first}; MCP server \"{}\" was reconnected for the next call, but this call was not replayed because the request may already have reached the server",
                    self.name()
                ),
                &tail,
            );
            return Err(CallError::Recovery { message: scrub(&message, &self.secrets), outcome_unknown: true });
        }
        // A reconnect that outlived the caller's cancel must not dispatch the replay.
        if cancel.is_cancelled() {
            return Err(RpcError::Cancelled.into());
        }
        let ready = self.ready()?;
        let Some(request) = listed(&ready, tool) else {
            return Err(CallError::UnknownTool { server: self.name().to_owned(), tool: tool.to_owned() });
        };
        match self.call_ready(gate, &ready, owner, request, arguments, cancel, deadline).await {
            Err(CallError::Rpc(retry)) if !matches!(retry, RpcError::Cancelled) && !cancel.is_cancelled() => {
                // The SDK's text of a JSON-RPC error (`McpError`).
                let (text, answered) = match &retry {
                    RpcError::Server { code, message, .. } => (format!("MCP error {code}: {message}"), true),
                    other => (other.to_string(), false),
                };
                let message = format!("Tool call failed: {first}; retry after reconnect also failed: {text}");
                Err(CallError::Recovery { message: scrub(&message, &self.secrets), outcome_unknown: !answered })
            }
            other => other,
        }
    }

    /// `reconnectMcpServer` (mcp/client.mjs:432): replaces the connection `failed` was (`None`: the one that ended by
    /// itself), unless a peer already did (its replacement is reused) or the server was closed meanwhile (a failed call
    /// never brings back a server someone removed).
    pub(crate) async fn reconnect_after(self: &Arc<Self>, failed: Option<Arc<RpcClient>>) -> Result<(), String> {
        let _one = self.reconnecting.lock().await;
        let disconnected = || format!("MCP server \"{}\" was disconnected", self.name());
        match &*self.state() {
            ServerState::Ready(ready) if !ready.client.is_closed() && failed.as_ref().is_none_or(|old| !Arc::ptr_eq(old, &ready.client)) => {
                return Ok(());
            }
            ServerState::Closed => return Err(disconnected()),
            // A peer's reconnect of the same connection already failed: this caller shares that failure.
            ServerState::Failed { cause } if !self.is_dead() => return Err(cause.clone()),
            _ => {}
        }
        if self.shutdown.is_cancelled() {
            return Err(disconnected());
        }
        self.reconnect().await.map_err(|error| error.to_string())
    }

    /// Calls a tool the server answers without listing it (a read-only helper the approval
    /// card uses). The server itself reports an unknown name.
    pub async fn call_tool_unlisted(
        &self,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let ready = self.ready()?;
        self.call_ready(&self.gate, &ready, owner, Request::Tool(tool), arguments, cancel, deadline).await
    }

    /// Calls `tool` (the server's own name) and answers as the SDK's `Client.callTool` settles: the server's result once
    /// its output schema passed, or the error. What [`Self::call_tool`] maps for the model.
    pub async fn call_tool_settled(
        &self,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Value, CallError> {
        let ready = self.ready()?;
        self.settle(&self.gate, &ready, owner, Request::Tool(tool), arguments, cancel, deadline).await
    }

    /// One call on `ready`, admitted by `gate`.
    #[allow(clippy::too_many_arguments)]
    async fn call_ready(
        &self,
        gate: &Arc<AdmissionGate>,
        ready: &Ready,
        owner: &str,
        request: Request<'_>,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let result = self.settle(gate, ready, owner, request, arguments, cancel, deadline).await?;
        map_call_result(&result, self.policy, &self.spiller)
            .await
            .map_err(|mut reported| {
                reported.text = scrub(&reported.text, &self.secrets);
                CallError::Reported(reported)
            })
    }

    /// `request` sent as the SDK's `Client.callTool` settles it (a feature's as `_callMcpFeatureWithTimeout` does): the
    /// result once its output schema passed, or the error.
    #[allow(clippy::too_many_arguments)]
    async fn settle(
        &self,
        gate: &Arc<AdmissionGate>,
        ready: &Ready,
        owner: &str,
        request: Request<'_>,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Value, CallError> {
        let permit = gate.acquire(owner, cancel, self.config.wait_timeout).await?;
        let from_deadline = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let max_total = match (self.config.max_total_timeout, from_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let options = RequestOptions { idle_timeout: self.config.call_timeout, max_total, cancel: Some(cancel) };
        let (method, params) = match request {
            Request::Tool(tool) => ("tools/call", json!({"name": tool, "arguments": arguments})),
            Request::Feature(feature) => (feature.method(), feature.params(&arguments)),
        };
        let result = ready.client.request(method, params, options).await;
        drop(permit);
        match request {
            Request::Tool(tool) => self.checked(ready, tool, result?, cancel).await,
            // The server's answer, as the text of a call that succeeded.
            Request::Feature(_) => Ok(json!({"content": [{"type": "text", "text": mixdog_js::json_stringify_indent(&result?, 2)}], "isError": false})),
        }
    }

    /// `callTool`'s check of `result` against `tool`'s output schema, as a cpu-bulk lane job: a pattern may backtrack for
    /// long, and its match ends at its next read of the stop once the call is cancelled or the server closes.
    async fn checked(&self, ready: &Ready, tool: &str, result: Value, cancel: &CancellationToken) -> Result<Value, CallError> {
        if !ready.outputs.checks(tool) {
            return Ok(result);
        }
        let outputs = Arc::clone(&ready.outputs);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let job = {
            let (tool, stop) = (tool.to_owned(), Arc::clone(&stop));
            self.io
                .cpu
                .submit(cancel, move |_lane| {
                    let checked = outputs.check(&tool, &result, &stop);
                    (checked, result)
                })
                .map_err(|full| CallError::Overloaded(full.to_string()))?
        };
        tokio::pin!(job);
        let settled = tokio::select! {
            settled = &mut job => settled,
            () = cancel.cancelled() => {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                job.await
            }
            () = self.shutdown.cancelled() => {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
                job.await
            }
        };
        match settled {
            Ok((checked, result)) => checked.map(|()| result).map_err(CallError::from),
            // Dropped before it ran: its call was cancelled, or the lane can take no job.
            Err(dropped) if !cancel.is_cancelled() && !self.shutdown.is_cancelled() => Err(CallError::Overloaded(dropped.to_string())),
            Err(_) => Err(RpcError::Cancelled.into()),
        }
    }

    /// Removes model-visible secrets from a message about this server.
    pub fn scrub(&self, text: &str) -> String {
        scrub(text, &self.secrets)
    }
}

#[cfg(test)]
mod catalog_tests {
    use serde_json::json;

    use super::Feature;
    use super::MAX_TOOL_PAGES;
    use super::ToolPages;
    use super::build_catalog;

    /// `listAllMcpTools`: a cursor already followed ends the walk with the tools gathered so far, and so does the
    /// hundredth page whatever cursor it names.
    #[test]
    fn a_listing_ends_on_a_repeated_cursor_and_at_the_page_bound() {
        let page = |tool: &str, next: Option<&str>| (vec![json!({"name": tool})], next.map(str::to_owned));
        let mut walk = ToolPages::default();
        assert!(walk.take(page("a", Some("c1"))));
        assert_eq!(walk.cursor.as_deref(), Some("c1"));
        assert!(walk.take(page("b", Some("c2"))));
        assert!(!walk.take(page("c", Some("c1"))), "c1 was followed already");
        assert_eq!(walk.tools.len(), 3, "the repeated page's tools are kept");

        let mut walk = ToolPages::default();
        assert!(!walk.take(page("only", None)));
        assert!(!ToolPages::default().take(page("blank", None)));

        let mut walk = ToolPages::default();
        for n in 1..MAX_TOOL_PAGES {
            assert!(walk.take(page("t", Some(&format!("c{n}")))), "page {n} is followed");
        }
        assert!(!walk.take(page("t", Some("one more"))), "the hundredth page is the last");
        assert_eq!(walk.tools.len(), MAX_TOOL_PAGES);
    }

    /// Node's `mcpServerTools` keeps an external tool's name, description, `inputSchema` and
    /// `annotations` (the title only inside them) and nothing else: a top-level `title` or
    /// `trigger` a server lists is not sent to the model, so the entry has nowhere to hold one.
    #[test]
    fn an_external_tool_keeps_what_nodes_session_list_keeps() {
        let listed = [json!({
            "name": "lookup", "title": "Lookup", "trigger": "when asked",
            "description": "d", "inputSchema": {"type": "object"}, "annotations": {"title": "Lookup", "readOnlyHint": true},
        })];
        let catalog = build_catalog("srv", &listed, &json!({}));
        let entry = &catalog.entries[0];
        assert_eq!((entry.description.as_str(), &entry.input_schema), ("d", &json!({"type": "object"})));
        assert_eq!((entry.annotations.title.as_deref(), entry.annotations.read_only_hint), (Some("Lookup"), Some(true)));
    }

    /// Node's `mcpFeatureTools` (`features.test.mjs`): a server that advertises resources and prompts lists their five
    /// requests after its own tools, under Node's names and schemas; a name one of its own tools holds is taken with `_`
    /// appended. A server that advertises neither lists none.
    #[test]
    fn advertised_resources_and_prompts_are_listed_after_the_servers_tools() {
        let listed = [json!({"name": "mixdog_read_resource"})];
        let catalog = build_catalog("catalog", &listed, &json!({"resources": {}, "prompts": {}}));
        let names: Vec<&str> = catalog.entries.iter().map(|entry| entry.qualified.as_str()).collect();
        assert_eq!(
            names,
            [
                "mcp__catalog__mixdog_read_resource",
                "mcp__catalog__mixdog_list_resources",
                "mcp__catalog__mixdog_list_resource_templates",
                "mcp__catalog__mixdog_read_resource_",
                "mcp__catalog__mixdog_list_prompts",
                "mcp__catalog__mixdog_get_prompt",
            ]
        );
        assert_eq!((catalog.entries[0].feature, catalog.entries[3].feature), (None, Some(Feature::ReadResource)));
        assert_eq!(
            catalog.entries[3].input_schema,
            json!({
                "type": "object",
                "properties": {"uri": {"type": "string", "description": "Resource URI returned by the server."}},
                "required": ["uri"],
                "additionalProperties": false,
            })
        );
        assert!(build_catalog("catalog", &[], &json!({"tools": {}})).entries.is_empty());
    }
}
