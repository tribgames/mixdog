//! Node's session-adoption compaction cases (`fixtures/session-adopt-cases`, `record-session-adopt-cases.mjs`): the
//! runtime's compaction section stored as the saved config, the session's record as its header, and the record the
//! session holds once it is installed (`synced_compaction(header, install = true)`, unchanged when it returns none)
//! against Node's after `sessionAdopter`. The hook cases replay in mixdog-mcp.

use std::collections::HashMap;

use serde_json::{Value, json};

use mixdog_core::run_host::host_seams::ConfigSeams as _;

use super::run_seams::seams;

#[tokio::test]
async fn every_recorded_adoption_leaves_nodes_session_compaction() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/session-adopt-cases/golden.json")).unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap().iter().filter(|c| c["kind"] == "compaction") {
        let stored = (!case["section"].is_null()).then(|| json!({ "agent": { "compaction": case["section"] } }));
        let (_dir, seams) = seams(stored, HashMap::new()).await;
        let seams = seams.with_injected_config(case["injected"] == true);
        let header = json!({ "compaction": case["before"] }).as_object().unwrap().clone();
        let after = seams.synced_compaction(&header, true).unwrap_or_else(|| case["before"].clone());
        let got = json!({ "compaction": after });
        if got != case["recorded"] {
            failures.push(format!("{}:\n  want {}\n  got  {got}", case["case"], case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
