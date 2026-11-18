//! The provider setup of a model-proxy client: what the PC advertised, projected to the rows the setup screen shows.

use serde_json::{Value, json};

use super::provider_setup::model_proxy_provider_setup;

fn local_row(advertised: Value) -> Value {
    let providers = json!({ "mixdog-local": advertised });
    model_proxy_provider_setup(providers.as_object())["local"][0].clone()
}

#[test]
fn a_client_that_heard_nothing_from_the_pc_shows_every_group_empty_and_unavailable() {
    assert_eq!(
        model_proxy_provider_setup(None),
        json!({ "managedByClient": true, "unavailable": true, "api": [], "oauth": [], "local": [] })
    );
}

#[test]
fn an_enabled_provider_with_no_auth_state_is_connected_and_a_row_keeps_its_key_order() {
    let row = local_row(json!({ "enabled": true }));
    assert_eq!(
        serde_json::to_string(&row).unwrap(),
        r#"{"id":"mixdog-local","name":"Local Provider","group":"local","type":"local","enabled":true,"authenticated":true,"usable":true,"detected":true,"status":"Connected"}"#
    );
}

#[test]
fn the_auth_state_tells_a_missing_credential_from_an_unreadable_one_and_a_switched_off_one() {
    let absent = local_row(json!({ "enabled": true, "authState": "absent" }));
    assert_eq!((absent["authenticated"].clone(), absent["usable"].clone(), absent["status"].clone()), (json!(false), json!(false), json!("Not connected")));
    let unreadable = local_row(json!({ "enabled": true, "authState": "unreadable" }));
    assert_eq!((unreadable["usable"].clone(), unreadable["status"].clone()), (json!(true), json!("Checking…")));
    let off = local_row(json!({ "enabled": false, "authState": "present" }));
    assert_eq!((off["authenticated"].clone(), off["usable"].clone(), off["status"].clone()), (json!(true), json!(false), json!("Off")));
    let disabled = local_row(json!({ "enabled": false }));
    assert_eq!(disabled["status"], json!("Not connected"));
}

#[test]
fn only_the_providers_the_pc_advertised_get_a_row() {
    let providers = json!({ "mixdog-local": { "enabled": true } });
    let setup = model_proxy_provider_setup(providers.as_object());
    assert_eq!(setup["api"], json!([]));
    assert_eq!(setup["oauth"], json!([]));
    assert_eq!(setup["local"].as_array().unwrap().len(), 1);
}
