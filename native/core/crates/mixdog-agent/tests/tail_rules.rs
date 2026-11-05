//! The tail reminder rules against the goldens recorded from Node
//! (`fixtures/agent/record-tail-reminder.mjs`).
//! Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::env::TailReminder;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_agent::tail_rules::model_family_id;
use mixdog_protocol::JsonValue;

#[test]
fn rust_rules_match_the_recorded_node_results() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/tail_reminder/cases.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in golden["families"].as_array().unwrap() {
        let model = case["model"].as_str().unwrap();
        assert_eq!(model_family_id(model), case["id"].as_str().unwrap(), "{model:?}");
    }
    let matches = golden["matches"].as_array().unwrap();
    assert!(matches.iter().any(|m| m["text"].is_string()) && matches.len() > 100);
    for case in matches {
        let c = &case["context"];
        let role = match c["role"].as_str().unwrap() {
            "lead" => TailRole::Lead,
            "bot" => TailRole::Bot,
            _ => TailRole::Worker,
        };
        let language = c["language"].as_object().map(|l| TailLanguage {
            id: l["id"].as_str().unwrap().to_owned(),
            name: l["name"].as_str().unwrap().to_owned(),
        });
        let rules = RuleTailReminder {
            context: TailContext { provider: c["provider"].as_str().unwrap().to_owned(), language, role },
        };
        let model = c["model"].as_str().unwrap();
        // Node's "no reminder" is the empty string.
        assert_eq!(rules.text(model).as_deref().unwrap_or(""), case["text"].as_str().unwrap(), "{c}");
    }
}
