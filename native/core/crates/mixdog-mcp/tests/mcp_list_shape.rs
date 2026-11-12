//! A `tools/list` result without a `tools` array, as Node's client treats it (`fixtures/mcp-list-shape`, recorded by
//! `record-mcp-list-shape.mjs`): every recorded case is served by the mock server and connected through the hub, and what
//! the session has is compared with what Node's `getMcpServerStatus` and `getMcpTools` returned, with the connect failure
//! the server row shows, and with the lines written to the log (here the hub's and the server's events: the message of
//! each is the recorded line less the one line feed that ends it), after the connect and after the refresh a
//! `list_changed` starts.
//! Its own test binary: the log is taken by one process-wide subscriber.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::server::ServerState;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

/// The events of the process at INFO and above: their messages, in order.
#[derive(Default)]
struct Log {
    lines: Mutex<Vec<String>>,
    arrived: Notify,
}

struct Message(String);

impl tracing::field::Visit for Message {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

struct Sink(Arc<Log>);

impl tracing::Subscriber for Sink {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        *metadata.level() <= tracing::Level::INFO
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut message = Message(String::new());
        event.record(&mut message);
        self.0.lines.lock().unwrap().push(message.0);
        self.0.arrived.notify_waiters();
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

impl Log {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.lines.lock().unwrap())
    }

    /// Returns once `count` lines are there: the server's events come from its own tasks.
    async fn wait_for(&self, count: usize, what: &str) {
        let arrival = async {
            loop {
                let arrived = self.arrived.notified();
                if self.lines.lock().unwrap().len() >= count {
                    return;
                }
                arrived.await;
            }
        };
        mixdog_rt::time::timeout(Duration::from_secs(60), arrival)
            .await
            .unwrap_or_else(|_| panic!("{what}: {count} log lines within 60 s, got {:?}", self.lines.lock().unwrap()));
    }
}

/// The server rows and tools of a session, in the form Node's recording stores them (`getMcpServerStatus` less the
/// constant fields, `getMcpTools`): none while the server is not ready.
fn snapshot(server: &McpServer) -> Value {
    let Some(catalog) = server.catalog() else { return json!({"status": [], "tools": []}) };
    let tools: Vec<Value> = catalog
        .entries
        .iter()
        .map(|e| json!({"name": e.qualified, "description": e.description, "inputSchema": e.input_schema}))
        .collect();
    let listed: Vec<Value> = catalog.entries.iter().map(|e| json!({"name": e.qualified, "description": e.description})).collect();
    json!({"status": [{"name": "srv", "connected": true, "toolCount": listed.len(), "tools": listed}], "tools": tools})
}

/// The recorded lines, each less the one line feed that ends it (manifest `mappings`): a line is one log event here, and
/// the log's writer ends it. Everything before that line feed is compared as recorded.
fn recorded_lines(lines: &Value) -> Vec<String> {
    lines
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let line = l.as_str().unwrap();
            let text = line.strip_suffix('\n').unwrap_or_else(|| panic!("a recorded log line ends in a line feed: {line:?}"));
            assert!(!text.ends_with('\n'), "a recorded log line ends in one line feed, not more: {line:?}");
            text.to_owned()
        })
        .collect()
}

#[test]
fn a_tools_list_without_a_tools_array_is_treated_as_node_does() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/mcp-list-shape/golden.json")).unwrap();
    let log = Arc::new(Log::default());
    tracing::subscriber::set_global_default(Sink(Arc::clone(&log))).expect("the first subscriber of this process");
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the production lanes");
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut differ = Vec::new();
    runtime.block_on(async {
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
            let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO": json!({"phases": case["phases"]}).to_string()}});
            let config = McpServerConfig::from_entry("srv", &entry, &std::env::vars().collect()).unwrap();
            let hub = McpHub::new(io, dir.path().to_path_buf(), OutputPolicy::default());
            log.take();
            hub.apply(vec![config]);
            // The connect is over when the hub has written its line: one, whichever way it ended.
            log.wait_for(1, &format!("{name}: the connect")).await;
            let server = hub.server("srv").expect("the configured server");
            let connect = match &*server.state() {
                ServerState::Ready(_) => Value::Null,
                ServerState::Failed { cause } => json!(cause),
                other => panic!("{name}: the connect left {}", other.describe()),
            };
            let got = json!({"connect": connect, "status": snapshot(&server)["status"], "tools": snapshot(&server)["tools"], "log": log.take()});
            let want = json!({"connect": case["connect"], "status": case["status"], "tools": case["tools"], "log": recorded_lines(&case["log"])});
            if got != want {
                differ.push(format!("{name}: after the connect want {want} got {got}"));
            }
            if let Some(refresh) = case.get("refresh") {
                let before = server.catalog().map(|c| c.digest.clone());
                let mut changed = server.subscribe();
                server.call_tool("replay", "poke", json!({}), &CancellationToken::new(), None).await.expect("the poke");
                // The refresh is over when its failure is logged, or, with nothing to log, when the listing changed.
                let expected = recorded_lines(&refresh["log"]);
                if expected.is_empty() {
                    mixdog_rt::time::timeout(
                        Duration::from_secs(60),
                        changed.wait_for(|s| matches!(s.as_ref(), ServerState::Ready(r) if Some(&r.catalog.digest) != before.as_ref())),
                    )
                    .await
                    .unwrap_or_else(|_| panic!("{name}: the refresh changes the listing within 60 s"))
                    .unwrap();
                } else {
                    log.wait_for(expected.len(), &format!("{name}: the refresh")).await;
                }
                let got = json!({"status": snapshot(&server)["status"], "tools": snapshot(&server)["tools"], "log": log.take()});
                let want = json!({"status": refresh["status"], "tools": refresh["tools"], "log": expected});
                if got != want {
                    differ.push(format!("{name}: after the refresh want {want} got {got}"));
                }
            }
            hub.close_all().await;
        }
    });
    assert!(differ.is_empty(), "{differ:#?}");
}
