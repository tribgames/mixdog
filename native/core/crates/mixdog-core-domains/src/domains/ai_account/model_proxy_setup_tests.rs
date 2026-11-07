//! `modelProxyProviderSetup` against Node's (`fixtures/model-proxy-setup/golden.json`,
//! `record-model-proxy-setup.mjs`: the real `providerSetup` in the model-proxy client mode over the
//! real `ModelProxyChannel`): the projection of what the PC advertised, key order included.

use serde_json::Value;

use super::provider_setup::model_proxy_provider_setup;

const GOLDEN: &str = include_str!("../../../../../fixtures/model-proxy-setup/golden.json");

#[test]
fn the_projection_is_nodes_for_every_advertised_set() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 11);
    for scenario in scenarios {
        let providers = scenario["providers"].as_object();
        let got = model_proxy_provider_setup(providers);
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&scenario["result"]).unwrap(), "{}", scenario["name"]);
    }
}
