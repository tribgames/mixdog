//! One HTTP/1.1 request read off a stand-in provider's connection, as the exec replays' stand-ins read it: the head, then
//! the body by `content-length` or chunked, inflated when it was sent gzipped.

use std::io::Read;

use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;

/// What one messages request carried, in the recordings' shape (the recorders' `heard`): the model, the tools offered,
/// and the tool results of its last message.
pub fn heard(body: &Value) -> Value {
    let tools: Vec<Value> = body["tools"].as_array().map_or_else(Vec::new, |tools| {
        tools.iter().map(|tool| json!({ "name": tool["name"], "description": tool["description"], "input_schema": tool["input_schema"] })).collect()
    });
    let results: Vec<Value> = body["messages"].as_array().and_then(|messages| messages.last()).and_then(|last| last["content"].as_array()).map_or_else(Vec::new, |blocks| {
        blocks
            .iter()
            .filter(|block| block["type"] == "tool_result")
            .map(|block| json!({ "tool_use_id": block["tool_use_id"], "is_error": block.get("is_error").cloned().unwrap_or(json!(false)), "content": block["content"] }))
            .collect()
    });
    json!({ "model": body["model"], "tools": tools, "toolResults": results })
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub body: Vec<u8>,
}

async fn more<S: AsyncRead + Unpin>(socket: &mut S, raw: &mut Vec<u8>, what: &str) {
    let mut chunk = [0u8; 8192];
    let read = socket.read(&mut chunk).await.unwrap();
    assert!(read > 0, "the request ended {what}");
    raw.extend_from_slice(&chunk[..read]);
}

/// The next request of the connection; `None` when it closed before sending one.
pub async fn read_request<S: AsyncRead + Unpin>(socket: &mut S) -> Option<Request> {
    let mut raw = Vec::new();
    let (head_len, length, chunked, gzip, method, path, host) = loop {
        let mut chunk = [0u8; 8192];
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            assert!(raw.is_empty(), "the request ended before its head");
            return None;
        }
        raw.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut request = httparse::Request::new(&mut headers);
        if let httparse::Status::Complete(head_len) = request.parse(&raw).unwrap() {
            let header = |name: &str| request.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).into_owned());
            break (
                head_len,
                header("content-length").map_or(0, |v| v.parse::<usize>().unwrap()),
                header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")),
                header("content-encoding").as_deref() == Some("gzip"),
                request.method.unwrap_or_default().to_owned(),
                request.path.unwrap_or_default().to_owned(),
                header("host"),
            );
        }
    };
    let body = if chunked {
        // The body runs until the zero-length chunk.
        let mut decoded = Vec::new();
        let mut at = head_len;
        loop {
            while !raw[at..].windows(2).any(|w| w == b"\r\n") {
                more(socket, &mut raw, "inside a chunk size").await;
            }
            let line_end = at + raw[at..].windows(2).position(|w| w == b"\r\n").unwrap();
            let size = usize::from_str_radix(String::from_utf8_lossy(&raw[at..line_end]).split(';').next().unwrap().trim(), 16).unwrap();
            at = line_end + 2;
            while raw.len() < at + size + 2 {
                more(socket, &mut raw, "inside a chunk").await;
            }
            if size == 0 {
                break decoded;
            }
            decoded.extend_from_slice(&raw[at..at + size]);
            at += size + 2;
        }
    } else {
        while raw.len() < head_len + length {
            more(socket, &mut raw, "before its body").await;
        }
        raw[head_len..head_len + length].to_vec()
    };
    let body = if gzip {
        let mut plain = Vec::new();
        flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut plain).unwrap();
        plain
    } else {
        body
    };
    Some(Request { method, path, host, body })
}
