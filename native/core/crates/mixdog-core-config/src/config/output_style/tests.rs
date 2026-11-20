//! The configured output style: an unknown style names the choices.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;

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


