//! The connector transition against Node's goldens (`vectors/connector_merge.mjs`): each
//! case's data dir goes through a whole migration and must end as Node's start left it.

#![allow(
    clippy::disallowed_methods,
    reason = "the tests build and read data dirs with blocking std::fs"
)]

use std::collections::BTreeMap;
use std::path::Path;

use mixdog_store::schema::migration::MANIFEST_PATH;
use mixdog_store::schema::migration::Manifest;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::run::MigrateOptions;
use crate::run::Migrator;
use crate::run::tests::corpus;
use crate::run::tests::drivers;
use crate::run::tests::write;

fn golden() -> Value {
    serde_json::from_str(include_str!("vectors/connector_merge.json")).expect("golden")
}

/// The case's data dir after a whole migration, in the shape the generator prints.
fn migrated(case: &Value) -> (tempfile::TempDir, MigrationRoots, Manifest, Value) {
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    std::fs::create_dir_all(&roots.home).unwrap();
    let input = case["input"].as_object().unwrap();
    for (rel, text) in input {
        write(&roots.data, rel, text.as_str().unwrap().as_bytes());
    }
    let complete = Migrator::new(roots.clone(), drivers(), MigrateOptions::default()).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "{}: {complete:?}", case["name"]);
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(roots.data.join(MANIFEST_PATH)).unwrap()).unwrap();
    let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join(stores::CONFIG_FILE)).unwrap()).unwrap();
    // The files the generator prints: the case's own and every store it can write.
    let mut files = BTreeMap::new();
    for rel in durable::walk_files(&roots.data).unwrap() {
        let store = ["agents/", "bots/", "hooks", "project-connectors", "connector-"].iter().any(|p| rel.starts_with(p));
        if rel != stores::CONFIG_FILE && (input.contains_key(&rel) || store) {
            files.insert(rel.clone(), String::from_utf8(std::fs::read(roots.data.join(&rel)).unwrap()).unwrap());
        }
    }
    let out = json!({
        "mcpServers": config["agent"].get("mcpServers").cloned().unwrap_or(Value::Null),
        "extensionScopes": config["agent"].get("extensionScopes").cloned().unwrap_or(Value::Null),
        "files": files,
    });
    (dir, roots, manifest, out)
}

/// `out` with each v4 id not in the input written `<new-id-N>` in order of appearance, as the
/// generator writes Node's random ones.
fn placeholders(out: &Value, case: &Value) -> Value {
    let input = case["input"].to_string();
    let uuid = regex::Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").unwrap();
    let mut ids: Vec<String> = Vec::new();
    let out = out.to_string();
    let text = uuid.replace_all(&out, |caps: &regex::Captures<'_>| {
        let id = caps[0].to_owned();
        if input.contains(&id) {
            return id;
        }
        if !ids.contains(&id) {
            ids.push(id.clone());
        }
        format!("<new-id-{}>", ids.iter().position(|x| *x == id).unwrap() + 1)
    });
    serde_json::from_str(&text).unwrap()
}

#[test]
fn every_case_ends_as_node_leaves_it() {
    for case in golden()["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input: Value = serde_json::from_str(case["input"]["mixdog-config.json"].as_str().unwrap()).unwrap();
        let (servers, merged) = merge_servers(input["agent"].get("mcpServers"));
        let merged: Vec<Value> = merged.iter().map(|g| json!({"name": g.name, "from": g.from})).collect();
        assert_eq!(Value::from(merged.clone()), case["merged"], "{name}: merged");
        let (_dir, roots, manifest, out) = migrated(case);
        let want = json!({"mcpServers": case["mcpServers"], "extensionScopes": case["extensionScopes"], "files": case["files"]});
        assert_eq!(placeholders(&out, case), want, "{name}");
        // The servers keep Node's order.
        let order = |v: &Value| v.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>());
        assert_eq!(order(&out["mcpServers"]), order(&case["mcpServers"]), "{name}: server order");
        if !merged.is_empty() {
            assert_eq!(order(&Value::Object(servers.clone())), order(&case["mcpServers"]), "{name}: merge order");
        }
        // Nothing else of the config changes.
        let config: Value = serde_json::from_slice(&std::fs::read(roots.data.join(stores::CONFIG_FILE)).unwrap()).unwrap();
        let rest = |mut doc: Value| {
            let agent = doc["agent"].as_object_mut().unwrap();
            agent.shift_remove("mcpServers");
            agent.shift_remove("extensionScopes");
            doc
        };
        assert_eq!(rest(config), rest(input.clone()), "{name}: the rest of the config");
        // A case Node leaves as it is plans nothing.
        let unchanged = case["input"].as_object().unwrap().iter().all(|(rel, text)| case["files"].get(rel).is_none_or(|t| t == text))
            && case["mcpServers"] == input["agent"]["mcpServers"]
            && case["files"].as_object().unwrap().keys().all(|rel| case["input"].get(rel).is_some());
        assert_eq!(manifest.items.iter().any(|i| i.key.as_str() == ITEM), !unchanged, "{name}: item planned");
        if unchanged {
            let bytes = std::fs::read(roots.data.join(stores::CONFIG_FILE)).unwrap();
            assert_eq!(bytes, case["input"]["mixdog-config.json"].as_str().unwrap().as_bytes(), "{name}: config bytes");
        }
    }
}

#[test]
fn numbered_servers_sort_naturally() {
    let mut names = vec!["gmail-10", "gmail-2", "gmail", "gmail-1"];
    names.sort_by(|a, b| natural_order(a, b));
    assert_eq!(names, ["gmail", "gmail-1", "gmail-2", "gmail-10"]);
}

#[test]
fn ids_are_v4_and_stable() {
    let id = account_id("seed", "gmail", 1);
    assert_eq!(id, account_id("seed", "gmail", 1));
    assert_ne!(id, account_id("seed", "gmail", 2));
    assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
}

/// A file 1.4.5 fails on stays as it is, and the others still move.
#[test]
fn unreadable_stores_are_left_as_they_are() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    write(data, "mixdog-config.json", br#"{"agent":{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp","connector":"linear"},"linear-2":{"url":"https://mcp.linear.app/mcp","oauthKey":"2","connector":"linear"}}}}"#);
    write(data, "agents/bad/agent.json", b"{not json");
    write(data, "agents/odd/agent.json", br#"{"connectors":{"allow":["linear-2"]}}"#);
    write(data, "agents/ok/agent.json", br#"{"connectors":{"off":["linear-2"]}}"#);
    write(data, "hooks.json", b"[");
    let conversion = convert(data, &|_| true).unwrap();
    let rels: Vec<&str> = conversion.outputs.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(rels, ["agents/ok/agent.json.bak", "agents/ok/agent.json", "mixdog-config.json"]);
    // A quarantined store is not written.
    let conversion = convert(data, &|rel| !rel.starts_with("agents/")).unwrap();
    let rels: Vec<&str> = conversion.outputs.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(rels, ["mixdog-config.json"]);
}

/// The v145 profile is already converted: nothing to do.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn v145_needs_no_connector_transition() {
    let data = corpus().join("v145");
    assert!(!Path::new(&data.join(PENDING_FILE)).exists());
    assert!(convert(&data, &|_| true).unwrap().outputs.is_empty());
}
