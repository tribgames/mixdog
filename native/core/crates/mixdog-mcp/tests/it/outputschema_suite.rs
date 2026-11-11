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
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::server::ServerState;
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
        io: ToolIo {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// A call's whole answer as Node's `executeMcpTool` returns it: the text, or (when there is media) every part in order;
/// a failure is its `Error: …` text. A part Node never returns (structured content) shows as itself.
fn node_view(
    answer: Result<
        mixdog_core_api::domain::tool::ToolOutput,
        mixdog_core_api::domain::tool::ToolError,
    >,
) -> Value {
    use base64::Engine;
    let out = match answer {
        Ok(out) => out,
        Err(error) => return Value::String(error.message_for_model),
    };
    if out.parts.iter().all(|p| matches!(p, ToolPart::Text(_))) {
        return Value::String(
            out.parts
                .iter()
                .map(|p| {
                    if let ToolPart::Text(t) = p {
                        t.as_str()
                    } else {
                        ""
                    }
                })
                .collect(),
        );
    }
    let parts: Vec<Value> = out
        .parts
        .iter()
        .map(|part| match part {
            ToolPart::Text(text) => json!({"type": "text", "text": text}),
            ToolPart::Image { mime, data: mixdog_core_api::domain::tool::ImageData::Bytes(bytes) } => {
                json!({"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(bytes), "mimeType": mime})
            }
            other => json!({"unexpected": format!("{other:?}")}),
        })
        .collect();
    json!({"content": parts})
}

/// What the model reads of one recorded case: the connect failure and each call's whole answer. A case naming a remote
/// address is served with that address moved to a listener of this test, which must get no request.
async fn replay(case: &Value, artifacts: &std::path::Path) -> Value {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo {
        spawn: tokens.spawn_io,
        durability: tokens.durability_io,
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let here = format!("http://{}", listener.local_addr().unwrap());
    let recorded = case["remote"].as_str();
    let moved = |value: &Value, from: &str, to: &str| -> Value {
        match recorded {
            Some(_) => serde_json::from_str(&value.to_string().replace(from, to)).unwrap(),
            None => value.clone(),
        }
    };
    let tools = moved(&case["tools"], recorded.unwrap_or_default(), &here);
    let scenario = json!({"tools": tools, "results": case["results"]});
    let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO": scenario.to_string()}});
    let config = McpServerConfig::from_entry("srv", &entry, &std::env::vars().collect()).unwrap();
    // The hub a session's tools come from: the configured server is connected by the apply, and every call is made
    // through the tool the hub publishes for its qualified name.
    let hub = McpHub::new(io, artifacts.to_path_buf(), OutputPolicy::default());
    hub.apply(vec![config]);
    let server = hub.server("srv").expect("the configured server");
    let state = server
        .subscribe()
        .wait_for(|s| !matches!(**s, ServerState::Starting))
        .await
        .unwrap()
        .clone();
    let connect = match &*state {
        ServerState::Ready(_) => Value::Null,
        ServerState::Failed { cause } => json!(cause),
        other => panic!("{}: the connect left {}", case["name"], other.describe()),
    };
    let mut outputs = Vec::new();
    for call in case["outputs"].as_array().unwrap() {
        let name = call["tool"].as_str().unwrap();
        let output = match hub.tool(&format!("mcp__srv__{name}")) {
            Some(tool) => node_view(tool.call(&ctx(), json!({"i": call["i"]})).await),
            // A server whose connect failed publishes no tool; Node's call of one answers so.
            None if !connect.is_null() => {
                Value::String("Error: MCP server \"srv\" not connected".to_owned())
            }
            None => panic!("{}: {name} is not published", case["name"]),
        };
        outputs.push(json!({"tool": name, "i": call["i"], "output": output}));
    }
    hub.close_all().await;
    let mut replayed = json!({"name": case["name"], "tools": case["tools"], "results": case["results"], "connect": connect, "outputs": outputs});
    if let Some(remote) = recorded {
        let mut hits = 0;
        while listener.accept().is_ok() {
            hits += 1;
        }
        replayed = moved(&replayed, &here, remote);
        replayed["remote"] = json!(remote);
        replayed["remoteHits"] = json!(hits);
    }
    replayed
}

/// Where the core answers otherwise on purpose: `(case, tool, call, the core's answer)`. A reference cycle that never
/// moves into the result (`a` → `b` → `a`, or `allOf: [{"$ref": "#"}]` at the root): Node's Ajv recurses until V8's
/// stack overflows and the call fails with `Maximum call stack size exceeded`; jsonschema follows each reference once
/// per place in the result, so the check ends and the result is valid.
const DEPARTURES: &[(&str, &str, u64, &str)] = &[
    ("recursive references and deep results", "loop", 0, "loop"),
    (
        "recursive references and deep results",
        "endless",
        0,
        "endless",
    ),
];

#[tokio::test(flavor = "multi_thread")]
async fn a_result_is_checked_against_its_tools_output_schema_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut differ = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let mut case = case.clone();
        for output in case["outputs"]
            .clone()
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let (at, output) = output;
            if let Some((.., answer)) = DEPARTURES.iter().find(|(name, tool, i, _)| {
                case["name"] == *name && output["tool"] == *tool && output["i"] == *i
            }) {
                case["outputs"][at]["output"] = json!(answer);
            }
        }
        let case = &case;
        let replayed = replay(case, dir.path()).await;
        if &replayed != case {
            let (want, got) = (&case["outputs"], &replayed["outputs"]);
            let calls: Vec<String> = (0..want.as_array().map_or(0, Vec::len))
                .filter(|&i| want[i] != got[i])
                .map(|i| {
                    format!(
                        "{}[{}]: want {} got {}",
                        want[i]["tool"], want[i]["i"], want[i]["output"], got[i]["output"]
                    )
                })
                .collect();
            differ.push(format!(
                "{}: connect want {} got {}; {calls:#?}",
                case["name"], case["connect"], replayed["connect"]
            ));
        }
    }
    assert!(differ.is_empty(), "{differ:#?}");
}
