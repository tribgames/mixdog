//! The one-time migration over a data directory the real v1.4.5 code wrote
//! (`benchmarks/rust-core/recorders/record-migration-145.mjs`), read back against what 1.4.5 itself answered for the
//! same data, with the run-once and crash guarantees proven on that same directory.

use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_migrate::durable;
use mixdog_migrate::durable::Step;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::session::target::read_sessions;
use serde_json::Value;

use crate::recorded_145_support::*;

/// The header keys 1.4.5 recorded that the migrated session does not carry, each with the decision that drops it:
/// `_providerPrefixGuardState` is the cache-prefix guard the strict loader drops (store-migration §11.4.1,
/// `legacy-session.mjs:14`), and a `null` `liveTurnMessages` is the absent key.
fn dropped_header_key(key: &str, value: &Value) -> bool {
    key == "_providerPrefixGuardState" || (key == "liveTurnMessages" && value.is_null())
}

#[test]
fn every_session_reads_back_as_1_4_5_answered() {
    let (copy, complete) = migrated();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    let folded = read_sessions(&copy.roots(), &complete.manifest_sha256).expect("the migrated sessions fold");
    let answers = answers();
    let threads = answers["threads"].as_object().expect("threads");
    assert_eq!(folded.len(), threads.len(), "one session per 1.4.5 session");
    for (name, thread) in threads {
        let id = thread["id"].as_str().expect("id");
        let session = folded.get(id).unwrap_or_else(|| panic!("{name} ({id}) was not migrated"));
        let record = thread["record"].as_object().expect("record");
        // The system prefix is the header's prompt blocks, not rows (compose-seams "Migration (WP-MIGRATE)").
        let messages = record["messages"].as_array().expect("messages");
        let lead = messages.iter().take_while(|m| m["role"] == "system").count();
        let rows: Vec<&Value> = session.rows.iter().filter(|r| r.model && r.visible).map(|r| &r.body).collect();
        assert_eq!(rows.len(), messages.len() - lead, "{name}: message count");
        for (i, (want, got)) in messages[lead..].iter().zip(&rows).enumerate() {
            assert_eq!(want, *got, "{name}: message {i}");
        }
        let header = serde_json::to_value(&session.header).expect("header");
        for (key, want) in record.iter().filter(|(k, v)| *k != "messages" && !dropped_header_key(k, v)) {
            // An interrupted turn is recovered by 1.4.5's reader before it answers: its clock, transcript epoch and
            // turn coverage are what recovery stamped, not what the crash left (store-migration §11.4.4). Those four
            // are compared by the relation below, not skipped.
            if name == "crashed" && RECOVERY_STAMPED.contains(&key.as_str()) {
                continue;
            }
            assert_eq!(header.get(key), Some(want), "{name}: header {key}");
        }
    }
}

/// The header keys 1.4.5's recovery of an interrupted turn stamps when it loads the session.
const RECOVERY_STAMPED: [&str; 4] = ["updatedAt", "lastUsedAt", "transcriptEpoch", "turnCoverage"];

/// The interrupted session, key by key: what 1.4.5 answered after recovering it is the recovery's stamp (a later clock, a
/// fresh epoch, the turn's token as coverage); the migrated session carries what the crash left in the recorded record,
/// and the turn itself is the recorded checkpoint's, which the migration turns into rows and an interrupted run.
#[test]
fn the_interrupted_session_carries_what_the_crash_left_and_1_4_5_stamped_on_recovery() {
    let (copy, complete) = migrated();
    let folded = read_sessions(&copy.roots(), &complete.manifest_sha256).expect("fold");
    let answers = answers();
    let id = answers["ids"]["crashed"].as_str().expect("crashed id");
    let fixture = fixture_dir().join(".mixdog/data");
    let read = |rel: String| -> Value { serde_json::from_slice(&durable::read(&fixture.join(rel)).expect("recorded file")).expect("json") };
    let raw = read(format!("sessions/{id}.json"));
    let checkpoint = read(format!("turn-checkpoints/{id}.json"));
    let answered = &answers["threads"]["crashed"]["record"];
    let header = serde_json::to_value(&folded[id].header).expect("header");
    for key in ["updatedAt", "lastUsedAt", "transcriptEpoch"] {
        assert_eq!(header.get(key), raw.get(key), "migrated {key} is the crash's");
        assert_ne!(answered.get(key), raw.get(key), "1.4.5's recovery re-stamped {key}");
    }
    assert!(answered["updatedAt"].as_i64() > raw["updatedAt"].as_i64(), "recovery ran after the crash");
    assert!(raw.get("turnCoverage").is_none(), "the crash left no coverage");
    assert_eq!(header.get("turnCoverage").filter(|v| !v.is_null()), None, "the migrated header claims no coverage");
    assert_eq!(answered["turnCoverage"], checkpoint["turnToken"], "1.4.5 covered the recorded turn");
    let rid = format!("ckpt:{}", checkpoint["turnToken"].as_str().expect("turnToken"));
    assert!(
        folded[id].runs.iter().any(|run| run.0 == rid),
        "the interrupted turn {rid} is a run of the migrated session"
    );
}

#[test]
fn a_queued_message_is_still_queued_for_its_thread() {
    let (copy, complete) = migrated();
    let folded = read_sessions(&copy.roots(), &complete.manifest_sha256).expect("fold");
    let answers = answers();
    let lead = answers["ids"]["lead"].as_str().expect("lead");
    let queue = &folded[lead].queue;
    assert_eq!(queue.len(), 1, "one queued message");
    // 1.4.5 lists the entry as the spool row (`message`) and as the delivery row (`content`/`text`); both carry its id.
    let pending = answers["pending"].as_array().expect("pending");
    assert_eq!(pending.len(), 2, "the spool row and the delivery row");
    for entry in pending {
        let text = entry.get("message").or_else(|| entry.get("content")).expect("the entry's text");
        assert_eq!(queue[0].0, entry["id"].as_str().expect("the recorded id"), "the queued message's id");
        assert_eq!(&queue[0].1["message"], text);
        assert_eq!(queue[0].1["enqueuedAt"], entry["enqueuedAt"]);
    }
    for (id, session) in &folded {
        assert!(id == lead || session.queue.is_empty(), "{id} has nothing queued");
    }
}

#[test]
fn the_settings_read_back_as_1_4_5_answered() {
    let (copy, _) = migrated();
    let answers = answers();
    let now: Value = serde_json::from_slice(&durable::read(&copy.roots().data.join("mixdog-config.json")).expect("config")).expect("json");
    let was = answers["config"]["file"].as_object().expect("the recorded config");
    for (key, value) in was {
        if key != "quotaResume" {
            assert_eq!(&now[key], value, "setting {key}");
        }
    }
    // The switch moved from quotaResume.autoResume to the registered quotaAutoResume, with the value 1.4.5 acted on.
    assert_eq!(now["quotaAutoResume"], answers["config"]["quotaAutoResume"]);
    assert!(now["quotaResume"]["autoResume"].is_null(), "the 1.4.5 key was left");
}

/// What the migration removes from the 1.4.5 tree (store-migration §11.2): converted sessions, spool and checkpoints,
/// derived indexes and caches, the legacy usage input the ledger already imported, and the interrupted writes the
/// recorder produced by killing each 1.4.5 writer (`answers.leftovers`) and the set-aside it kept (`answers.setAside`,
/// moved to quarantine). Nothing here asks the migration's own classifier.
fn removed_by_contract(rel: &str, answers: &Value) -> bool {
    let listed = |key: &str| answers[key].as_array().expect(key).iter().any(|w| w["rel"].as_str() == Some(rel));
    listed("leftovers")
        || listed("setAside")
        || (rel.starts_with("data/sessions/") && rel.ends_with(".json"))
        || rel.starts_with("data/session-pending/")
        || rel.starts_with("data/turn-checkpoints/")
        || rel.starts_with("data/media/renditions/")
        || ["data/session-summaries.log", "data/prompt-attachments/gc-last-run", "data/prompt-attachments/gc-reference-cache.json"]
            .contains(&rel)
}

#[test]
fn the_1_4_5_files_left_behind_are_the_ones_the_decisions_name() {
    let (copy, _) = migrated();
    let after = tree_digest(&copy.roots());
    let recorded = recorded_files();
    let answers = answers();
    for (rel, sha) in &recorded {
        match after.get(rel) {
            Some(now) if now == sha => {
                assert!(!removed_by_contract(rel, &answers), "{rel} is retired by the contract but was left");
            }
            Some(_) => assert!(
                ["data/mixdog-config.json", "data/usage/ledger.sqlite"].contains(&rel.as_str()),
                "{rel} was rewritten but the contract only converts the settings and the ledger"
            ),
            None => assert!(removed_by_contract(rel, &answers), "{rel} was removed but the contract keeps it"),
        }
    }
    // Real files whose names only resemble a temp file of some writer are still there, byte for byte.
    let lookalikes = answers["lookalikes"].as_array().expect("lookalikes");
    assert!(lookalikes.len() >= 5);
    for rel in lookalikes.iter().map(|v| v.as_str().expect("path")) {
        assert!(recorded.contains_key(rel), "{rel} is in the recording");
        assert_eq!(after.get(rel), recorded.get(rel), "{rel} is a user's file");
    }
}

/// Every writer the recorder killed left a temp file in the recording, and the migration retires each; every format of
/// `temp_files` has such a recorded file, and every store directory its writers publish through.
#[test]
fn every_temp_file_format_a_killed_1_4_5_writer_left_is_retired() {
    let (copy, _) = migrated();
    let after = tree_digest(&copy.roots());
    let recorded = recorded_files();
    let answers = answers();
    let leftovers = answers["leftovers"].as_array().expect("leftovers");
    for leftover in leftovers {
        let rel = leftover["rel"].as_str().expect("rel");
        assert!(recorded.contains_key(rel) && !after.contains_key(rel), "{} ({}): {rel}", leftover["format"], leftover["writer"]);
    }
    let formats: std::collections::BTreeSet<&str> = leftovers.iter().map(|l| l["format"].as_str().expect("format")).collect();
    for format in ["atomic-publish", "compaction-publish", "session-save", "lock-stage", "owner-refresh"] {
        assert!(formats.contains(format), "no recorded {format} leftover");
    }
    for (dir, writer) in mixdog_migrate::temp_files::ATOMIC_STORE_DIRS {
        assert!(
            leftovers.iter().any(|l| l["format"] == "atomic-publish" && l["rel"].as_str().is_some_and(|rel| rel.starts_with(&format!("data/{dir}/")))),
            "no recorded leftover of the {dir} store ({writer})"
        );
    }
    assert!(
        leftovers.iter().any(|l| l["rel"].as_str().is_some_and(|rel| rel.starts_with("data/prompt-attachments/"))),
        "no recorded blob leftover"
    );
    assert!(
        leftovers.iter().any(|l| l["rel"].as_str().is_some_and(|rel| !rel.trim_start_matches("data/").contains('/'))),
        "no recorded leftover directly under the data dir"
    );
}

/// The set-aside record 1.4.5 kept (`<id>.json.corrupt-<ts>`) is not data the core reads: it goes to quarantine, whole,
/// and the original place is empty. The recorded run therefore publishes into quarantine.
#[test]
fn a_set_aside_record_is_kept_whole_in_quarantine() {
    let (copy, complete) = migrated();
    let after = tree_digest(&copy.roots());
    let recorded = recorded_files();
    let answers = answers();
    let aside = answers["setAside"].as_array().expect("setAside");
    assert!(!aside.is_empty(), "the recording holds a set-aside record");
    assert_eq!(complete.kinds.data.retained as usize, aside.len());
    for entry in aside {
        let rel = entry["rel"].as_str().expect("rel");
        let name = rel.rsplit('/').next().expect("name");
        assert!(!after.contains_key(rel), "{rel} was left in place");
        let kept: Vec<&String> = after
            .iter()
            .filter(|(path, sha)| path.contains("/quarantine/") && path.ends_with(&format!("/{name}")) && *sha == &recorded[rel])
            .map(|(path, _)| path)
            .collect();
        assert_eq!(kept.len(), 1, "{rel} is in quarantine once, byte for byte: {kept:?}");
    }
}
#[test]
fn the_migration_runs_once_and_a_later_start_changes_nothing() {
    let copy = copy();
    let first = migrate(&copy.roots());
    let tree = tree_digest(&copy.roots());
    assert!(durable::is_file(&copy.roots().data.join("migration/complete.json")));
    // A second start of the same daemon, and a start by a fresh migrator, both find the marker.
    assert_eq!(migrate(&copy.roots()), first);
    assert_eq!(tree_digest(&copy.roots()), tree, "a later start rewrote the data");
    // A 1.4.5 file that appears afterwards is not the migration's to convert (no compatibility reads).
    durable::write_synced(&copy.roots().data.join("quota-resume.json.late"), b"{}").expect("write");
    assert_eq!(migrate(&copy.roots()), first);
    assert!(durable::is_file(&copy.roots().data.join("quota-resume.json.late")));
}

// ── Crash safety ──────────────────────────────────────────────────────────────────────────────────────────────
//
// A real kill, not an error returned to the run: the migration runs in a child process (this test binary, started
// on `crash_child`) with `durable::set_step_hook` installed. The migration reports every boundary of every mutating
// step to the hook before it takes it (`durable::Step`: a file created, half its bytes written, all written, synced,
// renamed, the parents synced; a journal frame half appended; a file removed; a transaction about to commit). The
// disk at a boundary is exactly what a process killed there leaves, so the hook only exits at the chosen one, running
// no destructor; nothing is simulated except the index database, torn by hand after it was really built. The parent then resumes in a fresh
// migration run over the same directory and compares the whole tree, the journal included, with an uninterrupted run.

/// The child's exit code when the hook killed it.
const KILLED: i32 = 86;

static STEPS: AtomicUsize = AtomicUsize::new(0);
static STOP_AT: OnceLock<usize> = OnceLock::new();
static BASE: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn on_step(step: Step, path: &Path, _bytes: &[u8]) {
    let at = STEPS.fetch_add(1, Ordering::SeqCst);
    let rel = path.strip_prefix(BASE.get().expect("base")).map_or_else(|_| path.to_string_lossy().into_owned(), |p| p.to_string_lossy().replace('\\', "/"));
    match STOP_AT.get() {
        Some(stop) if *stop == at => {
            // The one boundary a hook cannot reach into: the SQLite build. A kill after it leaves a database the OS
            // had not finished writing, which is the built file cut short.
            if step == Step::Projected {
                let len = std::fs::metadata(path).expect("the built database").len();
                std::fs::OpenOptions::new().write(true).open(path).expect("open").set_len(len / 2).expect("torn database");
            }
            std::process::exit(KILLED);
        }
        Some(_) => {}
        None => LOG.lock().expect("log").push(format!("{step:?} {rel}")),
    }
}
/// The child of the crash tests: a no-op unless the parent set `MIG145_BASE`.
#[test]
fn crash_child() {
    let Some(base) = std::env::var_os("MIG145_BASE") else { return };
    // A killed process leaves its writes with the OS, flushed or not: the kill is what is tested.
    mixdog_store::fsio::elide_syncs();
    if let Ok(stop) = std::env::var("MIG145_STOP_AT") {
        STOP_AT.set(stop.parse().expect("a step index")).expect("once");
    }
    BASE.set(Path::new(&base).to_path_buf()).expect("once");
    durable::set_step_hook(on_step);
    let roots = roots_at(Path::new(&base));
    migrator(&roots, MigrateOptions { workers: 1, fault: None }).run().expect("the run the child was not stopped in");
    if let Some(log) = std::env::var_os("MIG145_LOG") {
        std::fs::write(log, LOG.lock().expect("log").join("\n")).expect("step log");
    }
}

fn child(base: &Path, stop: Option<usize>, log: Option<&Path>) -> Option<i32> {
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["--exact", "recorded_145::crash_child", "--test-threads=1"])
        .env("MIG145_BASE", base)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(stop) = stop {
        command.env("MIG145_STOP_AT", stop.to_string());
    }
    if let Some(log) = log {
        command.env("MIG145_LOG", log);
    }
    command.status().expect("spawn the child").code()
}

/// The crash matrix is split by step index: step `i` is killed in chunk `i % CRASH_CHUNKS`, so the chunks run side by side.
const CRASH_CHUNKS: usize = 16;
/// Threads within one chunk, each killing and resuming in its own directory.
const CHUNK_WORKERS: usize = 3;

/// The steps of an unstopped run over the recorded directory, as the hook of its child logged them.
fn recorded_steps(scratch: &Path) -> Vec<String> {
    let log = scratch.join("steps.log");
    let probe = scratch.join("probe");
    copy_at(&probe);
    assert_eq!(child(&probe, None, Some(&log)), Some(0), "the unstopped child completes");
    std::fs::read_to_string(&log).expect("step log").lines().map(str::to_owned).collect()
}

/// Every boundary kind is a step of the recorded run: a kill at each is in the crash matrix.
#[test]
fn the_recorded_run_reaches_every_boundary_kind() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let steps = recorded_steps(scratch.path());
    // Every boundary of a publication is a step of the recorded run, for the quarantine it publishes into as well.
    let on = |step: &str, needle: &str| steps.iter().any(|s| s.starts_with(&format!("{step} ")) && s.contains(needle));
    for step in ["Create", "Write", "Sync", "Rename", "SyncDir"] {
        assert!(on(step, "/migration/quarantine/") || on(step, "quarantine"), "no {step} boundary in quarantine");
        assert!(on(step, "/migration/"), "no {step} boundary in the migration directory");
    }
    for step in ["Remove", "RemoveDir", "Append", "Projected", "SqliteCommit"] {
        assert!(steps.iter().any(|s| s.starts_with(&format!("{step} "))), "no {step} boundary in the run");
    }
    assert!(steps.len() >= CRASH_CHUNKS, "every crash chunk holds a step ({} recorded)", steps.len());
}

mixdog_rt::replay_chunks!(CRASH_TESTS, #[test] crash_points_chunk; [
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_00 = 0,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_01 = 1,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_02 = 2,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_03 = 3,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_04 = 4,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_05 = 5,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_06 = 6,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_07 = 7,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_08 = 8,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_09 = 9,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_10 = 10,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_11 = 11,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_12 = 12,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_13 = 13,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_14 = 14,
    every_crash_point_resumes_to_the_same_tree_on_the_recorded_directory_15 = 15,
]);

#[test]
fn every_crash_chunk_has_its_test() {
    mixdog_rt::testing::assert_chunks_registered(CRASH_TESTS, CRASH_CHUNKS, 1);
}

/// A kill at every mutating step of chunk `chunk` of a run over the recorded directory, then a resume in a fresh run: the
/// whole tree, the journal and the completion marker included, is the one an uninterrupted run leaves.
fn crash_points_chunk(chunk: usize) {
    // The trees compared are read back from the running OS; a flush to the device changes none of them.
    mixdog_store::fsio::elide_syncs();
    let scratch = tempfile::tempdir().expect("scratch dir");
    let steps = recorded_steps(scratch.path());
    let mine: Vec<(usize, &String)> = steps.iter().enumerate().skip(chunk).step_by(CRASH_CHUNKS).collect();
    assert!(!mine.is_empty(), "chunk {chunk} holds no step of the {} recorded", steps.len());
    std::thread::scope(|scope| {
        for worker in 0..CHUNK_WORKERS {
            let (mine, base) = (&mine, scratch.path().join(format!("w{worker}")));
            scope.spawn(move || {
                // The manifest names the dir a run was in, so every run of this worker is in one path: the
                // uninterrupted run first, then a kill and a resume for each of its steps.
                copy_at(&base);
                migrator(&roots_at(&base), MigrateOptions { workers: 1, fault: None }).run().expect("the uninterrupted run");
                let want = tree_digest(&roots_at(&base));
                durable::remove_dir_all(&base).expect("clean");
                for &(stop_at, step) in mine.iter().skip(worker).step_by(CHUNK_WORKERS) {
                    let roots = copy_at(&base);
                    assert_eq!(child(&base, Some(stop_at), None), Some(KILLED), "step {stop_at} ({step}) was not reached");
                    migrator(&roots, MigrateOptions { workers: 1, fault: None })
                        .run()
                        .unwrap_or_else(|e| panic!("resume after a kill in step {stop_at} ({step}): {e}"));
                    let got = tree_digest(&roots);
                    let diff: Vec<_> = want.keys().chain(got.keys()).filter(|k| want.get(*k) != got.get(*k)).collect();
                    assert!(diff.is_empty(), "after a kill in step {stop_at} ({step}): {diff:?}");
                    durable::remove_dir_all(&base).expect("clean");
                }
            });
        }
    });
}