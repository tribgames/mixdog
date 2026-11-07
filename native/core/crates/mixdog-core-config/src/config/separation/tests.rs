//! The boot pass and the canonical storage of the agent section against Node's recording (`fixtures/defaults-separation/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-defaults-separation.mjs`): the file the pass leaves, the
//! copy it backs up, the roster of switched-off agents the config holds afterwards, and the marker a
//! first write into an empty config stamps.

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;

use super::*;
use crate::config::AgentRoutes;
use crate::config::ConfigLanes;

const NOW_MS: i64 = 1_800_000_000_123;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/defaults-separation/twin.json")).expect("twin.json")
}

async fn open(dir: &Path) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.expect("opens");
    config
}

fn same(got: &Doc, want: &Value) -> bool {
    js_deep_equal(&Value::Object(got.clone()), want)
}

#[tokio::test]
async fn the_boot_pass_leaves_the_file_node_left() {
    let twin = twin();
    let cases = twin["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 12);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("dir");
        for (rel, text) in case["files"].as_object().expect("files") {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            std::fs::write(path, text.as_str().expect("text")).expect("file");
        }
        let input = case["inputText"].as_str().expect("input");
        std::fs::write(dir.path().join("mixdog-config.json"), input).expect("config");
        let config = open(dir.path()).await;
        config.separate_defaults(NOW_MS).await.expect(name);

        // What the file holds afterwards (the pass, then the canonical agent section), in memory and on disk.
        assert!(same(&config.full(), &case["final"]), "{name}: {:?}", config.full());
        let stored: Value = serde_json::from_slice(&std::fs::read(dir.path().join("mixdog-config.json")).expect("file")).expect("json");
        assert!(js_deep_equal(&stored, &case["final"]), "{name}: on disk {stored}");

        // The copy taken before the rewrite: the file as it was, in a folder named for the moment.
        let backups: Vec<_> = match std::fs::read_dir(dir.path().join("backups")) {
            Ok(entries) => entries.map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        };
        let wanted = case["backups"].as_array().expect("backups");
        assert_eq!(backups.len(), wanted.len(), "{name}: backups {backups:?}");
        for (made, node) in backups.iter().zip(wanted) {
            assert!(made.starts_with("defaults-separation-") && made.ends_with('Z') && made.len() == "defaults-separation-".len() + 24, "{name}: {made}");
            assert!(node["name"].as_str().expect("name").starts_with("defaults-separation-<iso>"), "{name}: Node's folder {node}");
            let text = std::fs::read_to_string(dir.path().join("backups").join(made).join("mixdog-config.json")).expect("backup");
            assert_eq!(Some(text.as_str()), node["text"].as_str(), "{name}: the backup is the file as it was");
        }

        // The roster of switched-off agents the loaded config holds.
        let routes = AgentRoutes::new(config, dir.path());
        let off: Vec<&str> = case["disabledAgents"].as_array().expect("roster").iter().map(|id| id.as_str().expect("id")).collect();
        for id in ["worker", "heavy-worker", "reviewer", "advisor", "security", "front-worker", "writer", "maintainer", "explore", "custom", "mine"] {
            assert_eq!(routes.is_disabled(id), off.contains(&id), "{name}: {id}");
        }
    }
}

/// The pass alone (what Node's `ensureDefaultsSeparated` published, before the agent section was made canonical).
#[test]
fn the_pass_alone_writes_what_node_published() {
    for case in twin()["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("dir");
        for (rel, text) in case["files"].as_object().expect("files") {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            std::fs::write(path, text.as_str().expect("text")).expect("file");
        }
        let input = case["input"].as_object().expect("input");
        if !needs_separation(input) {
            assert!(js_deep_equal(&Value::Object(input.clone()), &case["output"]), "{name}");
            continue;
        }
        let mut separated = separate_defaults_in_config(input, dir.path());
        separated.insert(DEFAULTS_VERSION_KEY.into(), Value::from(2));
        let written = super::super::canonical::canonicalize(separated);
        assert!(same(&written, &case["output"]), "{name}: {written:?}");
    }
}

/// A file created by this code is born separated (`withFreshDefaultsVersion`): the first write into
/// an empty config stamps the marker, whatever it writes.
#[tokio::test]
async fn the_first_write_into_an_empty_config_stamps_the_marker() {
    let twin = twin();
    let dir = tempfile::tempdir().expect("dir");
    let config = open(dir.path()).await;
    config
        .update_agent(|agent| {
            agent.insert("recap".into(), serde_json::json!({ "enabled": false }));
            Ok(())
        })
        .await
        .expect("write");
    assert!(same(&config.full(), &twin["born"]["written"]), "{:?}", config.full());
    let empty = tempfile::tempdir().expect("dir");
    let config = open(empty.path()).await;
    config.update(|_| Ok(())).await.expect("write");
    assert!(same(&config.full(), &twin["born"]["empty"]), "{:?}", config.full());
}
