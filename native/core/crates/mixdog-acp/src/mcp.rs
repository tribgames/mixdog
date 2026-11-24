//! The tools a Mixdog session hands its agent: an MCP server of the session's own, which lists
//! the session's tool surface and passes every call to the session's turn, where it runs through
//! Mixdog's pipeline and is shown as any other call of a Mixdog tool.
//!
//! The server is one listener on the loopback interface, started with the agent's process and
//! closed with it. Its address carries no secret; every request must carry the bearer token made
//! for that one process, which only the agent's `session/new` (or its reopen) is told.

use std::convert::Infallible;
use std::sync::Arc;
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
use mixdog_agent::handed::Handed;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ToolDefinition;
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
        Ok(definitions.into_iter().map(|tool| tool.name).chain([BATCH_TOOL.to_owned()]).collect())
    }
}

/// The server's name in the agent's `mcpServers`.
pub const SERVER_NAME: &str = "mixdog";

/// The MCP revisions the server speaks, newest first; a client that asks for another is answered with the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The session's tool of the step list.
pub const STEP_LIST_TOOL: &str = "todo";

/// The tool the server lists besides the session's own: one call of it makes several calls of those. An agent's CLI
/// makes its MCP calls one after another, each behind a safety check of seconds, so calls made together cost one check.
pub const BATCH_TOOL: &str = "batch";

/// The most calls one call of [`BATCH_TOOL`] carries: about twice the most an agent's model step was seen to make (17),
/// a bound on how many calls one call starts together and on how many results one answer carries.
pub const BATCH_LIMIT: usize = 32;

/// The paragraph that follows Mixdog's own prompt in the agent's system prompt when it is handed the session's tools.
pub const PREFERENCE: &str = "# Mixdog tools\nThis session runs inside Mixdog, which hands you its own tools through the MCP server `mixdog`. \
Prefer those tools over your built-in ones wherever one of them does the job: their calls follow the user's Mixdog permissions and hooks, \
and the user sees and reviews them in Mixdog. Use a built-in tool only for work no Mixdog tool covers.";

/// [`PREFERENCE`], with what a separate Mixdog call costs the agent and how to make a step's calls in one.
pub fn preference() -> String {
    format!(
        "{PREFERENCE}\nEach separate call of a Mixdog tool waits for a safety check of several seconds in your CLI before it runs. \
Put every independent Mixdog call of a step into one call of the Mixdog tool `{BATCH_TOOL}`, as the items of its `calls` array, \
instead of calling the tools one by one; call a Mixdog tool directly only when the step makes that one Mixdog call alone. \
`read`, `grep` and `glob` each take several files or patterns as an array in one call: give them all to one call, never one call per file or pattern."
    )
}

/// [`BATCH_TOOL`] as the server lists it: a plain array of `{tool, arguments}` objects, each described in so many words.
fn batch_definition() -> Value {
    json!({
        "name": BATCH_TOOL,
        "description": format!(
            "Make several calls of this server's other tools in one call. Your CLI runs a safety check of several seconds before each \
    separate call of a Mixdog tool, and checks one call of `{BATCH_TOOL}` once for all the calls it carries: whenever a step makes two or more \
    Mixdog calls that do not need each other's results, put them all in `calls` instead of calling the tools one by one. Calls of tools that \
    only read (read, grep, glob, list) run at the same time; every other call runs alone, after the calls before it have ended, in the order \
    given. Each call is checked, approved and run exactly as a direct call of its tool, and a refused or failed call does not stop the others. \
    The result holds every call's result in the order given, each headed `[position/total] tool`, with `(failed)` after one that failed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "calls": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": BATCH_LIMIT,
                    "description": format!(
                        "The calls, in the order they run: an array of objects, each {{\"tool\": \"<tool name>\", \"arguments\": {{<that tool's \
    arguments>}}}}. Example: [{{\"tool\": \"grep\", \"arguments\": {{\"pattern\": \"fn main\", \"path\": \"src\"}}}}, {{\"tool\": \"glob\", \
    \"arguments\": {{\"pattern\": \"**/*.toml\"}}}}]. At most {BATCH_LIMIT} calls."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": { "type": "string", "description": format!("The name of one tool of this server as it lists it, as `grep` or `edit`; never `{BATCH_TOOL}`.") },
                            "arguments": { "type": "object", "description": "That tool's arguments, exactly as a direct call of it takes them; {} for none." },
                        },
                        "required": ["tool", "arguments"],
                    },
                },
            },
            "required": ["calls"],
        },
    })
}

/// One item of a call of [`BATCH_TOOL`]: the tool it names, and what it carries or why it makes no call.
pub type BatchItem<T> = (String, Result<T, String>);

/// The calls a call of [`BATCH_TOOL`] carries, in order: each item's tool, with its arguments or why the item makes no
/// call. `Err` for arguments that carry no calls to make, or more than [`BATCH_LIMIT`].
pub fn batch_items(arguments: &Value) -> Result<Vec<BatchItem<Value>>, String> {
    let Some(items) = arguments.get("calls").and_then(Value::as_array) else {
        return Err(format!("{BATCH_TOOL} takes `calls`: an array of {{\"tool\": <name>, \"arguments\": {{…}}}} objects."));
    };
    if items.is_empty() {
        return Err("`calls` is empty: give it the calls to make.".to_owned());
    }
    if items.len() > BATCH_LIMIT {
        return Err(format!("`calls` holds {} calls, and one call of {BATCH_TOOL} makes at most {BATCH_LIMIT}: split them over several.", items.len()));
    }
    Ok(items
        .iter()
        .map(|item| {
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or_default().to_owned();
            let arguments = match item.get("arguments") {
                _ if tool.is_empty() => Err("The item names no `tool`.".to_owned()),
                _ if tool == BATCH_TOOL => Err(format!("{BATCH_TOOL} does not carry a call of itself: put those calls in this call's `calls`.")),
                None | Some(Value::Null) => Ok(json!({})),
                Some(arguments @ Value::Object(_)) => Ok(arguments.clone()),
                Some(_) => Err("`arguments` must be an object of that tool's arguments.".to_owned()),
            };
            (tool, arguments)
        })
        .collect())
}

/// The Mixdog session's side of the hand-over: what its server lists. A call runs in the turn it is made in
/// ([`crate::turn::TurnContext::calls`]).
#[async_trait]
pub trait SessionTools: Send + Sync {
    /// The tool definitions a request of `thread` would send now: for a session on an agent, a bridge session's
    /// (its directly defined tools, `load_tool` and `call_tool`). The agent is listed exactly these, and [`BATCH_TOOL`].
    async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String>;
}

/// A call that never ran, answered with `why`.
pub fn unrun(call_id: &str, why: impl Into<String>) -> Handed {
    Handed { message: AgentMessage::tool_text(call_id, why, ToolKind::Error), follow_ups: Vec::new(), failed: true }
}

/// A `tools/call` of the agent, waiting for the session's turn to run it.
pub struct ToolAsk {
    pub name: String,
    pub arguments: Value,
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

/// The answer to a call of [`BATCH_TOOL`]: each item's answer in the order the items were given, headed by its position
/// and its tool, the result of the call it made ([`rendered`]) or why it made none. An error only where no call succeeded.
pub fn batch_rendered(answers: &[BatchItem<Handed>]) -> Value {
    let failed = |answer: &Result<Handed, String>| !matches!(answer, Ok(handed) if !handed.failed);
    let mut blocks = Vec::new();
    for (index, (tool, answer)) in answers.iter().enumerate() {
        let mark = if failed(answer) { " (failed)" } else { "" };
        blocks.push(json!({ "type": "text", "text": format!("[{}/{}] {tool}{mark}", index + 1, answers.len()) }));
        match answer {
            Ok(handed) => blocks.extend(content(handed)),
            Err(why) => blocks.push(json!({ "type": "text", "text": why })),
        }
    }
    json!({ "content": blocks, "isError": answers.iter().all(|(_, answer)| failed(answer)) })
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
}

type Reply = Response<Full<Bytes>>;

fn plain(status: StatusCode) -> Reply {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
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
        // 244 random bits: the one thing that tells the session's agent from every other program on this machine.
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let stop = CancellationToken::new();
        let (asks, calls) = mpsc::unbounded_channel();
        let initialized: Arc<AtomicBool> = Arc::default();
        let served = Arc::new(Served { thread, token: token.clone(), tools, asks, initialized: initialized.clone() });
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
        Ok((Self { port, token, stop, initialized }, calls))
    }

    /// Set once the agent's MCP client has initialized the server: it took the session's tools.
    pub fn initialized(&self) -> Arc<AtomicBool> {
        self.initialized.clone()
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
    async fn handle(&self, request: Request<Body>) -> Reply {
        let bearer = request.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
        // A page in a browser can reach a loopback port; it cannot leave out its `Origin`, and the agent sends none.
        if bearer != Some(self.token.as_str()) || request.headers().contains_key(header::ORIGIN) {
            return plain(StatusCode::UNAUTHORIZED);
        }
        if request.uri().path() != "/mcp" {
            return plain(StatusCode::NOT_FOUND);
        }
        // The server sends nothing of its own, so it offers no stream to listen on.
        if request.method() != Method::POST {
            return plain(StatusCode::METHOD_NOT_ALLOWED);
        }
        let Ok(body) = request.into_body().collect().await else { return plain(StatusCode::BAD_REQUEST) };
        let Ok(message) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
            return answered(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "the body is not JSON" } }));
        };
        match message {
            Value::Array(batch) => {
                let mut answers = Vec::new();
                for message in &batch {
                    answers.extend(self.message(message).await);
                }
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
                let tools: Vec<Value> = definitions
                    .into_iter()
                    .map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema }))
                    .chain([batch_definition()])
                    .collect();
                json!({ "tools": tools })
            }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
                let arguments = params.get("arguments").cloned().filter(|arguments| !arguments.is_null()).unwrap_or_else(|| json!({}));
                let (answer, answered) = oneshot::channel();
                // A session whose agent is gone answers nobody; the call's sender then drops.
                let _ = self.asks.send(ToolAsk { name, arguments, answer });
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

    /// Every agent handed the session's tools is told to prefer them over its built-in ones, what a separate call of one
    /// costs it, that a step's independent calls go into the batch tool together, and that the tools that take several
    /// files or patterns take them at once.
    #[test]
    fn an_agent_is_told_to_prefer_mixdog_tools_and_to_make_a_steps_calls_in_one() {
        let told = preference();
        assert!(told.starts_with(PREFERENCE), "{told}");
        assert!(told.contains("Each separate call of a Mixdog tool waits for a safety check of several seconds in your CLI"), "{told}");
        assert!(told.contains(&format!("Put every independent Mixdog call of a step into one call of the Mixdog tool `{BATCH_TOOL}`")), "{told}");
        assert!(told.contains("`read`, `grep` and `glob` each take several files or patterns as an array in one call"), "{told}");
    }
}
