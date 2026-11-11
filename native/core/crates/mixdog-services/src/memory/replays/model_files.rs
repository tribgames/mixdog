//! memory-embedding-model-files: `ensure_model_file` / `ensure_model_graph` (`ensureModelFile` / `ensureModelGraph`),
//! the two steps the public embedding install (`install::install`, through `EmbeddingProvider::install`) is made of,
//! in the order Node's embedding worker calls them (`embedding-worker.mjs:286-307`: tokenizer.json,
//! tokenizer_config.json, then the graph after its weights). Each session runs over a real temp cache directory; the
//! hub is a local HTTP server that records every request.
//!
//! Mappings:
//! - The hub's answers are those of the recorder's script, read back from the recording: a URL whose download the
//!   error names (`… HTTP <status>`) answers that status, a URL whose file a step left in the cache answers those
//!   bytes, any other URL answers 404 (the script's default).
//! - A recorded URL is `https://huggingface.co/…` ([`HUB`]); the replay's hub is the local server, its origin written
//!   as `HUB` before comparing.
//! - `init: undefined` (Node passes none, so the request carries only the HTTP client's own headers): each request is
//!   a body-less GET whose headers are exactly the HTTP client's defaults (reqwest: `accept: */*`,
//!   `accept-encoding`, `host`), none set by the caller. Node's fetch defaults (`user-agent: node`, …) are not in the
//!   recording.
//! - An error compares name and message: the core's error is `InstallError::Hub`, named `Error` as Node's.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_testkit::Exact;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::{assert_case_count, case, golden, object, same, string};
use crate::memory::embed::install::{HUB, Hub, ensure_model_file, ensure_model_graph};

const SET: &str = "memory-embedding-model-files";
const STEP_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// A hub answering `answers` (path → status, body) and recording each request in order.
struct ScriptedHub {
    origin: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ScriptedHub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn scripted_hub(answers: Vec<(String, u16, Vec<u8>)>) -> ScriptedHub {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("addr"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let head_end = loop {
                if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at;
                }
                let read = stream.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    break buf.len();
                }
                buf.extend_from_slice(&chunk[..read]);
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
            let mut lines = head.split("\r\n");
            let mut start = lines.next().unwrap_or_default().split(' ');
            let method = start.next().unwrap_or_default().to_owned();
            let path = start.next().unwrap_or_default().to_owned();
            let headers: Vec<(String, String)> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let length = headers.iter().find(|(n, _)| n == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0usize);
            let mut body = buf.get(head_end + 4..).unwrap_or_default().to_vec();
            while body.len() < length {
                let read = stream.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read]);
            }
            let (status, answer) = answers
                .iter()
                .find(|(p, _, _)| *p == path)
                .map_or((404, b"not found".to_vec()), |(_, status, body)| (*status, body.clone()));
            log.lock().expect("requests").push(Seen { method, path, headers, body });
            let head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", answer.len());
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&answer).await;
            let _ = stream.shutdown().await;
        }
    });
    ScriptedHub { origin, seen, task }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex")).collect()
}

/// Every file under `dir`, names sorted per directory, depth first (the recorder's `files`).
#[allow(clippy::disallowed_methods, reason = "a test reading its own temp directory")]
fn files(dir: &Path) -> Exact {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<Exact>) {
        let mut names: Vec<_> = std::fs::read_dir(dir).expect("read dir").map(|e| e.expect("entry").file_name()).collect();
        names.sort();
        for name in names {
            let full = dir.join(&name);
            if full.is_dir() {
                walk(root, &full, out);
            } else {
                let path = full.strip_prefix(root).expect("under root").to_string_lossy().replace('\\', "/");
                out.push(object(vec![("path", string(path)), ("bytesHex", string(hex(&std::fs::read(&full).expect("read"))))]));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    Exact::Array(out)
}

#[allow(clippy::disallowed_methods, reason = "a test writing its own temp directory")]
fn write(dir: &Path, entry: &Exact) {
    let path = dir.join(entry.get("path").as_str());
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(path, unhex(entry.get("bytesHex").as_str())).expect("write");
}

/// The script's answers, read back from the session (module header).
fn answers(session: &Exact) -> Vec<(String, u16, Vec<u8>)> {
    let mut out: Vec<(String, u16, Vec<u8>)> = Vec::new();
    for step in session.get("steps").as_array() {
        let failed = step.try_get("error").map(|e| match e {
            Exact::Error { message, .. } => message.clone(),
            other => panic!("error {other:?}"),
        });
        for request in step.get("requests").as_array() {
            let url = request.get("url").as_str();
            let tail = url.strip_prefix(&format!("{HUB}/")).expect("a hub URL");
            let path = format!("/{tail}");
            if out.iter().any(|(p, _, _)| *p == path) {
                continue;
            }
            let file = tail.replacen("/resolve/main/", "/", 1);
            let status = failed.as_deref().and_then(|m| m.strip_prefix(&format!("embedding model download failed: {file} HTTP ")));
            if let Some(status) = status {
                out.push((path, status.parse().expect("status"), b"busy".to_vec()));
                continue;
            }
            let left = step.get("cacheAfter").as_array().iter().find(|f| f.get("path").as_str() == file);
            if let Some(left) = left {
                out.push((path, 200, unhex(left.get("bytesHex").as_str())));
            }
        }
    }
    out
}

async fn replay_session(name: &str, session: &Exact) {
    let cache = tempfile::tempdir().expect("cache dir");
    let dir = cache.path().to_path_buf();
    for entry in session.get("setup").as_array() {
        write(&dir, entry);
    }
    let server = scripted_hub(answers(session)).await;
    let cancel = CancellationToken::new();
    let hub = Hub { lane: mixdog_rt::testing::tokens().cpu_bulk, url: &server.origin, progress: None, cancel: &cancel };
    for (at, step) in session.get("steps").as_array().iter().enumerate() {
        let what = format!("{name}: step {at}");
        if let Some(entry) = step.try_get("write") {
            write(&dir, entry);
        }
        let before = server.seen.lock().expect("requests").len();
        let (model, file) = (step.get("model").as_str(), step.get("file").as_str());
        let call = async {
            match step.get("call").as_str() {
                "graph" => ensure_model_graph(&hub, &dir, model, file).await,
                "file" => ensure_model_file(&hub, &dir, model, file).await,
                other => panic!("{what}: call {other}"),
            }
        };
        let outcome = tokio::time::timeout(STEP_DEADLINE, call).await.unwrap_or_else(|_| panic!("{what}: did not settle within 30 s"));
        match (outcome, step.try_get("error")) {
            (Ok(path), None) => {
                let relative = path.strip_prefix(&dir).expect("under the cache").to_string_lossy().replace('\\', "/");
                same(&format!("{what}: result"), step.get("result"), &string(relative));
            }
            (Err(error), Some(Exact::Error { name, message, code, cause, props })) => {
                assert_eq!(name, "Error", "{what}: error name");
                assert_eq!(&error.to_string(), message, "{what}: error message");
                assert!(code.is_none() && cause.is_none() && props.is_empty(), "{what}: Node's error carries nothing else");
                assert!(matches!(error, crate::model_install::InstallError::Hub(_)), "{what}: {error:?}");
            }
            (outcome, recorded) => panic!("{what}: the core answered {outcome:?}, Node {recorded:?}"),
        }
        let seen: Vec<Seen> = server.seen.lock().expect("requests")[before..].to_vec();
        let host = server.origin.trim_start_matches("http://");
        for request in &seen {
            assert_eq!(request.method, "GET", "{what}: method");
            assert!(request.body.is_empty(), "{what}: body");
            let expected = vec![
                ("accept".to_owned(), "*/*".to_owned()),
                ("accept-encoding".to_owned(), "gzip,deflate,br".to_owned()),
                ("host".to_owned(), host.to_owned()),
            ];
            assert_eq!(request.headers, expected, "{what}: headers of {}", request.path);
        }
        let requests = Exact::Array(
            seen.iter().map(|r| object(vec![("url", string(format!("{HUB}{}", r.path))), ("init", Exact::Undefined)])).collect(),
        );
        same(&format!("{what}: requests"), step.get("requests"), &requests);
        same(&format!("{what}: cache"), step.get("cacheAfter"), &files(&dir));
    }
}

#[test]
fn the_recording_has_three_cases() {
    assert_case_count(&golden(SET), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn an_intact_cached_graph_with_empty_or_nul_external_weights_fetches_only_the_weights() {
    let g = golden(SET);
    let name = "an intact cached graph with empty or NUL external weights fetches only the weights";
    replay_session(name, case(&g, 0, name).get("session")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn empty_nul_filled_or_unparsable_cached_model_files_are_fetched_again() {
    let g = golden(SET);
    let name = "empty, NUL-filled or unparsable cached model files are fetched again";
    replay_session(name, case(&g, 1, name).get("session")).await;
}

#[tokio::test(flavor = "current_thread")]
async fn further_shapes_cold_graph_404_weights_404_graph_503_exact_text_file_healthy_cache() {
    let g = golden(SET);
    let name = "further shapes (beyond the test file): cold graph, 404 weights, 404 graph, 503, exact-text file, healthy cache";
    for (at, session) in case(&g, 2, name).get("sessions").as_array().iter().enumerate() {
        replay_session(&format!("{name}: session {at}"), session).await;
    }
}
