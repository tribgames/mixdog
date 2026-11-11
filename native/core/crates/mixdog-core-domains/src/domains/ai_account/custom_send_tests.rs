//! The connection test as a real send, against what Node does on the same scripted endpoint
//! (`benchmarks/rust-core/recorders/record-custom-send.mjs`): the exact error text a refused
//! key pool surfaces, which key sent each chat request, and how a 503 is retried.

use std::collections::HashMap;

use serde_json::Value;
use serde_json::json;

use super::collaborators::CustomProviders;
use super::custom_admin_tests::endpoint;
use super::custom_admin_tests::world;

const GOLDEN: &str = include_str!("../../../../../fixtures/custom-send/golden.json");

#[tokio::test]
async fn every_scenario_ends_as_it_does_in_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let strings = |key: &str| -> Vec<String> { case[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect() };
        let (keys, refused) = (strings("keys"), strings("refused"));
        let (base, seen) = endpoint(refused, case["flaky"].as_u64().unwrap() as usize).await;
        let w = world(HashMap::from([("CS_ENV".to_owned(), "sk-env".to_owned())])).await;
        let extra: Vec<Value> = keys[1..].iter().map(|k| json!({ "apiKey": k })).collect();
        let mut input = json!({ "name": name, "protocol": "openai-chat", "baseURL": base, "apiKey": keys[0] });
        if !extra.is_empty() {
            input["extraApiKeys"] = json!(extra);
        }
        let saved = w.admin.save(input, 0).await.unwrap();
        let mut probe = json!({ "id": saved["id"], "schemaVersion": 2, "name": name, "protocol": "openai-chat", "baseURL": base });
        // The test's own unsaved settings (keyless, environment key) decide who sends.
        for (key, value) in case["probe"].as_object().into_iter().flatten() {
            probe[key] = value.clone();
        }
        let answer = w.admin.test(probe, 0).await;
        match (answer, case["error"].as_str()) {
            (Ok(result), None) => {
                let shown = result.to_string().replace(saved["extraApiKeys"][0]["id"].as_str().unwrap_or("\0"), "<key1>");
                assert_eq!(serde_json::from_str::<Value>(&shown).unwrap(), case["result"], "{name}");
            }
            (Err(failure), Some(error)) => assert_eq!(failure.message(), error, "{name}"),
            (other, expected) => panic!("{name}: got {other:?}, Node {expected:?}"),
        }
        let seen = seen.lock().unwrap();
        let chats: Vec<String> =
            seen.iter().filter(|s| s.path == "/chat/completions").map(|s| s.authorization.replace("Bearer ", "")).collect();
        assert_eq!(json!(chats), case["chats"], "{name}: chat requests, in order, by key");
        assert_eq!(seen.iter().filter(|s| s.path == "/models").count() as u64, case["discoveries"].as_u64().unwrap(), "{name}");
    }
}
