//! One MCP server connection (T §4 target 1). The state machine
//! `Starting → Ready{catalog} → Failed{cause} → Closed` moves only on transport facts and
//! explicit commands (`connect`, `reconnect`, `close`); nothing retries on a timer. The call path
//! reads the published state and takes this server's own admission gate — no lock is shared with
//! any other server.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;

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
use crate::result::OutputPolicy;
use crate::result::ReportedError;
use crate::result::Spiller;
use crate::result::map_call_result;
use crate::rpc::RequestOptions;
use crate::rpc::RpcClient;
use crate::rpc::RpcError;
use crate::sse::SseTransport;
use crate::stdio::StdioSpec;
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
    /// The server's own name for the tool; what `tools/call` carries.
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: ToolAnnotations,
    /// The tool's `outboundHint: true` annotation: it opts in as an outbound message.
    pub outbound_hint: bool,
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
}

pub struct McpServer {
    config: McpServerConfig,
    state: watch::Sender<Arc<ServerState>>,
    gate: Arc<AdmissionGate>,
    spiller: Spiller,
    policy: OutputPolicy,
    secrets: Vec<String>,
    io: McpIo,
    authorizer: Option<Arc<dyn Authorizer>>,
    generation: AtomicU64,
    connecting: AtomicBool,
    shutdown: CancellationToken,
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

pub(crate) fn build_catalog(server: &str, tools: &[Value]) -> ToolCatalog {
    let digest = Sha256::digest(serde_json::to_vec(tools).unwrap_or_default());
    let entries = tools
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
            }))
        })
        .collect();
    ToolCatalog { digest: digest.iter().map(|b| format!("{b:02x}")).collect(), entries }
}

/// Follows `nextCursor` to the end: a server returning many pages is a server fact.
async fn list_tools(client: &RpcClient) -> Result<Vec<Value>, RpcError> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => json!({"cursor": c}),
            None => json!({}),
        };
        let page = client.request("tools/list", params, RequestOptions::default()).await?;
        if let Some(items) = page.get("tools").and_then(Value::as_array) {
            tools.extend(items.iter().cloned());
        }
        match page.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => cursor = Some(next.to_owned()),
            _ => return Ok(tools),
        }
    }
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
            spiller,
            policy,
            secrets,
            io,
            authorizer,
            generation: AtomicU64::new(0),
            connecting: AtomicBool::new(false),
            shutdown: CancellationToken::new(),
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

    pub fn state(&self) -> Arc<ServerState> {
        Arc::clone(&self.state.borrow())
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<ServerState>> {
        self.state.subscribe()
    }

    /// The tool catalog while the server is ready.
    pub fn catalog(&self) -> Option<Arc<ToolCatalog>> {
        match &*self.state() {
            ServerState::Ready(ready) => Some(Arc::clone(&ready.catalog)),
            _ => None,
        }
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
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.state.send_replace(Arc::new(ServerState::Starting));
        let opened: Mutex<Option<Arc<RpcClient>>> = Mutex::new(None);
        let outcome = match mixdog_rt::time::timeout(self.config.startup_timeout, self.handshake(&opened)).await {
            Ok(result) => result,
            Err(_) => Err(ConnectError::StartupTimeout {
                name: self.config.name.clone(),
                ms: self.config.startup_timeout.as_millis(),
            }),
        };
        match outcome {
            Ok(ready) => {
                let client = Arc::clone(&ready.client);
                self.publish(generation, ServerState::Ready(Arc::new(ready)));
                self.watch(generation, client);
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
        let init = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
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
            catalog: Arc::new(build_catalog(&self.config.name, &tools)),
            outputs: Arc::new(outputs),
            client,
            capabilities,
            instructions: init.get("instructions").and_then(Value::as_str).map(str::to_owned),
        })
    }

    /// Follows one connection: its end is the `Failed` transition, `list_changed` re-lists.
    fn watch(self: &Arc<Self>, generation: u64, client: Arc<RpcClient>) {
        let server = Arc::clone(self);
        mixdog_rt::spawn("mcp.server.watch", TaskClass::Work, async move {
            let mut closed = client.closed();
            loop {
                tokio::select! {
                    () = async { let _ = closed.wait_for(Option::is_some).await; } => break,
                    () = client.tools_changed() => server.relist(generation, &client).await,
                }
            }
            // `getMcpServerStatus`: a dead connection reads `MCP server "<name>" closed` and the stderr tail.
            let tail = closed.borrow().as_ref().map(|c| c.stderr_tail.clone()).unwrap_or_default();
            let cause = append_stderr_tail(&format!("MCP server \"{}\" closed", server.name()), &tail);
            let cause = scrub(&cause, &server.secrets);
            server.publish(generation, ServerState::Failed { cause });
        });
    }

    async fn relist(&self, generation: u64, client: &Arc<RpcClient>) {
        let listed = mixdog_rt::time::timeout(self.config.startup_timeout, list_tools(client)).await;
        let tools = match listed {
            Ok(Ok(tools)) => tools,
            Ok(Err(error)) => return tracing::warn!(server = self.name(), %error, "tools/list failed after list_changed"),
            Err(_) => return tracing::warn!(server = self.name(), "tools/list timed out after list_changed"),
        };
        let catalog = build_catalog(&self.config.name, &tools);
        let current = self.state();
        let ServerState::Ready(ready) = &*current else { return };
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
        self.gate.close(&format!("MCP {} closed", self.name()));
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

    /// A protocol request outside `tools/call` (resources, prompts) with the call timeout.
    pub async fn request(&self, method: &str, params: Value, cancel: &CancellationToken) -> Result<Value, CallError> {
        let ready = self.ready()?;
        let options = RequestOptions {
            idle_timeout: self.config.call_timeout,
            max_total: self.config.max_total_timeout,
            cancel: Some(cancel),
        };
        Ok(ready.client.request(method, params, options).await?)
    }

    /// Calls `tool` (the server's own name). `owner` identifies the caller for fair admission.
    pub async fn call_tool(
        &self,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let ready = self.ready()?;
        if !ready.catalog.entries.iter().any(|e| e.tool == tool) {
            return Err(CallError::UnknownTool { server: self.name().to_owned(), tool: tool.to_owned() });
        }
        self.call_ready(&ready, owner, tool, arguments, cancel, deadline).await
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
        self.call_ready(&ready, owner, tool, arguments, cancel, deadline).await
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
        self.settle(&ready, owner, tool, arguments, cancel, deadline).await
    }

    async fn call_ready(
        &self,
        ready: &Ready,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<ToolOutput, CallError> {
        let result = self.settle(ready, owner, tool, arguments, cancel, deadline).await?;
        map_call_result(&result, self.policy, &self.spiller)
            .await
            .map_err(|mut reported| {
                reported.text = scrub(&reported.text, &self.secrets);
                CallError::Reported(reported)
            })
    }

    async fn settle(
        &self,
        ready: &Ready,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Value, CallError> {
        let permit = self.gate.acquire(owner, cancel, self.config.wait_timeout).await?;
        let from_deadline = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let max_total = match (self.config.max_total_timeout, from_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let options = RequestOptions { idle_timeout: self.config.call_timeout, max_total, cancel: Some(cancel) };
        let result = ready
            .client
            .request("tools/call", json!({"name": tool, "arguments": arguments}), options)
            .await;
        drop(permit);
        self.checked(ready, tool, result?, cancel).await
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

    use super::build_catalog;

    /// Node's `mcpServerTools` keeps an external tool's name, description, `inputSchema` and
    /// `annotations` (the title only inside them) and nothing else: a top-level `title` or
    /// `trigger` a server lists is not sent to the model, so the entry has nowhere to hold one.
    #[test]
    fn an_external_tool_keeps_what_nodes_session_list_keeps() {
        let listed = [json!({
            "name": "lookup", "title": "Lookup", "trigger": "when asked",
            "description": "d", "inputSchema": {"type": "object"}, "annotations": {"title": "Lookup", "readOnlyHint": true},
        })];
        let catalog = build_catalog("srv", &listed);
        let entry = &catalog.entries[0];
        assert_eq!((entry.description.as_str(), &entry.input_schema), ("d", &json!({"type": "object"})));
        assert_eq!((entry.annotations.title.as_deref(), entry.annotations.read_only_hint), (Some("Lookup"), Some(true)));
    }
}
