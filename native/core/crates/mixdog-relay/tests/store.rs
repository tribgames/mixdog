//! The device store: the store-level cases of `apps/relay/security.test.mjs`, the credential rules of `device-store-auth.mjs`,
//! and the file round trip with Node's own `lib/device-store.mjs`. Time is the virtual clock of tokio's paused test runtime
//! through `mixdog_rt::time`; the disk is a temporary directory.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use mixdog_relay::store::{
    DeviceStore, ProfileInput, client_token_usable, is_desktop_version, is_shell_version, leg_credentials_usable, read_device_credentials,
    registrable_device_id,
};
use mixdog_testkit as testkit;
use serde_json::{Value, json};

const SECRET: &str = "0123456789abcdef";
const TOKEN: &str = "fedcba9876543210";
const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn io() -> mixdog_rt::DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

async fn open(dir: &Path) -> DeviceStore {
    DeviceStore::open(dir, io()).await.expect("the store opens")
}

fn devices_file(dir: &Path) -> PathBuf {
    dir.join("devices.json")
}

fn parsed(dir: &Path) -> Value {
    mixdog_relay::js::parse(&testkit::read_string(devices_file(dir))).expect("devices.json is JSON")
}

/// Makes the next write of a store opened on `dir` fail: a file stands where the data directory was.
fn block_writes(dir: &Path) {
    testkit::remove_dir_all(dir);
    testkit::write(dir, "not a directory");
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn hex64() -> String {
    "0123456789abcdef".repeat(4)
}

// ---- readDeviceCredentials, registrableDeviceId, the leg checks ----

fn basic(text: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(text))
}

#[test]
fn device_authentication_accepts_headers_and_never_a_url() {
    let credentials = read_device_credentials(Some(&basic("header-device:header-secret")));
    assert_eq!((credentials.device_id.as_str(), credentials.secret.as_str()), ("header-device", "header-secret"));
    // No header: the query string of the upgrade is never read for credentials.
    assert_eq!(read_device_credentials(None), Default::default());
}

#[test]
fn a_basic_header_is_split_at_the_first_colon_and_read_as_node_reads_it() {
    let split = read_device_credentials(Some(&basic("id:se:cret")));
    assert_eq!((split.device_id.as_str(), split.secret.as_str()), ("id", "se:cret"));
    let lower = read_device_credentials(Some(&basic("id:secret").replacen("Basic", "bAsIc", 1)));
    assert_eq!(lower.device_id, "id");
    let tabs = read_device_credentials(Some(&format!("Basic \t {}", base64::engine::general_purpose::STANDARD.encode("id:secret"))));
    assert_eq!(tabs.secret, "secret");
    // Buffer.from reads unpadded base64: "a:" is YTo=.
    let unpadded = read_device_credentials(Some("Basic YTo"));
    assert_eq!((unpadded.device_id.as_str(), unpadded.secret.as_str()), ("a", ""));
    for refused in [
        basic(":secret"),
        basic("no-colon"),
        "Bearer abc".to_owned(),
        "Basic".to_owned(),
        "Basic ".to_owned(),
        "Basic YTo===".to_owned(),
        "Basic YT o".to_owned(),
        "BasicYTo=".to_owned(),
        String::new(),
    ] {
        assert_eq!(read_device_credentials(Some(&refused)), Default::default(), "{refused:?}");
    }
}

#[test]
fn registrable_ids_are_uuids_or_long_hex_and_the_leg_checks_count_utf16_units() {
    assert!(!registrable_device_id("00000001"));
    assert!(registrable_device_id(&uuid()));
    assert!(registrable_device_id(&hex64()));
    assert!(!registrable_device_id(&hex64().to_uppercase()));
    assert!(!registrable_device_id(&"a".repeat(31)));
    assert!(!registrable_device_id(&"a".repeat(65)));
    assert!(leg_credentials_usable("abcdef12", SECRET));
    assert!(!leg_credentials_usable("nope", SECRET));
    assert!(!leg_credentials_usable("abcdef12", "short"));
    assert!(!leg_credentials_usable("abcdef12", "0123456789abcde"));
    // Eight emoji are sixteen UTF-16 units.
    assert!(leg_credentials_usable("abcdef12", &"\u{1F600}".repeat(8)));
    assert!(!leg_credentials_usable("abcdef12", &"\u{1F600}".repeat(7)));
    assert!(client_token_usable(TOKEN));
    assert!(!client_token_usable("short"));
}

#[test]
fn version_fields_have_their_patterns() {
    assert!(is_desktop_version("1.2.3"));
    assert!(is_desktop_version("0"));
    assert!(is_desktop_version(&format!("1{}", "a".repeat(63))));
    assert!(!is_desktop_version(&format!("1{}", "a".repeat(64))));
    assert!(!is_desktop_version(""));
    assert!(!is_desktop_version(".1"));
    assert!(!is_desktop_version("1 2"));
    assert!(is_shell_version(&hex64()));
    assert!(!is_shell_version(&hex64().to_uppercase()));
    assert!(!is_shell_version(&"a".repeat(63)));
}

// ---- persistence ----

#[tokio::test]
async fn devices_json_is_owner_only_and_corrupt_state_is_refused_at_load() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.set_client_token(DEVICE, TOKEN).await);
    store.save().await.unwrap();
    let persisted = parsed(&data);
    let row = &persisted[DEVICE];
    for key in ["secretHash", "clientTokenHash"] {
        let digest = row[key].as_str().unwrap();
        assert!(digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{key}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = mixdog_fsio::metadata(&mixdog_fsio::Unlaned, devices_file(&data)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // No temporary file is left behind.
    assert_eq!(testkit::entry_names(&data), vec![std::ffi::OsString::from("devices.json")]);
    testkit::write(devices_file(&data), "{corrupt");
    let error = DeviceStore::open(&data, io()).await.err().expect("a corrupt file refuses the start");
    assert!(error.to_string().starts_with("failed to load device store: "), "{error}");
    assert!(error.to_string().contains("JSON"), "{error}");
}

#[tokio::test]
async fn every_invalid_row_refuses_the_start_and_a_missing_file_is_an_empty_store() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!open(dir.path()).await.is_known(DEVICE));
    let good_client = json!({ "tokenHash": HASH_B });
    let cases: Vec<(Value, &str)> = vec![
        (json!([]), "device store root is invalid"),
        (json!("text"), "device store root is invalid"),
        (json!({ "short": { "secretHash": HASH_A } }), "device store row is invalid"),
        (json!({ "abcdef12": [] }), "device store row is invalid"),
        (json!({ "abcdef12": { "secretHash": "xyz" } }), "device store row is invalid"),
        (json!({ "abcdef12": { "secretHash": HASH_A, "clientTokenHash": "zz" } }), "device store row is invalid"),
        (json!({ "abcdef12": { "secretHash": HASH_A, "clients": [] } }), "device store row is invalid"),
        (json!({ "abcdef12": { "secretHash": HASH_A, "clients": { "NOT-ROUTING": good_client } } }), "device store client row is invalid"),
        (json!({ "abcdef12": { "secretHash": HASH_A, "clients": { "bbbbbbbb": { "tokenHash": "no" } } } }), "device store client row is invalid"),
        (json!({ "abcdef12": { "secretHash": HASH_A, "clients": { "bbbbbbbb": 5 } } }), "device store client row is invalid"),
    ];
    for (document, reason) in cases {
        testkit::write(devices_file(dir.path()), mixdog_relay::js::wire(&document));
        let error = DeviceStore::open(dir.path(), io()).await.err().expect("an invalid file refuses the start");
        assert_eq!(error.to_string(), format!("failed to load device store: {reason}"), "{document}");
    }
}

#[tokio::test]
async fn a_new_registration_is_persisted_before_the_credential_authenticates() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    let device = uuid();
    assert!(store.authenticate(&device, SECRET).await);
    // The credential is on disk before it is honoured.
    assert!(testkit::exists(devices_file(&data)));
    assert!(!parsed(&data)[device.as_str()].is_null());
    assert!(open(&data).await.is_known(&device));

    // A write that cannot land leaves nothing live behind it.
    block_writes(&data);
    let rejected = uuid();
    assert!(!store.authenticate(&rejected, SECRET).await);
    assert!(!store.is_known(&rejected));
    // The same holds for a CHANGED pairing token.
    assert!(!store.set_client_token(&device, TOKEN).await);
    assert_eq!(store.device_id_for_client_token(TOKEN), None);
}

#[tokio::test]
async fn trust_on_first_use_refuses_a_guessable_id_and_a_wrong_secret() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(!store.authenticate("00000001", SECRET).await);
    assert!(!store.is_known("00000001"));
    let device = uuid();
    assert!(store.authenticate(&device, SECRET).await);
    assert!(!store.authenticate(&device, "wrong-secret-value").await);
    assert!(!store.authenticate(&device, "").await);
    assert!(store.authenticate(&device, SECRET).await);
    // Two first dials of one id at once: the first secret wins, the other is a stranger.
    let racing = uuid();
    let (first, second) = tokio::join!(store.authenticate(&racing, SECRET), store.authenticate(&racing, "another-secret-xyz"));
    assert!(first && !second);
    assert!(store.authenticate(&racing, SECRET).await);
}

#[tokio::test]
async fn a_revocation_that_cannot_persist_reports_failure_and_keeps_both_pairing_and_phone() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.set_client_token(DEVICE, TOKEN).await);
    let phone = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::default()).await.expect("registered");
    block_writes(&data);
    assert!(!store.revoke(DEVICE).await);
    assert!(store.is_known(DEVICE));
    assert_eq!(store.device_id_for_client_token(TOKEN).as_deref(), Some(DEVICE));
    assert_eq!(store.client_access_for_token(&phone.token).and_then(|access| access.client_id).as_deref(), Some("bbbbbbbb"));
    assert!(!store.revoke_client(DEVICE, "bbbbbbbb").await);
    assert!(store.has_client(DEVICE, "bbbbbbbb"));
    assert!(store.register_client(DEVICE, "cccccccc", &ProfileInput::default()).await.is_none());
    assert!(!store.has_client(DEVICE, "cccccccc"));
    // Once the disk is back the same revocation lands.
    testkit::remove_file(&data);
    assert!(store.revoke(DEVICE).await);
    assert!(!store.is_known(DEVICE));
    assert_eq!(store.device_id_for_client_token(TOKEN), None);
    assert_eq!(store.client_access_for_token(&phone.token), None);
    assert!(open(&data).await.client_access_for_token(&phone.token).is_none());
}

#[tokio::test(start_paused = true)]
async fn client_activity_writes_coalesce_into_one_debounced_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::default()).await.is_some());
    let before = testkit::read(devices_file(&data));
    // lastSeenAt is not a credential: a redial stampede is not one whole-file rewrite per touch.
    let renamed = ProfileInput::text("Renamed", "", "");
    for _ in 0..500 {
        assert!(store.touch_client(DEVICE, "bbbbbbbb", &renamed));
    }
    assert_eq!(testkit::read(devices_file(&data)), before);
    assert!(store.save_pending());
    mixdog_rt::time::sleep(Duration::from_millis(400)).await;
    // ...and the debounced beat is what commits them, once.
    assert!(!store.save_pending());
    let after = parsed(&data);
    assert_eq!(after[DEVICE]["clients"]["bbbbbbbb"]["name"], "Renamed");
    assert!(after[DEVICE]["clients"]["bbbbbbbb"]["lastSeenAt"].as_f64().unwrap() > 0.0);
    assert!(!store.touch_client(DEVICE, "cccccccc", &renamed));
    assert!(!store.touch_client("00000000", "bbbbbbbb", &renamed));
}

#[tokio::test(start_paused = true)]
async fn a_credential_write_carries_pending_activity_and_cancels_the_beat() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::default()).await.is_some());
    assert!(store.touch_client(DEVICE, "bbbbbbbb", &ProfileInput::text("Quiet", "", "")));
    assert!(store.save_pending());
    // Node's save() writes the whole map: the touch rides on this registration and the beat is not needed.
    assert!(store.register_client(DEVICE, "cccccccc", &ProfileInput::default()).await.is_some());
    assert!(!store.save_pending());
    assert_eq!(parsed(&data)[DEVICE]["clients"]["bbbbbbbb"]["name"], "Quiet");
}

#[tokio::test]
async fn a_failed_beat_is_logged_and_the_state_stays_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    block_writes(&data);
    assert!(!store.save_or_log().await);
    assert!(store.save().await.is_err());
    assert!(store.is_known(DEVICE));
}

// ---- browser credentials ----

#[tokio::test]
async fn browser_credentials_are_isolated_per_desktop_and_individually_revocable() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.set_client_token(DEVICE, TOKEN).await);
    let first = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::text("iPhone \u{b7} Safari", "iPhone", "Safari")).await.unwrap();
    let second = store.register_client(DEVICE, "cccccccc", &ProfileInput::text("Windows \u{b7} Edge", "Windows", "Edge")).await.unwrap();
    assert_eq!(first.token.len(), 64);
    assert_ne!(first.token, second.token);
    assert_eq!(first.client.id, "bbbbbbbb");
    assert_eq!(first.client.name, "iPhone \u{b7} Safari");
    assert_eq!(store.client_access_for_token(&first.token).and_then(|access| access.client_id).as_deref(), Some("bbbbbbbb"));
    assert_eq!(store.client_access_for_token(&second.token).and_then(|access| access.client_id).as_deref(), Some("cccccccc"));
    // The pairing token names the device and no browser.
    let pairing = store.client_access_for_token(TOKEN).unwrap();
    assert_eq!((pairing.device_id.as_str(), pairing.client_id), (DEVICE, None));
    let online = |id: &str| id == "bbbbbbbb";
    let listed = store.list_clients(DEVICE, &online);
    assert!(listed.iter().find(|row| row.id == "bbbbbbbb").unwrap().online);
    assert!(!listed.iter().find(|row| row.id == "cccccccc").unwrap().online);
    assert!(store.revoke_client(DEVICE, "bbbbbbbb").await);
    assert!(!store.revoke_client(DEVICE, "bbbbbbbb").await);
    assert_eq!(store.client_access_for_token(&first.token), None);
    assert_eq!(store.client_access_for_token(&second.token).map(|access| access.device_id).as_deref(), Some(DEVICE));
    store.save().await.unwrap();
    let restored = open(&data).await;
    let ids: Vec<String> = restored.list_clients(DEVICE, &|_| false).into_iter().map(|row| row.id).collect();
    assert_eq!(ids, vec!["cccccccc".to_owned()]);
    assert_eq!(restored.client_access_for_token(&second.token).and_then(|access| access.client_id).as_deref(), Some("cccccccc"));
    // Nothing is registered for an unknown desktop or an id that is not a routing id.
    assert!(store.register_client(&uuid(), "dddddddd", &ProfileInput::default()).await.is_none());
    assert!(store.register_client(DEVICE, "NOT-ROUTING", &ProfileInput::default()).await.is_none());
    assert!(store.register_client(DEVICE, "short", &ProfileInput::default()).await.is_none());
}

#[tokio::test]
async fn a_browser_registration_clips_its_profile_defaults_its_name_and_replaces_the_previous_token() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    let long = "n".repeat(200);
    let first = store.register_client(DEVICE, "12345678", &ProfileInput::from_value(&json!({ "name": long, "platform": 7, "browser": ["a", "b"] }))).await.unwrap();
    assert_eq!(first.client.name.len(), 80);
    assert_eq!((first.client.platform.as_str(), first.client.browser.as_str()), ("7", "a,b"));
    let nameless = store.register_client(DEVICE, "cccccccc", &ProfileInput::from_value(&json!({ "name": "", "platform": null }))).await.unwrap();
    assert_eq!((nameless.client.name.as_str(), nameless.client.platform.as_str()), ("Browser", ""));
    // Registering the id again keeps its createdAt and replaces its token.
    let again = store.register_client(DEVICE, "12345678", &ProfileInput::default()).await.unwrap();
    assert_eq!(again.client.created_at, first.client.created_at);
    assert_eq!(again.client.name, "Browser");
    assert_eq!(store.client_access_for_token(&first.token), None);
    assert_eq!(store.client_access_for_token(&again.token).and_then(|access| access.client_id).as_deref(), Some("12345678"));
    // The listing is newest first, equal times in the order of the file (an all-digit id first).
    let listed: Vec<String> = store.list_clients(DEVICE, &|_| false).into_iter().map(|row| row.id).collect();
    assert_eq!(listed.len(), 2);
}

#[tokio::test]
async fn at_most_256_browsers_are_paired_to_one_desktop_and_a_known_one_is_still_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    let mut tokens = Vec::new();
    for index in 0..256 {
        let registered = store.register_client(DEVICE, &format!("{index:08x}"), &ProfileInput::default()).await;
        tokens.push(registered.expect("under the limit").token);
    }
    assert!(store.register_client(DEVICE, "0000ffff", &ProfileInput::default()).await.is_none());
    assert!(!store.has_client(DEVICE, "0000ffff"));
    assert_eq!(store.list_clients(DEVICE, &|_| false).len(), 256);
    let replaced = store.register_client(DEVICE, "00000000", &ProfileInput::default()).await.expect("replacing is not adding");
    assert_eq!(store.client_access_for_token(&tokens[0]), None);
    assert!(store.client_access_for_token(&replaced.token).is_some());
    // Room again once one is revoked.
    assert!(store.revoke_client(DEVICE, "00000001").await);
    assert!(store.register_client(DEVICE, "0000ffff", &ProfileInput::default()).await.is_some());
}

#[tokio::test]
async fn tokens_are_looked_up_by_digest_and_an_empty_one_matches_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(store.set_client_token(DEVICE, TOKEN).await);
    assert!(store.set_client_token(DEVICE, TOKEN).await, "an unchanged token is accepted");
    assert!(!store.set_client_token(&uuid(), TOKEN).await, "an unknown device has no token");
    assert_eq!(store.client_access_for_token(""), None);
    assert_eq!(store.client_access_for_token("not-a-token"), None);
    // A changed pairing token retires the previous one.
    assert!(store.set_client_token(DEVICE, "0123456789abcdef0").await);
    assert_eq!(store.device_id_for_client_token(TOKEN), None);
    assert_eq!(store.device_id_for_client_token("0123456789abcdef0").as_deref(), Some(DEVICE));
}

// ---- desktop versions ----

#[tokio::test(start_paused = true)]
async fn a_desktop_version_report_is_stored_and_an_unchanged_one_is_rewritten_only_when_an_hour_old() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let store = open(&data).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert_eq!(store.device_version(DEVICE), Default::default());
    let report = json!({ "appVersion": "1.2.3", "rendererRelease": hex64() });
    let start = 1_700_000_000_000_i64;
    assert!(!store.record_desktop_version_at(DEVICE, &json!({ "appVersion": "not a version" }), start));
    assert!(!store.record_desktop_version_at(DEVICE, &json!("1.2.3"), start));
    assert!(!store.record_desktop_version_at(&uuid(), &report, start));
    assert!(store.record_desktop_version_at(DEVICE, &report, start));
    let version = store.device_version(DEVICE);
    assert_eq!((version.app_version.as_str(), version.renderer_release.as_str()), ("1.2.3", hex64().as_str()));
    assert!(store.save_pending());
    store.save().await.unwrap();
    let document = parsed(&data);
    let row = &document[DEVICE];
    assert_eq!((row["appVersion"].as_str(), row["rendererRelease"].as_str(), row["versionSeenAt"].as_i64()), (Some("1.2.3"), Some(hex64().as_str()), Some(start)));
    // The same report inside the hour changes nothing and writes nothing.
    assert!(store.record_desktop_version_at(DEVICE, &report, start + 59 * 60_000));
    assert!(!store.save_pending());
    // Past the hour the timestamp is refreshed.
    assert!(store.record_desktop_version_at(DEVICE, &report, start + 61 * 60_000));
    assert!(store.save_pending());
    // A new release without a renderer drops the stored renderer.
    assert!(store.record_desktop_version_at(DEVICE, &json!({ "appVersion": "1.2.4" }), start + 62 * 60_000));
    store.save().await.unwrap();
    let document = parsed(&data);
    let row = &document[DEVICE];
    assert_eq!((row["appVersion"].as_str(), row.get("rendererRelease")), (Some("1.2.4"), None));
    assert_eq!(store.device_version(DEVICE).renderer_release, "");
}

#[tokio::test]
async fn unusable_version_fields_are_dropped_at_load_and_the_rest_of_the_row_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let rows = json!({
        "abcdef12": { "secretHash": HASH_A, "clientTokenHash": "", "clients": {}, "appVersion": "bad version", "rendererRelease": hex64(), "versionSeenAt": 5 },
        "abcdef34": { "secretHash": HASH_B, "clientTokenHash": "", "clients": {}, "appVersion": "2.0.0", "rendererRelease": "zz", "versionSeenAt": "late" },
        "abcdef56": { "secretHash": HASH_C, "extra": { "kept": true } },
    });
    testkit::write(devices_file(dir.path()), mixdog_relay::js::pretty(&rows));
    let store = open(dir.path()).await;
    assert_eq!(store.device_version("abcdef12"), Default::default());
    let second = store.device_version("abcdef34");
    assert_eq!((second.app_version.as_str(), second.renderer_release.as_str()), ("2.0.0", ""));
    store.save().await.unwrap();
    let saved = parsed(dir.path());
    assert!(saved["abcdef12"].get("appVersion").is_none() && saved["abcdef12"].get("versionSeenAt").is_none() && saved["abcdef12"].get("rendererRelease").is_none());
    assert!(saved["abcdef34"].get("rendererRelease").is_none());
    assert!(saved["abcdef34"]["versionSeenAt"].is_number(), "a missing timestamp is the load time");
    // Defaults are added to a sparse row, and what the file holds besides is kept.
    assert_eq!(saved["abcdef56"]["clientTokenHash"], "");
    assert_eq!(saved["abcdef56"]["clients"], json!({}));
    assert_eq!(saved["abcdef56"]["extra"], json!({ "kept": true }));
}

// ---- the file form ----

fn node_file_text(extra_client_name: &str) -> String {
    let rows = json!({
        "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f": {
            "secretHash": HASH_A,
            "clientTokenHash": HASH_B,
            "clients": {
                "12345678": { "tokenHash": HASH_C, "name": extra_client_name, "platform": "iPhone", "browser": "Safari", "createdAt": 1_700_000_000_000_i64, "lastSeenAt": 1_700_000_000_001_i64 },
                "bbbbbbbb": { "tokenHash": HASH_A, "name": "Browser", "platform": "", "browser": "", "createdAt": 1_700_000_000_002_i64, "lastSeenAt": 1_700_000_000_003_i64 },
            },
            "appVersion": "1.2.3",
            "rendererRelease": hex64(),
            "versionSeenAt": 1_700_000_000_004_i64,
        },
    });
    mixdog_relay::js::pretty(&rows)
}

#[tokio::test]
async fn a_file_with_a_clipped_emoji_name_and_an_all_digit_client_id_is_rewritten_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    // 79 characters and an emoji cut by `slice(0, 80)`: the file holds the lone high surrogate as the escape JSON.stringify writes.
    let clipped = format!("{}\\ud83d", "a".repeat(79));
    let text = node_file_text("PLACEHOLDER").replace("PLACEHOLDER", &clipped);
    assert!(text.contains("\\ud83d\""));
    // An all-digit eight character id is listed first by JavaScript, and the text has it first.
    assert!(text.find("\"12345678\"").unwrap() < text.find("\"bbbbbbbb\"").unwrap());
    testkit::write(devices_file(dir.path()), &text);
    let store = open(dir.path()).await;
    store.save().await.unwrap();
    assert_eq!(testkit::read_string(devices_file(dir.path())), text);
    assert_eq!(store.list_clients(DEVICE, &|_| false).len(), 2);
    // A touch that sets no profile field keeps the clipped name as it is.
    assert!(store.touch_client(DEVICE, "12345678", &ProfileInput::default()));
    store.save().await.unwrap();
    assert!(testkit::read_string(devices_file(dir.path())).contains(&clipped));
}

#[tokio::test]
async fn a_name_clipped_at_registration_is_the_text_node_stores() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path()).await;
    assert!(store.authenticate(DEVICE, SECRET).await);
    let name = format!("{}\u{1F600}", "a".repeat(79));
    let registered = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::text(&name, "", "")).await.unwrap();
    assert_eq!(mixdog_relay::js::js_len(&registered.client.name), 80);
    let written = testkit::read_string(devices_file(dir.path()));
    assert!(written.contains(&format!("\"name\": \"{}\\ud83d\"", "a".repeat(79))), "{written}");
    assert!(open(dir.path()).await.has_client(DEVICE, "bbbbbbbb"));
}

fn relay_lib() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/relay/lib/device-store.mjs")
}

fn node_output(script: &str) -> String {
    let args = [OsStr::new("--input-type=module"), OsStr::new("-e"), OsStr::new(script)];
    testkit::output("node", &args)
}

fn quoted(path: &Path) -> String {
    mixdog_relay::js::wire(&Value::String(path.to_string_lossy().into_owned()))
}

#[tokio::test]
async fn a_devices_json_written_by_node_loads_rewrites_byte_identical_and_loads_again_in_node() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let lib = quoted(&relay_lib());
    let writer = format!(
        r#"
        import {{ pathToFileURL }} from 'node:url';
        const {{ DeviceStore }} = await import(pathToFileURL({lib}).href);
        const store = new DeviceStore({data});
        const device = {device};
        store.authenticate(device, {secret});
        store.setClientToken(device, {token});
        store.registerClient(device, '12345678', {{ name: 'a'.repeat(79) + '\u{{1F600}}', platform: 'iPhone', browser: 'Safari' }});
        store.registerClient(device, 'bbbbbbbb', {{}});
        store.registerClient(device, 'cccccccc', {{ name: 12345, platform: ['x', 'y'] }});
        store.recordDesktopVersion(device, {{ appVersion: '1.2.3', rendererRelease: 'a'.repeat(64) }});
        store.authenticate({second}, {secret});
        store.save();
        "#,
        data = quoted(&data),
        device = quoted_text(DEVICE),
        second = quoted_text("0123456789abcdef0123456789abcdef"),
        secret = quoted_text(SECRET),
        token = quoted_text(TOKEN),
    );
    node_output(&writer);
    let original = testkit::read_string(devices_file(&data));
    assert!(original.contains("\\ud83d"), "Node writes the clipped emoji as a lone surrogate escape");

    let store = open(&data).await;
    assert!(store.is_known(DEVICE) && store.is_known("0123456789abcdef0123456789abcdef"));
    assert_eq!(store.device_version(DEVICE).app_version, "1.2.3");
    store.save().await.unwrap();
    let rewritten = testkit::read_string(devices_file(&data));
    assert_eq!(rewritten, original, "the rewrite is byte-identical");

    // Node loads what the Rust store wrote and writes the same text again.
    let reader = format!(
        r#"
        import {{ pathToFileURL }} from 'node:url';
        const {{ DeviceStore }} = await import(pathToFileURL({lib}).href);
        const store = new DeviceStore({data});
        process.stdout.write(JSON.stringify(Object.fromEntries(store.devices), null, 2));
        "#,
        data = quoted(&data),
    );
    assert_eq!(node_output(&reader), original);
    // The digests Node stored authenticate in Rust: the secret and the pairing token are the ones Node hashed.
    assert!(store.authenticate(DEVICE, SECRET).await);
    assert!(!store.authenticate(DEVICE, "0123456789abcdeg").await);
    assert_eq!(store.device_id_for_client_token(TOKEN).as_deref(), Some(DEVICE));
    let tokens: BTreeSet<String> = store.list_clients(DEVICE, &|_| false).into_iter().map(|row| row.id).collect();
    assert_eq!(tokens, BTreeSet::from(["12345678".to_owned(), "bbbbbbbb".to_owned(), "cccccccc".to_owned()]));
}

fn quoted_text(text: &str) -> String {
    mixdog_relay::js::wire(&Value::String(text.to_owned()))
}
