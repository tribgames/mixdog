//! `mixdogd exec` on its own core, replayed from Node's recording (`fixtures/exec-readonly`, `record-exec-readonly.mjs`): each
//! case runs the exec flow over the real launcher, which composes the core in this process on the pristine root and reaches it
//! over the in-process connector, with the provider's base URL pointed at a stand-in that serves the recorded replies. The
//! requests the core sends (the tools offered, the tool results), stdout, stderr, the exit code, the usage document and the
//! files of the working folder are Node's. Own test binary: the run sets the process environment and boots the executors.
#![allow(clippy::disallowed_methods, reason = "the test writes the install layout and reads what the run left on disk")]

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_server_client::api::ThreadReducer;
use mixdog_cli::exec::ExecArgs;
use mixdog_cli::exec::Sink;
use mixdog_cli::exec::boundary::Boundary;
use mixdog_cli::exec::launcher::InProcessLauncher;
use mixdog_cli::exec::launcher::ResolvedCredentials;
use mixdog_cli::exec::run::Host;
use mixdog_cli::exec::run::run_exec;
use mixdog_cli::exec::seams::CoreLauncher;
use mixdog_cli::exec::seams::CoreSession;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

/// The cases a command line selects: text output (the mode `review-deck.mjs` runs) and `--json`, each read-only and full.
fn cases() -> [&'static str; 4] {
    [
        mixdog_testkit::fixture!("../../fixtures/exec-readonly/readonly-blocked.json"),
        mixdog_testkit::fixture!("../../fixtures/exec-readonly/full-simple.json"),
        mixdog_testkit::fixture!("../../fixtures/exec-readonly/readonly-json.json"),
        mixdog_testkit::fixture!("../../fixtures/exec-readonly/full-json.json"),
    ]
}
/// The clock Node's JSON runs were pinned to.
const FIXED_NOW: i64 = 1_700_000_000_000;
/// The thread id and working folder Node's runs were pinned to.
const NODE_THREAD: &str = "sess_exec_readonly";
const NODE_CWD: &str = "/work";

#[derive(Default)]
struct Out {
    out: Mutex<Vec<String>>,
    err: Mutex<Vec<String>>,
}

impl Sink for Out {
    fn out(&self, text: &str) {
        eprint!("[exec stdout] {text}");
        self.out.lock().unwrap().push(text.to_owned());
    }
    fn err(&self, text: &str) {
        eprint!("[exec stderr] {text}");
        self.err.lock().unwrap().push(text.to_owned());
    }
}

/// The recorder's `messageSse` for one served reply.
fn reply_body(served: &Value, index: usize) -> String {
    let sse = |kind: &str, data: Value| format!("event: {kind}\ndata: {data}\n\n");
    let mut parts = vec![sse(
        "message_start",
        json!({ "type": "message_start", "message": { "id": format!("msg_{index}"), "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "usage": { "input_tokens": served["inputTokens"], "output_tokens": 1 } } }),
    )];
    let mut block = 0;
    let text = served["text"].as_str().unwrap();
    if !text.is_empty() {
        parts.push(sse("content_block_start", json!({ "type": "content_block_start", "index": block, "content_block": { "type": "text", "text": "" } })));
        parts.push(sse("content_block_delta", json!({ "type": "content_block_delta", "index": block, "delta": { "type": "text_delta", "text": text } })));
        parts.push(sse("content_block_stop", json!({ "type": "content_block_stop", "index": block })));
        block += 1;
    }
    for call in served["calls"].as_array().unwrap() {
        parts.push(sse("content_block_start", json!({ "type": "content_block_start", "index": block, "content_block": { "type": "tool_use", "id": call["id"], "name": call["name"], "input": {} } })));
        parts.push(sse("content_block_delta", json!({ "type": "content_block_delta", "index": block, "delta": { "type": "input_json_delta", "partial_json": call["input"].to_string() } })));
        parts.push(sse("content_block_stop", json!({ "type": "content_block_stop", "index": block })));
        block += 1;
    }
    parts.push(sse("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": served["stopReason"] }, "usage": { "output_tokens": served["outputTokens"] } })));
    parts.push(sse("message_stop", json!({ "type": "message_stop" })));
    parts.concat()
}

/// What one request the core sent carried, in the recording's shape.
fn heard(body: &Value) -> Value {
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

/// The stand-in provider: every `POST /v1/messages` is answered with the next recorded reply, and its body is kept.
async fn serve(listener: tokio::net::TcpListener, replies: Vec<String>, bodies: Arc<Mutex<Vec<Value>>>, others: Arc<Mutex<Vec<String>>>) {
    let mut replies = replies.into_iter();
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { return };
        let mut raw = Vec::new();
        let (head_len, length, chunked, gzip, target) = loop {
            let mut chunk = [0u8; 8192];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "the request ended before its head");
            raw.extend_from_slice(&chunk[..read]);
            let mut headers = [httparse::EMPTY_HEADER; 64];
            let mut request = httparse::Request::new(&mut headers);
            if let httparse::Status::Complete(head_len) = request.parse(&raw).unwrap() {
                let header = |name: &str| request.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| String::from_utf8_lossy(h.value).into_owned());
                let target = format!("{} {}", request.method.unwrap_or_default(), request.path.unwrap_or_default());
                break (
                    head_len,
                    header("content-length").map_or(0, |v| v.parse::<usize>().unwrap()),
                    header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")),
                    header("content-encoding").as_deref() == Some("gzip"),
                    target,
                );
            }
        };
        let mut body = if chunked {
            // The body runs until the zero-length chunk.
            let mut decoded = Vec::new();
            let mut at = head_len;
            loop {
                while !raw[at..].windows(2).any(|w| w == b"\r\n") {
                    let mut chunk = [0u8; 8192];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "the request ended inside a chunk size");
                    raw.extend_from_slice(&chunk[..read]);
                }
                let line_end = at + raw[at..].windows(2).position(|w| w == b"\r\n").unwrap();
                let size = usize::from_str_radix(String::from_utf8_lossy(&raw[at..line_end]).split(';').next().unwrap().trim(), 16).unwrap();
                at = line_end + 2;
                while raw.len() < at + size + 2 {
                    let mut chunk = [0u8; 8192];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "the request ended inside a chunk");
                    raw.extend_from_slice(&chunk[..read]);
                }
                if size == 0 {
                    break decoded;
                }
                decoded.extend_from_slice(&raw[at..at + size]);
                at += size + 2;
            }
        } else {
            while raw.len() < head_len + length {
                let mut chunk = [0u8; 8192];
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "the request ended before its body");
                raw.extend_from_slice(&chunk[..read]);
            }
            raw[head_len..head_len + length].to_vec()
        };
        eprintln!("[stand-in] {target}");
        if !target.split('?').next().unwrap_or_default().ends_with("/v1/messages") {
            // Only the turn's messages are scripted; any other call gets the recorder's answer.
            others.lock().unwrap().push(target);
            socket.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nno script").await.unwrap();
            socket.shutdown().await.unwrap();
            continue;
        }
        if gzip {
            let mut plain = Vec::new();
            flate2::read::GzDecoder::new(&body[..]).read_to_end(&mut plain).unwrap();
            body = plain;
        }
        bodies.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
        let reply = replies.next().expect("a recorded reply for every request");
        let response = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    }
}

/// The real launcher, with the provider of the pristine config pointed at the stand-in before the core reads it.
struct Pointed {
    inner: InProcessLauncher,
    base_url: String,
    root: Mutex<Option<PathBuf>>,
}

#[async_trait]
impl CoreLauncher for Pointed {
    async fn launch(&self, boundary: &Boundary, feed: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String> {
        let config_path = boundary.data_dir.join("mixdog-config.json");
        let mut config: Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        config["agent"]["providers"]["anthropic"]["baseURL"] = json!(self.base_url);
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        *self.root.lock().unwrap() = Some(boundary.root_dir.clone());
        eprintln!("[launch] composing");
        let session = self.inner.launch(boundary, feed).await;
        eprintln!("[launch] {}", if session.is_ok() { "connected" } else { "failed" });
        Ok(Arc::new(Traced(session?)))
    }
}

/// The session with every call it carries shown on stderr, so a stuck run names the call it is stuck in.
struct Traced(Arc<dyn CoreSession>);

#[async_trait]
impl CoreSession for Traced {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        eprintln!("[call] {method}");
        let result = self.0.call(method, params).await;
        eprintln!("[call] {method} -> {}", if result.is_ok() { "ok" } else { "error" });
        result
    }
    async fn lost(&self) -> String {
        self.0.lost().await
    }
    async fn close(&self) -> Result<(), String> {
        eprintln!("[close]");
        self.0.close().await
    }
    async fn stop_services(&self) -> Result<(), String> {
        self.0.stop_services().await
    }
}

/// An install beside a stand-in binary path: the bundled JS package is this tree's, its interpreter the `node` on `PATH`.
fn install(dir: &Path) -> mixdog_app_server_daemon::compose::JsRuntime {
    let core = dir.join("core");
    std::fs::create_dir_all(&core).unwrap();
    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    std::fs::write(core.join("js-runtime.json"), json!({ "program": "node", "packageRoot": package }).to_string()).unwrap();
    mixdog_app_server_daemon::js_runtime::resolve(&core.join("mixdogd"), std::env::var_os("PATH").as_deref()).unwrap()
}

/// A JSON stdout line as Node's pinned run printed it: the thread id, the working folder and the clock are the pinned ones.
fn pinned(line: &str, thread: &str, cwd: &str) -> String {
    let mut event: Value = serde_json::from_str(line).unwrap();
    fn walk(value: &mut Value, thread: &str, cwd: &str) {
        match value {
            Value::Object(map) => {
                for (key, field) in map.iter_mut() {
                    match (key.as_str(), &*field) {
                        ("timestamp" | "started_at" | "completed_at", Value::String(_)) => *field = json!("2023-11-14T22:13:20.000Z"),
                        ("duration_ms" | "duration_api_ms" | "queue_ms" | "dispatch_ms" | "execution_ms" | "batch_wait_ms" | "postprocess_ms" | "total_ms", Value::Number(_)) => *field = json!(0),
                        (_, Value::String(text)) if text == thread => *field = json!(NODE_THREAD),
                        ("cwd", Value::String(text)) if text == cwd => *field = json!(NODE_CWD),
                        _ => walk(field, thread, cwd),
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, thread, cwd)),
            _ => {}
        }
    }
    walk(&mut event, thread, cwd);
    format!("{}\n", serde_json::to_string(&event).unwrap())
}

#[test]
fn an_exec_on_its_own_core_does_what_node_recorded_for_every_case() {
    let (executors, tokens) = mixdog_app_server_daemon::boot_executors().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for text in cases() {
        let case: Value = serde_json::from_str(text).unwrap();
        let label = case["case"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("a.txt"), "hello\n").unwrap();
        for folder in ["tmp", "host-data"] {
            std::fs::create_dir_all(dir.path().join(folder)).unwrap();
        }
        let usage_path = dir.path().join("usage.json");
        let requests = case["requests"].as_array().unwrap();
        let replies = requests.iter().enumerate().map(|(index, request)| reply_body(&request["served"], index + 1)).collect();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let others = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(Out::default());
        let code = runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(serve(listener, replies, bodies.clone(), others.clone()));
            let launcher = Pointed {
                inner: InProcessLauncher::new(executors.clone(), tokens.clone(), install(dir.path()), mixdog_services::effort_judge::model::OrtRuntime::NoBinding),
                base_url,
                root: Mutex::new(None),
            };
            let mut argv = vec!["--provider".to_owned(), "anthropic".into(), "--model".into(), "claude-sonnet-4-6".into(), "--cwd".into(), work.to_string_lossy().into_owned(), "--tool-mode".into(), case["mode"].as_str().unwrap().into()];
            if case["json"] == true {
                argv.push("--json".into());
            }
            argv.extend(["--usage-log".to_owned(), usage_path.to_string_lossy().into_owned(), "go".into()]);
            #[derive(clap::Parser)]
            struct Wrapper {
                #[command(flatten)]
                args: ExecArgs,
            }
            let options = <Wrapper as clap::Parser>::try_parse_from(std::iter::once("exec".to_owned()).chain(argv)).unwrap().args.into_options(None).unwrap();
            let host = Host {
                launcher: &launcher,
                credentials: &ResolvedCredentials { api_key: Some("sk-fake".into()), pool_credential: None },
                host_env: BTreeMap::from([("PATH".to_owned(), std::env::var("PATH").unwrap_or_default())]),
                host_data_dir: dir.path().join("host-data"),
                temp_dir: dir.path().join("tmp"),
                sink: sink.clone(),
                now: Arc::new(|| FIXED_NOW),
            };
            let code = run_exec(options, host, Box::pin(std::future::pending())).await;
            server.abort();
            assert!(!launcher.root.lock().unwrap().as_ref().expect("launched").exists(), "{label}: the pristine root is removed");
            code
        });

        let heard: Vec<Value> = bodies.lock().unwrap().iter().map(heard).collect();
        assert_eq!(heard.len(), requests.len(), "{label}: the requests the core sent (other calls: {:?})", others.lock().unwrap());
        // Node reached `api.anthropic.com` (its fetch was intercepted), a first-party route, so its follow-ups are message-thread
        // continues (`anthropic-message-threads.mjs`): a delta body without `tools`, the server holding the create's list (the
        // thread fingerprint covers the tools, so a continue never changes them). The stand-in here is a local origin, where the
        // core sends every request as a create: a recorded request without tools is compared with the create it continued.
        let mut held = Value::Null;
        for (index, (got, node)) in heard.iter().zip(requests).enumerate() {
            assert_eq!(got["model"], node["model"], "{label}: request {index} model");
            if node["tools"].as_array().is_some_and(|tools| !tools.is_empty()) || index == 0 {
                held = node["tools"].clone();
            }
            let names = |tools: &Value| tools.as_array().unwrap().iter().map(|tool| tool["name"].clone()).collect::<Vec<_>>();
            assert_eq!(names(&got["tools"]), names(&held), "{label}: request {index} tool names");
            assert_eq!(got["tools"], held, "{label}: request {index} tools");
            assert_eq!(got["toolResults"], node["toolResults"], "{label}: request {index} tool results");
        }
        assert_eq!(code, case["code"], "{label}: exit code");
        let mut usage: Value = serde_json::from_str(&std::fs::read_to_string(&usage_path).unwrap()).unwrap();
        let thread = usage["sessions"][0]["sessionId"].as_str().expect("the run's session").to_owned();
        let stdout: String = sink.out.lock().unwrap().iter().map(|chunk| if case["json"] == true { chunk.lines().map(|line| pinned(line, &thread, &work.to_string_lossy())).collect() } else { chunk.clone() }).collect();
        assert_eq!(stdout, case["stdout"].as_array().unwrap().iter().map(|line| line.as_str().unwrap()).collect::<String>(), "{label}: stdout");
        assert_eq!(sink.err.lock().unwrap().concat(), case["stderr"].as_array().unwrap().iter().map(|line| line.as_str().unwrap()).collect::<String>(), "{label}: stderr");
        usage["sessions"][0]["sessionId"] = json!(NODE_THREAD);
        assert_eq!(usage, case["usage"], "{label}: usage document");
        let files: BTreeMap<String, String> = std::fs::read_dir(&work).unwrap().map(|entry| entry.unwrap()).map(|entry| (entry.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(entry.path()).unwrap())).collect();
        assert_eq!(serde_json::to_value(files).unwrap(), case["files"], "{label}: the working folder");
    }
}
