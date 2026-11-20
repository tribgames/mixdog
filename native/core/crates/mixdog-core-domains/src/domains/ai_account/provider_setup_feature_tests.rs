//! The provider setup snapshot: one row per API provider, OAuth provider and the local provider, with the status and the
//! source of the credential each shows.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::custom_admin::CustomFacts;
use super::provider_setup::{KeychainStatus, SetupOptions, SetupWorld, UnsafeStore, keychain_issue_of, provider_setup};

#[derive(Default)]
struct Fake {
    /// Provider id -> the variable its key was read from.
    resolved: HashMap<&'static str, &'static str>,
    key_present: Vec<&'static str>,
    stored: Vec<&'static str>,
    keychain_state: &'static str,
    local: Option<Value>,
}

impl CustomFacts for Fake {
    fn env(&self, _: &str) -> Option<String> {
        None
    }
    fn has_stored_secret(&self, account: &str) -> bool {
        self.stored.iter().any(|id| account == format!("agent.{id}.apiKey"))
    }
    fn is_fallback_secret(&self, _: &str) -> bool {
        false
    }
    fn custom_key_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
}

impl SetupWorld for Fake {
    fn resolved_env_name(&self, id: &str) -> Option<String> {
        self.resolved.get(id).map(|name| (*name).to_owned())
    }
    fn has_agent_api_key(&self, id: &str) -> bool {
        self.key_present.contains(&id)
    }
    fn keychain_status(&self) -> KeychainStatus {
        KeychainStatus { state: self.keychain_state.to_owned(), fallback: false, unsafe_store: None }
    }
    fn oauth_available(&self, _: &str) -> bool {
        true
    }
    fn oauth_describe(&self, id: &str) -> Value {
        let detail = if id == "anthropic-oauth" { "Mixdog OAuth credentials" } else { "Mixdog token store" };
        json!({ "authenticated": false, "usable": false, "refreshable": false, "reauthRequired": false, "status": "Not Set", "detail": detail })
    }
    fn vertex_adc(&self, _: Option<&str>) -> Option<Value> {
        Some(json!({ "state": "missing", "message": "No gcloud login found. Run `gcloud auth application-default login`." }))
    }
    fn probe_vertex_metadata(&self) {}
    fn vertex_env_location(&self) -> Option<String> {
        None
    }
    fn vertex_key_project(&self) -> Option<String> {
        None
    }
    fn local_status(&self) -> Option<Value> {
        self.local.clone()
    }
}

fn setup(world: &Fake, config: Value) -> Value {
    provider_setup(world, &config, SetupOptions { check_secrets: true, detect_local: true })
}

fn api<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["api"].as_array().unwrap().iter().find(|row| row["id"] == id).unwrap_or_else(|| panic!("no api row {id}"))
}

#[test]
fn the_api_rows_come_in_setup_order_and_an_empty_config_leaves_every_provider_off() {
    let snapshot = setup(&Fake::default(), json!({}));
    let ids: Vec<&str> = snapshot["api"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["openrouter", "openai", "anthropic", "gemini", "vertex-ai", "deepseek", "xai"]);
    assert_eq!(
        api(&snapshot, "openrouter"),
        &json!({
            "id": "openrouter", "name": "OpenRouter", "env": false, "url": "https://openrouter.ai/keys", "group": "api", "type": "api-key",
            "enabled": false, "authenticated": false, "stored": false, "envName": "OPENROUTER_API_KEY", "status": "Off", "detail": "OPENROUTER_API_KEY"
        })
    );
    assert_eq!(api(&snapshot, "xai")["envName"], "XAI_API_KEY");
    assert_eq!(api(&snapshot, "deepseek")["url"], "https://platform.deepseek.com/api_keys");
}

#[test]
fn an_enabled_provider_without_a_key_reads_no_key() {
    let snapshot = setup(&Fake::default(), json!({ "providers": { "openai": { "enabled": true } } }));
    let row = api(&snapshot, "openai");
    assert_eq!((row["enabled"].clone(), row["authenticated"].clone(), row["status"].clone()), (json!(true), json!(false), json!("No Key")));
}

#[test]
fn a_key_from_the_environment_shows_the_variable_it_was_read_from() {
    let world = Fake { resolved: HashMap::from([("xai", "GROK_API_KEY")]), key_present: vec!["xai"], ..Fake::default() };
    let row = setup(&world, json!({ "providers": { "xai": { "enabled": true } } })).pointer("/api/6").cloned().unwrap();
    assert_eq!(row["env"], true);
    assert_eq!((row["status"].clone(), row["envName"].clone(), row["credentialSource"].clone()), (json!("Env"), json!("GROK_API_KEY"), json!("environment")));
}

#[test]
fn a_key_stored_in_the_keychain_enables_its_provider_even_when_the_config_does_not() {
    let world = Fake { stored: vec!["openai"], key_present: vec!["openai"], ..Fake::default() };
    let snapshot = setup(&world, json!({}));
    let row = api(&snapshot, "openai");
    assert_eq!((row["enabled"].clone(), row["authenticated"].clone(), row["stored"].clone()), (json!(true), json!(true), json!(true)));
    assert_eq!((row["status"].clone(), row["detail"].clone(), row["credentialSource"].clone()), (json!("Set"), json!("stored in keychain"), json!("keychain")));
}

#[test]
fn an_environment_key_wins_over_a_stored_one_in_the_status_but_both_are_reported() {
    let world = Fake { resolved: HashMap::from([("openai", "OPENAI_API_KEY")]), stored: vec!["openai"], key_present: vec!["openai"], ..Fake::default() };
    let row = setup(&world, json!({ "providers": { "openai": { "enabled": true } } })).pointer("/api/1").cloned().unwrap();
    assert_eq!((row["status"].clone(), row["stored"].clone(), row["credentialSource"].clone()), (json!("Env"), json!(true), json!("environment")));
}

#[test]
fn vertex_names_its_authentication_mode_and_defaults_to_the_global_location() {
    let snapshot = setup(&Fake::default(), json!({}));
    let row = api(&snapshot, "vertex-ai");
    assert_eq!(
        (row["authMode"].clone(), row["authKind"].clone(), row["detail"].clone()),
        (json!("service-account"), json!("service-account"), json!("Location: global"))
    );
    assert_eq!((row["location"].clone(), row["locationSource"].clone()), (json!("global"), json!("default")));
    assert_eq!(row["adc"]["state"], "missing");

    let world = Fake { stored: vec!["vertex-ai"], key_present: vec!["vertex-ai"], ..Fake::default() };
    let express = setup(&world, json!({ "providers": { "vertex-ai": { "enabled": true, "authMode": "api-key" } } }));
    let row = api(&express, "vertex-ai");
    assert_eq!(
        (row["status"].clone(), row["detail"].clone(), row["credentialSource"].clone()),
        (json!("Set"), json!("API key (express mode) · global"), json!("keychain"))
    );
}

#[test]
fn a_locked_keyring_is_reported_once_on_the_snapshot_and_on_each_row_that_needs_it() {
    let world = Fake { keychain_state: "locked", ..Fake::default() };
    let snapshot = setup(&world, json!({ "providers": { "openai": { "enabled": true } } }));
    let message = "Keyring is locked \u{2014} unlock it (log in again or open Passwords and Keys).";
    assert_eq!(snapshot["keychain"], json!({ "state": "locked", "message": message }));
    let row = api(&snapshot, "openrouter");
    assert_eq!((row["keychainIssue"]["state"].clone(), row["detail"].clone()), (json!("locked"), json!(message)));
    assert_eq!(api(&snapshot, "openai")["status"], "No Key");

    let with_env = Fake { keychain_state: "locked", resolved: HashMap::from([("openai", "OPENAI_API_KEY")]), key_present: vec!["openai"], ..Fake::default() };
    let row = setup(&with_env, json!({ "providers": { "openai": { "enabled": true } } })).pointer("/api/1").cloned().unwrap();
    assert!(row.get("keychainIssue").is_none(), "a key found in the environment needs no keychain");
    assert_eq!(row["status"], "Env");
}

#[test]
fn oauth_rows_carry_the_describe_of_their_provider_and_stay_off_until_enabled() {
    let snapshot = setup(&Fake::default(), json!({}));
    let rows = snapshot["oauth"].as_array().unwrap();
    assert_eq!(
        rows[0],
        json!({
            "id": "openai-oauth", "name": "OpenAI OAuth", "desc": "Mixdog OAuth credentials", "group": "oauth", "type": "oauth", "enabled": false,
            "authenticated": false, "status": "Not Set", "detail": "Mixdog token store", "expiresAt": null, "plan": null, "usable": false,
            "refreshable": false, "reauthRequired": false
        })
    );
    assert_eq!(rows[1]["id"], "anthropic-oauth");
    assert_eq!(rows[1]["detail"], "Mixdog OAuth credentials");
}

#[test]
fn a_local_status_that_cannot_be_read_shows_the_local_provider_as_not_installed() {
    let snapshot = setup(&Fake::default(), json!({}));
    assert_eq!(
        snapshot["local"],
        json!([{
            "id": "mixdog-local", "name": "Local Provider", "desc": "Models managed on this PC by Mixdog", "group": "local", "type": "local",
            "enabled": false, "detected": false, "authenticated": false, "usable": false, "status": "Not Installed",
            "detail": "Install a recommended model from Built-in"
        }])
    );
}

fn local_row(config: Value, status: Option<Value>, detect_local: bool) -> Value {
    let world = Fake { local: status, ..Fake::default() };
    let snapshot = provider_setup(&world, &config, SetupOptions { check_secrets: true, detect_local });
    snapshot["local"][0].clone()
}

fn installed_runtime(models: &[bool]) -> Value {
    json!({ "runtime": { "installed": true }, "models": models.iter().map(|installed| json!({ "installed": installed })).collect::<Vec<_>>() })
}

fn ready_config() -> Value {
    json!({ "builtins": { "localProvider": { "installed": true } }, "providers": { "mixdog-local": { "enabled": true } } })
}

#[test]
fn a_local_provider_with_an_installed_runtime_and_models_is_ready_when_enabled_and_off_when_not() {
    let ready = local_row(ready_config(), Some(installed_runtime(&[true, false, true])), true);
    assert_eq!((ready["status"].clone(), ready["detail"].clone()), (json!("Ready"), json!("2 installed models")));
    assert_eq!(
        (ready["enabled"].clone(), ready["detected"].clone(), ready["authenticated"].clone(), ready["usable"].clone()),
        (json!(true), json!(true), json!(true), json!(true))
    );

    let one = local_row(ready_config(), Some(installed_runtime(&[true])), true);
    assert_eq!(one["detail"], "1 installed model");

    let off = local_row(json!({ "builtins": { "localProvider": { "installed": true } } }), Some(installed_runtime(&[true])), true);
    assert_eq!(
        (off["status"].clone(), off["enabled"].clone(), off["detected"].clone(), off["usable"].clone()),
        (json!("Off"), json!(false), json!(true), json!(false))
    );
}

#[test]
fn a_local_provider_installed_without_a_model_reads_no_model() {
    let row = local_row(ready_config(), Some(installed_runtime(&[false])), true);
    assert_eq!((row["status"].clone(), row["detected"].clone(), row["usable"].clone()), (json!("No Model"), json!(false), json!(false)));
    assert_eq!(row["detail"], "Install a recommended model from Built-in");
}

#[test]
fn the_local_module_switched_off_leaves_the_provider_disabled_even_with_models() {
    let mut config = ready_config();
    config["modules"] = json!({ "localProvider": { "enabled": false } });
    let row = local_row(config, Some(installed_runtime(&[true])), true);
    assert_eq!((row["status"].clone(), row["enabled"].clone(), row["usable"].clone()), (json!("Off"), json!(false), json!(false)));
}

#[test]
fn the_local_runtime_is_not_asked_unless_detection_is_wanted() {
    let row = local_row(ready_config(), Some(installed_runtime(&[true])), false);
    assert_eq!((row["status"].clone(), row["detected"].clone()), (json!("No Model"), json!(false)));
}

fn status_of(state: &str, fallback: bool, unsafe_store: Option<(&str, &str)>) -> KeychainStatus {
    KeychainStatus {
        state: state.to_owned(),
        fallback,
        unsafe_store: unsafe_store.map(|(kind, path)| UnsafeStore { kind: kind.to_owned(), path: path.to_owned() }),
    }
}

#[test]
fn each_keyring_state_that_hides_stored_keys_has_its_own_hint_and_a_working_keyring_has_none() {
    for (state, message) in [
        ("unreachable", "The keyring is not reachable — make sure it is running, then press Unlock keyring."),
        ("locked", "Keyring is locked — unlock it (log in again or open Passwords and Keys)."),
        ("missing", "Install libsecret-tools (sudo apt install libsecret-tools) to use the system keyring."),
        ("error", "The system keyring could not be read — check that it is running and unlocked."),
    ] {
        assert_eq!(keychain_issue_of(status_of(state, false, None)), Some(json!({ "state": state, "message": message })), "{state}");
    }
    assert_eq!(keychain_issue_of(status_of("ok", false, None)), None);
    assert_eq!(keychain_issue_of(status_of("unknown", false, None)), None);
}

#[test]
fn the_private_file_store_is_an_issue_only_when_its_files_are_ignored_and_names_why() {
    assert_eq!(keychain_issue_of(status_of("ok", true, None)), None, "a private file store in use, key stored there");
    assert_eq!(keychain_issue_of(status_of("locked", true, None)), None, "the keyring's locked state does not matter to the private file");
    for (kind, message) in [
        (
            "permissions",
            "The private secrets folder has unsafe permissions, so its keys are ignored — run chmod 700 on the folder and chmod 600 on its files, or save the key again.",
        ),
        (
            "owner",
            "The private secrets folder or one of its files belongs to another user, so its keys are ignored — change its owner to the current user (chown).",
        ),
        (
            "type",
            "The private secrets folder or one of its files is a symlink or not a regular file, so its keys are ignored — remove it and save the key again.",
        ),
        (
            "anything-else",
            "The private secrets folder has unsafe permissions, so its keys are ignored — run chmod 700 on the folder and chmod 600 on its files, or save the key again.",
        ),
    ] {
        assert_eq!(
            keychain_issue_of(status_of("ok", true, Some((kind, "/home/u/.mixdog/secrets")))),
            Some(json!({ "state": "unsafe-store", "kind": kind, "message": message, "path": "/home/u/.mixdog/secrets" })),
            "{kind}"
        );
    }
}
