//! The custom-provider rows of the setup snapshot against Node's `customProviderRows` inside
//! `providerSetup` (`fixtures/provider-setup-custom/golden.json`, `record-provider-setup-custom.mjs`):
//! every scenario, with and without secret checks, compared as serialized text (key order is part
//! of the document).

use serde_json::Value;

use super::custom_admin::{CustomFacts, custom_provider_rows};

const GOLDEN: &str = include_str!("../../../../../fixtures/provider-setup-custom/golden.json");

/// The facts the recorder read from Node's own modules for one scenario.
struct Recorded<'a>(&'a Value);

fn id_of(account: &str) -> &str {
    account.strip_prefix("agent.").and_then(|rest| rest.strip_suffix(".apiKey")).unwrap_or_default()
}

fn listed(list: &Value, id: &str) -> bool {
    list.as_array().is_some_and(|items| items.iter().any(|item| item == id))
}

impl CustomFacts for Recorded<'_> {
    fn env(&self, name: &str) -> Option<String> {
        self.0["env"][name].as_str().map(str::to_owned).or_else(|| listed(&self.0["emptyEnv"], name).then(String::new))
    }
    fn has_stored_secret(&self, account: &str) -> bool {
        listed(&self.0["stored"], id_of(account))
    }
    fn is_fallback_secret(&self, account: &str) -> bool {
        listed(&self.0["fallback"], id_of(account))
    }
    fn custom_key_ids(&self, id: &str) -> Vec<String> {
        self.0["keyIds"][id].as_array().into_iter().flatten().filter_map(|key| key.as_str().map(str::to_owned)).collect()
    }
}

#[test]
fn the_rows_equal_nodes_for_every_scenario_with_and_without_secret_checks() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 20);
    let mut shown = 0;
    for scenario in scenarios {
        let providers = scenario["providers"].as_object().unwrap();
        let facts = Recorded(&scenario["world"]);
        for check_secrets in [true, false] {
            let got = Value::Array(custom_provider_rows(&facts, providers, check_secrets));
            let want = &scenario["rows"][check_secrets.to_string()];
            assert_eq!(
                serde_json::to_string(&got).unwrap(),
                serde_json::to_string(want).unwrap(),
                "{} (checkSecrets {check_secrets})",
                scenario["name"]
            );
            shown += got.as_array().unwrap().len();
        }
    }
    assert!(shown > 40, "the golden reaches the rows ({shown})");
}
