//! The custom-provider rows of the setup snapshot: the status a provider shows by where its key comes from, which rows are
//! listed at all, and what an invalid stored config shows.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::custom_admin::{CustomFacts, custom_provider_rows};

const A: &str = "custom-11111111-1111-4111-8111-111111111111";
const B: &str = "custom-22222222-2222-4222-8222-222222222222";

#[derive(Default)]
struct World {
    env: HashMap<&'static str, &'static str>,
    stored: Vec<&'static str>,
    fallback: Vec<&'static str>,
    keys: Vec<&'static str>,
}

fn id_of(account: &str) -> &str {
    account.strip_prefix("agent.").and_then(|rest| rest.strip_suffix(".apiKey")).unwrap_or_default()
}

impl CustomFacts for World {
    fn env(&self, name: &str) -> Option<String> {
        self.env.get(name).map(|value| (*value).to_owned())
    }
    fn has_stored_secret(&self, account: &str) -> bool {
        self.stored.contains(&id_of(account))
    }
    fn is_fallback_secret(&self, account: &str) -> bool {
        self.fallback.contains(&id_of(account))
    }
    fn custom_key_ids(&self, _: &str) -> Vec<String> {
        self.keys.iter().map(|key| (*key).to_owned()).collect()
    }
}

fn provider(extra: Value) -> Value {
    let mut config = json!({ "type": "custom", "name": "Alpha", "protocol": "openai-chat", "baseURL": "http://localhost:1234/v1", "schemaVersion": 2, "auth": "key", "enabled": true });
    config.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    config
}

fn rows(world: &World, providers: Vec<(&str, Value)>, check_secrets: bool) -> Vec<Value> {
    let map: Map<String, Value> = providers.into_iter().map(|(id, entry)| (id.to_owned(), entry)).collect();
    custom_provider_rows(world, &map, check_secrets)
}

fn shown(row: &Value) -> (String, String, bool, bool) {
    (
        row["status"].as_str().unwrap().to_owned(),
        row["detail"].as_str().unwrap().to_owned(),
        row["authenticated"].as_bool().unwrap(),
        row["stored"].as_bool().unwrap(),
    )
}

#[test]
fn only_generated_custom_providers_are_listed_in_config_order() {
    let world = World::default();
    let listed = rows(
        &world,
        vec![
            (B, provider(json!({}))),
            ("openai", json!({ "enabled": true })),
            (A, provider(json!({}))),
            ("custom-x", provider(json!({}))),
            ("custom-33333333-3333-4333-8333-333333333333", json!({ "type": "other" })),
        ],
        true,
    );
    assert_eq!(listed.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), [B, A]);
    assert!(rows(&world, vec![], true).is_empty());
}

#[test]
fn a_keyed_provider_shows_where_its_key_is_kept() {
    let world = World { stored: vec![A], ..World::default() };
    assert_eq!(shown(&rows(&world, vec![(A, provider(json!({})))], true)[0]), ("Set".into(), "stored in keychain".into(), true, true));
    let private = World { stored: vec![A], fallback: vec![A], ..World::default() };
    assert_eq!(shown(&rows(&private, vec![(A, provider(json!({})))], true)[0]).1, "stored in private file");
    let none = World::default();
    assert_eq!(shown(&rows(&none, vec![(A, provider(json!({})))], true)[0]), ("No Key".into(), "custom endpoint".into(), false, false));
    assert_eq!(shown(&rows(&none, vec![(A, provider(json!({ "enabled": false })))], true)[0]).0, "Off");
}

#[test]
fn without_secret_checks_a_provider_counts_as_connected_when_enabled_and_never_as_stored() {
    let world = World { stored: vec![A], ..World::default() };
    let row = &rows(&world, vec![(A, provider(json!({})))], false)[0];
    assert_eq!((row["authenticated"].clone(), row["stored"].clone(), row["status"].clone()), (json!(true), json!(false), json!("No Key")));
    assert_eq!(rows(&world, vec![(A, provider(json!({ "enabled": false })))], false)[0]["authenticated"], false);
}

#[test]
fn a_key_variable_decides_the_status_by_whether_it_is_set() {
    let set = World { env: HashMap::from([("MY_KEY", "sk-1")]), ..World::default() };
    let unset = World::default();
    let entry = provider(json!({ "apiKeyEnv": "MY_KEY" }));
    let row = &rows(&set, vec![(A, entry.clone())], true)[0];
    assert_eq!(
        (shown(row), row["env"].clone(), row["envName"].clone(), row["apiKeyEnv"].clone()),
        (("Env".into(), "MY_KEY".into(), true, false), json!(true), json!("MY_KEY"), json!("MY_KEY"))
    );
    assert_eq!(shown(&rows(&unset, vec![(A, entry.clone())], true)[0]), ("No Key".into(), "MY_KEY".into(), false, false));
    let empty = World { env: HashMap::from([("MY_KEY", "")]), ..World::default() };
    assert_eq!(rows(&empty, vec![(A, entry)], true)[0]["env"], false, "an empty variable is not set");
}

#[test]
fn a_keyless_provider_is_always_connected_and_lists_no_additional_keys() {
    let world = World { keys: vec!["k1"], ..World::default() };
    let row = &rows(&world, vec![(A, provider(json!({ "auth": "none" })))], true)[0];
    assert_eq!((shown(row), row["auth"].clone()), (("Keyless".into(), "no API key required".into(), true, false), json!("none")));
    assert!(row.get("extraApiKeys").is_none());
    assert_eq!(shown(&rows(&world, vec![(A, provider(json!({ "auth": "none", "enabled": false })))], true)[0]).0, "Off");
}

#[test]
fn additional_keys_are_listed_by_id_only() {
    let world = World { keys: vec!["k1", "k2"], ..World::default() };
    assert_eq!(rows(&world, vec![(A, provider(json!({})))], true)[0]["extraApiKeys"], json!([{ "id": "k1" }, { "id": "k2" }]));
}

#[test]
fn a_stored_config_that_does_not_normalize_is_shown_as_invalid_instead_of_connected() {
    let world = World { stored: vec![A], ..World::default() };
    let row = &rows(&world, vec![(A, provider(json!({ "protocol": "grpc" })))], true)[0];
    assert_eq!(
        (row["status"].clone(), row["detail"].clone(), row["configError"].clone()),
        (json!("Invalid config"), json!("unsupported protocol: grpc"), json!("unsupported protocol: grpc"))
    );
    assert_eq!((row["usable"].clone(), row["ready"].clone(), row["authenticated"].clone()), (json!(false), json!(false), json!(false)));
    assert_eq!(row["models"], json!([]));
}

#[test]
fn the_row_carries_the_name_protocol_url_models_and_the_normalized_extras() {
    let world = World::default();
    let entry = provider(json!({ "modelOverrides": { "m1": { "manual": true } }, "headers": { "X-Team": " blue " }, "wires": ["chat", "responses"] }));
    let row = &rows(&world, vec![(A, entry)], true)[0];
    assert_eq!(
        (row["name"].clone(), row["protocol"].clone(), row["baseURL"].clone(), row["custom"].clone(), row["group"].clone(), row["type"].clone()),
        (json!("Alpha"), json!("openai-chat"), json!("http://localhost:1234/v1"), json!(true), json!("api"), json!("api-key"))
    );
    assert_eq!(row["models"][0]["id"], "m1");
    assert_eq!(row["headers"], json!({ "X-Team": "blue" }), "the normalized headers");
    assert_eq!(row["wires"], json!(["chat", "responses"]));
    assert_eq!(row["discovery"], json!({ "newModelsHidden": false }));
}
