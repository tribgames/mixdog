#![allow(clippy::disallowed_methods, reason = "test setup: files of a scratch profile and data dir are written and read on the test thread")]

use std::path::PathBuf;

use mixdog_core_api::CoreError;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::Value;
use serde_json::json;

use super::*;

struct Rig {
    root: tempfile::TempDir,
    service: MigrateProfileService,
}

impl Rig {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        for dir in ["data", "home", "profile", "other"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let service = MigrateProfileService::new(root.path().join("data"), root.path().join("home"), &tokens);
        Self { root, service }
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
    let rig = Rig::new();
    rig.put("profile", "ssh-hosts.json", b"[\"a\"]");
    rig.put("profile", "remote-hosts.json", b"[\"b\"]");
    rig.put("profile", "window-state.json", b"{}");
    let answer = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(answer["generation"], json!(2));
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
    let rig = Rig::new();
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
    let rig = Rig::new();
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
    let rig = Rig::new();
    rig.put("profile", "server-windows.json", b"[1]");
    let first = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(first["moved"], json!(["server-windows.json"]));
    let again = rig.adopt(&path(rig.dir("profile"))).await.unwrap();
    assert_eq!(again, json!({ "generation": 2, "moved": [] }));
    assert_eq!(std::fs::read(rig.dir("data").join("desktop/server-windows.json")).unwrap(), b"[1]");
}

#[tokio::test]
async fn status_reports_generation() {
    let rig = Rig::new();
    assert_eq!(rig.status().await, json!({ "generation": 1, "profile": null, "completedWithProfile": false }));
    rig.put("profile", "ssh-hosts.json", b"[]");
    let profile = path(rig.dir("profile"));
    rig.adopt(&profile).await.unwrap();
    assert_eq!(rig.status().await, json!({ "generation": 2, "profile": profile, "completedWithProfile": true }));
}
