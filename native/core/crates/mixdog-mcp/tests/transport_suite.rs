//! Legacy SSE and WebSocket transports against loopback servers, including the sign-in token
//! being renewed after the server refuses it.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use futures::SinkExt;
use futures::StreamExt;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::transport::Authorizer;
use mixdog_mcp::transport::TransportError;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

fn answer(message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let result = match message["method"].as_str()? {
        "initialize" => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}),
        "tools/list" => json!({"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}),
        "tools/call" => json!({"content": [{"type": "text", "text": message["params"]["arguments"]["text"]}]}),
        _ => json!({}),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, String, Vec<(String, String)>, Vec<u8>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        assert!(n > 0);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (first.next().unwrap().to_owned(), first.next().unwrap().to_owned());
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers.iter().find(|(k, _)| k == "content-length").map_or(0, |(_, v)| v.parse().unwrap());
    while buf.len() < header_end + length {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
    }
    (method, path, headers, buf[header_end..header_end + length].to_vec())
}

async fn status(stream: &mut tokio::net::TcpStream, line: &str) {
    stream
        .write_all(format!("HTTP/1.1 {line}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
}

struct Renewing {
    renewed: AtomicUsize,
}

#[async_trait]
impl Authorizer for Renewing {
    async fn token(&self) -> Result<Option<String>, TransportError> {
        Ok(Some(if self.renewed.load(Ordering::SeqCst) == 0 { "old" } else { "fresh" }.to_owned()))
    }

    async fn renew(&self, rejected: Option<String>, _challenge: Option<String>) -> Result<(), TransportError> {
        assert_eq!(rejected.as_deref(), Some("old"));
        self.renewed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn server_for(entry: &Value, authorizer: Option<Arc<dyn Authorizer>>, dir: &std::path::Path) -> Arc<McpServer> {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let config = McpServerConfig::from_entry("legacy", entry, &Default::default()).unwrap();
    McpServer::new(config, io, Spiller::new(dir.to_path_buf(), io.durability), OutputPolicy::default(), authorizer)
}

#[tokio::test(flavor = "multi_thread")]
async fn sse_posts_to_the_announced_endpoint_and_renews_a_refused_token() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stream_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>> = Arc::default();
    let bearers: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let (tx_slot, seen) = (Arc::clone(&stream_tx), Arc::clone(&bearers));
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (tx_slot, seen) = (Arc::clone(&tx_slot), Arc::clone(&seen));
            tokio::spawn(async move {
                let (method, path, headers, body) = read_request(&mut stream).await;
                let bearer = headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.clone());
                seen.lock().unwrap().push(bearer.clone());
                if method == "GET" && path == "/sse" {
                    if bearer.as_deref() != Some("Bearer fresh") {
                        return status(&mut stream, "401 Unauthorized").await;
                    }
                    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                    *tx_slot.lock().unwrap() = Some(tx);
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\nevent: endpoint\r\ndata: /msg?s=1\r\n\r\n")
                        .await
                        .unwrap();
                    while let Some(event) = rx.recv().await {
                        if stream.write_all(event.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                } else if method == "POST" && path == "/msg?s=1" {
                    let message: Value = serde_json::from_slice(&body).unwrap();
                    if let Some(reply) = answer(&message) {
                        let slot = tx_slot.lock().unwrap().clone().unwrap();
                        slot.send(format!("event: message\ndata: {reply}\n\n")).unwrap();
                    }
                    status(&mut stream, "202 Accepted").await;
                }
            });
        }
    });

    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(Renewing { renewed: AtomicUsize::new(0) });
    let entry = json!({"type": "sse", "url": format!("http://127.0.0.1:{port}/sse")});
    let server = server_for(&entry, Some(auth.clone()), dir.path());
    server.connect().await.unwrap();
    assert_eq!(auth.renewed.load(Ordering::SeqCst), 1, "the refused token was renewed once");
    assert_eq!(server.catalog().unwrap().entries[0].qualified, "mcp__legacy__echo");
    let out = server
        .call_tool("t", "echo", json!({"text": "over sse"}), &CancellationToken::new(), None)
        .await
        .unwrap();
    assert_eq!(out.parts, vec![ToolPart::Text("over sse".to_owned())]);
    let seen = bearers.lock().unwrap().clone();
    assert_eq!(seen[0].as_deref(), Some("Bearer old"));
    assert!(seen[1..].iter().all(|b| b.as_deref() == Some("Bearer fresh")));
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_carries_messages_with_the_mcp_subprotocol_and_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    type Seen = Arc<Mutex<Vec<(Option<String>, Option<String>)>>>;
    let seen: Seen = Arc::default();
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        #[allow(clippy::result_large_err, reason = "the signature tokio-tungstenite's handshake callback requires")]
        let callback = |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                        mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            record.lock().unwrap().push((header("sec-websocket-protocol"), header("x-key")));
            response.headers_mut().insert("sec-websocket-protocol", "mcp".parse().unwrap());
            Ok(response)
        };
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
        while let Some(Ok(frame)) = socket.next().await {
            if let Message::Text(text) = frame {
                let message: Value = serde_json::from_str(text.as_str()).unwrap();
                if let Some(reply) = answer(&message) {
                    socket.send(Message::Text(reply.to_string().into())).await.unwrap();
                }
            }
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let entry = json!({"type": "ws", "url": format!("ws://127.0.0.1:{port}/mcp"), "headers": {"X-Key": "k-value"}});
    let server = server_for(&entry, None, dir.path());
    server.connect().await.unwrap();
    let out = server
        .call_tool("t", "echo", json!({"text": "over ws"}), &CancellationToken::new(), None)
        .await
        .unwrap();
    assert_eq!(out.parts, vec![ToolPart::Text("over ws".to_owned())]);
    assert_eq!(seen.lock().unwrap()[0], (Some("mcp".to_owned()), Some("k-value".to_owned())));
    server.close().await;
}
