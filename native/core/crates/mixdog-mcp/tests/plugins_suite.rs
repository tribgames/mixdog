//! The plugin registry edits replayed against what today's Node product answered and left on disk
//! (`tests/golden/plugins.mjs` → `plugins.json`), local sources only. The golden carries Windows
//! paths (the plugin ids hash them), so the replay runs only there.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures lay out plugin folders and read the registry back")]

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_rt::LaneToken;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used for local sources".to_owned())
    }
}

fn mask(base: &str, text: &str) -> String {
    let escaped = serde_json::to_string(base).unwrap();
    let text = text.replace(&escaped[1..escaped.len() - 1], "<BASE>");
    let text = regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap().replace_all(&text, "<TS>").into_owned();
    let text = regex::Regex::new(r"\.corrupt-\d+").unwrap().replace_all(&text, ".corrupt-<N>").into_owned();
    regex::Regex::new(r"mixdog-tmp-[0-9a-f]+").unwrap().replace_all(&text, "mixdog-tmp-<H>").into_owned()
}

fn masked(base: &str, value: &Value) -> Value {
    serde_json::from_str(&mask(base, &value.to_string())).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn every_registry_edit_answers_and_leaves_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/plugins.json")).unwrap();
    let base = golden["base"].as_str().unwrap().to_owned();
    let _ = std::fs::remove_dir_all(&base);
    for (name, files) in golden["fixtures"].as_object().unwrap() {
        let root = std::path::Path::new(&base).join("src").join(name);
        std::fs::create_dir_all(&root).unwrap();
        for (relative, text) in files.as_object().unwrap() {
            let file = root.join(relative);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text.as_str().unwrap()).unwrap();
        }
    }
    let data = std::path::Path::new(&base).join("data");
    let announced = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&announced);
    let admin = Arc::new(PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    })));
    let io = mixdog_rt::testing::tokens().maintenance_io;
    let registry = data.join("plugins").join("registry.json");
    for step in golden["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        // Edits the replay makes to the disk between Node's steps.
        if name == "update alpha after its manifest changed" {
            std::fs::write(
                std::path::Path::new(&base).join("src/alpha/.codex-plugin/plugin.json"),
                r#"{"name":"alpha-renamed","version":"2.0.0"}"#,
            )
            .unwrap();
        } else if name == "status with a missing folder" {
            std::fs::remove_dir_all(std::path::Path::new(&base).join("src/eps")).unwrap();
        } else if name.starts_with("status with a NUL-filled") {
            std::fs::write(&registry, "\0\0\0\0").unwrap();
        } else if name.starts_with("status with a registry that has no list") {
            std::fs::write(&registry, r#"{"version":1}"#).unwrap();
            let _ = std::fs::remove_file(data.join("plugins").join("registry.json.bak"));
        } else if name == "status with a byte order mark" {
            let text = std::fs::read_to_string(&registry).unwrap();
            std::fs::write(&registry, format!("\u{feff}{text}")).unwrap();
        }
        let args = step["args"].as_array().unwrap().clone();
        let admin = Arc::clone(&admin);
        let op = step["op"].as_str().unwrap().to_owned();
        let outcome: Result<Value, String> = io
            .submit(&CancellationToken::new(), move |lane| {
                let text = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
                match op.as_str() {
                    "status" => admin.status(lane),
                    "add" => admin.add_plugin(lane, &text(0), Some(text(1)).filter(|v| !v.is_null()).as_ref()),
                    "enable" => admin.set_plugin_enabled(lane, &text(0), &text(1)),
                    "update" => admin.update_plugin(lane, &text(0)),
                    "remove" => admin.remove_plugin(lane, &text(0)),
                    other => panic!("{other}"),
                }
                .map_err(|e| e.0)
            })
            .unwrap()
            .await
            .unwrap();
        match (&outcome, step["error"].as_str()) {
            (Err(got), Some(expected)) => assert_eq!(mask(&base, got), expected, "{name}: error"),
            (Ok(got), None) => assert_eq!(masked(&base, got), step["result"], "{name}: answer"),
            _ => panic!("{name}: got {outcome:?}, Node error {:?}", step["error"]),
        }
        let mut files: Vec<String> = std::fs::read_dir(data.join("plugins"))
            .map(|d| d.flatten().map(|e| mask(&base, &e.file_name().to_string_lossy())).collect())
            .unwrap_or_default();
        // Node's lock is a file it removes on release; the OS lock here keeps its file (removing
        // it would let two holders lock different inodes), so lock files are not compared.
        files.retain(|name| !name.ends_with(".lock"));
        files.sort();
        assert_eq!(serde_json::json!(files), step["files"], "{name}: files");
        let text = std::fs::read_to_string(&registry).ok().map(|t| mask(&base, &t));
        assert_eq!(text.map(Value::from).unwrap_or(Value::Null), step["registry"], "{name}: registry file");
    }
    assert!(announced.load(Ordering::SeqCst) > 0);
}
