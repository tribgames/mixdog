use std::collections::HashMap;

use serde_json::Value;
use serde_json::json;

use super::collaborators::CustomProviders;
use super::custom_admin_tests::endpoint;
use super::custom_admin_tests::world;

const QUOTA: &str = "429 You exceeded your current quota";

struct Case {
    name: &'static str,
    keys: &'static [&'static str],
    refused: &'static [&'static str],
    flaky: usize,
    /// Settings the test overrides on the saved provider (keyless, environment key).
    probe: Value,
    /// The chat requests' keys, in order.
    chats: &'static [&'static str],
    /// The failure shown, or `None` for a pass.
    error: Option<&'static str>,
    /// The pass shown, with the extra key's id as `<key1>`.
    result: Value,
}

async fn run(case: Case) {
    let Case { name, keys, refused, flaky, probe, chats, error, result } = case;
    let refused: Vec<String> = refused.iter().map(|b| (*b).to_owned()).collect();
    let (base, seen) = endpoint(refused, flaky).await;
    let w = world(HashMap::from([("CS_ENV".to_owned(), "sk-env".to_owned())])).await;
    let mut input = json!({ "name": name, "protocol": "openai-chat", "baseURL": base, "apiKey": keys[0] });
    if keys.len() > 1 {
        input["extraApiKeys"] = keys[1..].iter().map(|k| json!({ "apiKey": k })).collect();
    }
    let saved = w.admin.save(input, 0).await.unwrap();
    let mut settings = json!({ "id": saved["id"], "schemaVersion": 2, "name": name, "protocol": "openai-chat", "baseURL": base });
    for (key, value) in probe.as_object().into_iter().flatten() {
        settings[key] = value.clone();
    }
    match (w.admin.test(settings, 0).await, error) {
        (Ok(shown), None) => {
            let shown = shown.to_string().replace(saved["extraApiKeys"][0]["id"].as_str().unwrap_or("\0"), "<key1>");
            assert_eq!(serde_json::from_str::<Value>(&shown).unwrap(), result, "{name}");
        }
        (Err(failure), Some(error)) => assert_eq!(failure.message(), error, "{name}"),
        (other, expected) => panic!("{name}: got {other:?}, expected {expected:?}"),
    }
    let seen = seen.lock().unwrap();
    let sent: Vec<String> = seen.iter().filter(|s| s.path == "/chat/completions").map(|s| s.authorization.replace("Bearer ", "")).collect();
    assert_eq!(sent, chats, "{name}: chat requests, in order, by key");
    assert_eq!(seen.iter().filter(|s| s.path == "/models").count(), 1, "{name}: one discovery");
}

#[tokio::test]
async fn a_pool_whose_every_key_is_refused_shows_the_quota_error_after_trying_each_key() {
    run(Case {
        name: "every key refused",
        keys: &["sk-primary", "sk-extra"],
        refused: &["Bearer sk-primary", "Bearer sk-extra"],
        flaky: 0,
        probe: json!({}),
        chats: &["sk-primary", "sk-extra"],
        error: Some(QUOTA),
        result: Value::Null,
    })
    .await;
}

#[tokio::test]
async fn a_refused_primary_key_hands_the_send_to_the_additional_key() {
    run(Case {
        name: "primary refused",
        keys: &["sk-primary", "sk-extra"],
        refused: &["Bearer sk-primary"],
        flaky: 0,
        probe: json!({}),
        chats: &["sk-primary", "sk-extra"],
        error: None,
        result: json!({ "key": { "id": "<key1>", "number": 2 }, "ok": true }),
    })
    .await;
}

#[tokio::test]
async fn a_lone_refused_key_shows_the_quota_error() {
    run(Case {
        name: "only key refused",
        keys: &["sk-only"],
        refused: &["Bearer sk-only"],
        flaky: 0,
        probe: json!({}),
        chats: &["sk-only"],
        error: Some(QUOTA),
        result: Value::Null,
    })
    .await;
}

#[tokio::test]
async fn a_503_is_retried_with_the_same_key_and_the_test_passes() {
    run(Case {
        name: "503 then success",
        keys: &["sk-only"],
        refused: &[],
        flaky: 1,
        probe: json!({}),
        chats: &["sk-only", "sk-only"],
        error: None,
        result: json!({ "ok": true }),
    })
    .await;
}

#[tokio::test]
async fn a_keyless_test_sends_no_key_even_when_additional_keys_are_saved() {
    run(Case {
        name: "keyless",
        keys: &["sk-primary", "sk-extra"],
        refused: &["Bearer sk-primary", "Bearer sk-extra"],
        flaky: 0,
        probe: json!({ "auth": "none" }),
        chats: &[""],
        error: None,
        result: json!({ "ok": true }),
    })
    .await;
}

#[tokio::test]
async fn an_environment_key_test_sends_only_that_key_even_when_additional_keys_are_saved() {
    run(Case {
        name: "environment key",
        keys: &["sk-primary", "sk-extra"],
        refused: &["Bearer sk-env"],
        flaky: 0,
        probe: json!({ "apiKeyEnv": "CS_ENV" }),
        chats: &["sk-env"],
        error: Some(QUOTA),
        result: Value::Null,
    })
    .await;
}
