//! The effective MCP server catalog and the adoption edits replayed against what today's Node
//! product computed (`tests/golden/catalog.mjs` → `catalog.json`). Paths in the golden are
//! tokens (`<R:id>` a plugin's root, `<D>` the data dir, `<C>` the session cwd); the replay builds
//! the same plugin trees under a fresh directory and compares the results key order included.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test setup: builds the plugin trees on the test thread")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_mcp::plugin_servers::declarations_of;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_mcp::plugin_servers::with_adopted_copies;
use mixdog_mcp::plugin_servers::with_pinned_collision_names;
use mixdog_mcp::plugin_servers::with_plugin_server_intent;
use mixdog_mcp::plugin_servers::without_plugin_intents;
use mixdog_mcp::plugins::load_declarations;
use mixdog_rt::LaneToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn fill(value: &Value, roots: &[(String, String)], cwd: &str) -> Value {
    match value {
        Value::String(text) => {
            let mut out = text.replace("@C@", cwd);
            for (id, root) in roots {
                out = out.replace(&format!("@R:{id}@"), root);
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, roots, cwd)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, roots, cwd))).collect()),
        other => other.clone(),
    }
}

/// The tokens Node recorded in place of real paths.
fn stable(value: &Value, roots: &[(String, String)], data: &str, cwd: &str) -> Value {
    let escape = |path: &str| serde_json::to_string(path).unwrap().trim_matches('"').to_owned();
    let mut text = value.to_string();
    for (id, root) in roots {
        text = text.replace(&escape(root), &format!("<R:{id}>")).replace(&escape(&root.replace('\\', "/")), &format!("<Rs:{id}>"));
    }
    for (token, path) in [("<D>", data), ("<C>", cwd)] {
        text = text.replace(&escape(path), token).replace(&escape(&path.replace('\\', "/")), &token.replace('>', "s>"));
    }
    serde_json::from_str(&text).unwrap()
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_catalog_and_the_adoption_edits_match_node_in_every_recorded_case() {
    let tokens = mixdog_rt::testing::tokens();
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("tests/golden/catalog.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    let base = tempfile::tempdir().unwrap();
    let cwd_path = base.path().join("session-cwd").to_string_lossy().into_owned();
    let data_dir = base.path().join("data").to_string_lossy().into_owned();
    for (index, case) in cases.iter().enumerate() {
        let label = case["name"].as_str().unwrap().to_owned();
        let dir = base.path().join(format!("case{index}"));
        let mut roots: Vec<(String, String)> = Vec::new();
        let mut rows = Vec::new();
        for plugin in case["plugins"].as_array().unwrap() {
            let id = plugin["id"].as_str().unwrap();
            let root: PathBuf = dir.join(if id.is_empty() { "blank" } else { id });
            roots.push((id.to_owned(), root.to_string_lossy().into_owned()));
            if plugin["exists"] != json!(false) {
                std::fs::create_dir_all(&root).unwrap();
                for (rel, text) in plugin["files"].as_object().unwrap() {
                    write(&root.join(rel), text.as_str().unwrap());
                }
            }
            let mut row = Map::new();
            row.insert("id".into(), json!(id));
            row.insert("name".into(), plugin["name"].clone());
            row.insert("root".into(), json!(if plugin["noRoot"] == json!(true) { String::new() } else { root.to_string_lossy().into_owned() }));
            for key in ["enabled", "exists"] {
                if !plugin[key].is_null() {
                    row.insert(key.into(), plugin[key].clone());
                }
            }
            rows.push(Value::Object(row));
        }
        let config = fill(&case["config"], &roots, &cwd_path);
        let cwd = fill(&case["cwd"], &roots, &cwd_path).as_str().unwrap().to_owned();
        let ids: Vec<String> = roots.iter().map(|(id, _)| id.clone()).filter(|id| !id.is_empty()).collect();
        let (config_job, data_job) = (config.clone(), data_dir.clone());
        let got = tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                let declared = declarations_of(&rows, &|root| load_declarations(lane, root));
                let catalog = resolve_mcp_server_catalog(&config_job, &declared, &cwd, &data_job);
                let adopted = with_adopted_copies(&config_job, catalog.adoption.as_ref());
                let pinned = with_pinned_collision_names(&adopted, &catalog);
                let first = ids.first().cloned();
                let without = first.as_deref().map(|id| without_plugin_intents(&config_job, id));
                let with_intent = first.as_deref().map(|id| {
                    with_plugin_server_intent(&config_job, id, "k", |mut intent| {
                        intent.insert("enabled".into(), json!(false));
                        intent.insert("alias".into(), json!("al"));
                        intent
                    })
                });
                let cleared = first.as_deref().map(|id| with_plugin_server_intent(&config_job, id, "search", |_| Map::new()));
                json!({
                    "catalog": catalog.to_value(), "adopted": adopted, "pinned": pinned,
                    "withoutFirst": without, "withIntent": with_intent, "withIntentCleared": cleared,
                })
            })
            .unwrap()
            .await
            .unwrap();
        for name in ["catalog", "adopted", "pinned", "withoutFirst", "withIntent", "withIntentCleared"] {
            let ours = stable(&got[name], &roots, &data_dir, &cwd_path);
            if ours.to_string() != case[name].to_string() {
                // The difference is easier to read pretty-printed and side by side.
                let dump = std::env::temp_dir();
                std::fs::write(dump.join("catalog-ours.json"), serde_json::to_string_pretty(&ours).unwrap()).unwrap();
                std::fs::write(dump.join("catalog-node.json"), serde_json::to_string_pretty(&case[name]).unwrap()).unwrap();
                panic!("{label}: {name} differs (written to {})", dump.display());
            }
        }
    }
}
