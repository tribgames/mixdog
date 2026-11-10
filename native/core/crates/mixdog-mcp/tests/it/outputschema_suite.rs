//! A tool's `outputSchema` is enforced on its results as Node's MCP SDK client does
//! (`fixtures/mcp-output-schema`, recorded by `record-mcp-output-schema.mjs`): each recorded case
//! is served by the mock server, connected, and every call is made through the model's tool, whose
//! answer (the output's text, or the error the model reads) is compared with Node's.

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
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");
const GOLDEN: &str = include_str!("../../../../fixtures/mcp-output-schema/golden.json");

fn ctx() -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t1"),
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

/// What the model reads of one recorded case: the connect failure and each call's answer.
async fn replay(case: &Value, artifacts: &std::path::Path) -> Value {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let scenario = json!({"tools": case["tools"], "results": case["results"]});
    let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO": scenario.to_string()}});
    let config = McpServerConfig::from_entry("srv", &entry, &std::env::vars().collect()).unwrap();
    let server = McpServer::new(config, io, Spiller::new(artifacts.to_path_buf(), io.durability), OutputPolicy::default(), None);
    let connect = match server.connect().await {
        Ok(()) => Value::Null,
        Err(_) => match &*server.state() {
            ServerState::Failed { cause } => json!(cause),
            other => panic!("{}: a failed connect leaves {}", case["name"], other.describe()),
        },
    };
    let catalog = server.catalog();
    let mut outputs = Vec::new();
    for call in case["outputs"].as_array().unwrap() {
        let name = call["tool"].as_str().unwrap();
        let listed = catalog.as_ref().and_then(|c| c.entries.iter().find(|e| e.tool == name).cloned()).expect("the tool is listed");
        let tool = McpTool::new(Arc::clone(&server), listed);
        let output = match tool.call(&ctx(), json!({"i": call["i"]})).await {
            Ok(out) => out.parts.iter().map(|p| if let ToolPart::Text(t) = p { t.as_str() } else { "" }).collect::<String>(),
            Err(error) => error.message_for_model,
        };
        outputs.push(json!({"tool": name, "i": call["i"], "output": output}));
    }
    server.close().await;
    json!({"name": case["name"], "tools": case["tools"], "results": case["results"], "connect": connect, "outputs": outputs})
}

#[tokio::test(flavor = "multi_thread")]
async fn a_result_is_checked_against_its_tools_output_schema_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for case in golden["cases"].as_array().unwrap() {
        assert_eq!(&replay(case, dir.path()).await, case, "{}", case["name"]);
    }
}
