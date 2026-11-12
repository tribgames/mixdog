//! The transport harness: the server behind its real WebSocket listener on a loopback port, reached by real client
//! connections. Each connection is driven as the daemon drives it (`mixdog-app-server-daemon` server.rs `drive`): its
//! frames go to the server in arrival order and a close the server asks for closes the socket. A client keeps every text
//! frame it receives, in order, and waits for frames with a deadline that names what it waited for.

use std::time::Duration;

use futures::SinkExt;
use futures::StreamExt;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::Transport;
use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WebSocketListener;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::Rig;
use super::VERSION;
use crate::Inbound;

const TOKEN: &str = "replay-token";

/// How long a client waits for a frame before the test fails naming what it waited for.
pub(crate) const DEADLINE: Duration = Duration::from_secs(20);

/// `rig`'s server served on a loopback listener.
pub(crate) struct Wire {
    pub(crate) rig: Rig,
    addr: std::net::SocketAddr,
    _hub: ConnectionHub,
    _accept: tokio::task::JoinHandle<()>,
}

impl Wire {
    pub(crate) async fn serve(rig: Rig) -> Self {
        let hub = ConnectionHub::new(Limits::default()).expect("limits");
        let mut listener = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), hub.clone(), BearerAuth::new(TOKEN), ListenerOrigin::Loopback)
            .await
            .expect("bind the loopback listener");
        let addr = listener.local_addr();
        let server = rig.server.clone();
        let origins = rig.origins.clone();
        let known = hub.clone();
        let accept = tokio::spawn(async move {
            while let Some(accepted) = listener.accept().await {
                let AcceptedConnection { id, mut inbound, sink, .. } = accepted;
                let origin = known.origin_of(id).expect("an accepted connection has an origin");
                origins.lock().unwrap().insert(id, origin);
                let handle = server.open(id, std::sync::Arc::new(sink.clone()));
                tokio::spawn(async move {
                    while let Some(message) = inbound.recv().await {
                        match handle.on_message(message) {
                            Inbound::Continue => {}
                            Inbound::Pause(resume) => resume.await,
                            Inbound::Close(code) => {
                                sink.close(code);
                                break;
                            }
                        }
                    }
                });
            }
        });
        Self { rig, addr, _hub: hub, _accept: accept }
    }

    /// A client connection that has completed `initialize` as a `kind` client named `device`; its frames start after the
    /// initialize answer, which is checked and kept apart.
    pub(crate) async fn client(&self, device: &str, kind: &str) -> WireClient {
        let tcp = TcpStream::connect(self.addr).await.expect("dial the listener");
        let mut request = format!("ws://{}/rpc", self.addr).into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let (ws, _) = tokio_tungstenite::client_async(request, tcp).await.expect("the upgrade");
        let mut client = WireClient { ws, frames: Vec::new() };
        client.send(0, "initialize", json!({ "clientInfo": { "name": "test", "title": device, "version": VERSION, "kind": kind }, "capabilities": {} })).await;
        let answer = client.answer(0).await;
        assert!(answer.get("result").is_some(), "initialize: {answer}");
        client.frames.clear();
        client
    }
}

/// One real client connection and every text frame it received, in order.
pub(crate) struct WireClient {
    ws: WebSocketStream<TcpStream>,
    pub(crate) frames: Vec<Value>,
}

impl WireClient {
    pub(crate) async fn send(&mut self, id: i64, method: &str, params: Value) {
        let frame = json!({ "id": id, "method": method, "params": params });
        self.ws.send(Message::text(frame.to_string())).await.expect("send a request");
    }

    /// Receives until `done` holds of every frame received so far; fails at [`DEADLINE`] naming `what`.
    pub(crate) async fn until(&mut self, what: &str, done: impl Fn(&[Value]) -> bool) -> &[Value] {
        let deadline = tokio::time::Instant::now() + DEADLINE;
        while !done(&self.frames) {
            let next = tokio::time::timeout_at(deadline, self.ws.next())
                .await
                .unwrap_or_else(|_| panic!("no {what} within {DEADLINE:?}; received {}", Value::from(self.frames.clone())));
            match next.expect("the server closed the connection").expect("a frame") {
                Message::Text(text) => self.frames.push(serde_json::from_str(&text).expect("a JSON frame")),
                Message::Close(frame) => panic!("closed ({frame:?}) before {what}; received {}", Value::from(self.frames.clone())),
                _ => {}
            }
        }
        &self.frames
    }

    /// The answer to request `id`, once received.
    pub(crate) async fn answer(&mut self, id: i64) -> Value {
        let is = |frame: &Value| frame["id"] == id && frame.get("method").is_none();
        let frames = self.until(&format!("answer {id}"), |frames| frames.iter().any(is)).await;
        frames.iter().find(|frame| is(frame)).unwrap().clone()
    }

    /// Sends request `id` and returns its answer.
    pub(crate) async fn call(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(id, method, params).await;
        self.answer(id).await
    }

    /// Closes the connection from the client side.
    pub(crate) async fn close(mut self) {
        self.ws.close(None).await.expect("close");
    }
}

/// `frames` with the values the core generates replaced by stable names, the only normalization the transport manifests
/// declare: each distinct generated id becomes `<id:N>` in order of first appearance (a UUID anywhere in a string, as turn
/// and item ids are or embed one; a 32-hex feed epoch; and each string of `generated`, the thread ids the core minted), and
/// clock readings (`*At` fields, `clientHostPid`) become `<clock>` / `<pid>`. Everything else is compared as received. The
/// expected frames go through the same function, so two ids are compared by whether they are the same id.
pub(crate) fn normalized(frames: &[Value], generated: &[&str]) -> Value {
    fn name(names: &mut Vec<String>, id: &str) -> String {
        let at = names.iter().position(|n| n == id).unwrap_or_else(|| {
            names.push(id.to_owned());
            names.len() - 1
        });
        format!("<id:{at}>")
    }
    fn is_uuid(window: &[u8]) -> bool {
        window.len() == 36
            && window.iter().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { *b == b'-' } else { b.is_ascii_hexdigit() })
    }
    fn uuids(text: &str, names: &mut Vec<String>) -> String {
        let bytes = text.as_bytes();
        let (mut out, mut at) = (String::new(), 0);
        while at < bytes.len() {
            if at + 36 <= bytes.len() && is_uuid(&bytes[at..at + 36]) {
                out.push_str(&name(names, &text[at..at + 36]));
                at += 36;
            } else {
                let c = text[at..].chars().next().unwrap();
                out.push(c);
                at += c.len_utf8();
            }
        }
        out
    }
    fn walk(value: &mut Value, key: Option<&str>, generated: &[&str], names: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map.iter_mut() {
                    walk(v, Some(k), generated, names);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|v| walk(v, key, generated, names)),
            Value::Number(_) if key.is_some_and(|k| k.ends_with("At")) => *value = json!("<clock>"),
            Value::Number(_) if key == Some("clientHostPid") => *value = json!("<pid>"),
            Value::String(text) if generated.contains(&text.as_str()) || (text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit())) => {
                *value = json!(name(names, text));
            }
            Value::String(text) => *value = json!(uuids(text, names)),
            _ => {}
        }
    }
    let mut all = Value::from(frames.to_vec());
    walk(&mut all, None, generated, &mut Vec::new());
    all
}

/// Writes `frames` to the replay's frame log (`MIXDOG_REPLAY_FRAMES`, a directory) when set, so a reviewer can read what
/// a client received; the comparison never reads it.
pub(crate) fn log(name: &str, frames: &Value) {
    if let Ok(dir) = std::env::var("MIXDOG_REPLAY_FRAMES") {
        std::fs::write(format!("{dir}/{name}.json"), serde_json::to_string_pretty(frames).unwrap()).expect("write the frame log");
    }
}
