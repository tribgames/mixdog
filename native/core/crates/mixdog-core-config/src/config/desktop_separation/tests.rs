//! The `desktop` section's one-time separation against Node's recording (`fixtures/desktop-separation/twin.json`,
//! recorded by `benchmarks/rust-core/recorders/record-desktop-separation.mjs` from the real `DesktopSettingsStore`
//! after the real boot pass): the file after each step in bytes, the backup folders and their bytes, and what
//! `separateDefaults` answered the first and the second time.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

use super::super::separation::tests::lane;
use super::super::separation::tests::open;
use super::super::separation::tests::put;

const NOW_MS: i64 = 1_800_000_000_123;
/// The desktop asks later than the daemon, so the two backup folders never share a name (the recorder does the same).
const DESKTOP_MS: i64 = NOW_MS + 60_000;
const LATER_MS: i64 = NOW_MS + 120_000;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/desktop-separation/twin.json")).expect("twin.json")
}

/// The file at `path` as text; `None` when there is none.
async fn read(path: PathBuf) -> Option<String> {
    let bytes = lane(move |_| mixdog_statefile::read_content(&path).expect("read")).await;
    bytes.map(|bytes| String::from_utf8(bytes).expect("utf8"))
}

/// The backup folders under `dir`, by name: (name, the copy's text).
async fn backups(dir: &Path) -> Vec<(String, String)> {
    let folder = dir.join("backups");
    let mut names: Vec<String> = lane(move |lane| mixdog_statefile::list_dir(lane, &folder).unwrap_or_default()).await;
    names.sort();
    let mut made = Vec::new();
    for name in names {
        let text = read(dir.join("backups").join(&name).join("mixdog-config.json")).await.expect("a copy in every folder");
        made.push((name, text));
    }
    made
}

#[tokio::test]
async fn the_desktop_pass_leaves_the_file_and_the_copies_node_left() {
    let twin = twin();
    let cases = twin["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 41);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("mixdog-config.json");
        if let Some(input) = case["inputText"].as_str() {
            put(file.clone(), input.to_owned()).await;
        }
        let config = open(dir.path()).await;

        // The daemon's boot pass first, as in Node.
        config.separate_defaults(NOW_MS).await.expect(name);
        assert_eq!(read(file.clone()).await.as_deref(), case["afterCore"].as_str(), "{name}: the file after the boot pass");
        let core = backups(dir.path()).await;

        let ran = config.separate_desktop_defaults(DESKTOP_MS).await.expect(name);
        assert_eq!(Some(ran), case["ran"][0].as_bool(), "{name}: whether the first run ran");
        assert_eq!(read(file.clone()).await.as_deref(), case["final"].as_str(), "{name}: the file after the desktop pass");
        let made = backups(dir.path()).await;
        let wanted = case["backups"].as_array().expect("backups");
        assert_eq!(made.len(), wanted.len(), "{name}: backups {made:?}");
        for ((folder, text), node) in made.iter().zip(wanted) {
            assert!(folder.starts_with("defaults-separation-") && folder.ends_with('Z') && folder.len() == "defaults-separation-".len() + 24, "{name}: {folder}");
            assert!(node["name"].as_str().expect("name").starts_with("defaults-separation-<iso>"), "{name}: Node's folder {node}");
            let from_boot = core.iter().any(|(boot, _)| boot == folder);
            assert_eq!(from_boot, node["source"] == "core", "{name}: which pass made {folder}");
            assert_eq!(Some(text.as_str()), node["text"].as_str(), "{name}: the copy in {folder}");
        }

        // Once: the marker is the gate; the file and the folders stay as they are.
        let again = config.separate_desktop_defaults(LATER_MS).await.expect(name);
        assert_eq!(Some(again), case["ran"][1].as_bool(), "{name}: whether the second run ran");
        assert_eq!(read(file).await.as_deref(), case["finalAfterSecond"].as_str(), "{name}: the file after the second run");
        assert_eq!(backups(dir.path()).await.len() as u64, case["backupsAfterSecond"].as_u64().expect("count"), "{name}: backups after the second run");
    }
}

/// The in-memory document follows the file the pass wrote.
#[tokio::test]
async fn the_loaded_document_follows_the_pass() {
    let dir = tempfile::tempdir().expect("dir");
    put(
        dir.path().join("mixdog-config.json"),
        r#"{"defaultsVersion":2,"desktop":{"keepAwake":true,"runInBackground":false,"zoomFactor":1}}"#.to_owned(),
    )
    .await;
    let config = open(dir.path()).await;
    assert!(config.separate_desktop_defaults(NOW_MS).await.expect("pass"));
    assert_eq!(
        Value::Object((*config.full()).clone()),
        serde_json::json!({ "defaultsVersion": 2, "desktop": { "runInBackground": false, "defaultsSeparationVersion": 1 } })
    );
}
