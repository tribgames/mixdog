//! Node's config snapshot cases (`fixtures/config-snapshot-cases`, `record-config-snapshot-cases.mjs`): each recorded
//! step against the daemon's own pieces (the config, its file watch, the production provider builder and the provider
//! sync that rebuilds the runtime's loaded config), and after each step the whole loaded config (`LoadedConfig`, the
//! runtime's `getConfig()`) against the config Node's read returned. Named cases are left out.

use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_config::config::ConfigWatcher;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::model_list_node_tests::rig;
use super::provider_sync::spawn_provider_sync;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/config-snapshot-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The loaded config as its change from the base read over an empty data dir, through the production
/// `create_config_patch`, as Node's recording took it with its own from its own base.
fn stored(base: &serde_json::Map<String, Value>, loaded: &serde_json::Map<String, Value>) -> Value {
    use mixdog_core_config::config::patch::ChangeOp;
    let changes = mixdog_core_config::config::patch::create_config_patch(base, loaded);
    Value::Array(
        changes
            .into_iter()
            .map(|change| match change.op {
                ChangeOp::Set(value) => json!({ "path": change.path, "value": value }),
                ChangeOp::Remove => json!({ "path": change.path, "remove": true }),
            })
            .collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_replayed_config_snapshot_read_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let mut replayed = 0;
    for case in golden["cases"].as_array().unwrap().iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let name = case["case"].as_str().unwrap();
        let rig = rig(&json!({ "agent": {} }), &json!({ "modelsDev": {}, "litellm": {} }), false).await;
        let path = rig._dir.path().join("mixdog-config.json");
        let _watch = ConfigWatcher::start(rig.config.clone()).unwrap();
        let stop = CancellationToken::new();
        let _sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
        // The core's own base: its loaded config over the case's empty data dir, as Node's base is its read there.
        let base = (*rig.loaded.get()).clone();
        let base = &base;
        let mut in_place: Option<std::fs::File> = None;
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let text = step["text"].as_str().unwrap_or_default();
            match step["op"].as_str().unwrap() {
                // Another process's write: a whole new file renamed into place.
                "writeConfig" => {
                    let tmp = path.with_extension("json.foreign-tmp");
                    std::fs::write(&tmp, text).unwrap();
                    std::fs::rename(&tmp, &path).unwrap();
                }
                // Another process writing the file in place, caught halfway, then completing it.
                "writeConfigInPlace" => {
                    let mut file = std::fs::File::create(&path).unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                    file.sync_all().unwrap();
                    in_place = Some(file);
                    // Node's own wait for the first bytes' events and notification pass.
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                }
                "appendConfig" => {
                    let mut file = in_place.take().unwrap();
                    file.write_all(text.as_bytes()).unwrap();
                }
                "observe" => {
                    // Node waited until its snapshot took the step in; this waits as long for the loaded config.
                    let want = &step["stored"];
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
                    while stored(base, &rig.loaded.get()) != *want && tokio::time::Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    let got = stored(base, &rig.loaded.get());
                    assert!(got == *want, "{name}, step {index}\n got: {got}\nwant: {want}");
                }
                other => panic!("{name}: step {other} has no replay"),
            }
        }
        stop.cancel();
        replayed += 1;
    }
    assert_eq!(replayed + excluded.len(), golden["cases"].as_array().unwrap().len() + 5, "every case is replayed or named");
}
