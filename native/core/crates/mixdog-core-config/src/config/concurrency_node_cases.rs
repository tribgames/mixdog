//! Node's config-concurrency case (`fixtures/config-concurrency-cases`, `record-config-concurrency-cases.mjs`): from
//! Node's seeded file, each step of the test through the core (setProfile through each runtime's own `Settings` over
//! the one `Config`, peer writes through `Config::update`, direct saves through `Config::save_agent_config` with Node's
//! two configs), each from the file Node left before it, and the whole file after it against Node's; the alias patch
//! through `create_config_patch`.
#![allow(clippy::disallowed_methods, reason = "fixture files")]

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::Config;
use super::ConfigLanes;
use super::NoEffects;
use super::Settings;
use super::SettingsEnv;
use super::patch::ChangeOp;
use super::patch::create_config_patch;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/config-concurrency-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn doc(value: &Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn every_recorded_settings_write_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let case = &golden["cases"][0];
    let steps = case["steps"].as_array().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, steps[0]["file"].to_string()).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let runtime = || {
        let env: SettingsEnv = Arc::new(|_| None);
        Settings::new(config.clone(), Arc::new(NoEffects), env)
    };
    let mut failures = Vec::new();
    for (previous, step) in steps.iter().zip(&steps[1..]) {
        let name = step["step"].as_str().unwrap();
        if excluded.contains_key(name) {
            continue;
        }
        // Each step starts from the file Node left before it, so one step's difference does not carry into the next.
        std::fs::write(&path, previous["file"].to_string()).unwrap();
        config.reload().await.unwrap();
        match name {
            "a setProfile" | "b setProfile" | "c setProfile" => {
                runtime().set_profile(&step["profile"]).await.unwrap();
            }
            "d and e setProfile together" => {
                let (d, e) = (runtime(), runtime());
                let (left, right) = tokio::join!(d.set_profile(&step["runtimes"]["d"]), e.set_profile(&step["runtimes"]["e"]));
                left.unwrap();
                right.unwrap();
            }
            "peer compaction and autoClear off" => {
                config
                    .update_agent(|agent| {
                        for (section, key) in [("compaction", "auto"), ("autoClear", "enabled")] {
                            let entry = agent.entry(section).or_insert_with(|| json!({}));
                            entry[key] = json!(false);
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            "peer skills disabled" => {
                let disabled = step["disabled"].clone();
                config
                    .update_agent(move |agent| {
                        agent.entry("skills").or_insert_with(|| json!({}))["disabled"] = disabled;
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            "peer shell extra" => {
                config
                    .update_agent(|agent| {
                        agent.entry("shell").or_insert_with(|| json!({}))["extra"] = json!("peer");
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            "peer language ko" => {
                config
                    .update_agent(|agent| {
                        agent.entry("profile").or_insert_with(|| json!({}))["language"] = json!("ko");
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            _ if step.get("before").is_some() => {
                config.save_agent_config(&doc(&step["before"]), &doc(&step["after"]), false).await.unwrap();
            }
            other => panic!("step {other} has no replay and no exclusion"),
        }
        let got: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        if got != step["file"] {
            failures.push(format!("{name}:\n  want {}\n  got  {got}", step["file"]));
        }
    }
    let patch = &case["patch"];
    if excluded.contains_key("alias patch") {
        assert!(failures.is_empty(), "{} step(s) differ:\n{}", failures.len(), failures.join("\n"));
        return;
    }
    let changes: Vec<Value> = create_config_patch(&doc(&patch["before"]), &doc(&patch["after"]))
        .into_iter()
        .map(|change| match change.op {
            ChangeOp::Set(value) => json!({ "path": change.path, "value": value }),
            ChangeOp::Remove => json!({ "path": change.path, "remove": true }),
        })
        .collect();
    if json!(changes) != patch["changes"] {
        failures.push(format!("alias patch:\n  want {}\n  got  {}", patch["changes"], json!(changes)));
    }
    assert!(failures.is_empty(), "{} step(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(steps.len(), 13, "every recorded step of the test's one case");
}
