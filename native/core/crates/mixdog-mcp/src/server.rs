//! One MCP server connection (T §4 target 1). The state machine
//! `Starting → Ready{catalog} → Failed{cause} → Closed` moves only on transport facts and
//! explicit commands (`connect`, `reconnect`, `close`); nothing retries on a timer. The call path
//! reads the published state and takes this server's own admission gate (on a connection the scopes
//! share, the calling scope's) — no lock is shared with any other server.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
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
use crate::stdio::StdioTransport;
use crate::tools::Feature;
use crate::transport::Authorizer;
use crate::transport::IncomingRx;
use crate::transport::Transport;
use crate::transport::TransportError;
use crate::transport::append_stderr_tail;
use crate::ws::WebSocketTransport;

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
    pub(crate) tools: Vec<Value>,
    pub(crate) calls: Calls,
}

/// The calls running on one connection: a connection a reconnect replaced is closed once they ended.
#[derive(Clone)]
pub(crate) struct Calls(Arc<watch::Sender<usize>>);

impl Default for Calls {
    fn default() -> Self {
        Self(Arc::new(watch::channel(0).0))
    }
}

impl Calls {
    fn begin(&self) -> Running {
        self.0.send_modify(|running| *running += 1);
        Running(self.clone())
    }

    async fn ended(&self) {
        let _ = self.0.subscribe().wait_for(|running| *running == 0).await;
    }
}

struct Running(Calls);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.0.send_modify(|running| *running -= 1);
    }
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
    /// Nothing was dialled: the server is known to need a sign-in that is not stored. `reported`: that was known before.
    #[error("{}", TransportError::AuthRequired)]
    SignInAbsent { reported: bool },
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
    /// The call sat without progress past the server's call timeout (`runMcpRequest`'s `timeoutMessage`).
    #[error("{0}")]
    TimedOut(String),
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
    /// The Gmail app-password server of this process, for a server whose address is its reserved one.
    gmail: std::sync::OnceLock<Arc<crate::gmail_app_password::GmailMcp>>,
    accounts: std::sync::OnceLock<Arc<crate::connector_transport::AccountGroup>>,
    generation: AtomicU64,
    connecting: tokio::sync::Semaphore,
    opening: Mutex<Option<Arc<RpcClient>>>,
    shutdown: CancellationToken,
    stopped: CancellationToken,
    /// Ownership barriers inherited by a same-name replacement, including any skipped generations.
    pub(crate) predecessors: std::sync::OnceLock<Vec<CancellationToken>>,
    /// The running connect attempt and the starts it answers; see [`Attempts`].
    attempts: Mutex<Attempts>,
    /// The latest hub-scheduled start, written only under `attempts`: it ends with the attempt that answers it.
    scheduled: ArcSwapOption<CancellationToken>,
    #[cfg(feature = "test-support")]
    holds: Mutex<Vec<(ConnectStep, Arc<ConnectHold>)>>,
    /// The folder of the server's scope now, which a server that follows its scope advertises as its root
    /// (`_scopeRoots`, mcp/client.mjs:79); empty: none set.
    scope_root: Arc<Mutex<String>>,
    /// The connection the server was ready on, once that connection ended by itself (Node keeps such a server registered
    /// with `liveness.alive === false`, with the tools, capabilities and instructions it had): a call finds no connection
    /// to send on, and reconnects. Cleared when a connect settles.
    died: ArcSwapOption<Ready>,
    /// One failure-driven reconnect at a time (`reconnects.run(registryKey, …)`).
    reconnecting: tokio::sync::Semaphore,
    /// The service advert the last connect of an `autoDetect` server dialled: the one a refused connect distrusts.
    advert: Mutex<Option<crate::config::AutoDetectAdvert>>,
    /// The connection an explicit reconnect ended to start the server's process again.
    restarted: ArcSwapOption<RpcClient>,
    /// The closing of each connection a reconnect replaced, which a close of the server waits for.
    retired: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Test seam: the transport that serves a server whose identity (`config`) is a remote one, so a replay can drive the real
    /// call path of a server the core never reaches over the network.
    #[cfg(feature = "test-support")]
    stand_in: Option<TransportConfig>,
}

#[derive(Default)]
struct CallDelivery {
    account: Option<mixdog_core_api::domain::tool::ConnectorAccountBinding>,
    progress: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    unlisted: bool,
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

#[cfg(test)]
mod retire_tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    struct Counted {
        closes: AtomicUsize,
        _incoming: crate::transport::IncomingTx,
    }

    #[async_trait::async_trait]
    impl Transport for Counted {
        async fn send(&self, _: Value, _: mixdog_rt::Liveness) -> Result<(), TransportError> {
            Ok(())
        }
        async fn close(&self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// The close of a server began (its first step: the shutdown is signalled) before a reconnect of the ready server
    /// reached the point where it would start closing the connection it replaces. The reconnect starts no closing: none
    /// can then be pending when the close, which ends the connection itself, says the server stopped.
    #[tokio::test]
    async fn a_reconnect_that_comes_once_the_close_began_starts_no_closing_of_its_own() {
        let tokens = mixdog_rt::testing::tokens();
        let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
        let config = McpServerConfig::from_entry("fx", &json!({"url": "http://127.0.0.1:9/mcp"}), &Default::default()).unwrap();
        let server = McpServer::new(config, io, Spiller::new(std::env::temp_dir(), io.durability), OutputPolicy::default(), None);
        let (incoming, rx) = tokio::sync::mpsc::unbounded_channel();
        let transport = Arc::new(Counted { closes: AtomicUsize::new(0), _incoming: incoming });
        let ready = Ready {
            client: RpcClient::start(transport.clone(), rx),
            catalog: Arc::new(build_catalog("fx", &[], &json!({}))),
            outputs: Arc::new(OutputValidators::of(&[]).unwrap()),
            capabilities: Value::Null,
            instructions: None,
            tools: Vec::new(),
            calls: Calls::default(),
        };
        server.state.send_replace(Arc::new(ServerState::Ready(Arc::new(ready))));

        server.shutdown.cancel();
        let reconnected = server.reconnect().await;
        assert!(matches!(reconnected, Err(ConnectError::Closed)), "{reconnected:?}");
        assert!(server.retired.lock().unwrap().is_empty(), "no closing was started behind the close");
        assert_eq!(transport.closes.load(Ordering::SeqCst), 0, "the connection is the close's to end");

        server.close().await;
        assert_eq!(transport.closes.load(Ordering::SeqCst), 1, "and the close ended it before it returned");
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

/// A server's connect attempt, and the hub-scheduled starts it answers.
///
/// The invariant: for every reader, "this attempt's outcome is published", "this attempt can no longer be joined" and
/// "the starts it answers have ended" are one step ([`McpServer::end_attempt`]), and so are "an attempt runs", "the state
/// is `Starting`" and "the ready connection it replaces left the state" (`McpServer::attempt`); both steps hold this
/// lock. Readers:
/// - `attempt` (and `join_attempt` through it) decides under the lock: an attempt that runs has published no
///   outcome, so the caller joins it and is answered by it; one whose outcome is published has ended, so the caller
///   begins its own attempt, which asks the server.
/// - `McpServer::schedule_start` (the hub's `apply_retrying`) decides under the lock: the last start is alive only
///   while the attempt answering it has published nothing, or before its connect began or joined one, so it is
///   answered by a connect that began after the state the hub read; an ended start is replaced by one that asks.
/// - Waiters on a start or an attempt (`AccountGroup::initialize`, `McpGlue::account_connect_settled`,
///   `McpHub::pending_starts` for `ScopeRuntime::follow_pending`, `join_attempt`) are released by a cancel made after the
///   publish, so the state they read is the outcome or a later one.
/// - A ready connection leaves the state only in a claim (`McpServer::attempt`) that retires it, decided in the same
///   step that reads it and begins the attempt (publishing `Starting` and moving the generation on), by the
///   connection's identity ([`Retire`]: its client), not by the `Ready` value a relist may have replaced: `reconnect`
///   retires whichever is ready, `reconnect_after` only the connection its call found failed. The retiring caller
///   closes it (`McpServer::retire`). Any other claim that finds a live ready connection is answered by it and ends its
///   start there (that connection's attempt began after the failure the start was scheduled for); one being retired is
///   never found, as the state is already `Starting` and the claim joins the attempt.
/// - Every change of the generation (a claim, a connect that connects again, `close_because`) and every check of it
///   with the write it guards (an outcome, a relist, a connection's end) is made under the lock: a relist publishes only
///   over the value it was made from, and the watcher publishes a connection's end only while that connection, by
///   identity, is the state's.
/// - A reader of the state alone sees no outcome before the attempt's last connect: one that connects again under a new
///   sign-in publishes nothing for the connection it replaces, and is one start until its last connect.
/// - Shutdown (`close_because`) publishes `Closed` under the lock after cancelling `shutdown`: an attempt begun before it
///   ends without an outcome of its own, and none begins after it; a removed server is closed the same way.
#[derive(Default)]
struct Attempts {
    /// Ends with the running attempt; `None`: none runs.
    running: Option<CancellationToken>,
    /// The scheduled starts the running attempt answers.
    answers: Vec<CancellationToken>,
}

impl Attempts {
    fn end(&mut self) {
        if let Some(ended) = self.running.take() {
            ended.cancel();
        }
        for start in self.answers.drain(..) {
            start.cancel();
        }
    }
}

/// Which ready connection a claim takes out of the state, by the connection's identity (its client), whatever value a
/// relist published for it since.
#[derive(Clone, Copy)]
enum Retire<'a> {
    /// None: a ready connection answers the caller (`connect`, a hub start).
    Nothing,
    /// Whichever is ready (an explicit `reconnect`).
    Any,
    /// Only the one a call found failed (`reconnect_after`); another ready one answers the call.
    Connection(Option<&'a Arc<RpcClient>>),
}

impl Retire<'_> {
    fn takes(self, client: &Arc<RpcClient>) -> bool {
        match self {
            Self::Nothing => false,
            Self::Any => true,
            Self::Connection(failed) => failed.is_some_and(|failed| Arc::ptr_eq(failed, client)),
        }
    }
}

/// How [`McpServer::end_attempt`] ended.
enum Settled {
    /// The connect connects again first; nothing was published.
    Again,
    Published,
    /// A close moved the generation on first: the outcome was not published.
    Stale,
}

/// Ends the attempt `ended` names if it left without [`McpServer::end_attempt`].
struct AttemptEnded<'a> {
    server: &'a McpServer,
    ended: CancellationToken,
}

impl Drop for AttemptEnded<'_> {
    fn drop(&mut self) {
        if self.ended.is_cancelled() {
            return;
        }
        let mut attempts = self.server.attempts();
        if !self.ended.is_cancelled() {
            attempts.end();
        }
    }
}

/// Where a test holds a connect attempt (feature `test-support`).
#[cfg(feature = "test-support")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectStep {
    /// The connect waited for its predecessors and has not looked at the attempt yet.
    BeforeClaim,
    /// The claim took a ready connection out of the state; it is not closed yet.
    Retiring,
    /// A relist has its listing and has not taken the attempt lock to publish it.
    BeforeRelist,
    /// Inside the relist's publish step, after its check: the thread waits with the attempt lock held.
    InRelist,
    /// The relist's publish step is done, published or dropped.
    AfterRelist,
    /// The handshake settled and was checked; the step that ends the attempt has not begun.
    BeforeOutcome,
    /// Inside that step, between its statements: the thread waits with the attempt lock held.
    InOutcome,
    /// The step is done; the connect has not returned.
    AfterOutcome,
}

/// A connect held at a [`ConnectStep`] until released.
#[cfg(feature = "test-support")]
#[derive(Default)]
pub struct ConnectHold {
    pub reached: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
    resume: tokio::sync::Notify,
}

#[cfg(feature = "test-support")]
impl ConnectHold {
    pub fn release(&self) {
        *self.released.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
        self.resume.notify_one();
    }
}

#[cfg(feature = "test-support")]
impl McpServer {
    /// The next connect attempt of the server to reach `at` waits there until the hold is released.
    pub fn hold_connect(&self, at: ConnectStep) -> Arc<ConnectHold> {
        let hold = Arc::new(ConnectHold::default());
        self.holds.lock().unwrap_or_else(|e| e.into_inner()).push((at, Arc::clone(&hold)));
        hold
    }

    fn take_hold(&self, at: ConnectStep) -> Option<Arc<ConnectHold>> {
        let mut holds = self.holds.lock().unwrap_or_else(|e| e.into_inner());
        let index = holds.iter().position(|(step, _)| *step == at)?;
        Some(holds.remove(index).1)
    }

    async fn hold(&self, at: ConnectStep) {
        if let Some(hold) = self.take_hold(at) {
            hold.reached.notify_one();
            hold.resume.notified().await;
        }
    }

    fn hold_blocking(&self, at: ConnectStep) {
        if let Some(hold) = self.take_hold(at) {
            hold.reached.notify_one();
            let mut released = hold.released.lock().unwrap_or_else(|e| e.into_inner());
            while !*released {
                released = hold.wake.wait(released).unwrap_or_else(|e| e.into_inner());
            }
        }
    }
}

impl McpServer {
    pub fn new(config: McpServerConfig, io: McpIo, spiller: Spiller, policy: OutputPolicy, authorizer: Option<Arc<dyn Authorizer>>) -> Arc<Self> {
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
            gmail: std::sync::OnceLock::new(),
            accounts: std::sync::OnceLock::new(),
            generation: AtomicU64::new(0),
            connecting: tokio::sync::Semaphore::new(1),
            opening: Mutex::new(None),
            shutdown: CancellationToken::new(),
            stopped: CancellationToken::new(),
            predecessors: std::sync::OnceLock::new(),
            attempts: Mutex::new(Attempts::default()),
            scheduled: ArcSwapOption::empty(),
            #[cfg(feature = "test-support")]
            holds: Mutex::new(Vec::new()),
            scope_root: Arc::default(),
            died: ArcSwapOption::empty(),
            reconnecting: tokio::sync::Semaphore::new(1),
            advert: Mutex::new(None),
            restarted: ArcSwapOption::empty(),
            retired: Mutex::new(Vec::new()),
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

    /// Publishes `state` if `generation` is still the server's. The caller holds the attempt lock, under which every
    /// change of the generation is made, so the check and the send are one step.
    fn publish_locked(&self, generation: u64, state: ServerState) -> bool {
        if self.generation.load(Ordering::Acquire) != generation {
            return false;
        }
        self.state.send_replace(Arc::new(state));
        true
    }

    /// Bumps the generation and publishes `Starting`, under the attempt lock the caller holds.
    fn restart_locked(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.state.send_replace(Arc::new(ServerState::Starting));
        generation
    }

    fn attempts(&self) -> std::sync::MutexGuard<'_, Attempts> {
        self.attempts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The completion of the hub's latest scheduled start: it ends with the outcome of the connect that answers it,
    /// published before it ends.
    pub fn scheduled_start(&self) -> Option<CancellationToken> {
        self.scheduled.load_full().map(|start| CancellationToken::clone(&start))
    }

    /// A start for the hub to run through [`Self::connect_answering`]; `None` while the last one is not answered (its
    /// connect begins, or joins an attempt, after this call). Decided under the attempt lock, so a start whose outcome
    /// a caller read is ended here, and the start returned then asks the server.
    pub(crate) fn schedule_start(&self) -> Option<CancellationToken> {
        let _attempts = self.attempts();
        if self.scheduled.load().as_ref().is_some_and(|start| !start.is_cancelled()) {
            return None;
        }
        let start = CancellationToken::new();
        self.scheduled.store(Some(Arc::new(start.clone())));
        Some(start)
    }

    /// Connects, handshakes and lists tools. Concurrent callers share one attempt; a server found ready answers the call.
    pub async fn connect(self: &Arc<Self>) -> Result<(), ConnectError> {
        self.attempt(None, Retire::Nothing).await
    }

    /// [`Self::connect`] that answers hub-scheduled `start`: it ends with the outcome of the attempt this call begins or
    /// joins, or here when the server is found ready.
    pub(crate) async fn connect_answering(self: &Arc<Self>, start: Option<CancellationToken>) -> Result<(), ConnectError> {
        self.attempt(start, Retire::Nothing).await
    }

    /// Joins the running attempt, is answered by the ready connection `retire` does not take, or begins an attempt,
    /// taking out of the state the ready connection it retires; see [`Attempts`] for the step this decides in.
    async fn attempt(self: &Arc<Self>, start: Option<CancellationToken>, retire: Retire<'_>) -> Result<(), ConnectError> {
        if !self.wait_for_predecessors().await {
            return Err(ConnectError::Closed);
        }
        #[cfg(feature = "test-support")]
        self.hold(ConnectStep::BeforeClaim).await;
        enum Claim {
            Join(CancellationToken),
            Closed,
            Answered,
            Begun(CancellationToken, u64, Option<Arc<Ready>>),
        }
        let claimed = {
            let mut attempts = self.attempts();
            let current = self.state();
            let ready = match &*current {
                ServerState::Ready(ready) => Some(ready),
                _ => None,
            };
            if let Some(ended) = attempts.running.clone() {
                attempts.answers.extend(start);
                Claim::Join(ended)
            } else if self.shutdown.is_cancelled() {
                Claim::Closed
            } else if let Some(ready) = ready
                && !ready.client.is_closed()
                && !retire.takes(&ready.client)
            {
                if let Some(start) = start {
                    start.cancel();
                }
                Claim::Answered
            } else {
                let ended = CancellationToken::new();
                attempts.running = Some(ended.clone());
                attempts.answers.extend(start);
                Claim::Begun(ended, self.restart_locked(), ready.cloned())
            }
        };
        let (ended, mut generation, retired) = match claimed {
            Claim::Begun(ended, generation, retired) => (ended, generation, retired),
            Claim::Join(running) => return Self::join_attempt(&self.subscribe(), &running).await,
            Claim::Closed => return Err(ConnectError::Closed),
            Claim::Answered => return Ok(()),
        };
        // An attempt that leaves without an outcome (closed meanwhile) still ends, so nothing waits on it.
        let _ended = AttemptEnded { server: self, ended };
        let _swapped = match retired {
            Some(ready) => self.retire(ready).await?,
            None => None,
        };
        let _attempt = self.connecting.acquire().await.expect("the connect gate is never closed");
        if self.shutdown.is_cancelled() {
            return Err(ConnectError::Closed);
        }
        // `missingEnvWarnings` logs what the configuration could not resolve at every connect.
        for warning in &self.config.warnings {
            crate::config::mcp_log(&format!("[mcp-client] \"{}\": {warning}", self.config.name));
        }
        let opened = &self.opening;
        // The namespace owns no remote handshake: each private connection has its own
        // startup deadline, and the namespace waits only for one usable account.
        let startup_timeout = if self.accounts.get().is_some() { None } else { self.config.startup_timeout };
        // A connection is the sign-in it was opened as. One opened as a sign-in that is no longer the stored one is not
        // the server's connection, whatever its handshake came to: it is closed and the server connects again.
        let mut first = true;
        loop {
            if !std::mem::take(&mut first) {
                let _attempts = self.attempts();
                generation = self.restart_locked();
            }
            if let Some(cause) = &self.config.blocked {
                let cause = scrub(cause, &self.secrets);
                crate::config::daemon_line(&format!("[mcp-server] name={} connect failed (blocked by config): {cause}", self.name()));
                self.died.store(None);
                self.end_attempt(generation, ServerState::Failed { cause: cause.clone() }, || false).await;
                #[cfg(feature = "test-support")]
                self.hold(ConnectStep::AfterOutcome).await;
                return Err(ConnectError::Failed(cause));
            }
            let handshake = async {
                match startup_timeout {
                    Some(budget) => match mixdog_rt::time::timeout(budget, self.handshake(opened)).await {
                        Ok(result) => result,
                        Err(_) => Err(ConnectError::StartupTimeout { name: self.config.name.clone(), ms: budget.as_millis() }),
                    },
                    // The budget is disabled: the handshake is not bounded, as Node arms no deadline for it.
                    None => self.handshake(opened).await,
                }
            };
            let outcome = tokio::select! {
                outcome = handshake => outcome,
                () = self.shutdown.cancelled() => Err(ConnectError::Closed),
            };
            let opening = opened.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(client) = opening.filter(|client| self.opened_as_replaced(client) && !self.shutdown.is_cancelled()) {
                opened.lock().unwrap_or_else(|e| e.into_inner()).take();
                client.close().await;
                continue;
            }
            // The connect settled: whatever connection died before it is replaced or given up, and its tools with it (a
            // failed replacement is unregistered, `replaceServerConnection`). Until here a call still finds the dead one
            // and waits for this connect with the others (`died`).
            self.died.store(None);
            match outcome {
                Ok(ready) => {
                    opened.lock().unwrap_or_else(|e| e.into_inner()).take();
                    let client = Arc::clone(&ready.client);
                    // `connectServer` (mcp/client.mjs:1501) follows `list_changed` only from a server that advertised it.
                    let follows = ready.capabilities.pointer("/tools/listChanged").is_some_and(truthy);
                    // Read again in the step that publishes the server ready: a sign-in stored since the check above is
                    // seen here, and this attempt connects again as one start; one stored after it finds the server
                    // ready, or the attempt ended, when its own reconnect looks.
                    let replaced = || self.opened_as_replaced(&client) && !self.shutdown.is_cancelled();
                    match self.end_attempt(generation, ServerState::Ready(Arc::new(ready)), replaced).await {
                        Settled::Again => {
                            client.close().await;
                            continue;
                        }
                        // A close took the state first: the connection never entered it and is closed here.
                        Settled::Stale => {
                            client.close().await;
                            return Err(ConnectError::Closed);
                        }
                        Settled::Published => {}
                    }
                    self.watch(generation, Arc::clone(&client), follows);
                    #[cfg(feature = "test-support")]
                    self.hold(ConnectStep::AfterOutcome).await;
                    return Ok(());
                }
                Err(error) => {
                    let client = opened.lock().unwrap_or_else(|e| e.into_inner()).take();
                    let cause = self.connect_failure(&error, client).await;
                    match error {
                        ConnectError::SignInAbsent { reported: true } => {}
                        ConnectError::SignInAbsent { reported: false } => {
                            crate::config::daemon_line(&format!("[mcp-server] name={} needs sign-in: not connecting until one is stored", self.name()));
                        }
                        _ => crate::config::daemon_line(&format!("[mcp-server] name={} connect failed: {cause}", self.name())),
                    }
                    self.end_attempt(generation, ServerState::Failed { cause: cause.clone() }, || false).await;
                    #[cfg(feature = "test-support")]
                    self.hold(ConnectStep::AfterOutcome).await;
                    return Err(ConnectError::Failed(cause));
                }
            }
        }
    }

    /// The step that ends the attempt with `outcome`, unless `again` says it connects again first. One lock, the one a
    /// connect takes to join or begin an attempt and the hub takes to schedule a start, covers the publish and the end of
    /// the attempt and of the starts it answers, so neither sees the outcome without the end or the end without the
    /// outcome; a waiter on either token is released after the publish, so it reads the outcome or a later state.
    async fn end_attempt(&self, generation: u64, outcome: ServerState, again: impl FnOnce() -> bool) -> Settled {
        #[cfg(feature = "test-support")]
        self.hold(ConnectStep::BeforeOutcome).await;
        let mut attempts = self.attempts();
        if again() {
            return Settled::Again;
        }
        let published = self.publish_locked(generation, outcome);
        #[cfg(feature = "test-support")]
        self.hold_blocking(ConnectStep::InOutcome);
        attempts.end();
        if published { Settled::Published } else { Settled::Stale }
    }

    /// The ready connection `ready` left the state in the claim of this caller's attempt, which closes it: a server this
    /// process runs at once (a call it cut says the server was restarted), any other once the calls on it ended, the
    /// guard returned marking the replacement made. Shut down meanwhile: it is closed now, and the attempt ends.
    async fn retire(&self, ready: Arc<Ready>) -> Result<Option<tokio_util::sync::DropGuard>, ConnectError> {
        #[cfg(feature = "test-support")]
        self.hold(ConnectStep::Retiring).await;
        if self.runs_a_process() {
            // A connection that already ended by itself was not restarted by this caller.
            if !ready.client.is_closed() {
                self.restarted.store(Some(Arc::clone(&ready.client)));
            }
            ready.client.close().await;
            return Ok(None);
        }
        // The closing is started and listed under the list's lock, which a close of the server takes after it began: a
        // close finds every closing a reconnect started, and a reconnect that comes once the close began closes its own.
        let swapped = CancellationToken::new();
        {
            let mut retired = self.retired.lock().unwrap_or_else(|e| e.into_inner());
            if !self.shutdown.is_cancelled() {
                let (shutdown, replaced) = (self.shutdown.clone(), swapped.clone());
                retired.retain(|task| !task.is_finished());
                retired.push(mixdog_rt::spawn("mcp.server.retire", TaskClass::Work, async move {
                    let drained = async {
                        replaced.cancelled().await;
                        ready.calls.ended().await;
                    };
                    tokio::select! {
                        () = drained => {}
                        () = shutdown.cancelled() => {}
                    }
                    ready.client.close().await;
                }));
                return Ok(Some(swapped.drop_guard()));
            }
        }
        ready.client.close().await;
        Err(ConnectError::Closed)
    }

    /// Whether `client`'s connection was opened as a sign-in that is not the stored one any more.
    fn opened_as_replaced(&self, client: &RpcClient) -> bool {
        match (&self.authorizer, client.transport().opened_as()) {
            (Some(authorizer), Some(opened_as)) => authorizer.sign_in() != opened_as,
            _ => false,
        }
    }

    /// The outcome of the attempt `ended` ends with, or of one that began after it.
    async fn join_attempt(rx: &watch::Receiver<Arc<ServerState>>, ended: &CancellationToken) -> Result<(), ConnectError> {
        ended.cancelled().await;
        let mut rx = rx.clone();
        let settled = match rx.wait_for(|s| !matches!(**s, ServerState::Starting)).await {
            Ok(state) => Arc::clone(&*state),
            Err(_) => return Err(ConnectError::Closed),
        };
        match &*settled {
            ServerState::Ready(_) => Ok(()),
            ServerState::Failed { cause } => Err(ConnectError::Failed(cause.clone())),
            _ => Err(ConnectError::Closed),
        }
    }

    /// The scrubbed cause of a failed handshake, with what the server wrote to stderr.
    async fn connect_failure(&self, error: &ConnectError, client: Option<Arc<RpcClient>>) -> String {
        let mut message = error.to_string();
        // A pid-live advert whose port refuses the connect is a corpse (a recycled pid): the next connect does
        // not trust it again (`runBoundedHandshake`).
        let code = match error {
            ConnectError::Transport(error) => error.os_code(),
            ConnectError::Rpc(RpcError::Transport(_, code)) => *code,
            _ => None,
        };
        if let Some(advert) = self.advert.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
            && code.is_some_and(crate::config::connection_refused)
        {
            crate::config::mark_service_unreachable(advert);
        }
        // A failed handshake carries what the server wrote to stderr (`runBoundedHandshake`), read once the
        // closed transport's stream ended, its last unterminated line included.
        if let Some(client) = client {
            client.close().await;
            message = append_stderr_tail(&message, &client.transport().stderr_tail());
        }
        scrub(&message, &self.secrets)
    }

    async fn open_transport(&self) -> Result<(Arc<dyn Transport>, IncomingRx), TransportError> {
        if let Some(accounts) = self.accounts.get() {
            return Ok(accounts.open());
        }
        if !self.config.accounts.is_empty() {
            return Err(TransportError::Other("connector account runtime is not configured".into()));
        }
        #[cfg(feature = "test-support")]
        let transport = self.stand_in.as_ref().unwrap_or(&self.config.transport);
        #[cfg(not(feature = "test-support"))]
        let transport = &self.config.transport;
        match transport {
            TransportConfig::Stdio { command, args, env, cwd, stderr } => {
                let (transport, rx) = StdioTransport::spawn(
                    self.io.spawn,
                    StdioSpec {
                        command,
                        args,
                        env,
                        cwd: cwd.as_deref(),
                        shutdown_grace: self.config.shutdown_grace,
                        name: self.name(),
                        secrets: &self.secrets,
                        stderr,
                        log: if crate::config::log_quiet() { None } else { crate::config::daemon_log() },
                    },
                )
                .await?;
                Ok((Arc::new(transport), rx))
            }
            // The advert is read at each connect (`createMcpTransport`): a service restarted on another port is found.
            TransportConfig::AutoDetect(target) => {
                let resolved = target.resolve(self.name());
                let advert = resolved.as_ref().ok().map(|(_, advert)| advert.clone());
                *self.advert.lock().unwrap_or_else(|e| e.into_inner()) = advert;
                let (url, _) = resolved.map_err(|error| TransportError::Other(error.to_string()))?;
                let (transport, rx) = HttpTransport::new(url, &std::collections::BTreeMap::new(), None)?;
                Ok((Arc::new(transport), rx))
            }
            TransportConfig::Http { url, headers } => {
                self.check_sign_in_client()?;
                let (transport, rx) = HttpTransport::new(url.clone(), headers, self.authorizer.clone())?;
                let transport = match self.gmail.get() {
                    Some(gmail) => transport.with_gmail(gmail.clone()),
                    // The reserved name never resolves: without the server there is nothing to dial.
                    None if crate::gmail_app_password::is_service(url) => {
                        tracing::error!(server = self.config.name, "the Gmail app-password server is not available in this build");
                        return Err(TransportError::Other("the Gmail app-password server is not available in this build".into()));
                    }
                    None => transport,
                };
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
        if let Some(authorizer) = &self.authorizer {
            let reported = authorizer.sign_in_required();
            if authorizer.sign_in_absent().await {
                return Err(ConnectError::SignInAbsent { reported });
            }
        }
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
        client.notify_and_wait("notifications/initialized", json!({})).await?;
        client.transport().initialized();
        let capabilities = init.get("capabilities").cloned().unwrap_or(Value::Null);
        let tools = if capabilities.get("tools").is_some_and(Value::is_object) { list_tools(&client).await? } else { Vec::new() };
        let outputs = OutputValidators::of(&tools).map_err(ConnectError::Failed)?;
        Ok(Ready {
            catalog: Arc::new(build_catalog(&self.config.name, &tools, &capabilities)),
            outputs: Arc::new(outputs),
            client,
            capabilities,
            instructions: init.get("instructions").and_then(Value::as_str).map(str::to_owned),
            tools,
            calls: Calls::default(),
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
            // One step with the check: the connection still the state's (same generation, same client) is the one that
            // died, and its end is published; one a claim retired meanwhile is no longer the state's.
            let ended = {
                let _attempts = server.attempts();
                let current = server.state();
                let ours = matches!(&*current, ServerState::Ready(ready) if Arc::ptr_eq(&ready.client, &client));
                if ours && server.generation.load(Ordering::Acquire) == generation {
                    server.died.store(server.connection());
                    server.publish_locked(generation, ServerState::Failed { cause: cause.clone() })
                } else {
                    false
                }
            };
            if ended {
                crate::config::daemon_line(&format!("[mcp-server] name={} connection ended: {cause}", server.name()));
            }
        });
    }

    /// Every page of `tools/list`; `None` (already logged) when one fails and the listing stays as it was.
    async fn list_all_pages(&self, client: &Arc<RpcClient>) -> Option<Vec<Value>> {
        // Node's refresh gives each page's request the call timeout (`runToolRefresh`, `listAllMcpTools`), whatever the
        // startup budget is; with the call timeout disabled a page is not bounded.
        let mut walk = ToolPages::default();
        loop {
            let page = list_page(client, walk.cursor.as_deref());
            let page = match self.config.call_timeout {
                Some(bound) => match mixdog_rt::time::timeout(bound, page).await {
                    Ok(page) => page,
                    Err(_) => {
                        tracing::warn!(server = self.name(), "tools/list timed out after list_changed");
                        return None;
                    }
                },
                None => page.await,
            };
            match page {
                Ok(page) => {
                    if !walk.take(page) {
                        return Some(walk.tools);
                    }
                }
                // `runToolRefresh` keeps the listing it had and logs this line.
                Err(PageError::Shape(text)) => {
                    crate::config::mcp_log(&format!("[mcp-client] Failed to refresh tools for \"{}\": {}", self.name(), scrub(&text, &self.secrets)));
                    return None;
                }
                Err(PageError::Rpc(error)) => {
                    tracing::warn!(server = self.name(), %error, "tools/list failed after list_changed");
                    return None;
                }
            }
        }
    }

    async fn relist(&self, generation: u64, client: &Arc<RpcClient>) {
        let Some(tools) = self.list_all_pages(client).await else { return };
        let current = self.state();
        let ServerState::Ready(ready) = &*current else { return };
        if !Arc::ptr_eq(&ready.client, client) {
            return;
        }
        let catalog = build_catalog(&self.config.name, &tools, &ready.capabilities);
        let instructions = self.accounts.get().map(|group| group.instructions()).or_else(|| ready.instructions.clone());
        if ready.catalog.digest == catalog.digest && ready.instructions == instructions {
            return;
        }
        // The SDK's `listTools` throws on schemas that do not resolve: the previous listing stays.
        let outputs = match OutputValidators::of(&tools) {
            Ok(outputs) => outputs,
            Err(error) => return tracing::warn!(server = self.name(), %error, "tools/list failed after list_changed"),
        };
        let relisted = ServerState::Ready(Arc::new(Ready {
            client: Arc::clone(&ready.client),
            catalog: Arc::new(catalog),
            outputs: Arc::new(outputs),
            capabilities: ready.capabilities.clone(),
            instructions,
            tools,
            calls: ready.calls.clone(),
        }));
        #[cfg(feature = "test-support")]
        self.hold(ConnectStep::BeforeRelist).await;
        // One step with the check: the listing replaces only the value it was made from, of this connection's
        // generation; a claim that took the connection out of the state, or a newer listing, drops it.
        {
            let _attempts = self.attempts();
            let unchanged = Arc::ptr_eq(&self.state(), &current);
            #[cfg(feature = "test-support")]
            self.hold_blocking(ConnectStep::InRelist);
            if unchanged {
                self.publish_locked(generation, relisted);
            }
        }
        #[cfg(feature = "test-support")]
        self.hold(ConnectStep::AfterRelist).await;
    }

    /// Connects again — an explicit command, never a timer. A server this process runs cannot run twice: its connection
    /// is ended first, and a call that cut says the server was restarted. Any other connection is replaced: it ends
    /// once the calls already on it ended, each by its own result or timeout.
    pub async fn reconnect(self: &Arc<Self>) -> Result<(), ConnectError> {
        self.attempt(None, Retire::Any).await
    }

    fn runs_a_process(&self) -> bool {
        #[cfg(feature = "test-support")]
        let transport = self.stand_in.as_ref().unwrap_or(&self.config.transport);
        #[cfg(not(feature = "test-support"))]
        let transport = &self.config.transport;
        self.accounts.get().is_none() && matches!(transport, TransportConfig::Stdio { .. })
    }

    pub async fn close(&self) {
        self.close_because("closed by a caller that gave no reason").await;
    }

    pub(crate) fn stopped(&self) -> CancellationToken {
        self.stopped.clone()
    }

    async fn wait_for_predecessors(&self) -> bool {
        let predecessors = self.predecessors.get().into_iter().flatten();
        tokio::select! {
            biased;
            () = self.shutdown.cancelled() => false,
            _ = futures::future::join_all(predecessors.map(|stopped| stopped.cancelled())) => true,
        }
    }

    /// [`close`](Self::close), leaving one `daemon.log` line that says what closed the server.
    pub async fn close_because(&self, why: &str) {
        crate::config::daemon_line(&format!("[mcp-server] name={} closed: {why}", self.name()));
        self.shutdown.cancel();
        // Startup owns the opening client until it publishes it or shuts it down on failure.
        let _attempt = self.connecting.acquire().await.expect("the connect gate is never closed");
        // Under the attempt lock: an attempt that begins after this step finds the server shut down, and one that began
        // before it published its `Starting` first.
        let attempts = self.attempts();
        self.generation.fetch_add(1, Ordering::AcqRel);
        let previous = self.state.send_replace(Arc::new(ServerState::Closed));
        drop(attempts);
        // A closed server lists nothing: the connection that ended by itself goes too.
        self.died.store(None);
        let opening = self.opening.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(client) = opening {
            client.close().await;
        }
        for account in self.account_servers() {
            Box::pin(account.close_because(&format!("its connector {} closed ({why})", self.name()))).await;
        }
        let reason = format!("MCP {} closed", self.name());
        self.gate.close(&reason);
        let holders: Vec<Arc<AdmissionGate>> = self.holder_gates.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, gate)| gate).collect();
        for gate in holders {
            gate.close(&reason);
        }
        if let ServerState::Ready(ready) = &*previous {
            ready.client.close().await;
        }
        let retired = std::mem::take(&mut *self.retired.lock().unwrap_or_else(|e| e.into_inner()));
        for closing in retired {
            let _ = closing.await;
        }
        self.stopped.cancel();
    }

    fn ready(&self) -> Result<Arc<Ready>, CallError> {
        match &*self.state() {
            ServerState::Ready(ready) => Ok(Arc::clone(ready)),
            other => Err(CallError::NotReady { server: self.name().to_owned(), state: other.describe() }),
        }
    }

    /// The Gmail app-password server that answers this server's reserved address (set by the hub before the first start).
    pub fn set_gmail(&self, gmail: Arc<crate::gmail_app_password::GmailMcp>) {
        let _ = self.gmail.set(gmail);
    }

    pub(crate) fn set_accounts(&self, accounts: Arc<crate::connector_transport::AccountGroup>) {
        let _ = self.accounts.set(accounts);
    }

    /// The connection the server holds: the one it is ready on, else the one it is opening.
    fn held_client(&self) -> Option<Arc<RpcClient>> {
        match &*self.state() {
            ServerState::Ready(ready) => Some(Arc::clone(&ready.client)),
            _ => self.opening.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }

    /// Whether the server holds a connection, ready or still opening, that was opened as a sign-in another one has
    /// replaced since or that was signed out: that connection keeps the sign-in it has, so the server needs a new one.
    pub(crate) fn sign_in_replaced(&self) -> bool {
        self.held_client().is_some_and(|client| self.opened_as_replaced(&client))
    }

    /// Lets go of a connection [`sign_in_replaced`](Self::sign_in_replaced) names: a ready server connects again; one
    /// still opening has that connection closed, and its connect starts over as the stored sign-in.
    pub(crate) async fn leave_replaced_sign_in(self: &Arc<Self>) {
        if matches!(&*self.state(), ServerState::Ready(_)) {
            let _ = self.reconnect().await;
            return;
        }
        let opening = self.opening.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(client) = opening.filter(|client| self.opened_as_replaced(client)) {
            client.close().await;
        }
    }

    pub(crate) fn sign_in_required(&self) -> bool {
        self.authorizer.as_ref().is_some_and(|authorizer| authorizer.sign_in_required())
    }

    pub(crate) fn connector_accounts(&self) -> Option<Arc<crate::connector_accounts::ConnectorAccounts>> {
        self.accounts.get().map(|group| group.choice.clone())
    }

    pub fn account_server(&self, name: &str) -> Option<Arc<Self>> {
        self.accounts.get()?.servers.iter().find(|server| server.name() == name).cloned()
    }

    pub(crate) fn account_servers(&self) -> Vec<Arc<Self>> {
        self.accounts.get().map(|group| group.servers.clone()).unwrap_or_default()
    }

    pub(crate) async fn call_account(
        self: &Arc<Self>,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        forward: Option<Arc<dyn Fn(Value) + Send + Sync>>,
    ) -> Result<Value, CallError> {
        // A failed initial handshake has no dead connection to recover. It is a fresh
        // per-server connect; live-connection failures use the shared call recovery below.
        if !self.is_dead() && matches!(&*self.state(), ServerState::Starting | ServerState::Failed { .. }) {
            let server = self.clone();
            let connecting = mixdog_rt::spawn("mcp.account.connect", TaskClass::Work, async move { server.connect().await });
            tokio::select! {
                connected = connecting => connected.map_err(|error| CallError::Recovery { message: error.to_string(), outcome_unknown: false })?
                    .map_err(|error| CallError::Recovery { message: error.to_string(), outcome_unknown: false })?,
                () = cancel.cancelled() => return Err(RpcError::Cancelled.into()),
            }
        }
        self.call_raw_through(&self.gate, owner, tool, arguments, cancel, None, &CallDelivery { progress: forward, unlisted: true, ..Default::default() }).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn call_tool_bound_in(
        self: &Arc<Self>,
        scope: Option<&str>,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
        account: Option<&mixdog_core_api::domain::tool::ConnectorAccountBinding>,
    ) -> Result<ToolOutput, CallError> {
        let gate = scope.map_or_else(|| self.gate.clone(), |scope| self.gate_in(scope));
        let delivery = CallDelivery { account: account.cloned(), ..Default::default() };
        let result = self.call_raw_through(&gate, owner, tool, arguments, cancel, deadline, &delivery).await?;
        self.map_output(&result).await
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
        let result = self.call_raw_through(gate, owner, tool, arguments, cancel, deadline, &CallDelivery::default()).await?;
        self.map_output(&result).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn call_raw_through(
        self: &Arc<Self>,
        gate: &Arc<AdmissionGate>,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
        delivery: &CallDelivery,
    ) -> Result<Value, CallError> {
        let ready = match self.ready() {
            Ok(ready) if !ready.client.is_closed() => ready,
            // The connection ended before the call: nothing to send on (the SDK's `Not connected`).
            Ok(ready) => {
                let tail = ready.client.transport().stderr_tail();
                return self.recover_call(gate, Some(Arc::clone(&ready.client)), None, tail, owner, tool, arguments, cancel, deadline, delivery).await;
            }
            Err(_) if self.is_dead() && !self.shutdown.is_cancelled() => {
                return self.recover_call(gate, None, None, String::new(), owner, tool, arguments, cancel, deadline, delivery).await;
            }
            Err(not_ready) => return Err(not_ready),
        };
        let request = self.request_of(&ready, tool, delivery)?;
        let first = match self.settle(gate, &ready, owner, request, arguments.clone(), cancel, deadline, delivery).await {
            Ok(output) => return Ok(output),
            Err(error) => error,
        };
        let tail = match &first {
            CallError::Rpc(RpcError::Closed(tail)) => Some(tail.clone()),
            CallError::Rpc(RpcError::Transport(..)) => Some(String::new()),
            _ => None,
        };
        let Some(tail) = tail.filter(|_| !cancel.is_cancelled()) else {
            return Err(first);
        };
        if self.restarted.load().as_ref().is_some_and(|ended| Arc::ptr_eq(ended, &ready.client)) {
            let message = format!(
                "Tool call failed: MCP server \"{}\" was restarted by an explicit reconnect while this call was running; the call was cut and was not replayed",
                self.name()
            );
            return Err(self.recovery_error(&message, true));
        }
        self.recover_call(gate, Some(Arc::clone(&ready.client)), Some(first.to_string()), tail, owner, tool, arguments, cancel, deadline, delivery).await
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
        delivery: &CallDelivery,
    ) -> Result<Value, CallError> {
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
            return Err(self.recovery_error(&message, !undelivered));
        }
        if !undelivered {
            let message = append_stderr_tail(
                &format!(
                    "Tool call failed: {first}; MCP server \"{}\" was reconnected for the next call, but this call was not replayed because the request may already have reached the server",
                    self.name()
                ),
                &tail,
            );
            return Err(self.recovery_error(&message, true));
        }
        // A reconnect that outlived the caller's cancel must not dispatch the replay.
        if cancel.is_cancelled() {
            return Err(RpcError::Cancelled.into());
        }
        let ready = self.ready()?;
        let request = self.request_of(&ready, tool, delivery)?;
        match self.settle(gate, &ready, owner, request, arguments, cancel, deadline, delivery).await {
            Err(retry @ (CallError::Rpc(_) | CallError::TimedOut(_))) if !matches!(retry, CallError::Rpc(RpcError::Cancelled)) && !cancel.is_cancelled() => {
                // The SDK's text of a JSON-RPC error (`McpError`); a timed-out replay is wrapped too (`retryMsg`).
                let (text, answered) = match &retry {
                    CallError::Rpc(RpcError::Server { code, message, .. }) => (format!("MCP error {code}: {message}"), true),
                    other => (other.to_string(), false),
                };
                let message = format!("Tool call failed: {first}; retry after reconnect also failed: {text}");
                Err(self.recovery_error(&message, !answered))
            }
            other => other,
        }
    }

    fn recovery_error(&self, message: &str, outcome_unknown: bool) -> CallError {
        CallError::Recovery { message: scrub(message, &self.secrets), outcome_unknown }
    }

    fn request_of<'a>(&self, ready: &Ready, tool: &'a str, delivery: &CallDelivery) -> Result<Request<'a>, CallError> {
        let request = if delivery.unlisted { Some(Request::Tool(tool)) } else { listed(ready, tool) };
        request.ok_or_else(|| CallError::UnknownTool { server: self.name().to_owned(), tool: tool.to_owned() })
    }

    /// `reconnectMcpServer` (mcp/client.mjs:432): replaces the connection `failed` was (`None`: the one that ended by
    /// itself), unless a peer already did (its replacement is reused) or the server was closed meanwhile (a failed call
    /// never brings back a server someone removed).
    pub(crate) async fn reconnect_after(self: &Arc<Self>, failed: Option<Arc<RpcClient>>) -> Result<(), String> {
        self.reconnect_after_answering(failed, None).await
    }

    /// [`Self::reconnect_after`] that answers hub-scheduled `start`: a start is asked for once its server's failure was
    /// read, so it connects again rather than sharing a peer's failure.
    pub(crate) async fn reconnect_after_answering(self: &Arc<Self>, failed: Option<Arc<RpcClient>>, start: Option<CancellationToken>) -> Result<(), String> {
        let _one = self.reconnecting.acquire().await.expect("the private reconnect admission gate is never closed");
        let disconnected = || format!("MCP server \"{}\" was disconnected", self.name());
        // Whether a peer's replacement answers this caller is decided in the claim, by the failed connection's identity.
        match &*self.state() {
            ServerState::Closed => return Err(disconnected()),
            // A peer's reconnect of the same connection already failed: this caller shares that failure.
            ServerState::Failed { cause } if !self.is_dead() && start.is_none() => return Err(cause.clone()),
            _ => {}
        }
        if self.shutdown.is_cancelled() {
            return Err(disconnected());
        }
        self.attempt(start, Retire::Connection(failed.as_ref())).await.map_err(|error| error.to_string())
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
        self.call_tool_unlisted_bound(owner, tool, arguments, cancel, deadline, None).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn call_tool_unlisted_bound(
        &self,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
        account: Option<&mixdog_core_api::domain::tool::ConnectorAccountBinding>,
    ) -> Result<ToolOutput, CallError> {
        let ready = self.ready()?;
        let delivery = CallDelivery { account: account.cloned(), ..Default::default() };
        let result = self.settle(&self.gate, &ready, owner, Request::Tool(tool), arguments, cancel, deadline, &delivery).await?;
        self.map_output(&result).await
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
        self.call_tool_settled_bound(owner, tool, arguments, cancel, deadline, None).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn call_tool_settled_bound(
        &self,
        owner: &str,
        tool: &str,
        arguments: Value,
        cancel: &CancellationToken,
        deadline: Option<Instant>,
        account: Option<&mixdog_core_api::domain::tool::ConnectorAccountBinding>,
    ) -> Result<Value, CallError> {
        let ready = self.ready()?;
        let delivery = CallDelivery { account: account.cloned(), ..Default::default() };
        self.settle(&self.gate, &ready, owner, Request::Tool(tool), arguments, cancel, deadline, &delivery).await
    }

    async fn map_output(&self, result: &Value) -> Result<ToolOutput, CallError> {
        map_call_result(result, self.policy, &self.spiller).await.map_err(|mut reported| {
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
        delivery: &CallDelivery,
    ) -> Result<Value, CallError> {
        if delivery.account.is_some() && self.accounts.get().is_none() {
            return Err(CallError::Recovery { message: "The approved connector account is no longer available.".into(), outcome_unknown: false });
        }
        let _running = ready.calls.begin();
        let permit = gate.acquire(owner, cancel, self.config.wait_timeout).await?;
        let from_deadline = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let max_total = match (self.config.max_total_timeout, from_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let options = RequestOptions { idle_timeout: self.config.call_timeout, max_total, cancel: Some(cancel) };
        let (method, params) = self.wire_request(request, arguments, owner, delivery);
        let result = ready.client.request_with_progress(method, params, options, delivery.progress.clone()).await;
        drop(permit);
        // The call's own deadline, worded as `runMcpRequest`'s caller words it (`executeMcpTool`, `_callMcpFeatureWithTimeout`).
        // The total cap ends the call the same way: Node's own timer is re-armed on a progress to no more than the cap's remainder, so
        // it fires at the cap with the same text (`mcpCallTimeout`). A cap that is the caller's deadline is not the call's own.
        let caller_bound = from_deadline.is_some_and(|d| self.config.max_total_timeout.is_none_or(|m| d < m));
        let result = result.map_err(|error| match (error, self.config.call_timeout) {
            (error @ (RpcError::IdleTimeout | RpcError::TotalTimeout), Some(limit)) if !(caller_bound && matches!(error, RpcError::TotalTimeout)) => {
                self.timed_out(request, limit)
            }
            (error, _) => CallError::Rpc(error),
        });
        match request {
            Request::Tool(tool) => self.checked(ready, tool, result?, cancel).await,
            // The server's answer, as the text of a call that succeeded.
            Request::Feature(_) => Ok(json!({"content": [{"type": "text", "text": mixdog_js::json_stringify_indent(&result?, 2)}], "isError": false})),
        }
    }

    fn wire_request(&self, request: Request<'_>, arguments: Value, owner: &str, delivery: &CallDelivery) -> (&'static str, Value) {
        match request {
            Request::Tool(tool) => {
                let mut params = json!({"name": tool, "arguments": arguments});
                if self.accounts.get().is_some() {
                    params["_meta"] = json!({"mixdog/conversation": owner});
                    if let Some(account) = &delivery.account {
                        params["_meta"]["mixdog/approved-account"] = json!({"name": account.name, "id": account.id});
                    }
                }
                ("tools/call", params)
            }
            Request::Feature(feature) => (feature.method(), feature.params(&arguments)),
        }
    }

    fn timed_out(&self, request: Request<'_>, limit: std::time::Duration) -> CallError {
        let (kind, field, name) = match request {
            Request::Tool(tool) => ("tool", "tool", tool),
            Request::Feature(feature) => ("feature", "operation", feature.operation()),
        };
        CallError::TimedOut(scrub(
            &format!("MCP {kind} call timed out after {}ms without progress (server=\"{}\", {field}=\"{name}\")", limit.as_millis(), self.name()),
            &self.secrets,
        ))
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
