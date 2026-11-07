//! `fixtures/oauth-scrub/golden.json` (`record-oauth-scrub.mjs`): Node's `scrubOAuthSecrets` over
//! bodies that carry tokens and secrets in every form a refusal arrives in.

use serde_json::Value;

use super::scrub::scrub_oauth_secrets;

const GOLDEN: &str = include_str!("../../../../fixtures/oauth-scrub/golden.json");

#[test]
fn every_body_is_redacted_as_node_redacts_it() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 50);
    for scenario in scenarios {
        let text = scenario["text"].as_str().unwrap();
        let secrets: Vec<&str> = scenario["secrets"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        assert_eq!(scrub_oauth_secrets(text, &secrets), scenario["scrubbed"].as_str().unwrap(), "{text}");
    }
}
