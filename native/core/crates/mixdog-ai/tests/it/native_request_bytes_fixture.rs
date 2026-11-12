//! `scripts/tool-contracts/native-request-bytes.test.mjs`, case "the HEAD fixture exercises every native-visible path": the
//! recorded request set of Node's native providers (`providers/oracles/native-request-bytes.head.json`, the pre-bridge HEAD
//! output, byte-identical to Node's `scripts/tool-contracts/native-request-bytes.head.json` at b6f10295a) holds, for every provider,
//! each path the bridge work must never touch: the BP2 deferred-tool roster with the MCP server listed and its instruction text
//! held back until its first loaded tool, `load_tool` among the first request's tools, the late-MCP delta notice, the
//! first-turn MCP fold, skill loading and the deny texts.

use serde_json::Value;

const FIXTURE: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/providers/oracles/native-request-bytes.head.json");

fn has_line(text: &str, line_start: &str) -> bool {
    text.lines().any(|line| line.starts_with(line_start))
}

#[test]
fn the_recorded_request_set_exercises_every_native_visible_path() {
    let fixture: Value = serde_json::from_str(&FIXTURE).unwrap();
    let providers = fixture["expected"].as_object().unwrap();
    assert!(!providers.is_empty());
    for (provider, scenario) in providers {
        let bp2 = scenario["first"]["system"][1].as_str().unwrap();
        assert!(bp2.contains("<available-deferred-tools>"), "{provider}: the roster block");
        assert!(!bp2.contains("<mcp-instructions>"), "{provider}: no instructions before a tool of the server loads");
        assert!(has_line(bp2, "- mcp__github: "), "{provider}: the server in the roster");
        // The server's instruction text arrives with its first loaded tool.
        let load: Value = serde_json::from_str(scenario["loadToolResults"]["load"].as_str().unwrap()).unwrap();
        assert_eq!(load["mcpInstructions"], "## github\nPrefer list_issues before create_issue.", "{provider}");
        let first_tools = scenario["first"]["tools"].as_array().unwrap();
        assert!(first_tools.iter().any(|tool| tool[0] == "load_tool"), "{provider}: load_tool is offered");
        let after = &scenario["afterLoad"];
        assert!(
            after["tools"].as_array().unwrap().len() > first_tools.len() || !after["state"]["discovered"].as_array().unwrap().is_empty(),
            "{provider}: a load changes the next request"
        );
        let late = &scenario["lateMcp"]["connected"];
        assert!(has_line(late["content"].as_str().unwrap(), "- mcp__late: Look something up"), "{provider}: the late notice");
        let added: Vec<&Value> = late["added"].as_array().unwrap().iter().map(|entry| &entry["name"]).collect();
        assert_eq!(added, ["mcp__late__lookup"], "{provider}");
        assert!(has_line(scenario["firstTurnFold"]["system"][1].as_str().unwrap(), "- mcp__late: "), "{provider}: the fold");
        assert!(scenario["skillLoading"]["text"].as_str().unwrap().contains("office"), "{provider}: skill loading");
        for (name, text) in scenario["denials"].as_object().unwrap() {
            assert!(text.is_string() || text.is_null(), "{provider}: denial {name}");
        }
        assert!(scenario["denials"]["unresolvedMode"].as_str().unwrap().contains("load it with load_tool"), "{provider}");
    }
}
