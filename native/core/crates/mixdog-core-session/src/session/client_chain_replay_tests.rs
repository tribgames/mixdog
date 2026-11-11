//! Replays whose client half is the product's own TypeScript, run by node against this crate's threads in one chain: the client
//! half consumes what the core half has just produced, never a stored copy of it.
//! - `remote-transcript-window-cases` (benchmarks/rust-core/recorders/replay-remote-transcript-window.mjs): the phone's
//!   transcript window (apps/desktop/src/main/remote-phone-transcript.ts) over a thread's `thread/resume` snapshot, its feed
//!   and its `thread/items/list` pages, folded by packages/protocol-client;
//! - `desktop-visibility-restart-cases` (replay-desktop-visibility-restart.mjs): the desktop's service route
//!   (apps/desktop/src/main/protocol/service-route.ts `setVisibleSessions`), one connection per desktop process.
//!
//! The script asks for what it needs as JSON lines on its stdout (recorders/lib/core-bridge.mjs) and is answered on its stdin;
//! it compares with the recording itself and ends with `{"done": {"failures": [...]}}`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;

use super::SessionDirectory;
use super::testing::Rig;
use super::tests::start_thread;
use super::transcript::position_of_id;
use crate::eventually_on;

/// One client connection: its subscriptions by thread, and the feed frames drained after a snapshot not yet asked for.
struct Conn {
    connection: MockConnection,
    subs: Vec<(ThreadId, SubscriptionId)>,
    pending: Vec<Value>,
}

struct Bridge {
    directory: Arc<SessionDirectory>,
    conns: HashMap<u64, Conn>,
    closed: Vec<u64>,
    next_sub: u64,
}

/// A drained frame as `(subscription, JSON)`: `drain_text` renders `control:<frame>` or `<sub>:<frame>`.
fn parsed(text: &str) -> (String, Value) {
    let (lane, frame) = text.split_once(':').expect("a rendered frame");
    (lane.to_owned(), serde_json::from_str(frame).expect("a JSON frame"))
}

fn str_of<'a>(call: &'a Value, key: &str) -> Result<&'a str, String> {
    call.get(key).and_then(Value::as_str).ok_or_else(|| format!("`{key}` is missing"))
}

fn conn_of(call: &Value) -> Result<u64, String> {
    call.get("conn").and_then(Value::as_u64).ok_or_else(|| "`conn` is missing".to_owned())
}

/// The connection-addressed reads a script may make.
fn read_method(name: &str) -> Result<Method, String> {
    match name {
        "thread/items/list" => Ok(Method("thread/items/list")),
        other => Err(format!("{other} is not served here")),
    }
}

impl Bridge {
    fn conn(&mut self, id: u64) -> Result<&mut Conn, String> {
        if self.closed.contains(&id) {
            return Err("the connection is closed".to_owned());
        }
        Ok(self.conns.entry(id).or_insert_with(|| Conn {
            connection: MockConnection::new(ConnectionId(id), MockLimits::default()),
            subs: Vec::new(),
            pending: Vec::new(),
        }))
    }

    /// The thread frames `conn` received since it last asked: `{threadId, method, params}` each.
    fn frames(&mut self, id: u64) -> Result<Value, String> {
        let conn = self.conn(id)?;
        let mut frames = std::mem::take(&mut conn.pending);
        for text in conn.connection.drain_text() {
            let (lane, frame) = parsed(&text);
            if let Some((thread, _)) = conn.subs.iter().find(|(_, sub)| sub.as_str() == lane) {
                frames.push(json!({ "threadId": thread, "method": frame["method"], "params": frame["params"] }));
            }
        }
        Ok(Value::Array(frames))
    }

    async fn serve(&mut self, call: &Value) -> Result<Value, String> {
        match str_of(call, "call")? {
            "thread" => Ok(json!({ "threadId": start_thread(&self.directory).await.id })),
            // Rows of the conversation as Node transcript messages, stored as rows of no turn and shown live as they land; answered
            // once the thread shows the last of them.
            "append" => {
                let id = ThreadId::from(str_of(call, "threadId")?);
                // A conversation no desktop follows is unloaded; the session publishing to it opens it again, as the core does.
                let handle = self.directory.open_handle(&id, &CallContext::internal("test")).await.map_err(|error| format!("{error:?}"))?;
                let messages = call.get("messages").and_then(Value::as_array).cloned().ok_or("`messages` is missing")?;
                let last = messages.last().and_then(|m| m.pointer("/meta/transcript/clientSubmissionId")).and_then(Value::as_str).ok_or("each message names its row id")?.to_owned();
                let append = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") };
                handle.request(append).await.map_err(|error| format!("{error:?}"))?;
                eventually_on!(&[&handle.cell.stepped], || position_of_id(handle.cell.view.load_full().items.iter().map(|item| item.as_ref()), &last).map(|_| ())).await;
                Ok(json!({}))
            }
            // `thread/resume` on `conn`: the `thread/snapshot` params it is answered with.
            "resume" => {
                let id = ThreadId::from(str_of(call, "threadId")?);
                let window: mixdog_app_protocol::v2::feed::ResumeWindow = serde_json::from_value(call["window"].clone()).map_err(|e| e.to_string())?;
                let mixdog_app_protocol::v2::feed::ResumeWindow::LastItems { last_items } = window else { return Err("a lastItems window".into()) };
                // thread/resume opens the thread it follows.
                let handle = self.directory.open_handle(&id, &CallContext::internal("test")).await.map_err(|error| format!("{error:?}"))?;
                self.next_sub += 1;
                let sub = SubscriptionId::from(format!("sub{}", self.next_sub).as_str());
                let conn = self.conn(conn_of(call)?)?;
                let source: Arc<dyn FeedSource> = handle;
                let attached = mixdog_core_api::feed::subscribe(&source, sub.clone(), Window::LastItems(last_items), None, &conn.connection).map_err(|e| format!("{e:?}"))?;
                conn.connection.send_control_release(Bytes::from_static(b"{}"), attached.release).map_err(|e| format!("{e:?}"))?;
                conn.subs.push((id.clone(), sub.clone()));
                let texts = conn.connection.drain_text_until(|texts| texts.iter().any(|text| parsed(text).1["method"] == "thread/snapshot")).await;
                let mut snapshot = Value::Null;
                for text in texts {
                    let (lane, frame) = parsed(&text);
                    if lane != sub.as_str() {
                        continue;
                    }
                    if frame["method"] == "thread/snapshot" && snapshot.is_null() {
                        snapshot = frame["params"].clone();
                    } else {
                        conn.pending.push(json!({ "threadId": id, "method": frame["method"], "params": frame["params"] }));
                    }
                }
                Ok(snapshot)
            }
            "frames" => self.frames(conn_of(call)?),
            // The threads `conn` follows now.
            "subscribed" => Ok(json!(self.conn(conn_of(call)?)?.subs.iter().map(|(thread, _)| thread.as_str()).collect::<Vec<_>>())),
            "request" => {
                let id = conn_of(call)?;
                self.conn(id)?;
                let req = CoreRequest {
                    method: read_method(str_of(call, "method")?)?,
                    params: call["params"].clone(),
                    op: None,
                    ctx: CallContext::connection(ConnectionId(id), mixdog_protocol::Origin::Local, CancellationToken::new()),
                };
                match self.directory.request(req).await.map_err(|error| format!("{error:?}"))? {
                    Reply::Value(value) => Ok(value),
                    _ => Err("the read answers a value".to_owned()),
                }
            }
            // `thread/unsubscribe` on `conn`.
            "unsubscribe" => {
                let id = ThreadId::from(str_of(call, "threadId")?);
                let directory = self.directory.clone();
                let conn = self.conn(conn_of(call)?)?;
                let (gone, kept): (Vec<_>, Vec<_>) = conn.subs.drain(..).partition(|(thread, _)| *thread == id);
                conn.subs = kept;
                for (thread, sub) in gone {
                    if let Some(handle) = directory.handle(&thread) {
                        handle.detach(sub);
                    }
                }
                Ok(json!({}))
            }
            // The client process ended: the connection closes and every subscription it held goes with it.
            "close" => {
                let id = conn_of(call)?;
                let conn = self.conns.remove(&id).ok_or("no such connection")?;
                self.closed.push(id);
                for (thread, sub) in conn.subs {
                    if let Some(handle) = self.directory.handle(&thread) {
                        handle.detach(sub);
                    }
                }
                Ok(json!({}))
            }
            other => Err(format!("unknown call {other}")),
        }
    }
}

/// Runs `script` (under benchmarks/rust-core/recorders) against a fresh directory and returns what it found different.
async fn run(script: &str) -> Vec<Value> {
    let rig = Rig::new();
    // The product's transcript (compose_flip.rs), not the rig's text stub: the rows the client folds are the ones a user's would be.
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::transcript::RecordTranscript::new());
    let deps = Arc::new(deps);
    let mut bridge = Bridge { directory: Arc::new(SessionDirectory::new(deps)), conns: HashMap::new(), closed: Vec::new(), next_sub: 0 };
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let mut child = tokio::process::Command::new("node")
        .current_dir(&root)
        .args(["--import", "./apps/desktop/scripts/test-env.mjs", "--import", "./apps/desktop/scripts/test-tsx.mjs"])
        .arg(Path::new("benchmarks/rust-core/recorders").join(script))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node runs");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut lines = tokio::io::BufReader::new(child.stdout.take().expect("stdout")).lines();
    while let Some(line) = lines.next_line().await.expect("the script's output") {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("{line}");
            continue;
        };
        if let Some(done) = message.get("done") {
            return done["failures"].as_array().cloned().expect("the script lists its failures");
        }
        let answer = match bridge.serve(&message).await {
            Ok(result) => json!({ "id": message["id"], "result": result }),
            Err(error) => json!({ "id": message["id"], "error": error }),
        };
        stdin.write_all(format!("{answer}\n").as_bytes()).await.expect("the script reads");
    }
    panic!("{script} ended without its result: {:?}", child.wait().await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_phone_transcript_window_over_the_threads_feed_shows_what_node_showed() {
    let failures = run("replay-remote-transcript-window.mjs").await;
    assert!(failures.is_empty(), "{}", serde_json::to_string_pretty(&failures).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_desktop_service_route_shows_each_desktop_the_conversations_node_showed() {
    let failures = run("replay-desktop-visibility-restart.mjs").await;
    assert!(failures.is_empty(), "{}", serde_json::to_string_pretty(&failures).unwrap());
}
