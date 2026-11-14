//! The upgrade chain of the desktop-profile files over the recorded 1.4.5 directory: a 1.4.5 profile (synthetic files in
//! the formats 1.4.5 wrote, `tests/vectors/profile-145-supplement`) reaches the current layout in one start, after a start
//! that only migrated generation 1 (what 1.5.0 left), or when the core adopts the profile later (a TUI or standalone start
//! came first). Every move is one way: the sources leave the profile for `<D>/desktop/`.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_migrate::desktop_profile::supplement;
use mixdog_migrate::durable;
use mixdog_migrate::durable::Step;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::run::MigrateOptions;
use mixdog_store::schema::migration::COMPLETE_PATH;
use mixdog_store::schema::migration::Complete;
use mixdog_store::schema::migration::LATE_MANIFEST_PATH;
use mixdog_store::schema::migration::PROFILE_GEN_PATH;
use serde_json::Value;

use crate::recorded_145_support::*;

/// What a 1.4.5 profile holds of the second generation, each `.bak` the desktop's atomic writer kept beside its file.
const FILES: [&str; 6] = [
    "port-forwards.json",
    "port-forwards.json.bak",
    "remote-hosts.json",
    "server-windows.json",
    "ssh-hosts.json",
    "ssh-hosts.json.bak",
];

fn vector_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/profile-145-supplement/profile")
}

fn vector(name: &str) -> Vec<u8> {
    std::fs::read(vector_dir().join(name)).unwrap_or_else(|e| panic!("vector {name}: {e}"))
}

/// The roots of a recorded directory copied under `base`, with the profile named (`<base>/profile`).
fn named_roots(base: &Path) -> MigrationRoots {
    MigrationRoots { profile: Some(base.join("profile")), ..roots_at(base) }
}

/// `<base>/profile`, empty or holding the vector files.
fn put_profile(base: &Path, files: bool) {
    let profile = base.join("profile");
    std::fs::create_dir_all(&profile).expect("profile dir");
    if files {
        for name in FILES {
            std::fs::write(profile.join(name), vector(name)).expect("profile file");
        }
    }
}

fn start(roots: &MigrationRoots) {
    migrator(roots, MigrateOptions::default()).run().expect("the start completes");
}

fn marker(roots: &MigrationRoots) -> Value {
    serde_json::from_slice(&std::fs::read(roots.data.join(PROFILE_GEN_PATH)).expect("marker")).expect("marker json")
}

fn desktop(roots: &MigrationRoots, name: &str) -> Option<Vec<u8>> {
    std::fs::read(roots.data.join("desktop").join(name)).ok()
}

fn digest_of(dir: &Path) -> Vec<(String, String)> {
    let mut rows: Vec<_> = durable::walk_files(dir)
        .expect("walk")
        .into_iter()
        .map(|rel| {
            let sha = durable::hash_file(&dir.join(&rel)).expect("hash").1;
            (rel, sha)
        })
        .collect();
    rows.sort();
    rows
}

fn profile_files(base: &Path) -> Vec<String> {
    let mut names = durable::walk_files(&base.join("profile")).expect("walk the profile");
    names.sort();
    names
}

/// Every file stands at its target with the bytes it had, the profile holds none of them, and the stage is gone.
fn assert_all_moved(base: &Path) {
    let roots = named_roots(base);
    for name in FILES {
        assert_eq!(desktop(&roots, name), Some(vector(name)), "{name} at its target");
    }
    assert_eq!(profile_files(base), Vec::<String>::new(), "the profile still holds a moved file");
    assert!(!roots.data.join("migration/profile-gen-stage").exists(), "the stage was left");
}

#[test]
fn v145_to_current_one_start() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let base = scratch.path();
    copy_at(base);
    put_profile(base, true);
    let roots = named_roots(base);

    start(&roots);

    assert_all_moved(base);
    let marker = marker(&roots);
    assert_eq!(marker["generation"], 2);
    let mut seen: Vec<(String, bool)> = marker["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| (item["file"].as_str().expect("file").to_owned(), item["secret"].as_bool().expect("secret")))
        .collect();
    seen.sort();
    let want: Vec<(String, bool)> = FILES.iter().map(|name| ((*name).to_owned(), *name == "remote-hosts.json")).collect();
    assert_eq!(seen, want, "the paired PCs are the one secret");
    assert!(
        mixdog_store::fsio::is_owner_only(&roots.data.join("desktop/remote-hosts.json")).expect("access"),
        "the paired PCs' file is owner-only at its target"
    );
    let complete: Complete = serde_json::from_slice(&std::fs::read(roots.data.join(COMPLETE_PATH)).expect("complete")).expect("json");
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0, "the recorded data migrated whole");

    // A later start changes nothing.
    let tree = tree_digest(&roots);
    start(&roots);
    assert_eq!(tree_digest(&roots), tree);
    assert_all_moved(base);
}

#[test]
fn v145_gen1_then_gen2_next_start() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let base = scratch.path();
    copy_at(base);
    put_profile(base, false);
    let roots = named_roots(base);
    // 1.5.0's start: generation 1 of the profile only (this build records a generation-2 marker for it, which 1.5.0 never wrote).
    start(&roots);
    std::fs::remove_file(roots.data.join(PROFILE_GEN_PATH)).expect("the marker 1.5.0 did not write");
    // The files the 1.4.5 profile held and 1.5.0 left where they were.
    put_profile(base, true);
    assert_eq!(desktop(&roots, "ssh-hosts.json"), None);

    start(&roots);

    assert_all_moved(base);
    assert_eq!(marker(&roots)["generation"], 2);
    // The port forwards' backup moved with them: the desktop's reader restores from it.
    assert_eq!(desktop(&roots, "port-forwards.json.bak"), Some(vector("port-forwards.json.bak")));
    let tree = tree_digest(&roots);
    start(&roots);
    assert_eq!(tree_digest(&roots), tree, "the next start rewrote the data");
}

#[test]
fn tui_first_then_adopt() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let base = scratch.path();
    copy_at(base);
    put_profile(base, true);
    // The TUI (or a standalone core) starts first and is told no profile.
    let standalone = roots_at(base);
    start(&standalone);
    let named = named_roots(base);
    let before = supplement::run(&standalone).expect("a call without a profile");
    assert_eq!((before.generation, before.moved.is_empty()), (1, true));
    assert_eq!(profile_files(base), FILES, "the profile was not touched");
    let complete = std::fs::read(named.data.join(COMPLETE_PATH)).expect("complete");

    // The desktop tells the core its profile: generation 2 only, never the first pass's late pass.
    let adopted = supplement::run(&named).expect("adopt");

    assert_eq!(adopted.generation, 2);
    let mut moved = adopted.moved;
    moved.sort();
    assert_eq!(moved, FILES);
    assert_all_moved(base);
    assert!(!named.data.join(LATE_MANIFEST_PATH).exists(), "the late pass ran");
    assert_eq!(std::fs::read(named.data.join(COMPLETE_PATH)).expect("complete"), complete);
}

#[test]
fn adopt_after_gen2_noop() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let base = scratch.path();
    copy_at(base);
    put_profile(base, true);
    let roots = named_roots(base);
    start(&roots);
    let tree = tree_digest(&roots);
    // A file that appears after generation 2 is not the pass's any more.
    std::fs::write(base.join("profile/ssh-hosts.json"), b"{\"version\":1,\"hosts\":[]}").expect("a later file");

    let again = supplement::run(&roots).expect("adopt again");

    assert_eq!((again.generation, again.moved.is_empty()), (2, true));
    assert_eq!(tree_digest(&roots), tree);
    assert_eq!(profile_files(base), ["ssh-hosts.json"]);
    assert_eq!(desktop(&roots, "ssh-hosts.json"), Some(vector("ssh-hosts.json")));
}

/// One way: after the move nothing of the profile's sources is left for a 1.4.5 build to read, and the copies are the
/// bytes it wrote. (The old files are not kept: the move is the migration of the profile, as for generation 1.)
#[test]
fn downgrade_leaves_no_source() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let base = scratch.path();
    copy_at(base);
    put_profile(base, true);
    let roots = named_roots(base);
    start(&roots);

    let left = profile_files(base);
    assert!(left.is_empty(), "a downgraded build would still read {left:?}");
    for name in FILES {
        assert_eq!(desktop(&roots, name), Some(vector(name)), "{name} was changed by the move");
    }
}

// ── Crash matrix over generation 2 ────────────────────────────────────────────────────────────────────────────
//
// As in recorded_145.rs: the start runs in a child (this test binary, on `upgrade_chain::crash_child`) with
// `durable::set_step_hook`; the hook exits the process at the chosen mutating step. The directory is the recorded one
// already migrated to generation 1 with the profile's files waiting, so every step of the child is one of generation 2.

const KILLED: i32 = 86;

static STEPS: AtomicUsize = AtomicUsize::new(0);
static STOP_AT: OnceLock<usize> = OnceLock::new();
static BASE: OnceLock<PathBuf> = OnceLock::new();
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn on_step(step: Step, path: &Path, _bytes: &[u8]) {
    let at = STEPS.fetch_add(1, Ordering::SeqCst);
    match STOP_AT.get() {
        Some(stop) if *stop == at => std::process::exit(KILLED),
        Some(_) => {}
        None => {
            let rel = path
                .strip_prefix(BASE.get().expect("base"))
                .map_or_else(|_| path.to_string_lossy().into_owned(), |p| p.to_string_lossy().replace('\\', "/"));
            LOG.lock().expect("log").push(format!("{step:?} {rel}"));
        }
    }
}

/// The child of the crash matrix: a no-op unless the parent set `UPGRADE_CHAIN_BASE`.
#[test]
fn crash_child() {
    let Some(base) = std::env::var_os("UPGRADE_CHAIN_BASE") else { return };
    mixdog_store::fsio::elide_syncs();
    if let Ok(stop) = std::env::var("UPGRADE_CHAIN_STOP_AT") {
        STOP_AT.set(stop.parse().expect("a step index")).expect("once");
    }
    BASE.set(PathBuf::from(&base)).expect("once");
    durable::set_step_hook(on_step);
    migrator(&named_roots(Path::new(&base)), MigrateOptions { workers: 1, fault: None, verified: None })
        .run()
        .expect("the run the child was not stopped in");
    if let Some(log) = std::env::var_os("UPGRADE_CHAIN_LOG") {
        std::fs::write(log, LOG.lock().expect("log").join("\n")).expect("step log");
    }
}

fn child(base: &Path, stop: Option<usize>, log: Option<&Path>) -> Option<i32> {
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["--exact", "upgrade_chain::crash_child", "--test-threads=1"])
        .env("UPGRADE_CHAIN_BASE", base)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(stop) = stop {
        command.env("UPGRADE_CHAIN_STOP_AT", stop.to_string());
    }
    if let Some(log) = log {
        command.env("UPGRADE_CHAIN_LOG", log);
    }
    command.status().expect("spawn the child").code()
}

fn copy_tree(from: &Path, to: &Path) {
    for rel in durable::walk_files(from).expect("walk") {
        let target = to.join(&rel);
        std::fs::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        std::fs::copy(from.join(&rel), &target).expect("copy");
    }
}

#[test]
fn crash_matrix_over_gen2() {
    mixdog_store::fsio::elide_syncs();
    let scratch = tempfile::tempdir().expect("scratch dir");
    let (base, template) = (scratch.path().join("run"), scratch.path().join("template"));
    // The manifest names the dir a run was in: every run is in `base`, started from a copy of the prepared directory.
    copy_at(&base);
    put_profile(&base, false);
    let roots = named_roots(&base);
    start(&roots);
    std::fs::remove_file(roots.data.join(PROFILE_GEN_PATH)).expect("marker");
    put_profile(&base, true);
    copy_tree(&base, &template);
    let fresh = || {
        durable::remove_dir_all(&base).expect("clean");
        copy_tree(&template, &base);
    };

    fresh();
    let log = scratch.path().join("steps.log");
    assert_eq!(child(&base, None, Some(&log)), Some(0), "the unstopped child completes");
    let steps: Vec<String> = std::fs::read_to_string(&log).expect("step log").lines().map(str::to_owned).collect();
    assert!(steps.iter().any(|s| s.contains("profile-gen")), "the journal's publications are steps: {steps:?}");
    assert!(steps.len() >= FILES.len(), "{} steps for {} files", steps.len(), FILES.len());
    assert_all_moved(&base);
    let (want, want_profile) = (tree_digest(&roots), digest_of(&base.join("profile")));

    for (stop_at, step) in steps.iter().enumerate() {
        fresh();
        assert_eq!(child(&base, Some(stop_at), None), Some(KILLED), "step {stop_at} ({step}) was not reached");
        migrator(&roots, MigrateOptions { workers: 1, fault: None, verified: None })
            .run()
            .unwrap_or_else(|e| panic!("resume after a kill in step {stop_at} ({step}): {e}"));
        let got = tree_digest(&roots);
        let diff: Vec<_> = want.keys().chain(got.keys()).filter(|k| want.get(*k) != got.get(*k)).collect();
        assert!(diff.is_empty(), "after a kill in step {stop_at} ({step}): {diff:?}");
        assert_eq!(digest_of(&base.join("profile")), want_profile, "profile after a kill in step {stop_at} ({step})");
    }
}
