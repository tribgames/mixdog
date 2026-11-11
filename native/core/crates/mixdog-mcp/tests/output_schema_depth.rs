//! Ajv's stack bounds through the product's call: a result whose output schema's references run past them answers
//! Node's overflow, on the thread the product validates on, without a crash.
//! Its own test binary: it boots the production executors, which a process installs once.

use std::time::Duration;

use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::rpc::RpcError;
use mixdog_mcp::server::CallError;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

/// The overflow a fresh Node process answers for a chain past Ajv's stack, as recorded (`freshProcesses`, a chain of
/// 2111): its code and message.
fn recorded_overflow() -> (i64, String) {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/mcp-output-schema/golden.json")).unwrap();
    let fresh = golden["freshProcesses"].as_array().unwrap().iter().find(|f| f["n"] == 2111).expect("the chain of 2111");
    let thrown = fresh["outcomes"][0]["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|output| output["sdk"][0].get("thrown"))
        .expect("an overflow");
    let code = thrown["code"].as_i64().unwrap();
    let message = thrown["message"].as_str().unwrap().strip_prefix(&format!("MCP error {code}: ")).unwrap().to_owned();
    assert!(message.ends_with("Maximum call stack size exceeded"), "{message}");
    (code, message)
}

/// A chain of `n` + 1 definitions, each a reference to the next and the last a number, entered from `v` (`n` + 1
/// references in all).
fn chain(n: usize) -> Value {
    let definitions: serde_json::Map<String, Value> = (0..=n)
        .map(|i| {
            let schema = if i < n { json!({"$ref": format!("#/definitions/d{}", i + 1)}) } else { json!({"type": "number"}) };
            (format!("d{i}"), schema)
        })
        .collect();
    json!({"type": "object", "properties": {"v": {"$ref": "#/definitions/d0"}}, "definitions": definitions})
}

/// A loop of 1,000 references whose last one descends into `a` and back to the first: compiled, it is a chain of
/// 1,000; validated against `depth` nested objects, a path of `depth` × 1,000 references.
fn deep_loop() -> Value {
    let definitions: serde_json::Map<String, Value> = (0..1000)
        .map(|i| {
            let schema = if i < 999 {
                json!({"$ref": format!("#/definitions/n{}", i + 1)})
            } else {
                json!({"type": "object", "properties": {"a": {"$ref": "#/definitions/n0"}}})
            };
            (format!("n{i}"), schema)
        })
        .collect();
    json!({"type": "object", "properties": {"v": {"$ref": "#/definitions/n0"}}, "definitions": definitions})
}

/// Ajv's stack bounds, through the product's call (`McpServer::call_tool_settled`, its check a cpu-bulk lane job of the
/// production lanes, the validation walk on its own thread): exactly at each bound the result passes, one past it and
/// 100,000 references past it the call answers Node's overflow, and the process neither crashes nor overflows its own
/// stack. Compile chains: 2,460 references (the bound), 2,461 and 100,000, a value that does not reach them. Validation
/// paths: 2,111 references (the bound), 2,112, and 100,000 (a loop of 1,000 over 100 nested objects, compiled as a
/// chain of 1,000).
#[test]
fn ajvs_stack_bounds_answer_as_node_through_the_products_call() {
    let overflow = recorded_overflow();
    let nested = (0..100).fold(json!({}), |inner, _| json!({"a": inner}));
    let cases: Vec<(&str, Value, Value, bool)> = vec![
        ("compile_at", chain(2459), json!({}), true),
        ("compile_above", chain(2460), json!({}), false),
        ("compile_far", chain(99_999), json!({}), false),
        ("validation_at", chain(2110), json!({"v": 1}), true),
        ("validation_above", chain(2111), json!({"v": 1}), false),
        ("validation_far", deep_loop(), json!({"v": nested}), false),
    ];
    let tools: Vec<Value> = cases
        .iter()
        .map(|(name, schema, _, _)| json!({"name": name, "inputSchema": {"type": "object"}, "outputSchema": schema}))
        .collect();
    let results: serde_json::Map<String, Value> = cases
        .iter()
        .map(|(name, _, structured, _)| (name.to_string(), json!([{"content": [], "structuredContent": structured}])))
        .collect();
    let dir = tempfile::tempdir().unwrap();
    let scenario = dir.path().join("scenario.json");
    std::fs::write(&scenario, json!({"tools": tools, "results": results}).to_string()).unwrap();

    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the production lanes");
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    runtime.block_on(async {
        let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
        let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO_FILE": scenario.to_string_lossy()}});
        let config = McpServerConfig::from_entry("srv", &entry, &std::env::vars().collect()).unwrap();
        let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
        tokio::time::timeout(Duration::from_secs(60), server.connect()).await.expect("the mock server connects in 60 s").unwrap();
        let mut wrong = Vec::new();
        for (name, _, structured, passes) in &cases {
            let settled = tokio::time::timeout(
                Duration::from_secs(120),
                server.call_tool_settled("t", name, json!({"i": 0}), &CancellationToken::new(), None),
            )
            .await
            .unwrap_or_else(|_| panic!("{name}: no answer in 120 s"));
            let ok = match (&settled, passes) {
                (Ok(result), true) => result["structuredContent"] == *structured,
                (Err(CallError::Rpc(RpcError::Server { code, message, .. })), false) => (*code, message.clone()) == overflow,
                _ => false,
            };
            if !ok {
                wrong.push(format!("{name}: {settled:?}"));
            }
        }
        server.close().await;
        assert!(wrong.is_empty(), "{wrong:#?}");
    });
}
