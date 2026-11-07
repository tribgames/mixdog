//! Gate tests of the `desktopProfile` kind group, driven through the framework's
//! `ItemDriver`: the `electron-profile/` corpus migrates verified with nothing
//! quarantined unexpectedly, secrets stay owner-only (DS-REM-8), a damaged file is
//! restored from its `.bak` the way the desktop does, and the files Electron owns are
//! never touched.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::Contract;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ItemState;
use mixdog_store::schema::migration::KindGroup;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::StagedEntry;
use mixdog_store::schema::migration::Target;
use serde_json::Value;
use tempfile::TempDir;

use super::*;
use crate::durable;
use crate::framework::BlobStatuses;

/// `MIXDOG_MIGRATION_CORPUS` names the corpus root; CI restores it as an artifact.
fn corpus_root() -> PathBuf {
    let root = std::env::var_os("MIXDOG_MIGRATION_CORPUS").map_or_else(
        || PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"),
        PathBuf::from,
    );
    assert!(
        root.join("electron-profile").is_dir(),
        "the migration corpus is missing at {}; set MIXDOG_MIGRATION_CORPUS",
        root.display()
    );
    root
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn files_of(dir: &Path) -> BTreeMap<String, PathBuf> {
    durable::walk_files(dir)
        .unwrap()
        .into_iter()
        .map(|name| (name.clone(), dir.join(&name)))
        .collect()
}

fn hash_of(path: &Path) -> String {
    durable::hash_file(path).unwrap().1
}

fn session_item(id: &str) -> ManifestItem {
    crate::plan::item(
        &format!("session/{id}"),
        KindGroup::Data,
        ItemKind::Session,
        Contract::Convert,
        Vec::new(),
        Some(Target::Session { id: id.to_owned() }),
    )
    .unwrap()
}

/// The session ids of the corpus (v145 and dev146 session files).
fn corpus_session_ids(root: &Path) -> BTreeSet<String> {
    ["v145", "dev146"]
        .iter()
        .flat_map(|dir| {
            std::fs::read_dir(root.join(dir).join("sessions"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        })
        .filter_map(|name| {
            let stem = name.strip_suffix(".log.jsonl").or_else(|| name.strip_suffix(".json"));
            stem.map(str::to_owned)
        })
        .collect()
}

const MANIFEST_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Run {
    data: TempDir,
    profile: TempDir,
    roots: MigrationRoots,
    manifest: Manifest,
    driver: DesktopProfileDriver,
    blobs: BlobStatuses,
    states: BTreeMap<String, ItemState>,
}

impl Run {
    /// A profile holding `files` (or a copy of `profile_from`), planned beside `sessions`.
    fn new(profile_from: Option<&Path>, files: &[(&str, &[u8])], sessions: &BTreeSet<String>) -> Self {
        let data = TempDir::new().unwrap();
        let profile = TempDir::new().unwrap();
        if let Some(from) = profile_from {
            copy_tree(from, profile.path());
        }
        for (name, content) in files {
            let path = profile.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let roots = MigrationRoots {
            data: data.path().to_path_buf(),
            home: data.path().join("home"),
            profile: Some(profile.path().to_path_buf()),
        };
        let mut sink = PlanSink::new(&roots);
        for id in sessions {
            sink.add_item(session_item(id)).unwrap();
        }
        let driver = DesktopProfileDriver::new();
        driver.plan(&roots, &mut sink).unwrap();
        let manifest = sink.into_manifest(&roots);
        Self {
            data,
            profile,
            roots,
            manifest,
            driver,
            blobs: BlobStatuses::default(),
            states: BTreeMap::new(),
        }
    }

    fn cx(&self) -> ItemContext<'_> {
        ItemContext {
            roots: &self.roots,
            manifest: &self.manifest,
            manifest_sha256: MANIFEST_SHA,
            fault: None,
            blobs: &self.blobs,
            states: &self.states,
        }
    }

    fn items(&self) -> impl Iterator<Item = &ManifestItem> {
        self.manifest.items.iter().filter(|item| self.driver.owns(item))
    }

    fn item(&self, kind: ItemKind) -> &ManifestItem {
        self.items().find(|item| item.kind == kind).unwrap_or_else(|| panic!("no {kind:?} item"))
    }

    fn stage(&self, item: &ManifestItem) -> Result<Stage> {
        self.driver.stage(&self.cx(), item)
    }

    fn entry(item: &ManifestItem, staged: &Stage) -> StagedEntry {
        let Stage::Output {
            output_sha256,
            replaced_surrogates,
        } = staged
        else {
            panic!("{} did not stage", item.key.as_str());
        };
        StagedEntry {
            key: item.key.clone(),
            output_sha256: output_sha256.as_str().try_into().unwrap(),
            replaced_surrogates: *replaced_surrogates,
        }
    }

    /// stage → publish → verify, as the framework's state machine runs an item.
    fn migrate_item(&self, item: &ManifestItem) -> Result<Outcome> {
        let cx = self.cx();
        let staged = match self.driver.stage(&cx, item)? {
            Stage::Quarantine { code, .. } => return Ok(Outcome::Quarantined(code)),
            staged @ Stage::Output { .. } => staged,
        };
        self.driver.publish(&cx, item, &Self::entry(item, &staged))?;
        Ok(match self.driver.verify(&cx, item)? {
            Verdict::Verified { digest } => Outcome::Verified(digest.expect("every profile item has a digest")),
            Verdict::Quarantine { code, .. } => Outcome::Quarantined(code),
        })
    }

    /// Every item in wave then key order; retire items are verified by planning alone.
    /// Then the framework's disposal: verified and retired sources are re-hashed and deleted.
    fn migrate_all(&self) -> Report {
        let mut report = Report::default();
        let mut order: Vec<&ManifestItem> = self.items().collect();
        order.sort_by_key(|item| (self.driver.wave(item), item.key.as_str().to_owned()));
        for item in order {
            if item.contract == Contract::Retire {
                report.retired += 1;
                continue;
            }
            match self.migrate_item(item).unwrap_or_else(|error| panic!("{}: {error}", item.key.as_str())) {
                Outcome::Verified(digest) => {
                    report.verified.insert(item.key.as_str().to_owned(), digest);
                }
                Outcome::Quarantined(code) => report.quarantined.push((item.key.as_str().to_owned(), code)),
            }
        }
        for item in self.items() {
            let disposable = item.contract == Contract::Retire || report.verified.contains_key(item.key.as_str());
            if !disposable {
                continue;
            }
            for file in &item.sources {
                let path = self.cx().source_path(file).unwrap();
                assert_eq!(hash_of(&path), file.sha256, "{} changed before disposal", file.path);
                durable::remove_file(&path).unwrap();
            }
        }
        for shared in &self.manifest.shared {
            durable::remove_file(&self.cx().source_path(&shared.file).unwrap()).unwrap();
        }
        report
    }
}

#[derive(Debug)]
enum Outcome {
    Verified(Digest),
    Quarantined(QuarantineCode),
}

#[derive(Default)]
struct Report {
    verified: BTreeMap<String, Digest>,
    quarantined: Vec<(String, QuarantineCode)>,
    retired: usize,
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

const CORPUS_KEYS: &[&str] = &[
    "desktopProfile/agentGreetings",
    "desktopProfile/agentRooms",
    "desktopProfile/desktopProjects",
    "desktopProfile/editorBackups",
    "desktopProfile/nativePush",
    "desktopProfile/notificationPreferences",
    "desktopProfile/pairingToken",
    "desktopProfile/relayDevice",
    "desktopProfile/relayDeviceRevocations",
    "desktopProfile/relayE2ee",
    "desktopProfile/remoteActivated",
    "desktopProfile/remoteClients",
    "desktopProfile/retentionState",
    "desktopProfile/selectedFileGrants",
    "desktopProfile/sessionMetadata",
    "desktopProfile/webPush",
];

#[test]
fn the_electron_profile_corpus_migrates_verified_and_leaves_electron_files_alone() {
    let corpus = corpus_root();
    let sessions = corpus_session_ids(&corpus);
    let run = Run::new(Some(&corpus.join("electron-profile")), &[], &sessions);
    let before = files_of(run.profile.path());

    let mut keys: Vec<&str> = run.items().map(|item| item.key.as_str()).collect();
    let retired = keys.iter().filter(|key| key.starts_with("retire/profile/")).count();
    keys.retain(|key| !key.starts_with("retire/profile/"));
    assert_eq!(keys, CORPUS_KEYS);
    // Four `.bak` copies, the interrupted metadata write and four task receipts.
    assert_eq!(retired, 9);
    let planned: BTreeSet<String> = run
        .items()
        .flat_map(|item| item.sources.iter().map(|file| file.path.clone()))
        .chain(run.manifest.shared.iter().map(|shared| shared.file.path.clone()))
        .collect();
    let manifest = serde_json::to_string(&run.manifest).unwrap();
    assert_eq!(serde_json::from_str::<Manifest>(&manifest).unwrap(), run.manifest);
    for secret in ["feedface", "deadbeef"] {
        assert!(!manifest.contains(secret), "the manifest must not carry secret content");
    }
    let shared = &run.manifest.shared[0];
    assert_eq!(shared.file.path, SESSION_METADATA_FILE);
    assert_eq!(shared.consumers, [SESSION_METADATA_KEY]);

    let report = run.migrate_all();
    assert!(report.quarantined.is_empty(), "{:?}", report.quarantined);
    // `webPush` retires: the framework verifies it by planning alone.
    assert_eq!(report.verified.len(), CORPUS_KEYS.len() - 1);
    assert_eq!(report.retired, 10);

    // The corpus's own expectation: how many entries of each map name a corpus session.
    let manifest_json = json(&corpus.join("manifest.json"));
    let filter = &manifest_json["electronProfile"]["metadataFilter"];
    let cx = run.cx();
    let headers: Vec<_> = sessions
        .iter()
        .filter_map(|id| run.driver.session_meta(&cx, id).unwrap())
        .collect();
    let carrying = |key: &str| headers.iter().filter(|header| header.contains_key(key)).count() as u64;
    for (map, key) in [
        ("titles", "title"),
        ("names", "name"),
        ("archived", "archivedAt"),
        ("favorites", "favoriteAt"),
        ("reads", "readState"),
        ("retired", "retiredAt"),
    ] {
        assert_eq!(carrying(key), filter[map]["inCorpus"].as_u64().unwrap(), "{map}");
    }
    // Entries naming no migrated session retire with the file, counted.
    let orphans = filter["titles"]["orphans"].as_u64().unwrap();
    let dangling = run.driver.dangling(&cx, run.item(ItemKind::SessionMetadata)).unwrap();
    assert!(dangling >= orphans, "{dangling} < {orphans}");

    // Converted values.
    let data = run.data.path();
    let config = json(&data.join("mixdog-config.json"));
    assert_eq!(config["remote"]["activatedAt"], 1_792_308_233_327u64);
    assert_eq!(config["desktop"]["retentionState"]["enabledAt"], 1_793_450_746_723u64);
    assert!(config["agents"]["greeted"].as_array().unwrap().len() > 3);
    assert!(config["notifications"]["devices"]["pc"]["scope"].is_string());
    let connection = rusqlite::Connection::open(data.join("state").join("core.sqlite")).unwrap();
    let count = |sql: &str| connection.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT count(*) FROM projects"), 2);
    assert_eq!(count("SELECT count(*) FROM projects WHERE alias = 'mixdog.ai'"), 1);
    assert_eq!(count("SELECT count(*) FROM rooms"), 0);
    assert_eq!(count("SELECT count(*) FROM meta WHERE key LIKE 'migration:%'"), 4);

    // Preserved files: bytes unchanged, secrets owner-only.
    for (source, target) in [
        ("relay-device.json", "remote/device.json"),
        ("relay-device-revocations.json", "remote/device-revocations.json"),
        ("relay-e2ee.json", "remote/e2ee.json"),
        ("remote-bridge.token", "remote/pairing-token"),
        ("remote-native-push.json", "remote/native-push.json"),
        ("remote-clients.json", "remote/clients.json"),
        ("selected-file-grants.json", "desktop/selected-file-grants.json"),
    ] {
        let moved = data.join(target);
        assert_eq!(hash_of(&moved), hash_of(&corpus.join("electron-profile").join(source)), "{target}");
        assert!(fsx::is_owner_only(&moved).unwrap(), "{target} owner-only");
    }
    let backups = files_of(&corpus.join("electron-profile").join("editor-backups"));
    assert_eq!(backups.len(), 1);
    for (name, path) in backups {
        let moved = data.join("desktop/editor-backups").join(name);
        assert_eq!(hash_of(&moved), hash_of(&path));
        assert!(fsx::is_owner_only(&moved).unwrap());
    }

    // Disposal removed exactly the planned sources; everything else is byte-identical.
    let after = files_of(run.profile.path());
    for (name, path) in &before {
        if planned.contains(name) {
            assert!(!after.contains_key(name), "{name} should be disposed");
        } else {
            let kept = after.get(name).unwrap_or_else(|| panic!("{name} was removed"));
            assert_eq!(hash_of(kept), hash_of(path), "{name} changed");
        }
    }
    assert!(!planned.contains("last-launch-version"));
    assert_eq!(
        std::fs::read(run.profile.path().join("last-launch-version")).unwrap(),
        std::fs::read(corpus.join("electron-profile/last-launch-version")).unwrap()
    );
}

#[test]
fn titles_and_names_equal_what_the_desktops_own_functions_produce() {
    #[derive(serde::Deserialize)]
    struct Vector {
        input: String,
        generated: String,
        name: String,
    }
    let vectors: Vec<Vector> = serde_json::from_str(include_str!("vectors/titles.json")).unwrap();
    assert!(vectors.len() > 60);
    for vector in vectors {
        assert_eq!(title::generated_title(&vector.input), vector.generated, "title of {:?}", vector.input);
        assert_eq!(title::normalized_name(&vector.input), vector.name, "name of {:?}", vector.input);
    }
}

#[test]
fn a_damaged_state_file_is_restored_from_its_bak_and_set_aside_as_expected() {
    let good = br#"{"rooms":{"r1":{"id":"r1","name":"restored","running":{"startedAt":1}}}}"#;
    let run = Run::new(None, &[("agent-rooms.json", b"{\"rooms\":"), ("agent-rooms.json.bak", good)], &BTreeSet::new());
    let keys: Vec<_> = run.items().map(|item| item.key.as_str()).collect();
    assert_eq!(keys, ["desktopProfile/agentRooms", "retain/profile/agent-rooms.json"]);
    let rooms = run.item(ItemKind::AgentRooms);
    assert_eq!(rooms.sources[0].path, "agent-rooms.json.bak");
    let set_aside = run.item(ItemKind::SetAside);
    assert_eq!(set_aside.contract, Contract::Retain);

    let report = run.migrate_all();
    assert_eq!(report.verified.len(), 1);
    assert_eq!(report.quarantined, [("retain/profile/agent-rooms.json".to_owned(), QuarantineCode::CarriedSetAside)]);
    assert!(QuarantineCode::CarriedSetAside.expected());
    let connection = rusqlite::Connection::open(run.data.path().join("state/core.sqlite")).unwrap();
    let doc: String = connection.query_row("SELECT doc FROM rooms WHERE room_id = 'r1'", [], |row| row.get(0)).unwrap();
    let doc: Value = serde_json::from_str(&doc).unwrap();
    assert_eq!((doc["name"].as_str(), &doc["running"]), (Some("restored"), &Value::Null));
    // The damaged file stays for the framework to move into quarantine.
    assert!(run.profile.path().join("agent-rooms.json").exists());
    assert!(!run.profile.path().join("agent-rooms.json.bak").exists());
}

#[test]
fn a_damaged_file_without_a_usable_bak_is_quarantined_and_a_good_one_retires_its_bak() {
    for (main, bak) in [
        (b"{\"rooms\":".as_slice(), None),
        (b"{\"rooms\":".as_slice(), Some(b"also damaged".as_slice())),
        (b"{\"rooms\":".as_slice(), Some(b"[1]".as_slice())),
    ] {
        let mut files = vec![("agent-rooms.json", main)];
        files.extend(bak.map(|bak| ("agent-rooms.json.bak", bak)));
        let run = Run::new(None, &files, &BTreeSet::new());
        let report = run.migrate_all();
        assert_eq!(report.quarantined, [("desktopProfile/agentRooms".to_owned(), QuarantineCode::ParseError)]);
    }
    let run = Run::new(None, &[("agent-rooms.json", b"{\"rooms\":{}}"), ("agent-rooms.json.bak", b"{\"rooms\":{}}")], &BTreeSet::new());
    let keys: Vec<_> = run.items().map(|item| item.key.as_str()).collect();
    assert_eq!(keys, ["desktopProfile/agentRooms", "retire/profile/agent-rooms.json.bak"]);
}

#[test]
fn a_bak_without_its_file_is_ignored_by_the_desktop_and_retires() {
    let run = Run::new(None, &[("desktop-projects.json.bak", br#"{"version":2,"aliases":{},"hidden":[]}"#)], &BTreeSet::new());
    assert_eq!(run.items().count(), 0);
}

#[test]
fn a_profile_that_does_not_exist_has_no_items() {
    let missing = Run::new(None, &[], &BTreeSet::new());
    assert_eq!(missing.items().count(), 0);
    let mut roots = missing.roots.clone();
    roots.profile = None;
    let mut sink = PlanSink::new(&roots);
    missing.driver.plan(&roots, &mut sink).unwrap();
    assert_eq!(sink.items().count(), 0);
}

#[test]
fn secret_files_are_owner_only_and_plain_files_are_not() {
    let work = TempDir::new().unwrap();
    let secret = work.path().join("secret.json");
    let plain = work.path().join("plain.json");
    fsx::write_new(&secret, b"{}", true).unwrap();
    fsx::write_new(&plain, b"{}", false).unwrap();
    assert!(fsx::is_owner_only(&secret).unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(!fsx::is_owner_only(&plain).unwrap());
    // A rename keeps the access control the file was created with.
    let moved = work.path().join("moved").join("secret.json");
    durable::create_dir_all(moved.parent().unwrap()).unwrap();
    durable::durable_rename(&secret, &moved).unwrap();
    assert!(fsx::is_owner_only(&moved).unwrap());
}

#[test]
fn the_config_stays_owner_only_after_an_item_is_withdrawn_for_quarantine() {
    let run = Run::new(None, &[("agent-greetings.json", br#"{"seen":["a"]}"#)], &BTreeSet::new());
    let item = run.item(ItemKind::AgentGreetings);
    assert!(matches!(run.migrate_item(item).unwrap(), Outcome::Verified(_)));
    let config = run.roots.data.join(config_values::CONFIG_FILE);
    assert!(fsx::is_owner_only(&config).unwrap(), "published");
    run.driver.withdraw(&run.cx(), item).unwrap();
    let doc: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
    let Some(Target::ConfigKey { key }) = &item.target else {
        panic!("no config key");
    };
    assert!(doc.pointer(&format!("/{}", key.replace('.', "/"))).is_none(), "{key} is withdrawn");
    assert!(fsx::is_owner_only(&config).unwrap(), "republished by withdraw");
}

#[cfg(unix)]
#[test]
fn a_secret_file_is_created_with_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let work = TempDir::new().unwrap();
    let secret = work.path().join("secret.json");
    fsx::write_new(&secret, b"{}", true).unwrap();
    assert_eq!(std::fs::metadata(&secret).unwrap().permissions().mode() & 0o777, 0o600);
    let copy = work.path().join("copy.json");
    fsx::copy_new(&secret, &copy, true).unwrap();
    assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn every_step_is_idempotent_so_a_resume_after_a_crash_reenters_it() {
    for (name, content) in [
        ("agent-greetings.json", br#"{"seen":["b","a"]}"#.as_slice()),
        ("desktop-projects.json", br#"{"version":2,"aliases":{"C:/p":"P"},"hidden":["C:/q"]}"#.as_slice()),
        ("relay-device.json", br#"{"deviceId":"x","deviceSecret":"y"}"#.as_slice()),
    ] {
        let run = Run::new(None, &[(name, content)], &BTreeSet::new());
        let item = run.items().next().unwrap();
        let cx = run.cx();
        let first = run.stage(item).unwrap();
        let entry = Run::entry(item, &first);
        run.driver.publish(&cx, item, &entry).unwrap();
        // Crash before `published` was journaled: stage and publish run again.
        let second = run.stage(item).unwrap();
        assert_eq!(first, second, "{name}");
        run.driver.publish(&cx, item, &Run::entry(item, &second)).unwrap();
        run.driver.publish(&cx, item, &entry).unwrap();
        let verdict = run.driver.verify(&cx, item).unwrap();
        assert_eq!(run.driver.verify(&cx, item).unwrap(), verdict, "{name}");
    }
}

#[test]
fn a_damaged_or_wrongly_shaped_source_is_quarantined_not_blocked() {
    for (name, content, code) in [
        ("agent-rooms.json", b"[1]".as_slice(), QuarantineCode::SchemaViolation),
        ("notification-preferences.json", br#"{"version":9}"#.as_slice(), QuarantineCode::SchemaViolation),
        ("relay-device.json", b"{not json".as_slice(), QuarantineCode::ParseError),
        ("remote-activated.json", br#"{"other":1}"#.as_slice(), QuarantineCode::SchemaViolation),
    ] {
        let run = Run::new(None, &[(name, content)], &BTreeSet::new());
        let item = run.items().next().unwrap();
        let Ok(Stage::Quarantine { code: found, .. }) = run.stage(item) else {
            panic!("{name} should quarantine");
        };
        assert_eq!(found, code, "{name}");
    }
}

#[test]
fn a_source_changed_after_planning_blocks_and_a_foreign_target_conflicts() {
    let run = Run::new(None, &[("relay-e2ee.json", br#"{"version":1}"#)], &BTreeSet::new());
    let item = run.items().next().unwrap();
    let cx = run.cx();

    std::fs::create_dir_all(run.data.path().join("remote")).unwrap();
    std::fs::write(run.data.path().join("remote/e2ee.json"), b"{\"other\":1}").unwrap();
    let staged = run.stage(item).unwrap();
    let Err(Blocked::TargetConflict { .. }) = run.driver.publish(&cx, item, &Run::entry(item, &staged)) else {
        panic!("a different file at the target must conflict");
    };

    std::fs::write(run.profile.path().join("relay-e2ee.json"), br#"{"version":2}"#).unwrap();
    let Err(Blocked::SourceChanged { .. }) = run.stage(item) else {
        panic!("a changed source must block");
    };
}

#[test]
fn lone_surrogates_in_a_room_are_replaced_and_counted() {
    let run = Run::new(
        None,
        &[("agent-rooms.json", br#"{"rooms":{"r1":{"id":"r1","lastPreview":"cut \ud83d","running":{"startedAt":1}}}}"#)],
        &BTreeSet::new(),
    );
    let item = run.items().next().unwrap();
    let staged = run.stage(item).unwrap();
    let Stage::Output { replaced_surrogates, .. } = &staged else {
        panic!("staged");
    };
    assert_eq!(*replaced_surrogates, 1);
    run.driver.publish(&run.cx(), item, &Run::entry(item, &staged)).unwrap();
    assert!(matches!(run.driver.verify(&run.cx(), item).unwrap(), Verdict::Verified { .. }));
    let connection = rusqlite::Connection::open(run.data.path().join("state/core.sqlite")).unwrap();
    let doc: String = connection.query_row("SELECT doc FROM rooms", [], |row| row.get(0)).unwrap();
    let doc: Value = serde_json::from_str(&doc).unwrap();
    assert_eq!(doc["lastPreview"], "cut \u{fffd}");
    assert_eq!(doc["running"], Value::Null);
}

#[test]
fn file_order_is_kept_for_the_config_and_the_alias_cap() {
    // 250 aliases written in descending order: the cap keeps the first 200 of the file.
    let aliases: Vec<String> = (0..250).rev().map(|n| format!("\"/p{n:03}\":\"a{n}\"")).collect();
    let projects = format!("{{\"version\":2,\"aliases\":{{{}}},\"hidden\":[]}}", aliases.join(","));
    let run = Run::new(
        None,
        &[("desktop-projects.json", projects.as_bytes()), ("agent-greetings.json", br#"{"seen":["x"]}"#)],
        &BTreeSet::new(),
    );
    std::fs::write(run.data.path().join("mixdog-config.json"), br#"{"zeta":1,"alpha":{"b":1,"a":2}}"#).unwrap();
    run.migrate_all();
    let connection = rusqlite::Connection::open(run.data.path().join("state/core.sqlite")).unwrap();
    let kept: Vec<String> = connection
        .prepare("SELECT path FROM projects ORDER BY path")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(kept.len(), 200);
    assert_eq!((kept.first().map(String::as_str), kept.last().map(String::as_str)), (Some("/p050"), Some("/p249")));
    let text = std::fs::read_to_string(run.data.path().join("mixdog-config.json")).unwrap();
    let zeta = text.find("zeta").unwrap();
    let alpha = text.find("alpha").unwrap();
    let greeted = text.find("agents").unwrap();
    assert!(zeta < alpha && alpha < greeted, "file order lost: {text}");
    assert!(text.find("\"b\"").unwrap() < text.find("\"a\"").unwrap());
}

#[test]
fn only_planned_names_are_enumerated() {
    let mut files: Vec<(&str, &[u8])> = Vec::new();
    for name in [
        "last-launch-version",
        "window-state.json",
        "pane-layout.json",
        "desktop-pet.json",
        "browser-password-vault.bin",
        "remote-hosts.json",
        "unknown.json",
        ".desktop-session-metadata.json.nothex.tmp",
    ] {
        files.push((name, b"x"));
    }
    files.push((".desktop-session-metadata.json.0123456789abcdef01234567.tmp", b"x"));
    let run = Run::new(None, &files, &BTreeSet::new());
    let keys: Vec<_> = run.items().map(|item| item.key.as_str()).collect();
    assert_eq!(keys, ["retire/profile/.desktop-session-metadata.json.0123456789abcdef01234567.tmp"]);
}

// ── the framework's own run: complete marker, crash matrix, rename failure ──────────

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crate::framework::FaultHook;
use crate::run::MigrateOptions;
use crate::run::Migrator;

/// A data dir and a profile at fixed paths, so the manifest (which names its roots) is
/// the same in every run of the matrix.
struct Work {
    dir: TempDir,
}

impl Work {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    /// Wipes the work dir and lays down a fresh copy of the corpus profile.
    fn prepare(&self, corpus: &Path) -> MigrationRoots {
        for name in ["data", "profile", "home"] {
            durable::remove_dir_all(&self.dir.path().join(name)).unwrap();
        }
        copy_tree(&corpus.join("electron-profile"), &self.dir.path().join("profile"));
        durable::create_dir_all(&self.dir.path().join("data")).unwrap();
        MigrationRoots {
            data: self.dir.path().join("data"),
            home: self.dir.path().join("home"),
            profile: Some(self.dir.path().join("profile")),
        }
    }
}

fn migrator(roots: &MigrationRoots, fault: Option<FaultHook>) -> Migrator {
    Migrator::new(
        roots.clone(),
        vec![Arc::new(DesktopProfileDriver::new())],
        MigrateOptions { workers: 1, fault },
    )
}

/// The final state: every file of both trees by path and hash (the journal and the
/// SQLite files excluded), and the rows of `state/core.sqlite`.
fn final_state(roots: &MigrationRoots) -> String {
    let mut lines = Vec::new();
    for (label, root) in [("data", &roots.data), ("profile", roots.profile.as_ref().unwrap())] {
        for (name, path) in files_of(root) {
            if name.starts_with("migration/journal") || name.starts_with("state/core.sqlite") {
                continue;
            }
            lines.push(format!("{label}/{name} {}", hash_of(&path)));
        }
    }
    let database = roots.data.join("state/core.sqlite");
    if database.exists() {
        let connection = rusqlite::Connection::open(database).unwrap();
        for sql in [
            "SELECT path, alias, hidden, hidden_rank FROM projects ORDER BY path",
            "SELECT room_id, doc FROM rooms ORDER BY room_id",
            "SELECT key, value FROM meta ORDER BY key",
        ] {
            let mut select = connection.prepare(sql).unwrap();
            let rows: Vec<String> = select
                .query_map([], |row| {
                    let cells: Vec<String> = (0..row.as_ref().column_count())
                        .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                        .collect();
                    Ok(cells.join("|"))
                })
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap();
            lines.extend(rows.into_iter().map(|row| format!("sql {row}")));
        }
    }
    lines.join("\n")
}

#[test]
fn the_migrator_completes_the_corpus_profile_with_nothing_quarantined_unexpectedly() {
    let corpus = corpus_root();
    let work = Work::new();
    let roots = work.prepare(&corpus);
    let complete = migrator(&roots, None).run().unwrap();
    let counts = complete.kinds.desktop_profile;
    let quarantined = files_of(&roots.data.join("quarantine")).into_keys().collect::<Vec<_>>();
    assert_eq!(counts.quarantined_unexpected, 0, "{quarantined:?}");
    assert_eq!(counts.verified, CORPUS_KEYS.len() as u64 - 1);
    assert_eq!(counts.retired, 10);
    assert!(counts.dangling > 0);
    assert_eq!(complete.kinds.data.verified, 0);
    // A finished migration answers from its marker.
    assert_eq!(migrator(&roots, None).run().unwrap(), complete);
}

const CHILD_ROOT: &str = "MIXDOG_CRASH_CHILD_ROOT";
const CHILD_KILL_AT: &str = "MIXDOG_CRASH_CHILD_KILL_AT";

fn roots_in(dir: &Path) -> MigrationRoots {
    MigrationRoots {
        data: dir.join("data"),
        home: dir.join("home"),
        profile: Some(dir.join("profile")),
    }
}

/// The child half of the crash matrix: a no-op in a normal run. Launched by the matrix
/// with the work dir and the index of the fault point, it runs the migration and dies
/// there like a killed process: no unwinding, no destructors, no buffered state saved.
#[test]
fn crash_child() {
    let Some(dir) = std::env::var_os(CHILD_ROOT) else {
        return;
    };
    let kill_at: usize = std::env::var(CHILD_KILL_AT).unwrap().parse().unwrap();
    let seen = Arc::new(AtomicUsize::new(0));
    let hook: FaultHook = Arc::new(move |_| {
        if seen.fetch_add(1, Ordering::SeqCst) == kill_at {
            kill_self();
        }
        Ok(())
    });
    let _ = migrator(&roots_in(Path::new(&dir)), Some(hook)).run();
    // Reached only when the fault point was never hit.
    std::process::exit(0);
}

/// Ends this process the way a kill does. Not `abort`: on Windows it is a fail-fast that
/// starts Windows Error Reporting, which holds every child for seconds.
fn kill_self() -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        use windows_sys::Win32::System::Threading::TerminateProcess;
        // SAFETY: the pseudo-handle of this process is always valid.
        unsafe { TerminateProcess(GetCurrentProcess(), 1) };
    }
    std::process::abort()
}

/// The longest one child migration of the corpus may take before the matrix fails.

/// Runs the migration in a child process that dies at fault point `kill_at`.
fn run_child_killed_at(work: &Path, kill_at: usize) -> std::process::ExitStatus {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("{}::crash_child", module_path!().trim_start_matches("mixdog_migrate::")), "--nocapture", "--test-threads=1"])
        .env(CHILD_ROOT, work)
        .env(CHILD_KILL_AT, kill_at.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    // The child kills itself at `kill_at`; its exit is what is waited for.
    child.wait().unwrap()
}

/// Work dirs the fault points are split over. A kill-and-resume of one point shares nothing
/// with another's, and a run is bound by its journal and publication syncs, not by the
/// processor, so the points of different dirs overlap their waits.
const MATRIX_WORKERS: usize = 8;

/// Kills the migration in a child at each of `points[worker]`, `points[worker + MATRIX_WORKERS]`,
/// ... in a work dir of its own, resumes it and compares with that dir's uninterrupted run (the
/// manifest names the dir's roots, so the state differs from dir to dir).
fn kill_and_resume_each_point(corpus: &Path, points: &[String], worker: usize) {
    let work = Work::new();
    let roots = work.prepare(corpus);
    migrator(&roots, None).run().unwrap();
    let expected = final_state(&roots);

    for (kill_at, point) in points.iter().enumerate().skip(worker).step_by(MATRIX_WORKERS) {
        let roots = work.prepare(corpus);
        let status = run_child_killed_at(work.dir.path(), kill_at);
        assert!(!status.success(), "the child survived the kill at {kill_at} ({point})");
        // The marker is written between `complete:before` and `complete:after`: a kill at
        // any earlier point must leave none, and a kill at the last point must find it.
        assert_eq!(
            roots.data.join("migration/complete.json").exists(),
            point == "complete:after",
            "complete.json after a kill at {kill_at} ({point})"
        );
        migrator(&roots, None)
            .run()
            .unwrap_or_else(|error| panic!("resume after {point}: {error}"));
        assert_eq!(final_state(&roots), expected, "after a kill at {point}");
    }
}

#[test]
fn the_crash_matrix_ends_in_the_state_of_an_uninterrupted_run() {
    let corpus = corpus_root();
    let work = Work::new();

    let roots = work.prepare(&corpus);
    let points = Arc::new(Mutex::new(Vec::<String>::new()));
    let record = Arc::clone(&points);
    let recorder: FaultHook = Arc::new(move |point| {
        record.lock().unwrap().push(point.to_owned());
        Ok(())
    });
    migrator(&roots, Some(recorder)).run().unwrap();
    let points = points.lock().unwrap().clone();
    assert!(points.len() > 100, "{} fault points", points.len());

    std::thread::scope(|scope| {
        for worker in 0..MATRIX_WORKERS {
            let (corpus, points) = (&corpus, &points);
            scope.spawn(move || kill_and_resume_each_point(corpus, points, worker));
        }
    });
}

#[test]
fn a_failing_rename_blocks_the_run_and_the_retry_completes_it() {
    let corpus = corpus_root();
    let work = Work::new();
    let roots = work.prepare(&corpus);
    migrator(&roots, None).run().unwrap();
    let expected = final_state(&roots);

    let roots = work.prepare(&corpus);
    // A file where the moved identity files need a directory.
    std::fs::write(roots.data.join("remote"), b"in the way").unwrap();
    let Err(Blocked::Io { op, .. }) = migrator(&roots, None).run() else {
        panic!("the run must be blocked");
    };
    assert!(!op.is_empty());
    assert!(!roots.data.join("migration/complete.json").exists());
    assert!(roots.profile.as_ref().unwrap().join("relay-device.json").exists());

    std::fs::remove_file(roots.data.join("remote")).unwrap();
    migrator(&roots, None).run().unwrap();
    assert_eq!(final_state(&roots), expected);
}

/// The destination of the config publish is held open without `FILE_SHARE_DELETE`, so
/// the rename over it itself fails; once the handle is released the retry completes.
#[cfg(windows)]
#[test]
fn a_rename_onto_an_open_destination_fails_and_the_retry_recovers() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;

    let corpus = corpus_root();
    let work = Work::new();
    let roots = work.prepare(&corpus);
    std::fs::write(roots.data.join(config_values::CONFIG_FILE), b"{}").unwrap();
    migrator(&roots, None).run().unwrap();
    let expected = final_state(&roots);

    let roots = work.prepare(&corpus);
    let config = roots.data.join(config_values::CONFIG_FILE);
    std::fs::write(&config, b"{}").unwrap();
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .open(&config)
        .unwrap();
    let Err(Blocked::Io { op, path, .. }) = migrator(&roots, None).run() else {
        panic!("the run must be blocked by the rename");
    };
    assert_eq!(op, "rename");
    assert_eq!(path.file_name(), config.file_name());
    assert!(!roots.data.join("migration/complete.json").exists());
    drop(held);

    migrator(&roots, None).run().unwrap();
    assert_eq!(final_state(&roots), expected);
}