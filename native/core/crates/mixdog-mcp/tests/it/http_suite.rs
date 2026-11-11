//! Streamable HTTP transport against a loopback server speaking JSON, SSE and 202.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

type Seen = Arc<Mutex<Vec<(String, Option<String>, Option<String>)>>>;

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
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap().to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .map_or(0, |(_, v)| v.parse().unwrap());
    while buf.len() < header_end + length {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
    }
    (method, path, headers, buf[header_end..header_end + length].to_vec())
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, headers: &[(&str, &str)], body: &str) {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    stream.write_all(out.as_bytes()).await.unwrap();
}

async fn serve(listener: TcpListener, seen: Seen) {
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let seen = Arc::clone(&seen);
        tokio::spawn(async move {
            let (method, _path, headers, body) = read_request(&mut stream).await;
            let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
            if method != "POST" {
                return respond(&mut stream, "405 Method Not Allowed", &[], "").await;
            }
            let message: Value = serde_json::from_slice(&body).unwrap();
            let rpc = message["method"].as_str().unwrap_or_default().to_owned();
            seen.lock().unwrap().push((rpc.clone(), header("mcp-session-id"), header("mcp-protocol-version")));
            let id = message["id"].clone();
            match rpc.as_str() {
                "initialize" => {
                    let result = json!({"jsonrpc": "2.0", "id": id, "result": {
                        "protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}});
                    respond(&mut stream, "200 OK", &[("content-type", "application/json"), ("mcp-session-id", "sess-1")], &result.to_string()).await;
                }
                "tools/list" => {
                    let result = json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [
                        {"name": "echo", "inputSchema": {"type": "object"}}]}});
                    let sse = format!("event: message\r\ndata: {result}\r\n\r\n");
                    respond(&mut stream, "200 OK", &[("content-type", "text/event-stream")], &sse).await;
                }
                "tools/call" => {
                    let text = message["params"]["arguments"]["text"].clone();
                    let result = json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": text}]}});
                    respond(&mut stream, "200 OK", &[("content-type", "application/json")], &result.to_string()).await;
                }
                _ => respond(&mut stream, "202 Accepted", &[], "").await,
            }
        });
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn handshake_session_json_and_sse_responses_work_over_http() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::default();
    let server_task = tokio::spawn(serve(listener, Arc::clone(&seen)));

    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp"), "headers": {"X-Key": "secret-value"}});
    let config = McpServerConfig::from_entry("web", &entry, &Default::default()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
    server.connect().await.unwrap();
    assert_eq!(server.catalog().unwrap().entries[0].qualified, "mcp__web__echo", "tools/list came back as SSE");
    let out = server
        .call_tool("t", "echo", json!({"text": "over http"}), &CancellationToken::new(), None)
        .await
        .unwrap();
    assert_eq!(out.parts, vec![ToolPart::Text("over http".to_owned())]);

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0], ("initialize".to_owned(), None, None));
    let call = seen.iter().find(|s| s.0 == "tools/call").unwrap();
    assert_eq!(call.1.as_deref(), Some("sess-1"), "the session id is echoed");
    assert_eq!(call.2.as_deref(), Some("2025-06-18"), "so is the negotiated protocol version");
    server.close().await;
    server_task.abort();
}
