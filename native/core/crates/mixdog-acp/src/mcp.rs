//! The tools a Mixdog session hands its agent: an MCP server of the session's own, which lists
//! the session's tool surface and passes every call to the session's turn, where it runs through
//! Mixdog's pipeline and is shown as any other call of a Mixdog tool.
//!
//! The server is one listener on the loopback interface for each session, started with the
//! session and closed the moment the session closes or its process ends, also where one process
//! serves several sessions. Its address carries no secret; every request must carry the bearer
//! token made for that one session, which only that session's `session/new` (or its reopen) is told.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use hyper::Method;
use hyper::Request;
use hyper::Response;
use hyper::StatusCode;
use hyper::body::Incoming as Body;
use hyper::header;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::handed::Handed;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_ai::providers::compat::schema::Rule;
use mixdog_ai::providers::compat::schema::wire_input_schema;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionReport;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::preset::Command;

/// What a session's agent is handed its tools with.
#[derive(Clone)]
pub struct Handover {
    pub thread: ThreadId,
    pub tools: Arc<dyn SessionTools>,
    /// The program an agent that takes no HTTP server runs as the server's stdio end.
    pub bridge: Option<Command>,
}

impl Handover {
    /// The names of the tools the session's server lists now, in its order.
    pub async fn listed(&self) -> Result<Vec<String>, String> {
        let definitions = self.tools.definitions(&self.thread).await?;
        let (tools, _) = repair_tools_for_gemini(definitions);
        Ok(tools.into_iter().filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned)).collect())
    }

    /// Deterministic digest of the session's current repaired `tools/list` surface.
    pub async fn current_digest(&self) -> Option<String> {
        let definitions = self.tools.definitions(&self.thread).await.ok()?;
        let (tools, _) = repair_tools_for_gemini(definitions);
        Some(tools_digest(&tools))
    }
}

/// Repairs each tool's `inputSchema` for Gemini/Neon wires (`Rule::Gemini`), excluding tools whose schema remains
/// invalid so one broken schema never causes the agent to reject the entire `tools/list`.
pub(crate) fn repair_tools_for_gemini(definitions: Vec<ToolDefinition>) -> (Vec<Value>, Vec<ToolExclusionReport>) {
    let mut tools = Vec::with_capacity(definitions.len());
    let mut excluded = Vec::new();
    for (index, tool) in definitions.into_iter().enumerate() {
        match wire_input_schema(&tool.input_schema, Rule::Gemini) {
            Ok(schema) => tools.push(json!({ "name": tool.name, "description": tool.description, "inputSchema": schema })),
            Err(problem) => {
                let message = format!("tool {} ({}): {}", tool.name, problem.pointer, problem.reason);
                excluded.push(ToolExclusionReport { name: tool.name, index, pointer: problem.pointer, reason: problem.reason, message });
            }
        }
    }
    (tools, excluded)
}

/// Validates a single tool's `inputSchema` against `Rule::Gemini` without mutating state or emitting warning logs.
pub(crate) fn check_tool_schema_for_gemini(tool: &ToolDefinition) -> Result<(), String> {
    wire_input_schema(&tool.input_schema, Rule::Gemini).map(|_| ()).map_err(|problem| problem.reason)
}

/// Recursively sorts JSON object keys so digests are invariant to `serde_json` `preserve_order` key ordering.
fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(a, _)| *a);
            let mut out = serde_json::Map::with_capacity(entries.len());
            for (key, val) in entries {
                out.insert(key.clone(), canonicalize_json(val));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        other => other.clone(),
    }
}

/// Order-independent digest over repaired `tools/list` entries so surface changes invalidate stale cached tool lists.
pub(crate) fn tools_digest(tools: &[Value]) -> String {
    let mut items: Vec<(String, String)> =
        tools.iter().map(|tool| (tool.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(), canonicalize_json(tool).to_string())).collect();
    items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let joined: String = items.into_iter().map(|(_, serialized)| serialized).collect::<Vec<_>>().join("\n");
    crate::session::digest(&joined)
}

/// Order-independent equality over excluded tools, ignoring input `index`, so reordered `tools/list` responses do not re-log.
fn same_exclusions(a: &[ToolExclusionReport], b: &[ToolExclusionReport]) -> bool {
    fn signature(reports: &[ToolExclusionReport]) -> Vec<(&str, &str, &str, &str)> {
        let mut keys: Vec<_> =
            reports.iter().map(|report| (report.name.as_str(), report.pointer.as_str(), report.reason.as_str(), report.message.as_str())).collect();
        keys.sort_unstable();
        keys
    }
    a.len() == b.len() && signature(a) == signature(b)
}

/// The server's name in the agent's `mcpServers`.
pub const SERVER_NAME: &str = "mixdog";

/// The MCP revisions the server speaks, newest first; a client that asks for another is answered with the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The session's tool of the step list.
pub const STEP_LIST_TOOL: &str = "todo";

/// The paragraph that follows Mixdog's own prompt in the agent's system prompt when it is handed the session's tools.
pub const PREFERENCE: &str = "# Mixdog tools\nThis session runs inside Mixdog, which hands you its own tools through the MCP server `mixdog`. \
Prefer those tools over your built-in ones wherever one of them does the job: their calls follow the user's Mixdog permissions and hooks, \
and the user sees and reviews them in Mixdog. Use a built-in tool only for work no Mixdog tool covers.";

/// [`PREFERENCE`], with how to make a step's calls: the agent's CLI runs the calls of one model step one after another,
/// each behind a safety check, so a step's items go into one call of a tool that takes them as an array; it shows about
/// 10 KB of one MCP call's result and cuts the middle out of a longer one.
pub fn preference() -> String {
    format!(
        "{PREFERENCE}\nYour CLI runs the Mixdog calls of a step one after another, each behind its own safety check. Where a Mixdog tool \
takes several items as an array (files or ranges for `read`, patterns or paths for `grep` and `glob`, queries for `web_search`, and so \
on), give it all the items the step needs in one call instead of one call per item, and make the step's other calls that do not need \
each other's results together in that step. Your CLI shows you about 10 KB of one Mixdog call's result and cuts the middle out of a \
longer one: where a result comes back cut, get the part you need with narrower calls, such as a line range of the file, a narrower \
search or one file's diff."
    )
}

/// The Mixdog session's side of the hand-over: what its server lists, and where a call goes on that outlasts the
/// agent's deadline for it. A call runs in the turn it is made in ([`crate::turn::TurnContext::calls`]).
#[async_trait]
pub trait SessionTools: Send + Sync {
    /// The tool definitions a request of `thread` would send now: for a session on an agent, a bridge session's
    /// (its directly defined tools, `load_tool` and `call_tool`). The agent is listed exactly these.
    async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String>;

    /// The table of the tool calls that went on in the background ([`JobBoard::of_tool_calls`]), which the sessions'
    /// `task` tool reads and whose finished calls are delivered to their sessions.
    fn tasks(&self) -> &JobBoard;
}

/// A call that never ran, answered with `why`.
pub fn unrun(call_id: &str, why: impl Into<String>) -> Handed {
    Handed { message: AgentMessage::tool_text(call_id, why, ToolKind::Error), follow_ups: Vec::new(), failed: true }
}

/// A `tools/call` of the agent, waiting for the session's turn to run it.
pub struct ToolAsk {
    pub name: String,
    pub arguments: Value,
    /// When the server took the call: the agent's deadline for it runs from about then.
    pub received: tokio::time::Instant,
    /// Takes the `tools/call` result.
    pub answer: oneshot::Sender<Value>,
}

impl std::fmt::Debug for ToolAsk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolAsk").field("name", &self.name).field("arguments", &self.arguments).finish()
    }
}

impl PartialEq for ToolAsk {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && self.arguments == other.arguments
    }
}

impl ToolAsk {
    /// Answers the call with a refusal the agent's model reads.
    pub fn refuse(self, why: &str) {
        let _ = self.answer.send(result_text(why.to_owned(), true));
    }
}

/// A `tools/call` result of one text.
pub fn result_text(text: String, failed: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// A finished call as the `tools/call` result the agent reads: its text, its images as image content, and what the
/// tool adds to the conversation beside its result (a loaded skill's instructions).
pub fn rendered(handed: &Handed) -> Value {
    json!({ "content": content(handed), "isError": handed.failed })
}

/// Formats mid-turn user messages and task notifications into MCP content blocks so the running ACP agent
/// receives them on its next model step, resolving `AttachmentRef` images, files, and offloaded long pastes
/// through the same path as `runs::prompt_blocks`.
pub(crate) async fn steer_blocks(
    steers: &[crate::surface::SteerDelivery],
    capabilities: (bool, bool),
    attachments: &dyn crate::runs::Attachments,
) -> (Vec<Value>, crate::runs::LeftOut, Vec<String>) {
    let mut blocks = Vec::new();
    let mut left_out = crate::runs::LeftOut::default();
    let mut attached = Vec::new();
    for steer in steers {
        match &steer.content {
            Content::Text(text) => {
                let text = if steer.task_notification { text.to_string() } else { format!("[User message received while you were working]\n{text}") };
                blocks.push(json!({ "type": "text", "text": text }));
            }
            Content::Parts(parts) => {
                if !steer.task_notification {
                    blocks.push(json!({ "type": "text", "text": "[User message received while you were working]" }));
                }
                let row = json!({ "content": parts.iter().map(mixdog_agent::message_row::part_row).collect::<Vec<_>>() });
                let (mut resolved, left, mut paths) = crate::runs::prompt_blocks(&row, capabilities, attachments).await;
                blocks.append(&mut resolved);
                attached.append(&mut paths);
                if left.images > 0 {
                    blocks.push(json!({
                        "type": "text",
                        "text": format!("[{} image(s) of this message were not passed to the agent]", left.images),
                    }));
                    left_out.images += left.images;
                }
                for file in left.files {
                    blocks.push(json!({
                        "type": "text",
                        "text": format!("[Attached file \"{file}\" was not passed to the agent]"),
                    }));
                    left_out.files.push(file);
                }
            }
        }
    }
    (blocks, left_out, attached)
}

/// A finished call's result as the text a background task keeps: [`rendered`]'s text, an image noted where it was.
pub fn text_of(handed: &Handed) -> String {
    content(handed)
        .iter()
        .map(|block| block["text"].as_str().unwrap_or("[an image of the result: `task` read of this task gives it]"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A finished call's result as a background task keeps it whole: [`text_of`] as its `content`, and [`rendered`]'s images
/// as `images`, which the session's `task` tool gives with the text.
pub fn kept_result(handed: &Handed) -> Value {
    let images: Vec<Value> = content(handed).into_iter().filter(|block| block["type"] == "image").collect();
    json!({ "content": text_of(handed), "images": images })
}

/// The answer to a call of `tool` not over within the time the agent waits for it: Mixdog goes on with it as the
/// session's background task `task`, as it goes on with a command its `shell` tool moved to the background.
pub fn kept(tool: &str, task: &str) -> String {
    format!(
        "background task\ntask_id: {task}\ntool: {tool}\nstatus: running\nThis call has not ended within the time the agent waits for a Mixdog \
call: Mixdog goes on with it and keeps its result, which is delivered to you automatically when it ends. Do not make the call again. To \
read the result sooner, use the Mixdog tool `task` with action `wait` and task_id `{task}`, only if no other work remains."
    )
}

/// The answer to a call the agent makes again while Mixdog still goes on with the same call as background task `task`.
pub fn kept_again(tool: &str, task: &str) -> String {
    format!(
        "The same call of `{tool}` is still running as Mixdog background task `{task}`: it was not run again. Its result is delivered to you \
automatically when it ends; use the Mixdog tool `task` with action `wait` and task_id `{task}` only if no other work remains."
    )
}

fn content(handed: &Handed) -> Vec<Value> {
    let mut content = Vec::new();
    match &handed.message.message.content {
        Content::Text(text) => content.push(json!({ "type": "text", "text": text.to_string() })),
        Content::Parts(parts) => {
            for part in parts {
                content.push(match part {
                    ContentPart::Text(text, _) => json!({ "type": "text", "text": text }),
                    ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => json!({ "type": "image", "mimeType": mime_type, "data": data }),
                    // A stored blob and a file have no form the protocol's tool result carries: the agent is told one was made.
                    _ => json!({ "type": "text", "text": "[content kept in Mixdog and not passed to the agent]" }),
                });
            }
        }
    }
    content.extend(handed.follow_ups.iter().map(|text| json!({ "type": "text", "text": text })));
    content
}

/// A session's server: where the agent reaches it, and its end.
pub struct ToolServer {
    port: u16,
    token: String,
    stop: CancellationToken,
    /// An MCP client has initialized the server.
    initialized: Arc<AtomicBool>,
    /// Digest of the most recent `tools/list` served to the agent.
    served_digest: Arc<Mutex<Option<String>>>,
    /// Tools excluded by `Rule::Gemini` schema repair on the most recent `tools/list`.
    excluded: Arc<Mutex<Vec<ToolExclusionReport>>>,
}

impl Drop for ToolServer {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Served {
    thread: ThreadId,
    token: String,
    tools: Arc<dyn SessionTools>,
    asks: mpsc::UnboundedSender<ToolAsk>,
    initialized: Arc<AtomicBool>,
    served_digest: Arc<Mutex<Option<String>>>,
    excluded: Arc<Mutex<Vec<ToolExclusionReport>>>,
}

type Reply = Response<Full<Bytes>>;

fn plain(status: StatusCode) -> Reply {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

/// A refusal is sent once the request's body has been read, and dropped, as an accepted request's is. A connection
/// that closes with request bytes unread is reset, and a reset that reaches the client before it reads takes the
/// refusal with it (RFC 9112 §9.6); a body written after its head can arrive after the refusal was sent.
async fn refused(mut body: Body, status: StatusCode) -> Reply {
    while let Some(Ok(_)) = body.frame().await {}
    plain(status)
}

fn answered(message: Value) -> Reply {
    let mut response = Response::new(Full::new(Bytes::from(message.to_string())));
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json"));
    response
}

impl ToolServer {
    /// Starts the server of `thread`'s session; the calls the agent makes arrive on the returned channel, which the
    /// session's routing reads. The server ends when this value is dropped.
    pub async fn start(thread: ThreadId, tools: Arc<dyn SessionTools>) -> std::io::Result<(Self, mpsc::UnboundedReceiver<ToolAsk>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        // 244 random bits: the one thing that tells the session's agent, in this session, from every other program on
        // this machine and every other session of a shared agent.
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let stop = CancellationToken::new();
        let (asks, calls) = mpsc::unbounded_channel();
        let initialized: Arc<AtomicBool> = Arc::default();
        let served_digest: Arc<Mutex<Option<String>>> = Arc::default();
        let excluded: Arc<Mutex<Vec<ToolExclusionReport>>> = Arc::default();
        let served = Arc::new(Served {
            thread,
            token: token.clone(),
            tools,
            asks,
            initialized: initialized.clone(),
            served_digest: served_digest.clone(),
            excluded: excluded.clone(),
        });
        let stopped = stop.clone();
        drop(mixdog_rt::spawn("acp.mcp", TaskClass::Work, async move {
            loop {
                let stream = tokio::select! {
                    () = stopped.cancelled() => return,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => stream,
                        Err(_) => continue,
                    },
                };
                let (served, stopped) = (served.clone(), stopped.clone());
                drop(mixdog_rt::spawn("acp.mcp.conn", TaskClass::Work, async move {
                    let service = service_fn(move |request| {
                        let served = served.clone();
                        async move { Ok::<_, Infallible>(served.handle(request).await) }
                    });
                    let connection = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                    tokio::select! {
                        () = stopped.cancelled() => {}
                        _ = connection => {}
                    }
                }));
            }
        }));
        Ok((Self { port, token, stop, initialized, served_digest, excluded }, calls))
    }

    /// Set once the agent's MCP client has initialized the server: it took the session's tools.
    pub fn initialized(&self) -> Arc<AtomicBool> {
        self.initialized.clone()
    }

    /// Shared cell holding the digest of the last `tools/list` served to the agent.
    pub fn served_digest(&self) -> Arc<Mutex<Option<String>>> {
        self.served_digest.clone()
    }

    /// Shared cell holding any tools excluded during `Rule::Gemini` schema repair on `tools/list`.
    pub fn excluded(&self) -> Arc<Mutex<Vec<ToolExclusionReport>>> {
        self.excluded.clone()
    }

    /// The server's entry of `mcpServers` in a `session/new` or a reopen: the listener itself for an agent that
    /// takes an HTTP server (`http`), else `bridge`, the program the agent starts as the server's stdio end. `None`
    /// where the agent can be given neither.
    pub fn entry(&self, http: bool, bridge: Option<&Command>) -> Option<Value> {
        if http {
            return Some(json!({
                "type": "http",
                "name": SERVER_NAME,
                "url": format!("http://127.0.0.1:{}/mcp", self.port),
                "headers": [{ "name": "Authorization", "value": format!("Bearer {}", self.token) }],
            }));
        }
        bridge.map(|bridge| {
            json!({
                "name": SERVER_NAME,
                "command": bridge.program,
                "args": bridge.args,
                "env": [
                    { "name": crate::mcp_bridge::PORT_ENV, "value": self.port.to_string() },
                    { "name": crate::mcp_bridge::TOKEN_ENV, "value": self.token },
                ],
            })
        })
    }
}

impl Served {
    async fn handle(self: &Arc<Self>, request: Request<Body>) -> Reply {
        let bearer = request.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
        // A page in a browser can reach a loopback port; it cannot leave out its `Origin`, and the agent sends none.
        let refusal = if bearer != Some(self.token.as_str()) || request.headers().contains_key(header::ORIGIN) {
            Some(StatusCode::UNAUTHORIZED)
        } else if request.uri().path() != "/mcp" {
            Some(StatusCode::NOT_FOUND)
        } else if request.method() != Method::POST {
            // The server sends nothing of its own, so it offers no stream to listen on.
            Some(StatusCode::METHOD_NOT_ALLOWED)
        } else {
            None
        };
        if let Some(status) = refusal {
            return refused(request.into_body(), status).await;
        }
        let Ok(body) = request.into_body().collect().await else { return plain(StatusCode::BAD_REQUEST) };
        let Ok(message) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
            return answered(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "the body is not JSON" } }));
        };
        match message {
            Value::Array(batch) => {
                let mut tasks = tokio::task::JoinSet::new();
                for (index, message) in batch.into_iter().enumerate() {
                    let served = self.clone();
                    tasks.spawn(async move { (index, served.message(&message).await) });
                }
                let mut ordered: Vec<(usize, Value)> = Vec::new();
                while let Some(joined) = tasks.join_next().await {
                    if let Ok((index, Some(answer))) = joined {
                        ordered.push((index, answer));
                    }
                }
                ordered.sort_by_key(|(index, _)| *index);
                let answers: Vec<Value> = ordered.into_iter().map(|(_, answer)| answer).collect();
                if answers.is_empty() { plain(StatusCode::ACCEPTED) } else { answered(Value::Array(answers)) }
            }
            message => match self.message(&message).await {
                Some(answer) => answered(answer),
                None => plain(StatusCode::ACCEPTED),
            },
        }
    }

    /// The answer to one message; a notification and a response have none.
    async fn message(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").filter(|id| !id.is_null())?.clone();
        let method = message.get("method").and_then(Value::as_str)?;
        let params = message.get("params").unwrap_or(&Value::Null);
        let result = match method {
            "initialize" => {
                self.initialized.store(true, Ordering::SeqCst);
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = PROTOCOL_VERSIONS.iter().find(|version| **version == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "title": "Mixdog", "version": env!("CARGO_PKG_VERSION") },
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => self.tools.definitions(&self.thread).await.map(|definitions| {
                let (tools, excluded) = repair_tools_for_gemini(definitions);
                let digest = tools_digest(&tools);
                *self.served_digest.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(digest);
                let mut prev = self.excluded.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !same_exclusions(&prev, &excluded) {
                    for report in &excluded {
                        tracing::warn!(tool = %report.name, pointer = %report.pointer, reason = %report.reason, "[acp.mcp] excluded tool with invalid Gemini schema");
                    }
                    *prev = excluded;
                }
                json!({ "tools": tools })
            }),
            "tools/call" => {
                let raw_name = params.get("name").and_then(Value::as_str).unwrap_or_default();
                let prefix = format!("mcp_{SERVER_NAME}_");
                let name = raw_name.strip_prefix(&prefix).unwrap_or(raw_name).to_owned();
                let arguments = params.get("arguments").cloned().filter(|arguments| !arguments.is_null()).unwrap_or_else(|| json!({}));
                let (answer, answered) = oneshot::channel();
                // A session whose agent is gone answers nobody; the call's sender then drops.
                let _ = self.asks.send(ToolAsk { name, arguments, received: tokio::time::Instant::now(), answer });
                Ok(answered.await.unwrap_or_else(|_| result_text("The session's agent has ended.".to_owned(), true)))
            }
            other => {
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("{other} is not offered by this server") } }));
            }
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": message } }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every agent handed the session's tools is told to prefer them over its built-in ones, to give a tool that takes an
    /// array all of a step's items in one call, and to get a cut result's part with narrower calls.
    #[test]
    fn an_agent_is_told_to_prefer_mixdog_tools_and_to_give_a_steps_items_to_one_array_call() {
        let told = preference();
        assert!(told.starts_with(PREFERENCE), "{told}");
        assert!(told.contains("give it all the items the step needs in one call instead of one call per item"), "{told}");
        assert!(told.contains("queries for `web_search`"), "{told}");
        assert!(told.contains("get the part you need with narrower calls"), "{told}");
    }

    #[test]
    fn gemini_schema_repair_lowers_legacy_draft_and_excludes_broken_tools() {
        let legacy = ToolDefinition {
            name: "read".into(),
            description: "reads".into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "definitions": { "line": { "type": "integer", "exclusiveMinimum": true, "minimum": 0 } },
                "properties": { "offset": { "$ref": "#/definitions/line" } }
            }),
            defer_loading: false,
            freeform: None,
        };
        let broken = ToolDefinition {
            name: "bad".into(),
            description: "broken".into(),
            input_schema: json!("not-an-object-schema"),
            defer_loading: false,
            freeform: None,
        };
        let (repaired, excluded) = repair_tools_for_gemini(vec![legacy, broken]);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0]["name"], "read");
        assert!(repaired[0]["inputSchema"].get("$defs").is_some(), "{:?}", repaired[0]["inputSchema"]);
        assert_eq!(excluded.len(), 1);
        assert_eq!(excluded[0].name, "bad");
        assert_ne!(tools_digest(&repaired), tools_digest(&[]));

        // Equivalent tool listings with different tool ordering AND different nested JSON schema key ordering must hash identically.
        let mut props_a = serde_json::Map::new();
        props_a.insert("alpha".into(), json!({ "type": "string", "description": "a" }));
        props_a.insert("beta".into(), json!({ "description": "b", "type": "integer" }));
        let mut schema_a = serde_json::Map::new();
        schema_a.insert("type".into(), json!("object"));
        schema_a.insert("properties".into(), Value::Object(props_a));

        let mut props_b = serde_json::Map::new();
        props_b.insert("beta".into(), json!({ "type": "integer", "description": "b" }));
        props_b.insert("alpha".into(), json!({ "description": "a", "type": "string" }));
        let mut schema_b = serde_json::Map::new();
        schema_b.insert("properties".into(), Value::Object(props_b));
        schema_b.insert("type".into(), json!("object"));

        let list_one = vec![
            ToolDefinition { name: "first".into(), description: "one".into(), input_schema: Value::Object(schema_a), defer_loading: false, freeform: None },
            ToolDefinition {
                name: "second".into(),
                description: "two".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
                defer_loading: false,
                freeform: None,
            },
        ];
        let list_two = vec![
            ToolDefinition {
                name: "second".into(),
                description: "two".into(),
                input_schema: json!({ "properties": {}, "type": "object" }),
                defer_loading: false,
                freeform: None,
            },
            ToolDefinition { name: "first".into(), description: "one".into(), input_schema: Value::Object(schema_b), defer_loading: false, freeform: None },
        ];
        let (repaired_one, _) = repair_tools_for_gemini(list_one);
        let (repaired_two, _) = repair_tools_for_gemini(list_two);
        assert_eq!(
            tools_digest(&repaired_one),
            tools_digest(&repaired_two),
            "tools_digest must be invariant to tool ordering and nested JSON schema key ordering"
        );
    }

    #[test]
    fn same_exclusions_ignores_tool_order_and_input_index() {
        let valid = ToolDefinition {
            name: "ok".into(),
            description: "ok".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
            defer_loading: false,
            freeform: None,
        };
        let bad_a =
            ToolDefinition { name: "bad_a".into(), description: "a".into(), input_schema: json!("not-an-object"), defer_loading: false, freeform: None };
        let bad_b = ToolDefinition { name: "bad_b".into(), description: "b".into(), input_schema: json!(42), defer_loading: false, freeform: None };
        let (_, excluded_one) = repair_tools_for_gemini(vec![bad_a.clone(), valid.clone(), bad_b.clone()]);
        let (_, excluded_two) = repair_tools_for_gemini(vec![valid, bad_b.clone(), bad_a]);
        assert_ne!(excluded_one, excluded_two);
        assert!(same_exclusions(&excluded_one, &excluded_two));
        assert!(!same_exclusions(&excluded_one, &excluded_two[..1]));

        let bad_c =
            ToolDefinition { name: "bad_c".into(), description: "c".into(), input_schema: json!("not-an-object"), defer_loading: false, freeform: None };
        let (_, excluded_other) = repair_tools_for_gemini(vec![bad_b, bad_c]);
        assert!(!same_exclusions(&excluded_one, &excluded_other));
    }
}
