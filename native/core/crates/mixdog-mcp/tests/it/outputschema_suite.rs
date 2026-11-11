//! A tool's `outputSchema` is enforced on its results as Node's MCP SDK client does
//! (`fixtures/mcp-output-schema`, recorded by `record-mcp-output-schema.mjs`): each recorded case
//! is served by the mock server, connected, and every call is made through the model's tool, whose
//! whole answer (what it returned, or the error it threw with its code, message and data) is compared
//! with what Node's `executeMcpTool` returned or threw, and again as the SDK's `callTool`, whose whole
//! settlement (the result with its `isError`, content and structured content, or the error's code,
//! message and data) is compared with what Node's SDK settled with.

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

/// The SDK's `McpError` as the recording stores a thrown one (through `exact`): `MCP error <code>: <message>`, the code,
/// and the data (`undefined` when there is none).
fn mcp_error(code: i64, message: &str, data: Option<Value>) -> Value {
    json!({
        "$exact": "error",
        "name": "McpError",
        "message": format!("MCP error {code}: {message}"),
        "code": code,
        "props": {"data": data.unwrap_or_else(|| json!({"$exact": "undefined"})), "name": "McpError"},
    })
}

/// A call's whole answer in the form Node's recording stores `executeMcpTool`'s (through `exact`): `{"returned": …}`
/// with the text, or every part in order when there is media; `{"thrown": …}` with the error's name, message (the
/// model's text less its `Error: ` prefix), JSON-RPC code and data. A result the server marked `isError` Node returns as
/// its `Error: …` text, not as a throw; the core fails the call with a server error without a code, and so it reads.
fn node_view(
    answer: Result<
        mixdog_core_api::domain::tool::ToolOutput,
        mixdog_core_api::domain::tool::ToolError,
    >,
) -> Value {
    use base64::Engine;
    use mixdog_core_api::domain::tool::ToolErrorCode;
    let out = match answer {
        Ok(out) => out,
        Err(error) => {
            let message = error.message_for_model.strip_prefix("Error: ").unwrap_or(&error.message_for_model).to_owned();
            return match error.code {
                ToolErrorCode::McpError { rpc_code: None, .. } => json!({"returned": error.message_for_model}),
                ToolErrorCode::McpError { rpc_code: Some(code), data, .. } => {
                    let reason = message.strip_prefix(&format!("MCP error {code}: ")).unwrap_or(&message);
                    json!({"thrown": mcp_error(code, reason, data)})
                }
                _ => json!({"thrown": {"$exact": "error", "name": "Error", "message": message, "props": {}}}),
            };
        }
    };
    if out.parts.iter().all(|p| matches!(p, ToolPart::Text(_))) {
        let text: String = out.parts.iter().map(|p| if let ToolPart::Text(t) = p { t.as_str() } else { "" }).collect();
        return json!({"returned": text});
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
    json!({"returned": {"content": parts}})
}

/// How the SDK's `Client.callTool` settled, as the recording stores it: `{"returned": <the result, whole>}` once the
/// output schema passed, or `{"thrown": <the McpError>}`.
fn sdk_view(settled: Result<Value, mixdog_mcp::server::CallError>) -> Value {
    use mixdog_mcp::rpc::RpcError;
    use mixdog_mcp::server::CallError;
    match settled {
        Ok(result) => json!({"returned": result}),
        Err(CallError::Rpc(RpcError::Server { code, message, data })) => json!({"thrown": mcp_error(code, &message, data)}),
        Err(other) => json!({"thrown": {"$exact": "error", "name": "Error", "message": other.to_string(), "props": {}}}),
    }
}

/// What the model reads of one recorded case: the connect failure and each call's whole answer. A case naming a remote
/// address is served with that address moved to a listener of this test, which must get no request.
async fn replay(case: &Value, artifacts: &std::path::Path) -> Value {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo {
        spawn: tokens.spawn_io,
        durability: tokens.durability_io,
        cpu: tokens.cpu_bulk,
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
        let (answer, sdk) = match hub.tool(&format!("mcp__srv__{name}")) {
            Some(tool) => {
                let answer = node_view(tool.call(&ctx(), json!({"i": call["i"]})).await);
                // The SDK's own settlement of the same call, made again: the server answers each `i` alike.
                let settled = server.call_tool_settled("replay", name, json!({"i": call["i"]}), &CancellationToken::new(), None).await;
                (answer, json!([sdk_view(settled)]))
            }
            // A server whose connect failed publishes no tool; Node's call of one throws so, before the SDK.
            None if !connect.is_null() => (
                json!({"thrown": {"$exact": "error", "name": "Error", "message": "MCP server \"srv\" not connected", "props": {}}}),
                json!([]),
            ),
            None => panic!("{}: {name} is not published", case["name"]),
        };
        outputs.push(json!({"tool": name, "i": call["i"], "answer": answer, "sdk": sdk}));
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
            if got["answer"] != want["answer"] || got["sdk"] != want["sdk"] {
                differ.push(format!(
                    "{}: {}[{}]: want {} (sdk {}) got {} (sdk {})",
                    case["name"],
                    want["tool"],
                    want["i"],
                    want["answer"],
                    want["sdk"],
                    got["answer"],
                    got["sdk"]
                ));
            }
        }
    }
    // Chains run in fresh Node processes, each length many times: the core answers one of the outcomes Node gave there
    // (where a fresh process answers alike every time, that one).
    for fresh in golden["freshProcesses"].as_array().unwrap() {
        let outcomes = fresh["outcomes"].as_array().unwrap();
        let case = json!({"name": fresh["name"], "tools": fresh["tools"], "results": fresh["results"], "outputs": outcomes[0]["outputs"]});
        let replayed = replay(&case, dir.path()).await;
        let got = json!({"connect": replayed["connect"], "outputs": replayed["outputs"]});
        if !outcomes.contains(&got) {
            differ.push(format!("{}: got {got}, Node gave one of {}", fresh["name"], Value::Array(outcomes.clone())));
        }
    }
    assert!(differ.is_empty(), "{differ:#?}");
}

/// The core's time on the recorded patterns that backtrack exponentially (`HOSTILE`: 24 characters, then one that fails
/// them). A measurement, run on request: `-- --ignored hostile_patterns_take --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn hostile_patterns_take() {
    use mixdog_mcp::output_schema::OutputValidators;
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let name = "pattern matches as a JavaScript regular expression with the u flag";
    let case = golden["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap();
    let validators = OutputValidators::of(case["tools"].as_array().unwrap()).unwrap();
    for tool in case["tools"].as_array().unwrap() {
        let tool_name = tool["name"].as_str().unwrap();
        for result in case["results"][tool_name].as_array().unwrap() {
            if result["structuredContent"]["v"] != json!(format!("{}b", "a".repeat(24))) {
                continue;
            }
            let started = std::time::Instant::now();
            let verdict = validators.check(tool_name, result, &[]);
            println!(
                "{} {}: {:?} in {:.3} s",
                tool_name,
                tool["outputSchema"]["properties"]["v"]["pattern"],
                verdict.err(),
                started.elapsed().as_secs_f64()
            );
        }
    }
}

/// The core's stack bounds, at their edges: a chain of as many references as each allows compiles, or validates, on a
/// test thread's stack (no overflow of the core's own), and one more answers as Node's overflow does.
#[test]
fn a_chain_of_references_compiles_and_validates_up_to_the_bounds_and_overflows_past_them() {
    use mixdog_mcp::output_schema::OutputValidators;
    use mixdog_mcp::rpc::RpcError;
    const VALIDATION_LIMIT: usize = 2111;
    const COMPILE_LIMIT: usize = 2460;
    let overflow = (-32602, "Failed to validate structured content: Maximum call stack size exceeded");
    let chain = |n: usize| {
        let definitions: serde_json::Map<String, Value> = (0..=n)
            .map(|i| {
                let schema = if i < n { json!({"$ref": format!("#/definitions/d{}", i + 1)}) } else { json!({"type": "number"}) };
                (format!("d{i}"), schema)
            })
            .collect();
        json!([{"name": "chain", "outputSchema": {"type": "object", "properties": {"v": {"$ref": "#/definitions/d0"}}, "definitions": definitions}}])
    };
    let check = |n: usize, structured: Value| {
        let tools = chain(n);
        let validators = OutputValidators::of(tools.as_array().unwrap()).unwrap();
        validators.check("chain", &json!({"content": [], "structuredContent": structured}), &[])
    };
    let answer = |checked: Result<(), RpcError>| match checked {
        Err(RpcError::Server { code, message, .. }) => (code, message),
        other => panic!("not a server error: {other:?}"),
    };
    // `v` adds one reference to the chain's `n`.
    assert!(check(VALIDATION_LIMIT - 1, json!({"v": 1})).is_ok());
    assert_eq!(
        answer(check(VALIDATION_LIMIT - 1, json!({"v": "x"}))),
        (-32602, "Structured content does not match the tool's output schema: data/v must be number".to_owned())
    );
    assert_eq!(answer(check(VALIDATION_LIMIT, json!({"v": 1}))), (overflow.0, overflow.1.to_owned()));
    // A value that does not reach the chain only compiles it.
    assert!(check(COMPILE_LIMIT - 1, json!({})).is_ok());
    assert_eq!(answer(check(COMPILE_LIMIT, json!({}))), (overflow.0, overflow.1.to_owned()));
}
