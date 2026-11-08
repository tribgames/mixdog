//! The declaration errors for a damaged `.mcp.json` replayed against what today's Node put in them
//! (`fixtures/plugins-status/json-errors.json`, recorded by `record-json-errors.mjs`): one row per kind
//! of damage (unexpected token, end, string and number, bad escape, trailing comma, bad number, a
//! byte-order mark, invalid UTF-8, a folder in place of the file, and texts that read like V8's own
//! location phrases). The message reaches users and the agent, so it must be Node's, character for character.

use std::path::Path;

use mixdog_mcp::plugins;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_statefile::Opts;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const GOLDEN: &str = include_str!("../../../../fixtures/plugins-status/json-errors.json");

fn bytes_of(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect()
}

async fn on_lane<T: Send + 'static>(work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> T {
    mixdog_rt::testing::tokens().maintenance_io.submit(&CancellationToken::new(), work).unwrap().await.unwrap()
}

async fn declaration_errors(root: &Path, bytes: Vec<u8>, directory: bool) -> Vec<String> {
    let root = root.to_path_buf();
    on_lane(move |lane| {
        mixdog_statefile::create_dir_all(lane, &root).unwrap();
        let file = root.join(".mcp.json");
        if directory {
            mixdog_statefile::create_dir_all(lane, &file).unwrap();
        } else {
            mixdog_statefile::write_file(lane, &file, &bytes, &Opts::default()).unwrap();
        }
        plugins::load_declarations(lane, &root).errors.into_iter().map(|error| error.message).collect()
    })
    .await
}

#[tokio::test]
async fn every_kind_of_damage_reads_as_node_words_it() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let rows = golden["rows"].as_array().unwrap();
    assert!(rows.len() > 100);
    let scratch = tempfile::tempdir().unwrap();
    for (index, row) in rows.iter().enumerate() {
        let root = scratch.path().join(index.to_string());
        let got = declaration_errors(&root, bytes_of(row["hex"].as_str().unwrap()), row["directory"] == true).await;
        assert_eq!(serde_json::json!(got), row["errors"], "{}", row["name"]);
    }
}
