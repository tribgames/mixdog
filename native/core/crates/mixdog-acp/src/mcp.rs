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
use mixdog_agent::agent_tool::board::JobBoard;
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
        Ok(definitions.into_iter().map(|tool| tool.name).collect())
    }
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
                    .collect();
                json!({ "tools": tools })
            }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
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
}
