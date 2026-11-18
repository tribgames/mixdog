#![allow(clippy::disallowed_methods, reason = "test setup: files of a scratch profile and data dir are written and read on the test thread")]

use std::path::PathBuf;

use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_core_config::config::ConfigLanes;
use mixdog_protocol::config::keys::DESKTOP_MARKDOWN_DEFAULT_VIEW;
use serde_json::Value;
use serde_json::json;

use super::*;

struct Rig {
    root: tempfile::TempDir,
    config: Config,
    service: MigrateProfileService,
}

fn path(dir: PathBuf) -> String {
    dir.to_string_lossy().into_owned()
}

fn refused_on(error: CoreError, field: &str) {
    match error {
        CoreError::InvalidParams { path, .. } => assert_eq!(&*path, field),
        other => panic!("not an invalid-params refusal: {other:?}"),
    }
}

#[tokio::test]
async fn adopt_moves_gen2_files() {
    let rig = Rig::new(None).await;
    rig.put("profile", "ssh-hosts.json", b"[\"a\"]");
    rig.put("profile", "remote-hosts.json", b"[\"b\"]");
    rig.put("profile", "window-state.json", b"{}");
    let answer = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(answer["generation"], json!(supplement::GENERATION));
    let mut moved: Vec<String> = serde_json::from_value(answer["moved"].clone()).unwrap();
    moved.sort();
    assert_eq!(moved, ["remote-hosts.json", "ssh-hosts.json"]);
    assert_eq!(std::fs::read(rig.dir("data").join("desktop/ssh-hosts.json")).unwrap(), b"[\"a\"]");
    assert_eq!(std::fs::read(rig.dir("data").join("desktop/remote-hosts.json")).unwrap(), b"[\"b\"]");
    assert!(!rig.dir("profile").join("ssh-hosts.json").exists());
    assert!(!rig.dir("profile").join("remote-hosts.json").exists());
    // A file the pass does not list is never touched.
    assert_eq!(std::fs::read(rig.dir("profile").join("window-state.json")).unwrap(), b"{}");
}

#[tokio::test]
async fn adopt_refuses_other_profile() {
    let rig = Rig::new(None).await;
    rig.put("profile", "ssh-hosts.json", b"[\"a\"]");
    rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    rig.put("other", "port-forwards.json", b"[\"p\"]");
    refused_on(rig.adopt(&path(rig.dir("other"))).await.unwrap_err(), "userData");
    // The refused directory was not read, moved or deleted from.
    assert_eq!(std::fs::read(rig.dir("other").join("port-forwards.json")).unwrap(), b"[\"p\"]");
    assert!(!rig.dir("data").join("desktop/port-forwards.json").exists());
}

#[tokio::test]
async fn adopt_refuses_relative_path() {
    let rig = Rig::new(None).await;
    refused_on(rig.adopt("profile").await.unwrap_err(), "userData");
    refused_on(rig.adopt("").await.unwrap_err(), "userData");
    refused_on(rig.adopt(&path(rig.dir("missing"))).await.unwrap_err(), "userData");
    // A file is not a directory.
    rig.put("profile", "ssh-hosts.json", b"[]");
    refused_on(rig.adopt(&path(rig.dir("profile").join("ssh-hosts.json"))).await.unwrap_err(), "userData");
    assert!(rig.dir("profile").join("ssh-hosts.json").exists());
}

#[tokio::test]
async fn adopt_is_idempotent() {
    let rig = Rig::new(None).await;
    rig.put("profile", "server-windows.json", b"[1]");
    let first = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(first["moved"], json!(["server-windows.json"]));
    let again = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(again, json!({ "generation": supplement::GENERATION, "moved": [] }));
    assert_eq!(std::fs::read(rig.dir("data").join("desktop/server-windows.json")).unwrap(), b"[1]");
}

#[tokio::test]
async fn status_reports_generation() {
    let rig = Rig::new(None).await;
    assert_eq!(rig.status().await, json!({ "generation": 1, "profile": null, "completedWithProfile": false }));
    rig.put("profile", "ssh-hosts.json", b"[]");
    let profile = path(rig.dir("profile"));
    rig.adopt(&profile).await.unwrap();
    assert_eq!(rig.status().await, json!({ "generation": supplement::GENERATION, "profile": profile, "completedWithProfile": true }));
}

#[tokio::test]
async fn late_profile_adoption_gives_the_editor_the_same_markdown_default_as_config() {
    for (existing, effective) in [(None, "rich"), (Some(json!("preview")), "preview"), (Some(Value::Null), "preview")] {
        let rig = Rig::new(existing.clone()).await;
        std::fs::create_dir(rig.dir("profile").join("User")).unwrap();
        rig.put("profile", "User/settings.json", br#"{
            // Legacy editor settings
            "mixdog.markdown.defaultView": "rich",
        }"#);
        let answer = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
        assert_eq!(answer["moved"], json!(["User/settings.json"]));
        assert_eq!(rig.config.get(DESKTOP_MARKDOWN_DEFAULT_VIEW), existing.or_else(|| Some(json!("rich"))));
        let settings = mixdog_workspace::editorcfg::read_editor_settings(
            &rig.dir("data").join("userdata"), &rig.dir("data"), "example.md", None, rig.config.markdown_default_view(),
        ).unwrap();
        assert_eq!(settings["markdownDefaultView"], effective);
    }
}

impl Rig {
    async fn new(markdown: Option<Value>) -> Self {
        let root = tempfile::tempdir().unwrap();
        for dir in ["data", "home", "profile", "other"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let data = root.path().join("data");
        let config_path = data.join("mixdog-config.json");
        if let Some(markdown) = markdown {
            std::fs::write(&config_path, json!({ "desktop": { "editor": { "markdownDefaultView": markdown } } }).to_string()).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let service = MigrateProfileService::new(
            data.clone(), root.path().join("home"), data.join("userdata"), config.clone(), &tokens,
        );
        Self { root, config, service }
    }

    fn dir(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn put(&self, dir: &str, name: &str, bytes: &[u8]) {
        std::fs::write(self.dir(dir).join(name), bytes).unwrap();
    }

    async fn status(&self) -> Value {
        value(&self.service, request("migrate/profile/status", json!({}), None)).await.unwrap()
    }

    async fn adopt(&self, user_data: &str) -> Result<Value, CoreError> {
        value(&self.service, request("migrate/profile/adopt", json!({ "userData": user_data }), None)).await
    }
}
