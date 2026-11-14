//! The cases of `ssh-host-store.test.mjs`, `port-forward-store.test.mjs` and `window-restore.test.mjs`, and of the
//! store, redeem and presence parts of `remote-hosts.ts`.

use std::path::Path;

use mixdog_rt::DurabilityIo;
use mixdog_testkit::entry_names;
use mixdog_testkit::read_string;
use mixdog_testkit::write;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

use crate::host_store::SshHostRecord;
use crate::host_store::SshHostStore;
use crate::host_store::parse_host_settings;
use crate::paths::ConnectionsPaths;
use crate::port_forward_store::PortForwardStore;
use crate::port_forward_store::SavedPortForward;
use crate::remote_hosts::PairRedeemError;
use crate::remote_hosts::ParsedRemoteHostLink;
use crate::remote_hosts::PresenceQuery;
use crate::remote_hosts::RemoteHostStore;
use crate::remote_hosts::fetch_host_presence;
use crate::remote_hosts::parse_pair_code_input;
use crate::remote_hosts::parse_remote_host_link;
use crate::remote_hosts::redeem_pair_code;
use crate::remote_hosts::relay_http_origin;
use crate::remote_hosts::remote_host_id;
use crate::window_restore_store::WindowRestoreStore;

fn io() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

fn paths(dir: &Path) -> ConnectionsPaths {
    ConnectionsPaths::new(dir)
}

fn host(id: &str, name: &str, target: &str, last: u64) -> SshHostRecord {
    SshHostRecord {
        id: id.to_string(),
        name: name.to_string(),
        target: target.to_string(),
        last_connected_at: Some(last.into()),
        settings: None,
    }
}

fn ids(hosts: &[SshHostRecord]) -> Vec<String> {
    hosts.iter().map(|host| host.id.clone()).collect()
}

fn aside(dir: &Path, file: &str) -> Vec<String> {
    entry_names(dir).into_iter().map(|name| name.to_string_lossy().into_owned()).filter(|name| name.starts_with(&format!("{file}.corrupt-"))).collect()
}

fn stored(dir: &Path, file: &str) -> Value {
    serde_json::from_str(&read_string(dir.join(file))).unwrap()
}

#[tokio::test]
async fn saved_servers_persist_as_id_name_target_and_last_connected_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 10)).await.unwrap();
    store.save(host("b", "gpu-box", "gpu-box", 20)).await.unwrap();
    assert_eq!(ids(&store.list()), ["b", "a"]);
    let file = stored(dir.path(), "ssh-hosts.json");
    assert_eq!(file["hosts"][1], json!({ "id": "a", "name": "vps", "target": "root@vps.example.com", "lastConnectedAt": 10 }));
    assert_eq!(file["version"], 1);
    let reloaded = SshHostStore::load(&paths(dir.path()), io()).await;
    assert_eq!(reloaded.list(), store.list());
    assert_eq!(reloaded.find_by_target("gpu-box"), Some(host("b", "gpu-box", "gpu-box", 20)));
}

#[tokio::test]
async fn saving_an_id_again_updates_in_place_and_rename_and_forget_touch_only_that_entry() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 10)).await.unwrap();
    store.save(host("b", "gpu", "gpu", 20)).await.unwrap();
    store.save(host("a", "vps", "root@vps.example.com", 30)).await.unwrap();
    assert_eq!(store.list().len(), 2);
    assert_eq!(store.get("a").unwrap().last_connected_at, Some(30.into()));
    store.rename("a", "  My VPS  ").await.unwrap();
    assert_eq!(store.get("a").unwrap().name, "My VPS");
    store.rename("a", "   ").await.unwrap();
    assert_eq!(store.get("a").unwrap().name, "My VPS", "an empty name is ignored");
    store.forget("a").await.unwrap();
    assert_eq!(ids(&store.list()), ["b"]);
}

#[tokio::test]
async fn unreadable_files_and_invalid_entries_load_as_an_empty_or_shorter_list() {
    let dir = tempfile::tempdir().unwrap();
    assert!(SshHostStore::load(&paths(dir.path()), io()).await.list().is_empty());
    write(dir.path().join("ssh-hosts.json"), "{not json");
    assert!(SshHostStore::load(&paths(dir.path()), io()).await.list().is_empty());
    let rows = [host("a", "ok", "root@host", 1), host("b", "bad", "-oProxyCommand=x", 1), host("", "noid", "host", 1), host("c", "", "host", 1)];
    let document = json!({ "hosts": rows.iter().map(|row| json!({ "id": row.id, "name": row.name, "target": row.target, "lastConnectedAt": 1 })).collect::<Vec<_>>() });
    write(dir.path().join("ssh-hosts.json"), document.to_string());
    assert_eq!(ids(&SshHostStore::load(&paths(dir.path()), io()).await.list()), ["a"]);
}

#[tokio::test]
async fn the_host_part_of_a_target_is_compared_without_regard_to_case_user_and_port_are_not() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@Vps.Example.com", 10)).await.unwrap();
    assert_eq!(store.find_by_target("root@vps.example.com").map(|found| found.id), Some("a".to_string()));
    assert_eq!(store.find_by_target("Root@vps.example.com"), None);
    assert_eq!(store.find_by_target("root@vps.example.com:2202"), None);
    store.save(host("b", "vps again", "root@vps.example.com", 20)).await.unwrap();
    assert_eq!(ids(&store.list()), ["b"], "the same server under another spelling replaces the old entry");
    let rows = json!({ "hosts": [
        { "id": "x", "name": "one", "target": "u@HOST" },
        { "id": "y", "name": "two", "target": "u@host" },
    ] });
    write(dir.path().join("ssh-hosts.json"), rows.to_string());
    assert_eq!(ids(&SshHostStore::load(&paths(dir.path()), io()).await.list()), ["x"]);
}

#[test]
fn per_server_settings_are_validated_and_trimmed() {
    let parsed = parse_host_settings(&json!({ "remoteCwd": " /srv/app ", "identityFile": " ~/.ssh/id work ", "autoReconnect": true, "extra": 1 })).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), json!({ "remoteCwd": "/srv/app", "identityFile": "~/.ssh/id work", "autoReconnect": true }));
    assert!(parse_host_settings(&json!({ "remoteCwd": "  ", "identityFile": "" })).unwrap().is_empty());
    let refused = |raw: Value| parse_host_settings(&raw).unwrap_err().to_string();
    assert!(refused(json!({ "remoteCwd": "src" })).contains("absolute server path"));
    assert!(refused(json!({ "identityFile": "a\nb" })).contains("not valid"));
    assert!(refused(json!({ "identityFile": "-x" })).contains("must not start"));
}

#[tokio::test]
async fn settings_are_saved_with_the_entry_and_survive_a_save_of_the_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 1)).await.unwrap();
    store.update_settings("a", &json!({ "remoteCwd": "~/work", "autoReconnect": false })).await.unwrap();
    store.save(host("a", "renamed", "root@vps.example.com", 99)).await.unwrap();
    let reloaded = SshHostStore::load(&paths(dir.path()), io()).await;
    let settings = serde_json::to_value(reloaded.get("a").unwrap().settings).unwrap();
    assert_eq!(settings, json!({ "remoteCwd": "~/work", "autoReconnect": false }));
    assert_eq!(reloaded.get("a").unwrap().name, "renamed");
    reloaded.update_settings("a", &json!({})).await.unwrap();
    assert_eq!(reloaded.get("a").unwrap().settings, None);
}

#[test]
fn the_model_login_is_this_pcs_unless_the_servers_own_is_chosen_and_only_the_opt_in_is_stored() {
    let serialized = |raw: Value| serde_json::to_value(parse_host_settings(&raw).unwrap()).unwrap();
    assert_eq!(serialized(json!({ "modelLogin": "server" })), json!({ "modelLogin": "server" }));
    assert_eq!(serialized(json!({ "modelLogin": "pc" })), json!({}));
    assert_eq!(serialized(json!({ "modelLogin": null })), json!({}));
    assert_eq!(serialized(json!({})), json!({}));
    for bad in [json!("cloud"), json!(true), json!(1), json!("Server")] {
        assert!(parse_host_settings(&json!({ "modelLogin": bad })).unwrap_err().to_string().contains("model login is not valid"));
    }
}

#[tokio::test]
async fn a_damaged_model_login_in_the_file_falls_back_to_this_pcs_logins() {
    let dir = tempfile::tempdir().unwrap();
    let rows = json!({ "version": 1, "hosts": [
        { "id": "own", "name": "a", "target": "root@10.0.0.1", "lastConnectedAt": 1, "settings": { "modelLogin": "server" } },
        { "id": "odd", "name": "c", "target": "root@10.0.0.3", "lastConnectedAt": 1, "settings": { "modelLogin": "cloud" } },
    ] });
    write(dir.path().join("ssh-hosts.json"), rows.to_string());
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    assert_eq!(serde_json::to_value(store.get("own").unwrap().settings).unwrap(), json!({ "modelLogin": "server" }));
    assert_eq!(store.get("odd").unwrap().settings, None);
    store.update_settings("own", &json!({ "modelLogin": "pc", "remoteCwd": "~" })).await.unwrap();
    let reloaded = SshHostStore::load(&paths(dir.path()), io()).await;
    assert_eq!(serde_json::to_value(reloaded.get("own").unwrap().settings).unwrap(), json!({ "remoteCwd": "~" }));
}

#[test]
fn the_grace_period_is_a_whole_number_of_minutes_from_1_to_10080() {
    assert_eq!(parse_host_settings(&json!({ "graceMinutes": 45 })).unwrap().grace_minutes, Some(45));
    assert_eq!(parse_host_settings(&json!({ "graceMinutes": "" })).unwrap().grace_minutes, None);
    assert_eq!(parse_host_settings(&json!({})).unwrap().grace_minutes, None);
    for bad in [json!(0), json!(10_081), json!(2.5), json!("x")] {
        assert!(parse_host_settings(&json!({ "graceMinutes": bad })).unwrap_err().to_string().contains("1 to 10080"));
    }
}

#[test]
fn allowed_providers_are_trimmed_unique_and_bounded() {
    let parsed = parse_host_settings(&json!({ "allowedProviders": [" openai ", "openai", "anthropic"] })).unwrap();
    assert_eq!(parsed.allowed_providers, Some(vec!["openai".to_string(), "anthropic".to_string()]));
    assert!(parse_host_settings(&json!({ "allowedProviders": ["ok", ""] })).is_err());
    let many: Vec<String> = (0..65).map(|n| format!("p{n}")).collect();
    assert_eq!(parse_host_settings(&json!({ "allowedProviders": many })).unwrap_err().to_string(), "Too many providers.");
}

#[tokio::test]
async fn allowed_providers_no_io() {
    let dir = tempfile::tempdir().unwrap();
    let rows = json!({ "version": 1, "hosts": [
        { "id": "restricted", "name": "a", "target": "root@10.0.0.1", "lastConnectedAt": 1, "settings": { "allowedProviders": ["anthropic"] } },
        { "id": "open", "name": "b", "target": "root@10.0.0.2", "lastConnectedAt": 1 },
    ] });
    write(dir.path().join("ssh-hosts.json"), rows.to_string());
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    // The file is gone: the answers come from memory.
    mixdog_testkit::remove_file(dir.path().join("ssh-hosts.json"));
    assert_eq!(store.allowed_providers("restricted"), Some(vec!["anthropic".to_string()]));
    assert_eq!(store.allowed_providers("open"), None, "no list: every provider enabled on this PC");
    assert_eq!(store.allowed_providers("nobody"), Some(Vec::new()), "a server that is not saved gets none");
    store.update_settings("open", &json!({ "allowedProviders": ["openai"] })).await.unwrap();
    assert_eq!(store.allowed_providers("open"), Some(vec!["openai".to_string()]));
}

#[tokio::test]
async fn subscribers_see_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    let mut changes = store.subscribe();
    store.save(host("a", "vps", "root@vps.example.com", 1)).await.unwrap();
    changes.changed().await.unwrap();
    assert_eq!(ids(&changes.borrow_and_update()), ["a"]);
}

#[tokio::test]
async fn ensure_for_target_answers_the_saved_server_or_an_unsaved_record() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 1)).await.unwrap();
    assert_eq!(store.ensure_for_target("root@VPS.example.com", "").unwrap().id, "a");
    let fresh = store.ensure_for_target("root@new.example.com:2202", "").unwrap();
    assert_eq!((fresh.name.as_str(), fresh.target.as_str(), fresh.last_connected_at), ("new.example.com", "root@new.example.com:2202", None));
    assert_eq!(store.list().len(), 1, "an unsaved record is not saved");
    assert!(store.ensure_for_target("-oProxyCommand=x", "").is_err());
}

#[tokio::test]
async fn reservations_share_one_id_per_first_time_target_while_any_attempt_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 1)).await.unwrap();
    // A saved server is answered as it is.
    assert_eq!(store.reserve_for_target("root@VPS.example.com").unwrap().record.id, "a");
    let first = store.reserve_for_target("root@new.example.com:2202").unwrap();
    let second = store.reserve_for_target("root@NEW.example.com:2202").unwrap();
    assert_eq!(first.record.id, second.record.id);
    assert_eq!((first.record.name.as_str(), first.record.last_connected_at.is_none()), ("new.example.com", true));
    let id = first.record.id.clone();
    drop(first);
    // One attempt still holds it.
    assert_eq!(store.reserve_for_target("root@new.example.com:2202").unwrap().record.id, id);
    drop(second);
    // Every attempt let go: the next first connect starts over with its own id.
    assert_ne!(store.reserve_for_target("root@new.example.com:2202").unwrap().record.id, id);
    assert!(store.reserve_for_target("-oProxyCommand=x").is_err());
}

#[tokio::test]
async fn damaged_file_kept_aside() {
    let dir = tempfile::tempdir().unwrap();
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    store.save(host("a", "vps", "root@vps.example.com", 10)).await.unwrap();
    store.save(host("b", "gpu-box", "gpu-box", 20)).await.unwrap();
    write(dir.path().join("ssh-hosts.json"), "\0\0\0\0\0\0");
    let reloaded = SshHostStore::load(&paths(dir.path()), io()).await;
    assert_eq!(ids(&reloaded.list()), ["a"], "the copy kept before the last write is restored");
    let kept = aside(dir.path(), "ssh-hosts.json");
    assert_eq!(kept.len(), 1);
    assert_eq!(read_string(dir.path().join(&kept[0])), "\0\0\0\0\0\0");
    assert_eq!(stored(dir.path(), "ssh-hosts.json")["hosts"][0]["id"], "a");
}

#[tokio::test]
async fn a_damaged_list_with_no_backup_starts_empty_but_keeps_its_bytes() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path().join("ssh-hosts.json"), "{\"hosts\": [");
    let store = SshHostStore::load(&paths(dir.path()), io()).await;
    assert!(store.list().is_empty());
    store.save(host("n", "new", "new-box", 1)).await.unwrap();
    assert_eq!(ids(&SshHostStore::load(&paths(dir.path()), io()).await.list()), ["n"]);
    assert!(!aside(dir.path(), "ssh-hosts.json").is_empty());
}

fn forward(port: u16) -> SavedPortForward {
    SavedPortForward { remote_port: port, local_port: port }
}

#[tokio::test]
async fn a_nul_filled_forward_file_loads_none_is_kept_aside_and_later_saves_persist() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path().join("port-forwards.json"), vec![0u8; 90]);
    let store = PortForwardStore::new(&paths(dir.path()), io());
    assert!(store.get("box").await.unwrap().is_empty());
    assert!(!aside(dir.path(), "port-forwards.json").is_empty());
    store.set("box", &[forward(3000)]).await.unwrap();
    assert_eq!(PortForwardStore::new(&paths(dir.path()), io()).get("box").await.unwrap(), [forward(3000)]);
}

#[tokio::test]
async fn truncated_forward_json_is_damage_too() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path().join("port-forwards.json"), "{\"version\":1,\"hosts\":{\"box\":[{\"remotePo");
    assert!(PortForwardStore::new(&paths(dir.path()), io()).get("box").await.unwrap().is_empty());
}

#[tokio::test]
async fn a_forward_save_keeps_the_replaced_list_which_a_damaged_file_is_restored_from() {
    let dir = tempfile::tempdir().unwrap();
    let store = PortForwardStore::new(&paths(dir.path()), io());
    store.set("box", &[forward(3000)]).await.unwrap();
    store.set("box", &[forward(3000), forward(5173)]).await.unwrap();
    write(dir.path().join("port-forwards.json"), vec![0u8; 90]);
    assert_eq!(PortForwardStore::new(&paths(dir.path()), io()).get("box").await.unwrap(), [forward(3000)]);
}

#[tokio::test]
async fn forwards_are_limited_to_64_and_an_empty_list_forgets_the_server() {
    let dir = tempfile::tempdir().unwrap();
    let store = PortForwardStore::new(&paths(dir.path()), io());
    let many: Vec<SavedPortForward> = (1..=70).map(forward).collect();
    store.set("box", &many).await.unwrap();
    assert_eq!(store.get("box").await.unwrap().len(), 64);
    store.set("box", &[SavedPortForward { remote_port: 0, local_port: 80 }]).await.unwrap();
    assert!(store.get("box").await.unwrap().is_empty());
    assert_eq!(stored(dir.path(), "port-forwards.json"), json!({ "version": 1, "hosts": {} }));
}

#[tokio::test]
async fn a_forward_read_that_fails_is_not_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("port-forwards.json");
    // A directory where the file belongs cannot be read as a file.
    mixdog_testkit::create_dir(&file);
    let store = PortForwardStore::new(&paths(dir.path()), io());
    assert!(store.get("box").await.is_err());
    mixdog_testkit::remove_dir_all(&file);
    write(&file, json!({ "version": 1, "hosts": { "box": [{ "remotePort": 8080, "localPort": 8080 }] } }).to_string());
    assert_eq!(store.get("box").await.unwrap(), [forward(8080)]);
}

#[tokio::test]
async fn a_nul_filled_restore_list_reads_as_the_defaults_and_later_changes_persist() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path().join("server-windows.json"), vec![0u8; 120]);
    let restore = WindowRestoreStore::new(&paths(dir.path()), io());
    assert!(restore.enabled().await.unwrap());
    assert!(!aside(dir.path(), "server-windows.json").is_empty());
    restore.remember("box").await.unwrap();
    assert_eq!(stored(dir.path(), "server-windows.json"), json!({ "version": 1, "enabled": true, "open": ["box"] }));
    assert!(WindowRestoreStore::new(&paths(dir.path()), io()).enabled().await.unwrap());
}

#[tokio::test]
async fn truncated_restore_json_is_damage_too() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path().join("server-windows.json"), "{\"version\":1,\"enabled\":false,\"op");
    let restore = WindowRestoreStore::new(&paths(dir.path()), io());
    restore.remember("box").await.unwrap();
    assert_eq!(stored(dir.path(), "server-windows.json")["open"], json!(["box"]));
}

#[tokio::test]
async fn a_restore_read_that_fails_is_not_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("server-windows.json");
    mixdog_testkit::create_dir(&file);
    let restore = WindowRestoreStore::new(&paths(dir.path()), io());
    assert!(restore.enabled().await.is_err());
    mixdog_testkit::remove_dir_all(&file);
    write(&file, json!({ "version": 1, "enabled": false, "open": [] }).to_string());
    assert!(!restore.enabled().await.unwrap());
}

#[tokio::test]
async fn restore_remembers_forgets_and_keeps_the_last_64() {
    let dir = tempfile::tempdir().unwrap();
    let restore = WindowRestoreStore::new(&paths(dir.path()), io());
    assert!(!restore.set_enabled(false).await.unwrap());
    restore.remember("a").await.unwrap();
    restore.remember("a").await.unwrap();
    restore.remember("b").await.unwrap();
    assert_eq!(restore.list().await.unwrap(), ["a", "b"]);
    restore.forget("a").await.unwrap();
    restore.forget("never").await.unwrap();
    assert_eq!(restore.list().await.unwrap(), ["b"]);
    for n in 0..70 {
        restore.remember(&format!("w{n}")).await.unwrap();
    }
    let open = restore.list().await.unwrap();
    assert_eq!((open.len(), open[0].as_str(), open[63].as_str()), (64, "w6", "w69"));
    restore.retain(|id| id == "w69").await.unwrap();
    assert_eq!(restore.list().await.unwrap(), ["w69"]);
    assert!(!WindowRestoreStore::new(&paths(dir.path()), io()).enabled().await.unwrap());
}

const DEVICE: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn a_pairing_link_names_a_host_by_its_route_and_never_carries_a_credential() {
    let link = parse_remote_host_link(&format!("  https://relay.example.com/d/{DEVICE}?x=1#f  ")).unwrap();
    assert_eq!(link, ParsedRemoteHostLink { url: format!("https://relay.example.com/d/{DEVICE}/"), device_id: DEVICE.to_string() });
    let uuid = "0123ABCD-0123-4567-89ab-0123456789AB";
    assert_eq!(parse_remote_host_link(&format!("https://r.example/d/{uuid}/")).unwrap().device_id, uuid.to_ascii_lowercase());
    assert!(parse_remote_host_link(&format!("http://127.0.0.1:8080/d/{DEVICE}/")).is_some());
    assert!(parse_remote_host_link(&format!("http://relay.example.com/d/{DEVICE}/")).is_none());
    assert!(parse_remote_host_link(&format!("https://user:pw@relay.example.com/d/{DEVICE}/")).is_none());
    assert!(parse_remote_host_link("https://relay.example.com/d/short/").is_none());
    assert_eq!(parse_remote_host_link(&format!("https://relay.example.com/D/{DEVICE}")).unwrap().url, format!("https://relay.example.com/d/{DEVICE}/"));
    assert!(parse_remote_host_link("not a link").is_none());
}

#[test]
fn pair_codes_are_six_digits_however_they_were_typed() {
    assert_eq!(parse_pair_code_input("482\u{b7}917").as_deref(), Some("482917"));
    assert_eq!(parse_pair_code_input(" 482 917 ").as_deref(), Some("482917"));
    assert_eq!(parse_pair_code_input("48-29.17").as_deref(), Some("482917"));
    assert_eq!(parse_pair_code_input("48291"), None);
    assert_eq!(parse_pair_code_input("48291a"), None);
}

#[test]
fn the_relay_origin_and_the_host_id() {
    assert_eq!(relay_http_origin("wss://relay.example.com/ws").unwrap(), "https://relay.example.com");
    assert_eq!(relay_http_origin("ws://127.0.0.1:9000/x").unwrap(), "http://127.0.0.1:9000");
    assert!(relay_http_origin("not a url").is_err());
    let id = remote_host_id(&format!("https://relay.example.com/d/{DEVICE}/"));
    assert_eq!(id.len(), 16);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
}

#[tokio::test]
async fn remote_hosts_are_saved_renamed_touched_and_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let store = RemoteHostStore::load(&paths(dir.path()), io()).await;
    let link = parse_remote_host_link(&format!("https://relay.example.com/d/{DEVICE}/")).unwrap();
    let added = store.add(&link, "").await.unwrap();
    assert_eq!(added.name, "relay.example.com \u{b7} 01234567");
    assert_eq!(added.id, remote_host_id(&link.url));
    assert_eq!(store.add(&link, "Desk PC").await.unwrap().name, "Desk PC");
    assert_eq!(store.list().len(), 1);
    store.rename(&added.id, "  Mine  ").await.unwrap();
    assert_eq!(store.get(&added.id).unwrap().name, "Mine");
    assert_eq!(stored(dir.path(), "remote-hosts.json")["hosts"][0]["name"], "Desk PC");
    store.rename(&added.id, "").await.unwrap();
    assert_eq!(store.get(&added.id).unwrap().name, "Desk PC");
    store.touch(&added.id).await.unwrap();
    assert!(store.get(&added.id).unwrap().last_connected_at.is_some());
    assert_eq!(RemoteHostStore::load(&paths(dir.path()), io()).await.list().len(), 1);
    store.forget(&added.id).await.unwrap();
    assert!(store.list().is_empty());
}

#[tokio::test]
async fn at_most_32_computers_are_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = RemoteHostStore::load(&paths(dir.path()), io()).await;
    for n in 0..32 {
        let link = parse_remote_host_link(&format!("https://relay.example.com/d/{n:032x}/")).unwrap();
        store.add(&link, "").await.unwrap();
    }
    let link = parse_remote_host_link(&format!("https://relay.example.com/d/{:032x}/", 99)).unwrap();
    assert_eq!(store.add(&link, "").await.unwrap_err().to_string(), "Too many saved computers. Forget one first.");
}

/// A relay on a loopback port that answers each request it gets with the next of `answers` (a whole HTTP response)
/// and sends the request it read through the channel. Returns its origin.
async fn relay(answers: Vec<String>) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (seen, received) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        for answer in answers {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let mut request = vec![0u8; 8192];
            let mut length = 0;
            // The head, then as much body as the length it names.
            loop {
                let read = socket.read(&mut request[length..]).await.unwrap_or(0);
                length += read;
                let text = String::from_utf8_lossy(&request[..length]).into_owned();
                let wanted = text
                    .split("\r\n\r\n")
                    .next()
                    .and_then(|head| head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|n| n.trim().parse::<usize>().unwrap_or(0))))
                    .unwrap_or(0);
                if read == 0 || text.split_once("\r\n\r\n").is_some_and(|(_, body)| body.len() >= wanted) {
                    let _ = seen.send(text);
                    break;
                }
            }
            let _ = socket.write_all(answer.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    (origin, received)
}

fn http(status: &str, body: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

#[tokio::test]
async fn a_right_code_is_redeemed_once_with_the_hosts_name_cut_to_80() {
    let long = "n".repeat(100);
    let body = json!({ "deviceId": DEVICE, "ticket": "t-1", "name": long }).to_string();
    let (origin, mut seen) = relay(vec![http("200 OK", &body)]).await;
    let redeemed = redeem_pair_code(&origin, "482917").await.unwrap();
    assert_eq!((redeemed.device_id.as_str(), redeemed.ticket.as_str(), redeemed.name.len()), (DEVICE, "t-1", 80));
    let request = seen.recv().await.unwrap();
    assert!(request.starts_with("POST /pair-code/resolve "));
    assert!(request.ends_with("{\"code\":\"482917\"}"));
}

#[tokio::test]
async fn redeem_parses_older_relay() {
    // An older relay answers without JSON: that is "not available", not a crash.
    let (origin, _) = relay(vec![http("404 Not Found", "<html>no such route</html>")]).await;
    assert_eq!(redeem_pair_code(&origin, "482917").await.unwrap_err(), PairRedeemError::NotAvailable);
    let (origin, _) = relay(vec![http("200 OK", "ok")]).await;
    assert_eq!(redeem_pair_code(&origin, "482917").await.unwrap_err(), PairRedeemError::NotAvailable);
    let (origin, _) = relay(vec![http("404 Not Found", "{\"status\":\"invalid-code\"}")]).await;
    let wrong = redeem_pair_code(&origin, "482917").await.unwrap_err();
    assert_eq!(wrong.to_string(), "The code is wrong or has expired.");
    let (origin, _) = relay(vec![http("429 Too Many Requests", "{\"retryAfter\":12}")]).await;
    assert_eq!(redeem_pair_code(&origin, "482917").await.unwrap_err().to_string(), "Too many attempts. Try again in 12 seconds.");
    let (origin, _) = relay(vec![http("429 Too Many Requests", "{}")]).await;
    assert_eq!(redeem_pair_code(&origin, "482917").await.unwrap_err().to_string(), "Too many attempts. Try again in 60 seconds.");
}

#[tokio::test]
async fn presence_reports_online_and_offline_hosts_and_skips_an_unreachable_relay() {
    let other = "fedcba9876543210fedcba9876543210";
    let mut online = serde_json::Map::new();
    online.insert(DEVICE.to_string(), true.into());
    online.insert(other.to_string(), false.into());
    let (origin, mut seen) = relay(vec![http("200 OK", &json!({ "online": online }).to_string())]).await;
    let hosts = [
        PresenceQuery { id: "a".into(), url: format!("{origin}/d/{DEVICE}/") },
        PresenceQuery { id: "b".into(), url: format!("{origin}/d/{other}/") },
        PresenceQuery { id: "c".into(), url: "not a link".into() },
        PresenceQuery { id: "d".into(), url: format!("http://127.0.0.1:1/d/{DEVICE}/") },
    ];
    let online = fetch_host_presence(&hosts).await;
    let expected: std::collections::HashMap<String, bool> = [("a".to_string(), true), ("b".to_string(), false)].into_iter().collect();
    assert_eq!(online, expected, "an unreachable relay's host and a link that is not one are absent: unknown");
    let request = seen.recv().await.unwrap();
    assert!(request.starts_with("POST /pair-code/presence "));
    assert!(request.contains(&format!("\"ids\":[\"{DEVICE}\",\"{other}\"]")));
}

#[test]
fn pair_redeem_messages_are_translated_by_the_caller() {
    let upper = |key: &str| key.to_uppercase().replace("{{SECONDS}}", "{{seconds}}");
    assert_eq!(PairRedeemError::WrongOrExpired.message(&upper), "THE CODE IS WRONG OR HAS EXPIRED.");
    assert_eq!(
        PairRedeemError::TooManyAttempts { retry_after_seconds: "7".into() }.message(&upper),
        "TOO MANY ATTEMPTS. TRY AGAIN IN 7 SECONDS."
    );
    assert_eq!(PairRedeemError::Request("boom".into()).message(&upper), "boom");
    assert_eq!(PairRedeemError::WrongOrExpired.to_string(), "The code is wrong or has expired.");
}
