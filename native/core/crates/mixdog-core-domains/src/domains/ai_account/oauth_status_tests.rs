//! `describe_oauth` against Node's `describe*OAuthCredentials` (fixtures/oauth-describe/golden.json),
//! key order included: the rows are agent- and UI-visible JSON.

use serde_json::Value;

use super::oauth_status::describe_oauth;
use super::oauth_status::oauth_available;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/oauth-describe/golden.json")).unwrap()
}

#[test]
fn every_description_equals_nodes_from_the_loaded_document() {
    let golden = golden();
    let now = golden["now"].as_i64().unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 30);
    for scenario in scenarios {
        let provider = scenario["provider"].as_str().unwrap();
        let name = scenario["name"].as_str().unwrap();
        let loaded = Some(&scenario["loaded"]).filter(|loaded| !loaded.is_null());
        let built = describe_oauth(provider, loaded, now).unwrap_or_else(|| panic!("{provider} is covered"));
        assert_eq!(
            serde_json::to_string(&built).unwrap(),
            serde_json::to_string(&scenario["described"]).unwrap(),
            "{provider}: {name}"
        );
    }
}

#[test]
fn only_the_ten_providers_are_described() {
    assert_eq!(describe_oauth("unknown", None, 0), None);
    assert!(describe_oauth("cursor-oauth", None, 0).is_some());
}

#[test]
fn a_dev_only_provider_is_listed_only_while_its_stored_option_is_true() {
    let golden = golden();
    let ids = [
        "openai-oauth",
        "anthropic-oauth",
        "grok-oauth",
        "muse-code-oauth",
        "command-code-oauth",
        "opencode-go-oauth",
        "mimo-oauth",
        "cursor-oauth",
        "devin-oauth",
        "antigravity-oauth",
    ];
    for case in golden["availability"].as_array().unwrap() {
        let developer = &case["developer"];
        let listed: Vec<&str> = ids.iter().copied().filter(|id| oauth_available(id, developer)).collect();
        let want: Vec<&str> = case["available"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        assert_eq!(listed, want, "developer = {developer}");
    }
}
