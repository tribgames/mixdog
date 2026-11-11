use mixdog_agent::env::Clock;

use super::*;
use crate::run_host::tool_surface::SurfaceHost;

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1_700_000_000_000
    }
}

/// No connected server carries instructions (the recorder's registry is empty), and the fold never reads the bridge's own tools.
struct Host;
impl SurfaceHost for Host {
    fn bridge_tools(&self) -> Vec<Value> {
        Vec::new()
    }
    fn mcp_server_instructions(&self, _scope: Option<&str>) -> Value {
        json!({})
    }
}

/// Node's `refreshInitialDeferredMcpSurface` and `reconcileDeferredMcpToolCatalog` over native, bridge and fixed
/// surfaces, servers connecting, going and reconnecting, a loaded tool outliving its server, denied MCP tools
/// (`fixtures/mcp-fold`, the `unit` cases): each call's result and the whole session after it.
#[test]
fn the_mcp_fold_follows_node() {
    let golden: Value = mixdog_js::fixture_tools::parse_golden(mixdog_testkit::fixture!("../../fixtures/mcp-fold/golden.json")).expect("fixture");
    let surface = ToolSurface { host: &Host, clock: &Fixed };
    let mut calls = 0;
    for case in golden["cases"].as_array().expect("cases").iter().filter(|case| case["suite"] == "unit") {
        let name = case["name"].as_str().expect("name");
        let mut session = case["before"].clone();
        for (n, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let live = step["live"].as_array().expect("live").clone();
            let result = match step["call"].as_str().expect("call") {
                "initial" => json!(surface.refresh_initial_mcp_surface(&mut session, &live)),
                "reconcile" => surface.reconcile_mcp_catalog(&mut session, &live).map_or(Value::Null, |names| json!(names)),
                other => panic!("{name} step {n}: unknown call {other}"),
            };
            assert_eq!(result, step["result"], "{name} step {n}: result");
            assert_eq!(session, step["after"], "{name} step {n}: session");
            calls += 1;
        }
    }
    assert!(calls > 0);
}
