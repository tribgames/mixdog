//! The connector permission lookups replayed against what today's Node product answered
//! (`tests/golden/permissions.mjs` → `permissions.json`): for every recorded layout of policy
//! files, the permission each agent has for each tool, and whether each project path set has
//! the tool's connector switched off.
#![allow(clippy::disallowed_methods, reason = "test fixtures write policy files directly")]

use std::path::PathBuf;

use mixdog_mcp::McpServerConfig;
use mixdog_mcp::permissions::ConnectorPolicy;
use mixdog_mcp::permissions::PolicyIo;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/golden/permissions.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_connector_permissions_match_node_in_every_recorded_layout() {
    let tokens = mixdog_rt::testing::tokens();
    let golden = golden();
    let tools = strings(&golden["tools"]);
    let configs: Vec<McpServerConfig> = golden["servers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, connector)| {
            let mut entry = json!({"command": "unused"});
            if let Some(connector) = connector.as_str() {
                entry["connector"] = json!(connector);
            }
            McpServerConfig::from_entry(name, &entry, &Default::default()).unwrap()
        })
        .collect();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let label = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().replace('\\', "/");
        for sub in scenario["dirs"].as_array().unwrap() {
            std::fs::create_dir_all(dir.path().join(sub.as_str().unwrap())).unwrap();
        }
        for (file, text) in scenario["files"].as_object().unwrap() {
            let target = dir.path().join(file);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, text.as_str().unwrap().replace("$DIR", &root)).unwrap();
        }
        let policy = ConnectorPolicy::new(
            dir.path().to_path_buf(),
            PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
        );
        policy.set_servers(&configs);
        policy.reload().await;
        for entry in scenario["agents"].as_array().unwrap() {
            let agent = entry["agent"].as_str().unwrap();
            for (tool, expected) in tools.iter().zip(entry["perms"].as_array().unwrap()) {
                assert_eq!(
                    policy.permission(agent, tool).name(),
                    expected.as_str().unwrap(),
                    "{label}: agent {agent:?} tool {tool:?}"
                );
            }
        }
        for entry in scenario["projects"].as_array().unwrap() {
            let paths: Vec<PathBuf> = strings(&entry["paths"]).iter().map(|p| PathBuf::from(p.replace("$DIR", &root))).collect();
            for (tool, expected) in tools.iter().zip(entry["disabled"].as_array().unwrap()) {
                assert_eq!(
                    policy.project_disabled(&paths, tool),
                    expected.as_bool().unwrap(),
                    "{label}: project paths {:?} tool {tool:?}",
                    entry["paths"]
                );
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_policy_is_kept_aside_and_its_good_copy_restored_but_without_one_it_stays() {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let good = r#"{"connectors":{"off":["gmail"]}}"#;
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agents").join("worker");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("agent.json"), r#"{"connectors":"#).unwrap();
    std::fs::write(agent.join("agent.json.bak"), good).unwrap();
    let policy = ConnectorPolicy::new(dir.path().to_path_buf(), io);
    policy.reload().await;
    assert_eq!(policy.permission("worker", "mcp__gmail__read").name(), "disabled");
    assert_eq!(std::fs::read_to_string(agent.join("agent.json")).unwrap(), good);
    let aside: Vec<_> = std::fs::read_dir(&agent).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), r#"{"connectors":"#);

    let lone = tempfile::tempdir().unwrap();
    let agent = lone.path().join("agents").join("worker");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("agent.json"), "{").unwrap();
    let policy = ConnectorPolicy::new(lone.path().to_path_buf(), io);
    policy.reload().await;
    assert_eq!(policy.permission("worker", "mcp__gmail__read").name(), "disabled");
    assert_eq!(std::fs::read_to_string(agent.join("agent.json")).unwrap(), "{", "kept in place: moving it would read as no policy");
}
