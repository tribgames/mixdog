//! The launcher's staged update against Node's (`tests/goldens/staged-update.json`, recorded by
//! `tests/recorders/record-staged-update.mjs` from `src/runtime/shared/staged-update.mjs`): the same scenarios on a temporary data
//! folder, the same decisions. The release feed is a server of this process on the loopback; no executable is started (a binary
//! "says its version" through its first bytes here) and nothing outside the temporary folder is touched.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test lays out folders, files and a loopback server and reads what the update left on disk"
)]

use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_launch::staged_update::Context;
use mixdog_launch::staged_update::StageOutcome;
use mixdog_launch::staged_update::SwapOutcome;
use mixdog_launch::staged_update::is_staged_complete;
use mixdog_launch::staged_update::perform_pending_swap_in;
use mixdog_launch::staged_update::run_staged_install;
use mixdog_launch::staged_update::spawn_worker;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const CURRENT: &str = "1.5.0";
const OTHER_LIVE: u32 = 4242;
const DEAD: u32 = 2_147_483_000;
const PLATFORM: &str = "test-x64";

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/staged-update.json")).expect("golden")
}

fn binary_name() -> String {
    format!("mixdog{}", std::env::consts::EXE_SUFFIX)
}

/// A binary says its version through its text: `version:<v>`.
fn say_version(binary: &Path) -> Option<String> {
    std::fs::read_to_string(binary).ok()?.strip_prefix("version:").map(str::to_owned)
}

fn runs(pid: u32) -> bool {
    pid == std::process::id() || pid == OTHER_LIVE
}

/// A machine of a folder: data in `data`, the running executable in `app`.
fn context(root: &Path) -> Context {
    let exe = root.join("app").join(binary_name());
    std::fs::create_dir_all(exe.parent().expect("app")).expect("app");
    std::fs::write(&exe, format!("version:{CURRENT}")).expect("exe");
    Context {
        data_dir: root.join("data"),
        exe,
        version: CURRENT.to_owned(),
        feed_url: "http://127.0.0.1:9/never".to_owned(),
        platform: PLATFORM.to_owned(),
        process_runs: runs,
        probe_version: say_version,
        disable_install: false,
        disable_swap: false,
        swap_reexec: false,
        dev: false,
    }
}

fn staging(context: &Context, version: &str) -> PathBuf {
    context.data_dir.join("staging").join(version)
}

struct Laid {
    marker: bool,
    payload: bool,
    marker_version: Option<String>,
    age_secs: u64,
}

impl Default for Laid {
    fn default() -> Self {
        Self { marker: true, payload: true, marker_version: None, age_secs: 0 }
    }
}

/// A staged version: its binary, and the marker unless `marker` is false.
fn lay(context: &Context, version: &str, laid: &Laid) {
    let dir = staging(context, version);
    let binary = dir.join("bin").join(binary_name());
    std::fs::create_dir_all(binary.parent().expect("bin")).expect("bin");
    if laid.payload {
        std::fs::write(&binary, format!("version:{version}")).expect("binary");
    }
    if laid.marker {
        let marker = json!({ "version": laid.marker_version.as_deref().unwrap_or(version), "binary": binary.to_string_lossy(), "stagedAt": 1 });
        std::fs::write(dir.join(".staged-complete.json"), marker.to_string()).expect("marker");
    }
    if laid.age_secs > 0 {
        set_age(&dir, laid.age_secs);
    }
}

/// A file or folder last changed `secs` ago.
fn set_age(path: &Path, secs: u64) {
    let when = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
    let mut options = std::fs::OpenOptions::new();
    #[cfg(windows)]
    // FILE_FLAG_BACKUP_SEMANTICS: a folder can be opened.
    std::os::windows::fs::OpenOptionsExt::custom_flags(options.write(true), 0x0200_0000);
    #[cfg(not(windows))]
    options.read(true);
    options.open(path).expect("open").set_modified(when).expect("age");
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn pid_label(name: &str) -> String {
    let digits: String = name.chars().take_while(char::is_ascii_digit).collect();
    let pid: u32 = digits.parse().unwrap_or(0);
    let label = if pid == std::process::id() {
        "self"
    } else if pid == OTHER_LIVE {
        "other"
    } else if pid == DEAD {
        "dead"
    } else {
        "unknown"
    };
    format!("{label}{}", &name[digits.len()..])
}

fn labels(dir: &Path) -> Vec<String> {
    names(dir).iter().map(|name| pid_label(name)).collect()
}

/// The release feed on the loopback: the manifest and the archive of one version.
struct Feed {
    base: String,
    stop: Arc<AtomicBool>,
    address: std::net::SocketAddr,
}

struct FeedSpec {
    manifest_version: String,
    binary_text: String,
    /// The hash the manifest states instead of the archive's.
    sha256: Option<String>,
    /// The size the manifest states instead of the archive's.
    size: Option<u64>,
    platform: String,
    with_binary: bool,
    archive_status: u16,
}

impl FeedSpec {
    fn of(version: &str) -> Self {
        Self {
            manifest_version: version.to_owned(),
            binary_text: format!("version:{version}"),
            sha256: None,
            size: None,
            platform: PLATFORM.to_owned(),
            with_binary: true,
            archive_status: 200,
        }
    }
}

fn zip_of(spec: &FeedSpec) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("README.txt", options).expect("entry");
        zip.write_all(b"mixdog").expect("entry");
        if spec.with_binary {
            zip.start_file(format!("mixdog-cli/{}", binary_name()), options).expect("entry");
            zip.write_all(spec.binary_text.as_bytes()).expect("entry");
        }
        zip.finish().expect("zip");
    }
    bytes
}

fn answer(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    drop(stream.write_all(head.as_bytes()));
    drop(stream.write_all(body));
}

impl Feed {
    fn start(spec: FeedSpec) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let base = format!("http://{address}");
        let archive = zip_of(&spec);
        let hash: String = Sha256::digest(&archive).iter().map(|byte| format!("{byte:02x}")).collect();
        let mut assets = serde_json::Map::new();
        assets.insert(
            spec.platform.clone(),
            json!({
                "url": format!("{base}/mixdog.zip"),
                "sha256": spec.sha256.clone().unwrap_or(hash),
                "size": spec.size.unwrap_or(archive.len() as u64),
            }),
        );
        let manifest = json!({ "version": spec.manifest_version, "assets": assets }).to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let status = spec.archive_status;
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|n| n == 1) {
                    head.push(byte[0]);
                }
                let line = String::from_utf8_lossy(&head).lines().next().unwrap_or_default().to_owned();
                if line.contains("/manifest.json") {
                    answer(&mut stream, 200, manifest.as_bytes());
                } else if line.contains("/mixdog.zip") {
                    answer(&mut stream, status, if status == 200 { &archive } else { b"" });
                } else {
                    answer(&mut stream, 404, b"");
                }
            }
        });
        Self { base, stop, address }
    }

    fn manifest_url(&self) -> String {
        format!("{}/manifest.json", self.base)
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(TcpStream::connect(self.address));
    }
}

fn outcome_text(outcome: &StageOutcome) -> String {
    match outcome {
        StageOutcome::Staged { .. } => "staged".to_owned(),
        StageOutcome::AlreadyStaged { .. } => "already-staged".to_owned(),
        StageOutcome::InProgress => "in-progress".to_owned(),
        StageOutcome::Failed(error) => format!("failed: {error}"),
    }
}

/// One stage scenario the way the recorder records it.
fn stage_scenario(version: &str, prepare: impl FnOnce(&Context, &Path)) -> Value {
    let root = tempfile::tempdir().expect("root");
    let mut context = context(root.path());
    let feed = Feed::start(FeedSpec::of(version.trim()));
    context.feed_url = feed.manifest_url();
    let ver_dir = staging(&context, version.trim());
    prepare(&context, &ver_dir);
    let outcome = run_staged_install(&context, version);
    let marker: Option<Value> = std::fs::read(ver_dir.join(".staged-complete.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    json!({
        "outcome": outcome_text(&outcome),
        "markerVersion": marker.and_then(|marker| marker["version"].as_str().map(str::to_owned)),
        "lockLeft": ver_dir.join(".staging.lock").exists(),
    })
}

fn write_lock(ver_dir: &Path, text: &str, age_secs: u64) {
    std::fs::create_dir_all(ver_dir).expect("version folder");
    let lock = ver_dir.join(".staging.lock");
    std::fs::write(&lock, text).expect("lock");
    if age_secs > 0 {
        set_age(&lock, age_secs);
    }
}

#[test]
fn the_refcount_is_one_pid_file_for_as_long_as_a_session_of_this_process_is_registered() {
    let golden = golden();
    let root = tempfile::tempdir().expect("root");
    let context = context(root.path());
    let live = context.data_dir.join("live-sessions");
    let first = context.register_live_session("a");
    let text = std::fs::read_to_string(live.join(format!("{}.pid", std::process::id()))).expect("pid file");
    let shaped = text.strip_prefix(&format!("{} ", std::process::id())).is_some_and(|rest| rest.ends_with('\n') && rest.trim_end().bytes().all(|b| b.is_ascii_digit()));
    let registered = json!({ "files": labels(&live), "content": if shaped { "pid ms newline".to_owned() } else { text } });
    assert_eq!(registered, golden["refcount"]["registered"]);
    let second = context.register_live_session("b");
    assert_eq!(json!({ "files": labels(&live) }), golden["refcount"]["registeredTwice"]);
    // Node has one session per process; here the file goes with the last one.
    drop(first);
    assert_eq!(labels(&live), vec!["self.pid"], "a session is still registered");
    drop(second);
    assert_eq!(json!({ "files": labels(&live) }), golden["refcount"]["unregistered"]);
    assert_eq!(json!({ "files": labels(&live) }), golden["refcount"]["unregisteredTwice"]);
}

#[test]
fn the_completion_marker_rules_are_node_s() {
    let golden = golden();
    let root = tempfile::tempdir().expect("root");
    let context = context(root.path());
    let got = |version: &str| is_staged_complete(&context, version);
    assert_eq!(got("1.6.0"), golden["markers"]["noMarker"]);
    std::fs::create_dir_all(staging(&context, "1.6.0")).expect("dir");
    std::fs::write(staging(&context, "1.6.0").join(".staged-complete.json"), "not json").expect("marker");
    assert_eq!(got("1.6.0"), golden["markers"]["markerNotJson"]);
    lay(&context, "1.6.1", &Laid { marker_version: Some("1.6.2".into()), ..Laid::default() });
    assert_eq!(got("1.6.1"), golden["markers"]["markerOfAnotherVersion"]);
    lay(&context, "1.6.3", &Laid { payload: false, ..Laid::default() });
    assert_eq!(got("1.6.3"), golden["markers"]["payloadMissing"]);
    lay(&context, "1.6.4", &Laid::default());
    assert_eq!(got("1.6.4"), golden["markers"]["complete"]);
    assert_eq!(got(""), golden["markers"]["emptyVersion"]);
    assert_eq!(got(" 1.6.4 "), golden["markers"]["versionWithSpaces"]);
}

#[test]
fn no_worker_is_started_for_what_node_does_not_start_one() {
    let golden = golden();
    let root = tempfile::tempdir().expect("root");
    let mut context = context(root.path());
    assert_eq!(spawn_worker(&context, ""), golden["spawn"]["emptyVersion"]);
    context.disable_install = true;
    assert_eq!(spawn_worker(&context, "9.9.9"), golden["spawn"]["disabled"]);
    context.disable_install = false;
    lay(&context, "1.6.0", &Laid::default());
    assert_eq!(spawn_worker(&context, "1.6.0"), golden["spawn"]["alreadyStaged"]);
}

#[test]
fn the_staging_decisions_are_node_s() {
    let golden = golden();
    let want = &golden["stage"];
    assert_eq!(stage_scenario("", |_, _| {}), want["emptyVersion"], "emptyVersion");
    assert_eq!(stage_scenario("1.6.0", |_, _| {}), want["fresh"], "fresh");
    assert_eq!(stage_scenario("1.6.0", |context, _| lay(context, "1.6.0", &Laid::default())), want["alreadyStaged"], "alreadyStaged");
    let pid = std::process::id();
    let now = || now_ms();
    assert_eq!(stage_scenario("1.6.0", |_, dir| write_lock(dir, &format!("{pid} {}", now()), 0)), want["lockOfLiveOwner"], "lockOfLiveOwner");
    assert_eq!(stage_scenario("1.6.0", |_, dir| write_lock(dir, &format!("{DEAD} {}", now()), 0)), want["lockOfDeadOwner"], "lockOfDeadOwner");
    assert_eq!(stage_scenario("1.6.0", |_, dir| write_lock(dir, &format!("{pid} 1"), 11 * 60)), want["lockOfLiveOwnerOverTenMinutes"], "over ten minutes");
    assert_eq!(stage_scenario("1.6.0", |_, dir| write_lock(dir, &format!("{pid} 1"), 9 * 60)), want["lockOfLiveOwnerUnderTenMinutes"], "under ten minutes");
    assert_eq!(stage_scenario("1.6.0", |_, dir| write_lock(dir, "garbage", 0)), want["lockThatIsNotAPid"], "lockThatIsNotAPid");
    assert_eq!(
        stage_scenario("1.6.0", |context, _| lay(context, "1.6.0", &Laid { marker_version: Some("1.6.1".into()), ..Laid::default() })),
        want["markerOfAnotherVersion"],
        "markerOfAnotherVersion"
    );
    assert_eq!(stage_scenario(" 1.6.2 ", |_, _| {}), want["versionWithSpaces"], "versionWithSpaces");
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis())
}

/// One swap scenario the way the recorder records it.
fn swap_scenario(prepare: impl FnOnce(&Context), tune: impl FnOnce(&mut Context)) -> (Value, SwapOutcome) {
    let root = tempfile::tempdir().expect("root");
    let mut context = context(root.path());
    prepare(&context);
    tune(&mut context);
    let outcome = perform_pending_swap_in(&context);
    let app = context.exe.parent().expect("app");
    let name = binary_name();
    let record = json!({
        "swapped": matches!(outcome, SwapOutcome::Swapped(_)),
        "live": say_version(&context.exe),
        "staging": names(&context.data_dir.join("staging")),
        "sessions": labels(&context.data_dir.join("live-sessions")),
        "backups": names(app).iter().filter(|entry| entry.starts_with(&format!("{name}.old-"))).count(),
    });
    (record, outcome)
}

fn session(context: &Context, pid: u32) {
    let dir = context.data_dir.join("live-sessions");
    std::fs::create_dir_all(&dir).expect("live-sessions");
    std::fs::write(dir.join(format!("{pid}.pid")), format!("{pid} 1\n")).expect("pid file");
}

fn plain(_: &mut Context) {}

#[test]
fn the_swap_decisions_are_node_s() {
    let golden = golden();
    let want = &golden["swap"];
    let one = |name: &str, prepare: &dyn Fn(&Context), tune: &dyn Fn(&mut Context)| {
        let (record, _) = swap_scenario(prepare, tune);
        assert_eq!(&record, &want[name], "{name}");
    };
    let staged = |versions: &'static [&'static str]| move |context: &Context| versions.iter().for_each(|version| lay(context, version, &Laid::default()));
    one("nothingStaged", &|_| {}, &plain);
    one("older", &staged(&["1.4.0"]), &plain);
    one("equal", &staged(&["1.5.0"]), &plain);
    one("newer", &staged(&["1.6.0"]), &plain);
    one("bestOfSeveral", &staged(&["1.9.0", "1.10.0", "1.5.1-rc.1"]), &plain);
    one("prereleaseOfTheNextVersion", &staged(&["1.5.1-rc.1"]), &plain);
    one("prereleaseBelowCurrent", &staged(&["1.5.0-rc.1"]), &plain);
    one("prereleaseBeatsNothingButLosesToRelease", &staged(&["1.6.0-rc.2", "1.6.0"]), &plain);
    one(
        "anotherLiveSession",
        &|context| {
            lay(context, "1.6.0", &Laid::default());
            session(context, OTHER_LIVE);
        },
        &plain,
    );
    one(
        "deadSessionFile",
        &|context| {
            lay(context, "1.6.0", &Laid::default());
            session(context, DEAD);
        },
        &plain,
    );
    one(
        "ownSessionFile",
        &|context| {
            lay(context, "1.6.0", &Laid::default());
            session(context, std::process::id());
        },
        &plain,
    );
    one("swapSwitchedOff", &staged(&["1.6.0"]), &|context| context.disable_swap = true);
    one("afterASwap", &staged(&["1.6.0"]), &|context| context.swap_reexec = true);
    one(
        "incompleteAttempts",
        &|context| {
            lay(context, "1.7.0", &Laid { marker: false, age_secs: 2 * 60 * 60, ..Laid::default() });
            lay(context, "1.8.0", &Laid { marker: false, ..Laid::default() });
        },
        &plain,
    );
    one("payloadMissing", &|context| lay(context, "1.6.0", &Laid { payload: false, ..Laid::default() }), &plain);
    one(
        "markerNotJson",
        &|context| {
            std::fs::create_dir_all(staging(context, "1.6.0")).expect("dir");
            std::fs::write(staging(context, "1.6.0").join(".staged-complete.json"), "not json").expect("marker");
        },
        &plain,
    );
    one(
        "swapLockOfDeadOwner",
        &|context| {
            lay(context, "1.6.0", &Laid::default());
            std::fs::write(context.data_dir.join("staging").join(".swap.lock"), format!("{DEAD} 1")).expect("lock");
        },
        &plain,
    );
    let backup = |context: &Context| std::fs::write(context.exe.with_file_name(format!("{}.old-1", binary_name())), "old").expect("backup");
    one("leftoverBackup", &backup, &plain);
    one(
        "leftoverBackupAfterASwap",
        &|context| {
            lay(context, "1.6.0", &Laid::default());
            backup(context);
        },
        &plain,
    );
}

#[test]
fn a_swap_reports_where_the_new_executable_is_and_a_build_in_a_checkout_is_never_replaced() {
    let (record, outcome) = swap_scenario(|context| lay(context, "1.6.0", &Laid::default()), plain);
    assert_eq!(record["live"], "1.6.0");
    assert!(matches!(outcome, SwapOutcome::Swapped(path) if path.file_name().is_some_and(|name| *name == *binary_name())));
    let (record, outcome) = swap_scenario(|context| lay(context, "1.6.0", &Laid::default()), |context| context.dev = true);
    assert_eq!((record["live"].as_str(), outcome), (Some("1.5.0"), SwapOutcome::NothingStaged));
}

#[test]
fn a_swap_waits_for_no_session_but_defers_to_a_live_one_and_keeps_the_staged_version() {
    let (record, outcome) = swap_scenario(
        |context| {
            lay(context, "1.6.0", &Laid::default());
            session(context, OTHER_LIVE);
        },
        plain,
    );
    assert_eq!(outcome, SwapOutcome::Deferred);
    assert_eq!(record["staging"], json!(["1.6.0"]));
}

#[test]
fn a_staged_binary_that_does_not_say_its_version_is_not_swapped_in() {
    let (record, outcome) = swap_scenario(
        |context| {
            lay(context, "1.6.0", &Laid::default());
            std::fs::write(staging(context, "1.6.0").join("bin").join(binary_name()), "version:1.6.1").expect("binary");
        },
        plain,
    );
    assert_eq!((record["live"].as_str(), outcome), (Some("1.5.0"), SwapOutcome::Failed));
    assert_eq!(record["backups"], 0);
}

#[test]
fn a_marker_names_the_binary_it_staged() {
    let root = tempfile::tempdir().expect("root");
    let context = context(root.path());
    lay(&context, "1.6.0", &Laid::default());
    let elsewhere = root.path().join("elsewhere");
    std::fs::write(&elsewhere, "version:1.6.0").expect("binary");
    let marker = json!({ "version": "1.6.0", "binary": elsewhere.to_string_lossy(), "stagedAt": 1 });
    std::fs::write(staging(&context, "1.6.0").join(".staged-complete.json"), marker.to_string()).expect("marker");
    assert!(is_staged_complete(&context, "1.6.0"));
    std::fs::remove_file(&elsewhere).expect("remove");
    assert!(!is_staged_complete(&context, "1.6.0"), "the binary the marker names is gone");
}

fn stage_with(spec: FeedSpec, version: &str) -> (StageOutcome, Context, tempfile::TempDir) {
    let root = tempfile::tempdir().expect("root");
    let mut context = context(root.path());
    let feed = Feed::start(spec);
    context.feed_url = feed.manifest_url();
    let outcome = run_staged_install(&context, version);
    (outcome, context, root)
}

#[test]
fn a_staged_version_is_the_binary_of_the_archive_and_nothing_else_is_left() {
    let (outcome, context, _root) = stage_with(FeedSpec::of("1.6.0"), "1.6.0");
    let StageOutcome::Staged { binary, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(std::fs::read_to_string(&binary).expect("binary"), "version:1.6.0");
    assert_eq!(names(&staging(&context, "1.6.0")), vec![".staged-complete.json".to_owned(), "bin".to_owned()], "no archive, lock or temporary file is left");
    assert!(is_staged_complete(&context, "1.6.0"));
    let again = run_staged_install(&context, "1.6.0");
    assert!(matches!(again, StageOutcome::AlreadyStaged { .. }));
}

#[test]
fn nothing_is_staged_from_an_archive_the_feed_does_not_vouch_for() {
    let wrong_hash = FeedSpec { sha256: Some("0".repeat(64)), ..FeedSpec::of("1.6.0") };
    let wrong_size = FeedSpec { size: Some(3), ..FeedSpec::of("1.6.0") };
    let other_version = FeedSpec::of("1.6.1");
    let no_asset = FeedSpec { platform: "other-x64".into(), ..FeedSpec::of("1.6.0") };
    let no_binary = FeedSpec { with_binary: false, ..FeedSpec::of("1.6.0") };
    let says_other = FeedSpec { binary_text: "version:1.6.1".into(), ..FeedSpec::of("1.6.0") };
    let gone = FeedSpec { archive_status: 404, ..FeedSpec::of("1.6.0") };
    for (name, spec, expected) in [
        ("hash", wrong_hash, "SHA-256"),
        ("size", wrong_size, "bytes"),
        ("version", other_version, "feed version"),
        ("platform", no_asset, "asset"),
        ("binary", no_binary, "not in the archive"),
        ("says", says_other, "staged version 1.6.1"),
        ("status", gone, "answered 404"),
    ] {
        let (outcome, context, _root) = stage_with(spec, "1.6.0");
        let StageOutcome::Failed(text) = outcome else { panic!("{name}: {outcome:?}") };
        assert!(text.contains(expected), "{name}: {text}");
        assert!(!is_staged_complete(&context, "1.6.0"), "{name}: no marker");
        assert!(!staging(&context, "1.6.0").join(".staging.lock").exists(), "{name}: the lock is released");
        assert!(!staging(&context, "1.6.0").join("download").exists(), "{name}: no archive is kept");
    }
}

#[test]
fn a_feed_that_cannot_be_reached_fails_the_staging_and_leaves_it_to_the_next_launch() {
    let root = tempfile::tempdir().expect("root");
    let mut context = context(root.path());
    let closed = TcpListener::bind("127.0.0.1:0").expect("bind");
    context.feed_url = format!("http://{}/manifest.json", closed.local_addr().expect("address"));
    drop(closed);
    assert!(matches!(run_staged_install(&context, "1.6.0"), StageOutcome::Failed(_)));
    assert!(!is_staged_complete(&context, "1.6.0"));
}
