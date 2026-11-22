//! Generation 2 of the desktop-profile move: the SSH hosts, port forwards, paired PCs and server windows a profile holds
//! move to `<D>/desktop/` after the first pass, in the same start or a later one, crash-safe and without overwriting.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_migrate::desktop_profile::DesktopProfileDriver;
use mixdog_migrate::desktop_profile::supplement;
use mixdog_migrate::error::Blocked;
use mixdog_migrate::framework::FaultHook;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_store::schema::migration::PROFILE_GEN_PATH;
use serde_json::Value;

struct Dirs {
    root: tempfile::TempDir,
}

impl Dirs {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("scratch dir");
        for dir in ["data", "home", "profile"] {
            std::fs::create_dir_all(root.path().join(dir)).expect("dir");
        }
        Self { root }
    }

    fn data(&self) -> PathBuf {
        self.root.path().join("data")
    }

    fn profile(&self) -> PathBuf {
        self.root.path().join("profile")
    }

    fn roots(&self) -> MigrationRoots {
        MigrationRoots { data: self.data(), home: self.root.path().join("home"), profile: Some(self.profile()) }
    }

    fn put(&self, name: &str, bytes: &[u8]) {
        std::fs::write(self.profile().join(name), bytes).expect("profile file");
    }

    fn marker(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.data().join(PROFILE_GEN_PATH)).expect("marker")).expect("marker json")
    }

    fn moved(&self, target: &str) -> Option<Vec<u8>> {
        std::fs::read(self.data().join("desktop").join(target)).ok()
    }
}

fn migrator(roots: &MigrationRoots, fault: Option<FaultHook>) -> Migrator {
    Migrator::new(roots.clone(), vec![Arc::new(DesktopProfileDriver::new())], MigrateOptions { workers: 1, fault, verified: None, retention: None })
}

fn stop_at(point: &'static str) -> FaultHook {
    Arc::new(move |at| if at == point { Err(Blocked::Interrupted { point: at.to_owned() }) } else { Ok(()) })
}

fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[test]
fn gen2_after_gen1_with_profile() {
    let dirs = Dirs::new();
    let roots = dirs.roots();
    migrator(&roots, None).run().expect("first pass");
    // A data dir the first pass completed (generation 1 only): no marker.
    std::fs::remove_file(dirs.data().join(PROFILE_GEN_PATH)).expect("marker of the first run");
    dirs.put("ssh-hosts.json", b"{\"hosts\":[1]}");
    dirs.put("ssh-hosts.json.bak", b"{\"hosts\":[]}");
    dirs.put("port-forwards.json", b"{\"version\":1,\"hosts\":{}}");
    dirs.put("remote-hosts.json", b"{\"hosts\":[\"secret\"]}");
    dirs.put("server-windows.json", b"{\"windows\":[]}");

    migrator(&roots, None).run().expect("a later start");

    assert_eq!(dirs.moved("ssh-hosts.json").as_deref(), Some(&b"{\"hosts\":[1]}"[..]));
    assert_eq!(dirs.moved("ssh-hosts.json.bak").as_deref(), Some(&b"{\"hosts\":[]}"[..]));
    assert_eq!(dirs.moved("port-forwards.json").as_deref(), Some(&b"{\"version\":1,\"hosts\":{}}"[..]));
    assert_eq!(dirs.moved("remote-hosts.json").as_deref(), Some(&b"{\"hosts\":[\"secret\"]}"[..]));
    assert_eq!(dirs.moved("server-windows.json").as_deref(), Some(&b"{\"windows\":[]}"[..]));
    for name in ["ssh-hosts.json", "ssh-hosts.json.bak", "port-forwards.json", "remote-hosts.json", "server-windows.json"] {
        assert!(!exists(&dirs.profile().join(name)), "{name} still in the profile");
    }
    assert_eq!(dirs.marker()["generation"], supplement::GENERATION);
    assert!(!exists(&dirs.data().join("migration/profile-gen-stage")));
}

#[test]
fn gen2_in_same_start_as_first_run() {
    let dirs = Dirs::new();
    dirs.put("ssh-hosts.json", b"{\"hosts\":[2]}");
    dirs.put("server-windows.json", b"{\"windows\":[1]}");

    migrator(&dirs.roots(), None).run().expect("first run");

    assert_eq!(dirs.moved("ssh-hosts.json").as_deref(), Some(&b"{\"hosts\":[2]}"[..]));
    assert_eq!(dirs.moved("server-windows.json").as_deref(), Some(&b"{\"windows\":[1]}"[..]));
    assert!(!exists(&dirs.profile().join("ssh-hosts.json")));
    let marker = dirs.marker();
    assert_eq!(marker["generation"], supplement::GENERATION);
    assert_eq!(marker["items"].as_array().expect("items").len(), 2);
}

#[test]
fn gen2_skips_when_marker_current() {
    let dirs = Dirs::new();
    migrator(&dirs.roots(), None).run().expect("first run");
    assert_eq!(dirs.marker()["generation"], supplement::GENERATION);
    dirs.put("ssh-hosts.json", b"{\"hosts\":[3]}");

    migrator(&dirs.roots(), None).run().expect("a later start");
    let outcome = supplement::run(&dirs.roots()).expect("supplement");

    assert_eq!(outcome.generation, supplement::GENERATION);
    assert!(outcome.moved.is_empty());
    assert!(exists(&dirs.profile().join("ssh-hosts.json")));
    assert_eq!(dirs.moved("ssh-hosts.json"), None);
}

#[test]
fn gen2_crash_between_publish_and_delete_resumes() {
    let dirs = Dirs::new();
    migrator(&dirs.roots(), None).run().expect("first run");
    std::fs::remove_file(dirs.data().join(PROFILE_GEN_PATH)).expect("marker");
    dirs.put("remote-hosts.json", b"{\"hosts\":[\"x\"]}");

    let cut = migrator(&dirs.roots(), Some(stop_at("supplement:delete:remote-hosts.json:before")));
    assert!(cut.run().is_err(), "the run is cut before the delete");
    // The target is published, the source is still in the profile, the marker says published.
    assert_eq!(dirs.moved("remote-hosts.json").as_deref(), Some(&b"{\"hosts\":[\"x\"]}"[..]));
    assert!(exists(&dirs.profile().join("remote-hosts.json")));
    assert_eq!(dirs.marker()["generation"], 1);
    assert_eq!(dirs.marker()["items"][0]["state"], "published");

    migrator(&dirs.roots(), None).run().expect("the resume");

    assert!(!exists(&dirs.profile().join("remote-hosts.json")));
    assert_eq!(dirs.moved("remote-hosts.json").as_deref(), Some(&b"{\"hosts\":[\"x\"]}"[..]));
    assert_eq!(dirs.marker()["generation"], supplement::GENERATION);
}

#[test]
fn gen2_crash_before_publish_resumes_from_the_stage() {
    let dirs = Dirs::new();
    migrator(&dirs.roots(), None).run().expect("first run");
    std::fs::remove_file(dirs.data().join(PROFILE_GEN_PATH)).expect("marker");
    dirs.put("port-forwards.json", b"{\"version\":1,\"hosts\":{\"a\":[]}}");

    let cut = migrator(&dirs.roots(), Some(stop_at("supplement:publish:port-forwards.json:before")));
    assert!(cut.run().is_err());
    assert_eq!(dirs.moved("port-forwards.json"), None);
    assert_eq!(dirs.marker()["items"][0]["state"], "staged");

    migrator(&dirs.roots(), None).run().expect("the resume");

    assert_eq!(dirs.moved("port-forwards.json").as_deref(), Some(&b"{\"version\":1,\"hosts\":{\"a\":[]}}"[..]));
    assert!(!exists(&dirs.profile().join("port-forwards.json")));
}

#[test]
fn gen2_never_reads_other_files() {
    let dirs = Dirs::new();
    let others = [
        ("window-state.json", &b"{\"x\":1}"[..]),
        ("window-state-2.json", &b"{\"x\":2}"[..]),
        ("pane-layout.json", &b"{\"p\":1}"[..]),
        ("desktop-pet.json", &b"{\"pet\":1}"[..]),
        ("browser-password-vault.bin", &b"vault"[..]),
        ("unknown.json", &b"{}"[..]),
    ];
    for (name, bytes) in others {
        dirs.put(name, bytes);
    }
    dirs.put("ssh-hosts.json", b"{\"hosts\":[4]}");

    migrator(&dirs.roots(), None).run().expect("first run");

    for (name, bytes) in others {
        assert_eq!(std::fs::read(dirs.profile().join(name)).expect(name), bytes, "{name} was touched");
    }
    let marker = dirs.marker();
    let files: Vec<&str> = marker["items"].as_array().expect("items").iter().map(|item| item["file"].as_str().expect("file")).collect();
    assert_eq!(files, ["ssh-hosts.json"]);
}

#[test]
fn gen2_conflicting_target_kept() {
    let dirs = Dirs::new();
    std::fs::create_dir_all(dirs.data().join("desktop")).expect("desktop dir");
    std::fs::write(dirs.data().join("desktop/ssh-hosts.json"), b"{\"hosts\":[\"core\"]}").expect("existing target");
    dirs.put("ssh-hosts.json", b"{\"hosts\":[\"old\"]}");
    dirs.put("port-forwards.json", b"{\"version\":1,\"hosts\":{}}");

    migrator(&dirs.roots(), None).run().expect("first run");

    assert_eq!(dirs.moved("ssh-hosts.json").as_deref(), Some(&b"{\"hosts\":[\"core\"]}"[..]));
    assert!(!exists(&dirs.profile().join("ssh-hosts.json")));
    assert_eq!(std::fs::read(dirs.profile().join("ssh-hosts.json.superseded")).expect("set aside"), b"{\"hosts\":[\"old\"]}");
    // The other file moved as usual.
    assert!(dirs.moved("port-forwards.json").is_some());
    assert_eq!(dirs.marker()["generation"], supplement::GENERATION);
}

// JSONC is the user-editable Electron settings format; preserve its comments and trailing comma.
const EDITOR_SETTINGS: &[u8] = b"{\n // personal settings\n \"editor.tabSize\": 2,\n \"editor.insertSpaces\": false,\n}\n";

fn gen2_settings_profile(dirs: &Dirs) {
    std::fs::create_dir_all(dirs.profile().join("User")).unwrap();
    dirs.put("User/settings.json", EDITOR_SETTINGS);
    dirs.put("User/settings.json.bak", b"{\"editor.tabSize\": 8}");
    std::fs::create_dir_all(dirs.data().join("migration")).unwrap();
    let marker = serde_json::json!({ "generation": 2, "profile": dirs.profile(), "items": [] });
    std::fs::write(dirs.data().join(PROFILE_GEN_PATH), serde_json::to_vec(&marker).unwrap()).unwrap();
}

#[test]
fn gen3_completed_gen2_settings_apply_and_resume_at_each_step() {
    for point in [
        "supplement:extend:before",
        "supplement:stage:User/settings.json:before",
        "supplement:publish:User/settings.json:before",
        "supplement:delete:User/settings.json:before",
        "supplement:done:before",
    ] {
        let dirs = Dirs::new();
        gen2_settings_profile(&dirs);
        // A generation upgrade must not pick up an unrelated old-generation source again.
        dirs.put("ssh-hosts.json", b"new source after gen2");
        let fault = stop_at(point);
        assert!(supplement::run_with(&dirs.roots(), &|at| fault(at)).is_err(), "{point}");
        // Resume from the recorded profile even when the caller names another one.
        let roots = MigrationRoots { profile: Some(dirs.root.path().join("other")), ..dirs.roots() };
        supplement::run(&roots).unwrap();
        assert_eq!(dirs.marker()["generation"], supplement::GENERATION);
        assert_eq!(std::fs::read(dirs.data().join("userdata/User/settings.json")).unwrap(), EDITOR_SETTINGS);
        assert_eq!(std::fs::read(dirs.data().join("userdata/User/settings.json.bak")).unwrap(), b"{\"editor.tabSize\": 8}");
        let settings = mixdog_workspace::editorcfg::read_editor_settings(&dirs.data().join("userdata"), dirs.root.path(), "a.ts", None, None).unwrap();
        assert_eq!(settings["tabSize"], 2);
        assert_eq!(settings["insertSpaces"], false);
        assert!(exists(&dirs.profile().join("ssh-hosts.json")));
        let marker = std::fs::read(dirs.data().join(PROFILE_GEN_PATH)).unwrap();
        assert!(supplement::run(&roots).unwrap().moved.is_empty());
        assert_eq!(std::fs::read(dirs.data().join(PROFILE_GEN_PATH)).unwrap(), marker);
    }
}

#[test]
fn gen3_extends_interrupted_older_plan_without_resetting_staged_bytes() {
    let dirs = Dirs::new();
    dirs.put("remote-hosts.json", b"original remote hosts");
    let fault = stop_at("supplement:publish:remote-hosts.json:before");
    assert!(supplement::run_with(&dirs.roots(), &|at| fault(at)).is_err());
    let old_item = dirs.marker()["items"][0].clone();
    assert_eq!(old_item["state"], "staged");
    std::fs::create_dir_all(dirs.profile().join("User")).unwrap();
    dirs.put("User/settings.json", EDITOR_SETTINGS);
    dirs.put("remote-hosts.json", b"changed source survives");
    let fault = stop_at("supplement:publish:remote-hosts.json:before");
    assert!(supplement::run_with(&dirs.roots(), &|at| fault(at)).is_err());
    assert_eq!(dirs.marker()["items"][0], old_item);
    supplement::run(&dirs.roots()).unwrap();
    assert_eq!(dirs.moved("remote-hosts.json").unwrap(), b"original remote hosts");
    assert_eq!(std::fs::read(dirs.profile().join("remote-hosts.json")).unwrap(), b"changed source survives");
    assert_eq!(std::fs::read(dirs.data().join("userdata/User/settings.json")).unwrap(), EDITOR_SETTINGS);
    assert_eq!(dirs.marker()["items"].as_array().unwrap().len(), 2);
}

#[test]
fn gen3_existing_editor_settings_win_and_old_bytes_are_preserved() {
    let dirs = Dirs::new();
    gen2_settings_profile(&dirs);
    let target = dirs.data().join("userdata/User/settings.json");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"{\"editor.tabSize\": 4}").unwrap();
    dirs.put("User/settings.json.superseded", b"previously preserved settings");
    supplement::run(&dirs.roots()).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"{\"editor.tabSize\": 4}");
    assert_eq!(std::fs::read(dirs.profile().join("User/settings.json.superseded")).unwrap(), b"previously preserved settings");
    assert_eq!(std::fs::read(dirs.profile().join("User/settings.json.superseded.1")).unwrap(), EDITOR_SETTINGS);
    std::fs::remove_file(&target).unwrap();
    supplement::run(&dirs.roots()).unwrap();
    assert!(!target.exists(), "a deleted current setting is never re-imported");
}
