//! The catalog, the configured style and the selection equal the recorded Node answers
//! (`record-output-styles.mjs`, 40 style directories).

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;
use crate::config::patch::js_deep_equal;

async fn open(dir: &Path, entry: &Value) -> OutputStyles {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    for (side, base) in [("builtin", dir.join("root")), ("user", dir.join("data"))] {
        let styles = base.join("output-styles");
        std::fs::create_dir_all(&styles).unwrap();
        for (name, text) in entry["world"][side].as_object().unwrap() {
            std::fs::write(styles.join(name), text.as_str().unwrap()).unwrap();
        }
    }
    // Files that are no styles: a non-`.md` file and a directory called `x.md`.
    std::fs::write(dir.join("data/output-styles/notes.txt"), "not a style").unwrap();
    std::fs::create_dir_all(dir.join("data/output-styles/dir.md")).unwrap();
    let path = dir.join("data/mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&entry["config"]).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    OutputStyles::new(config, dir.join("root/output-styles"), dir.join("data"))
}

/// Recorded entries per test: each builds its own style directories.
const ENTRY_CHUNK: usize = 4;

fn styles_twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/output-styles-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

mixdog_rt::replay_chunks!(STYLE_TESTS, #[tokio::test] async the_styles_chunk; [
    the_status_and_the_selection_match_the_recorded_node_answers_00 = 0,
    the_status_and_the_selection_match_the_recorded_node_answers_01 = 1,
    the_status_and_the_selection_match_the_recorded_node_answers_02 = 2,
    the_status_and_the_selection_match_the_recorded_node_answers_03 = 3,
    the_status_and_the_selection_match_the_recorded_node_answers_04 = 4,
    the_status_and_the_selection_match_the_recorded_node_answers_05 = 5,
    the_status_and_the_selection_match_the_recorded_node_answers_06 = 6,
    the_status_and_the_selection_match_the_recorded_node_answers_07 = 7,
    the_status_and_the_selection_match_the_recorded_node_answers_08 = 8,
    the_status_and_the_selection_match_the_recorded_node_answers_09 = 9,
]);

#[test]
fn every_recorded_entry_has_its_styles_test() {
    let twin = styles_twin();
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 40);
    mixdog_rt::testing::assert_chunks_registered(STYLE_TESTS, entries.len(), ENTRY_CHUNK);
}

async fn the_styles_chunk(chunk: usize) {
    let twin = styles_twin();
    let entries = twin["entries"].as_array().unwrap();
    let range = mixdog_rt::testing::chunk_range(entries.len(), chunk, ENTRY_CHUNK);
    for (i, entry) in entries.iter().enumerate().skip(range.start).take(range.len()) {
        let dir = tempfile::tempdir().unwrap();
        let styles = open(dir.path(), entry).await;
        let status = styles.status().await.unwrap();
        assert!(js_deep_equal(&status, &entry["status"]), "status of {i}: {status}\nexpected {}", entry["status"]);
        for query in entry["queries"].as_array().unwrap() {
            let value = query["value"].as_str().unwrap();
            let answer = styles.set(value).await;
            match query["selected"].as_str() {
                None => assert!(answer.is_err(), "{value:?} of {i} selects nothing"),
                Some(id) => {
                    assert_eq!(answer.unwrap()["configured"], id, "{value:?} of {i}");
                    let stored = &query["stored"];
                    assert_eq!(styles.config.get("outputStyle"), stored.get("outputStyle").cloned(), "{value:?} of {i}");
                    assert_eq!(styles.config.get("agent"), stored.get("agent").cloned(), "{value:?} of {i}");
                    // Back to the recorded start for the next query.
                    let start = entry["config"].clone();
                    styles.config.update(move |doc| { *doc = start.as_object().cloned().unwrap_or_default(); Ok(()) }).await.unwrap();
                }
            }
        }
    }
}

#[tokio::test]
async fn an_unknown_style_names_the_choices_like_node() {
    let dir = tempfile::tempdir().unwrap();
    let entry = serde_json::json!({ "world": { "builtin": { "simple.md": "---\ntitle: Simple\n---\n", "detailed.md": "x" }, "user": {} }, "config": {} });
    let styles = open(dir.path(), &entry).await;
    match styles.set("nope").await {
        Err(ToolModulesError::InvalidArgument(message)) => assert_eq!(message, "output style must be one of Detailed, Simple"),
        other => panic!("{other:?}"),
    }
}
