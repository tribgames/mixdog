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
        Self { addr, _hub: hub, _accept: accept }
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
}
