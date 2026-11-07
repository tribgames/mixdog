//! `parse_native_tool_search` against Node's `parseNativeToolSearchPayload`
//! (`fixtures/native-tool-search/golden.json`, `record-native-tool-search.mjs`): the Skill
//! results Node's loader returns and the edge payloads of the parser, whole.

use mixdog_agent::native_search::parse_native_tool_search;
use serde_json::Value;

#[test]
fn the_payload_a_result_carries_is_what_node_parses() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/native-tool-search/golden.json")).expect("fixture");
    let cases = golden["parse"].as_array().expect("parse cases");
    assert_eq!(cases.len(), 17);
    for case in cases {
        let got = parse_native_tool_search(case["toolName"].as_str().expect("tool"), case["result"].as_str().expect("result"));
        let want = Some(case["parsed"].clone()).filter(|parsed| !parsed.is_null());
        assert_eq!(got.as_ref(), want.as_ref(), "{}", case["name"]);
        // Key order is the wire's: provider, toolReferences, openaiTools, summary.
        if let (Some(got), Some(want)) = (got, want) {
            assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&want).unwrap(), "{}: order", case["name"]);
        }
    }
}
