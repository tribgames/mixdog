//! A tool's `outputSchema` is enforced on its results as Node's MCP SDK client does
//! (`fixtures/mcp-output-schema`, recorded by `record-mcp-output-schema.mjs`): each recorded case
//! is served by the mock server, connected, and every call is made through the model's tool, whose
//! whole answer (what it returned, or the error it threw with its code, message and data) is compared
//! with what Node's `executeMcpTool` returned or threw, and the data the core keeps with an error with
//! what Node's SDK had.

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

/// A call's whole answer in the form Node's recording stores `executeMcpTool`'s (through `exact`): `{"returned": …}`
/// with the text, or every part in order when there is media; `{"thrown": …}` with the error's name, message (the
/// model's text less its `Error: ` prefix), JSON-RPC code and data. A result the server marked `isError` Node returns as
/// its `Error: …` text, not as a throw; the core fails the call with a server error without a code, and so it reads.
/// Also the data the core keeps with a server's error, which the comparison holds against what Node's SDK had.
fn node_view(
    answer: Result<
        mixdog_core_api::domain::tool::ToolOutput,
        mixdog_core_api::domain::tool::ToolError,
    >,
) -> (Value, Value) {
    use base64::Engine;
    use mixdog_core_api::domain::tool::ToolErrorCode;
    let out = match answer {
        Ok(out) => out,
        Err(error) => {
            let message = error.message_for_model.strip_prefix("Error: ").unwrap_or(&error.message_for_model).to_owned();
            return match error.code {
                ToolErrorCode::McpError { rpc_code: None, data, .. } => {
                    (json!({"returned": error.message_for_model}), data.unwrap_or(Value::Null))
                }
                ToolErrorCode::McpError { rpc_code: Some(code), data, .. } => {
                    let undefined = json!({"$exact": "undefined"});
                    let thrown = json!({
                        "$exact": "error",
                        "name": "McpError",
                        "message": message,
                        "code": code,
                        "props": {"data": data.clone().unwrap_or(undefined), "name": "McpError"},
                    });
                    (json!({"thrown": thrown}), data.unwrap_or(Value::Null))
                }
                _ => (json!({"thrown": {"$exact": "error", "name": "Error", "message": message, "props": {}}}), Value::Null),
            };
        }
    };
    if out.parts.iter().all(|p| matches!(p, ToolPart::Text(_))) {
        let text: String = out.parts.iter().map(|p| if let ToolPart::Text(t) = p { t.as_str() } else { "" }).collect();
        return (json!({"returned": text}), Value::Null);
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
    (json!({"returned": {"content": parts}}), Value::Null)
}

/// The data the core must keep with a call's error, from Node's recording: a thrown McpError's own `data`, or the
/// `structuredContent` of the last result the SDK returned marked `isError`; `null` when there is none.
fn recorded_data(output: &Value) -> Value {
    let thrown = &output["answer"]["thrown"];
    if thrown["name"] == "McpError" {
        let data = &thrown["props"]["data"];
        return if data == &json!({"$exact": "undefined"}) { Value::Null } else { data.clone() };
    }
    let last = output["sdk"].as_array().and_then(|calls| calls.last()).map(|call| &call["returned"]);
    match last {
        Some(result) if result["isError"] == true => result.get("structuredContent").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
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
        let (answer, data) = match hub.tool(&format!("mcp__srv__{name}")) {
            Some(tool) => node_view(tool.call(&ctx(), json!({"i": call["i"]})).await),
            // A server whose connect failed publishes no tool; Node's call of one throws so.
            None if !connect.is_null() => (
                json!({"thrown": {"$exact": "error", "name": "Error", "message": "MCP server \"srv\" not connected", "props": {}}}),
                Value::Null,
            ),
            None => panic!("{}: {name} is not published", case["name"]),
        };
        outputs.push(json!({"tool": name, "i": call["i"], "answer": answer, "data": data}));
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

/// Where the core answers otherwise on purpose: `(case, tool, call)`. A repetition holding a lookaround that backtracks
/// exponentially on a failing string: V8 has no bound and answers `must match pattern` after about a second here (2^24
/// steps; each more character doubles it), where the engine's backtracking stops at its bound and the call fails as a
/// validator that threw (`output_schema.rs` `BACKTRACK_LIMIT`). Compared with that answer instead. Nested quantifiers
/// without a lookaround inside the repetition the engine matches without backtracking, as V8 answers.
const DEPARTURES: &[(&str, &str, u64)] = &[
    ("pattern matches as a JavaScript regular expression with the u flag", "p23", 0),
    ("pattern matches as a JavaScript regular expression with the u flag", "p24", 0),
];

#[tokio::test(flavor = "multi_thread")]
async fn a_result_is_checked_against_its_tools_output_schema_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut differ = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let replayed = replay(case, dir.path()).await;
        if replayed["connect"] != case["connect"] || replayed.get("remoteHits") != case.get("remoteHits") {
            differ.push(format!(
                "{}: connect want {} got {}; remote hits want {:?} got {:?}",
                case["name"],
                case["connect"],
                replayed["connect"],
                case.get("remoteHits"),
                replayed.get("remoteHits")
            ));
        }
        let (want, got) = (case["outputs"].as_array().unwrap(), replayed["outputs"].as_array().unwrap());
        assert_eq!(want.len(), got.len(), "{}: every recorded call is made", case["name"]);
        for (want, got) in want.iter().zip(got) {
            let departs = DEPARTURES.iter().any(|(name, tool, i)| case["name"] == *name && want["tool"] == *tool && want["i"] == *i);
            let answer = if departs {
                let message = "MCP error -32602: Failed to validate structured content: data/v: its pattern needs more than 1000000 backtracking steps";
                json!({"thrown": {"$exact": "error", "name": "McpError", "message": message, "code": -32602,
                    "props": {"data": {"$exact": "undefined"}, "name": "McpError"}}})
            } else {
                want["answer"].clone()
            };
            if got["answer"] != answer || got["data"] != recorded_data(want) {
                differ.push(format!(
                    "{}: {}[{}]: want {} (data {}) got {} (data {})",
                    case["name"],
                    want["tool"],
                    want["i"],
                    answer,
                    recorded_data(want),
                    got["answer"],
                    got["data"]
                ));
            }
        }
    }
    assert!(differ.is_empty(), "{differ:#?}");
}

/// The core's stack bound, at its edge: a chain of as many references as it allows compiles and validates on a test
/// thread's stack (no overflow of the core's own), and one more answers as Node's overflow does.
#[test]
fn a_chain_of_references_compiles_up_to_the_bound_and_overflows_past_it() {
    use mixdog_mcp::output_schema::OutputValidators;
    use mixdog_mcp::rpc::RpcError;
    const STACK_LIMIT: usize = 5000;
    let chain = |n: usize| {
        let definitions: serde_json::Map<String, Value> = (0..=n)
            .map(|i| {
                let schema = if i < n { json!({"$ref": format!("#/definitions/d{}", i + 1)}) } else { json!({"type": "number"}) };
                (format!("d{i}"), schema)
            })
            .collect();
        json!([{"name": "chain", "outputSchema": {"type": "object", "properties": {"v": {"$ref": "#/definitions/d0"}}, "definitions": definitions}}])
    };
    let check = |n: usize, v: Value| {
        let tools = chain(n);
        let validators = OutputValidators::of(tools.as_array().unwrap()).unwrap();
        validators.check("chain", &json!({"content": [], "structuredContent": {"v": v}}))
    };
    // `v` adds one reference to the chain's `STACK_LIMIT - 1`.
    assert!(check(STACK_LIMIT - 1, json!(1)).is_ok());
    let Err(RpcError::Server { code, message, .. }) = check(STACK_LIMIT - 1, json!("x")) else { panic!("a string is not a number") };
    assert_eq!((code, message.as_str()), (-32602, "Structured content does not match the tool's output schema: data/v must be number"));
    let Err(RpcError::Server { code, message, .. }) = check(STACK_LIMIT, json!(1)) else { panic!("past the bound") };
    assert_eq!((code, message.as_str()), (-32602, "Failed to validate structured content: Maximum call stack size exceeded"));
}
