//! `setExtensionScope` replayed against what today's Node product saved and answered
//! (`tests/golden/scope.mjs` → `scope.json`), byte for byte on the saved config. The goldens carry
//! Windows paths, so the replay runs only there.
#![cfg(windows)]

use mixdog_mcp::scopes::ScopeKind;
use mixdog_mcp::scopes::plan_extension_scope;
use serde_json::Value;

#[test]
fn the_saved_scope_and_the_answer_match_node_in_every_recorded_case() {
    let golden: Value = serde_json::from_str(include_str!("../golden/scope.json")).unwrap();
    // Relative roots resolve against the directory Node recorded them in.
    std::env::set_current_dir(golden["cwd"].as_str().unwrap()).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let label = case["name"].as_str().unwrap();
        let projects = if case["projects"] == "omitted" { Value::Null } else { case["projects"].clone() };
        let plugins = case["plugins"].as_array().unwrap();
        let got = plan_extension_scope(&case["config"], &case["kind"], &case["target"], &projects, plugins);
        match (&got, case["error"].as_str()) {
            (Err(e), Some(expected)) => assert_eq!(e.to_string(), expected, "{label}"),
            (Ok(change), None) => {
                assert_eq!(change.config.to_string(), case["saved"].to_string(), "{label}: saved config");
                let answered = match change.kind {
                    ScopeKind::Skills => "skills",
                    ScopeKind::Mcp => "servers",
                    ScopeKind::Plugins => "plugins",
                };
                assert_eq!(answered, case["answered"], "{label}: answered status");
            }
            _ => panic!("{label}: got {got:?}, Node error {:?}", case["error"]),
        }
    }
}
