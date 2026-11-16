//! Migration output must be consumed at the root the daemon actually composes (`<D>/userdata`), not merely copied somewhere.
#![allow(clippy::disallowed_methods, reason = "synthetic migration/store fixtures in owned temporary directories")]
use std::path::Path;
use std::sync::Arc;
use serde_json::json;
use mixdog_migrate::desktop_profile::{DesktopProfileDriver, connection_adoption};
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::{MigrateOptions, Migrator};
use crate::paths::ConnectionsPaths;
use crate::host_store::SshHostStore;
use crate::remote_hosts::{RemoteHostStore, remote_host_id};
use crate::port_forward_store::PortForwardStore;
use crate::window_restore_store::WindowRestoreStore;

const URL: &str = "https://relay.example.test/d/0f8fad5b-d9cb-469f-a165-70867728950e/";
fn put(root: &Path, file: &str, value: serde_json::Value) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(root.join(file), serde_json::to_vec(&value).unwrap()).unwrap();
}
fn seed(root: &Path) -> MigrationRoots {
    let roots = MigrationRoots { data: root.join("data"), home: root.join("home"), profile: Some(root.join("profile")) };
    for dir in [&roots.data, &roots.home, roots.profile.as_ref().unwrap()] { std::fs::create_dir_all(dir).unwrap(); }
    let profile = roots.profile.as_ref().unwrap();
    put(profile, "ssh-hosts.json", json!({"version":1,"hosts":[{"id":"saved","name":"build box","target":"dev@build.example.test:2222","lastConnectedAt":42,"settings":{"remoteCwd":"/srv/work","autoReconnect":false,"graceMinutes":45,"allowedProviders":["openai-oauth"]}}]}));
    put(profile, "port-forwards.json", json!({"version":1,"hosts":{"saved":[{"remotePort":3000,"localPort":13000}]}}));
    put(profile, "remote-hosts.json", json!({"version":1,"hosts":[{"id":remote_host_id(URL),"url":URL,"name":"Office","alias":"desk","addedAt":12,"lastConnectedAt":34}]}));
    put(profile, "server-windows.json", json!({"enabled":true,"open":["saved"]}));
    roots
}
fn migrate(roots: &MigrationRoots) {
    Migrator::new(roots.clone(), vec![Arc::new(DesktopProfileDriver::new())], MigrateOptions::default()).run().unwrap();
}

#[tokio::test]
async fn old_profile_migration_is_read_by_all_four_real_connection_stores() {
    let temp = tempfile::tempdir().unwrap(); let roots = seed(temp.path()); migrate(&roots);
    let paths = ConnectionsPaths::new(roots.data.join("userdata"));
    let io = mixdog_rt::testing::tokens().durability_io;
    let hosts = SshHostStore::load(&paths, io).await;
    let row = hosts.get("saved").expect("migrated saved server is consumed");
    assert_eq!(row.target, "dev@build.example.test:2222");
    assert_eq!(row.name, "build box");
    let settings = row.settings.unwrap();
    assert_eq!(settings.remote_cwd.as_deref(), Some("/srv/work"));
    assert_eq!(settings.auto_reconnect, Some(false));
    assert_eq!(settings.grace_minutes, Some(45));
    assert_eq!(settings.allowed_providers, Some(vec!["openai-oauth".to_owned()]));
    let forwards = PortForwardStore::new(&paths, io).get("saved").await.unwrap();
    assert_eq!((forwards[0].remote_port, forwards[0].local_port), (3000, 13000));
    let remotes = RemoteHostStore::load(&paths, io).await;
    let remote = remotes.get(&remote_host_id(URL)).unwrap();
    assert_eq!((remote.name.as_str(), remote.url.as_str()), ("desk", URL));
    let windows = WindowRestoreStore::new(&paths, io);
    assert!(windows.enabled().await.unwrap());
    assert_eq!(windows.list().await.unwrap(), vec!["saved"]);
    // Real API-side deletion/write semantics must remain authoritative after another migration/start.
    hosts.forget("saved").await.unwrap();
    remotes.forget(&remote_host_id(URL)).await.unwrap();
    PortForwardStore::new(&paths, io).set("saved", &[]).await.unwrap();
    windows.forget("saved").await.unwrap(); windows.set_enabled(false).await.unwrap();
    migrate(&roots);
    assert!(SshHostStore::load(&paths, io).await.list().is_empty());
    assert!(RemoteHostStore::load(&paths, io).await.list().is_empty());
    assert!(PortForwardStore::new(&paths, io).get("saved").await.unwrap().is_empty());
    let windows = WindowRestoreStore::new(&paths, io);
    assert!(!windows.enabled().await.unwrap()); assert!(windows.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn existing_empty_current_stores_beat_legacy_rows_and_leave_recovery_bytes() {
    let temp = tempfile::tempdir().unwrap(); let roots = seed(temp.path());
    let current = roots.data.join("userdata");
    for file in ["ssh-hosts.json", "remote-hosts.json"] { put(&current, file, json!({"version":1,"hosts":[]})); }
    put(&current, "port-forwards.json", json!({"version":1,"hosts":{}}));
    put(&current, "server-windows.json", json!({"enabled":false,"open":[]}));
    migrate(&roots);
    let paths = ConnectionsPaths::new(current); let io = mixdog_rt::testing::tokens().durability_io;
    assert!(SshHostStore::load(&paths, io).await.list().is_empty());
    assert!(RemoteHostStore::load(&paths, io).await.list().is_empty());
    assert!(PortForwardStore::new(&paths, io).get("saved").await.unwrap().is_empty());
    assert!(!WindowRestoreStore::new(&paths, io).enabled().await.unwrap());
    for file in connection_adoption::FILES {
        assert_eq!(std::fs::read(roots.data.join("desktop").join(file)).unwrap(), std::fs::read(roots.data.join(connection_adoption::RECOVERY).join("desktop").join(file)).unwrap());
    }
}

#[tokio::test]
async fn corrupt_current_main_recovers_its_own_backup_not_the_migrated_host() {
    let temp = tempfile::tempdir().unwrap(); let roots = seed(temp.path()); let current = roots.data.join("userdata");
    put(&current, "ssh-hosts.json.bak", json!({"version":1,"hosts":[{"id":"current","name":"new box","target":"new.example.test","lastConnectedAt":99}]}));
    std::fs::write(current.join("ssh-hosts.json"), b"{damaged").unwrap();
    migrate(&roots);
    assert_eq!(std::fs::read(roots.data.join(connection_adoption::RECOVERY).join("userdata/ssh-hosts.json")).unwrap(), b"{damaged");
    let paths = ConnectionsPaths::new(current); let io = mixdog_rt::testing::tokens().durability_io;
    let hosts = SshHostStore::load(&paths, io).await;
    assert!(hosts.get("current").is_some()); assert!(hosts.get("saved").is_none());
}

#[tokio::test]
async fn current_written_records_and_backup_only_authority_are_consumed_without_legacy_union() {
    let temp = tempfile::tempdir().unwrap(); let roots = seed(temp.path()); let current = roots.data.join("userdata");
    put(&current, "ssh-hosts.json", json!({"version":1,"hosts":[{"id":"current","name":"renamed","target":"new.example.test","lastConnectedAt":99}]}));
    put(&current, "port-forwards.json", json!({"version":1,"hosts":{"current":[{"remotePort":4000,"localPort":14000}]}}));
    put(&current, "remote-hosts.json", json!({"version":1,"hosts":[{"url":URL,"name":"Office","alias":"current alias","addedAt":12}]}));
    put(&current, "server-windows.json", json!({"enabled":false,"open":["current"]}));
    migrate(&roots);
    let paths = ConnectionsPaths::new(current); let io = mixdog_rt::testing::tokens().durability_io;
    let hosts = SshHostStore::load(&paths, io).await;
    assert!(hosts.get("saved").is_none()); assert_eq!(hosts.get("current").unwrap().name, "renamed");
    let ports = PortForwardStore::new(&paths, io);
    assert!(ports.get("saved").await.unwrap().is_empty()); assert_eq!(ports.get("current").await.unwrap()[0].local_port, 14000);
    assert_eq!(RemoteHostStore::load(&paths, io).await.get(&remote_host_id(URL)).unwrap().name, "current alias");
    let windows = WindowRestoreStore::new(&paths, io);
    assert_eq!(windows.list().await.unwrap(), vec!["current"]); assert!(!windows.enabled().await.unwrap());

    let temp = tempfile::tempdir().unwrap(); let roots = seed(temp.path()); let current = roots.data.join("userdata");
    put(&current, "ssh-hosts.json.bak", json!({"version":1,"hosts":[]}));
    migrate(&roots);
    let paths = ConnectionsPaths::new(current.clone());
    assert!(SshHostStore::load(&paths, io).await.list().is_empty(), "a missing main is absent to the real reader, not an invitation to resurrect desktop rows");
    assert!(!current.join("ssh-hosts.json").exists());
    assert!(roots.data.join(connection_adoption::RECOVERY).join("userdata/ssh-hosts.json.bak").exists());
}
