//! `fixtures/mail-link-navigation`, the dispatch case: of the calls Node's `dispatchToolCall` made, only the built-in Gmail
//! connector's `read_email` leaves links for the session that read it; another server's `read_email` (even one marked as the
//! Gmail connector) and the connector's other tools leave none. Every recorded call is made through `McpTool::call` of a
//! server whose identity is the recorded config and whose answers come from the mock server (`mock/server.rs`, scenario
//! mode), and its whole result is compared with the recording.
#![allow(clippy::disallowed_methods, reason = "test fixtures run a real stdio process")]

use std::collections::BTreeMap;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::server::ServerState;
use mixdog_mcp::tools::McpTool;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_tools::desktop::mail_links;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");
const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/mail-link-navigation/golden.json");

fn io() -> McpIo {
    let tokens = mixdog_rt::testing::tokens();
    McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk }
}

fn ctx(session: &str) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from(session),
        turn_id: TurnId::from("r"),
        tool: "mcp".into(),
        cwd: AbsPath::new(std::env::temp_dir()).expect("absolute"),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_built_in_gmail_connectors_read_email_records_links_for_its_session() {
    let golden: Value = serde_json::from_str(&GOLDEN).expect("golden.json");
    let case = golden["cases"].as_array().unwrap().iter().find(|case| case["case"].as_str().unwrap().starts_with("only the built-in Gmail connector")).expect("the recorded case");
    let ops = case["observed"]["ops"].as_array().unwrap();
    let env = std::env::vars().collect();
    let dir = tempfile::tempdir().unwrap();

    // What each recorded server answered, by tool: the scenario its stand-in mock serves.
    let mut answers: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    for op in ops.iter().filter(|op| op["op"] == "dispatch") {
        let qualified = op["name"].as_str().unwrap();
        let [_, server, tool] = qualified.splitn(3, "__").collect::<Vec<_>>()[..] else { panic!("{qualified}") };
        let reply = json!({"content": [{"type": "text", "text": op["result"].as_str().unwrap()}]});
        assert!(answers.entry(server.to_owned()).or_default().insert(tool.to_owned(), json!([reply])).is_none(), "{qualified} is recorded once");
    }
    let mut servers = BTreeMap::new();
    for (name, entry) in case["observed"]["servers"].as_object().unwrap() {
        let identity = McpServerConfig::from_entry(name, entry, &env).expect("a recorded server config");
        let tools: Vec<Value> = answers[name].keys().map(|tool| json!({"name": tool, "inputSchema": {"type": "object"}})).collect();
        let scenario = json!({"tools": tools, "results": answers[name]});
        let stand_in = McpServerConfig::from_entry(name, &json!({"command": MOCK, "env": {"MOCK_SCENARIO": scenario.to_string()}}), &env).unwrap();
        let server = McpServer::standing_in(identity, stand_in.transport, io(), Spiller::new(dir.path().to_path_buf(), io().durability), OutputPolicy::default());
        server.connect().await.expect("the mock server connects");
        assert!(matches!(&*server.state(), ServerState::Ready(_)));
        servers.insert(name.clone(), server);
    }

    // Each session's call lies between these two clocks, and so does the `read_at` of the link it left.
    let mut called: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut probes = 0;
    for op in ops {
        let session = op["session"].as_str().unwrap();
        match op["op"].as_str().unwrap() {
            "dispatch" => {
                let qualified = op["name"].as_str().unwrap();
                let [_, server, _] = qualified.splitn(3, "__").collect::<Vec<_>>()[..] else { panic!("{qualified}") };
                let server = &servers[server];
                let entry = server.catalog().unwrap().entries.iter().find(|entry| entry.qualified == qualified).cloned().expect("a listed tool");
                let tool = McpTool::new(Arc::clone(server), entry);
                let before = mail_links::now_ms();
                let output = tool.call(&ctx(session), json!({"id": "9001", "i": 0})).await.expect("the call");
                called.insert(session.to_owned(), (before, mail_links::now_ms()));
                let parts: Vec<&str> = output.parts.iter().map(|part| if let ToolPart::Text(text) = part { text.as_str() } else { panic!("{qualified}: {part:?}") }).collect();
                assert_eq!(parts, [op["result"].as_str().unwrap()], "{qualified}: the result");
            }
            "probe" => {
                probes += 1;
                let got = mail_links::link_for(session, op["url"].as_str().unwrap(), mail_links::now_ms());
                match (&got, op["link"].is_null()) {
                    (None, true) => {}
                    (Some(link), false) => {
                        assert_eq!((link.url.as_str(), link.from_domain.as_str()), (op["link"]["url"].as_str().unwrap(), op["link"]["from_domain"].as_str().unwrap()), "{}: {}", session, op["why"]);
                        let (from, to) = called[session];
                        assert!((from..=to).contains(&link.read_at), "{}: read_at {} outside {from}..{to}", session, link.read_at);
                    }
                    _ => panic!("{}: {}: want {}, got {got:?}", session, op["why"], op["link"]),
                }
            }
            other => panic!("unexpected recorded operation {other}"),
        }
    }
    assert_eq!(probes, 6);
}
