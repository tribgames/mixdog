//! Node's session-adoption compaction cases (`fixtures/session-adopt-cases`, `record-session-adopt-cases.mjs`): the
//! runtime's compaction section stored as the saved config, the session's record as its header, and the record the
//! session holds once it is installed (`synced_compaction(header, install = true)`, unchanged when it returns none)
//! against Node's after `sessionAdopter`. The hook cases replay in mixdog-mcp.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::tests::seams;
use crate::run_host::host_seams::ConfigSeams;

#[tokio::test]
#[allow(clippy::disallowed_methods)] // test fixture loading
async fn every_recorded_adoption_leaves_nodes_session_compaction() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-adopt-cases/golden.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
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
