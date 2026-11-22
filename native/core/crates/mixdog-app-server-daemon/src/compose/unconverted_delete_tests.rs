//! A session of an earlier version that the migration removed without converting it is finished by the composed core's
//! session directory (`SessionDirectory::purge_unconverted`, what `boot.rs` `ProductRetention::purge` calls): the
//! sub-agent retention's delete from where a stored record would be gone, over the hooks and the delete seams the
//! daemon composes. What it leaves is what that delete leaves of a stored session, but for the earlier version's own
//! files of it, which the migration removes under its hash check.
use super::*;
use std::time::Duration;

#[test]
fn the_delete_of_an_unconverted_session_removes_what_a_delete_removes_and_leaves_its_sources() {
    crate::compose_test_support::on_marked_runtime(deleted_unconverted());
}

#[allow(clippy::disallowed_methods, reason = "Test-only fixture setup and owned-file assertions over the test's own data directory.")]
#[allow(clippy::disallowed_types, reason = "Test-only fixture setup and owned-file assertions over the test's own data directory.")]
async fn deleted_unconverted() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let put = |path: &Path, text: &str| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    // The earlier version's own files of the session: the migration's to remove.
    let sources = [data.join("sessions").join("sess_worker.log.jsonl"), data.join("sessions").join("sess_worker.compaction-archive.jsonl")];
    // What a delete removes of a session outside its record.
    let removed = [
        mixdog_tools::exec::session_scratch_dir(&data, "sess_worker").unwrap().join("note.txt"),
        data.join("scratch").join("sess_worker").join("note.txt"),
        data.join("read-snapshots").join("sess_worker.json"),
        data.join("tool-results").join("sess_worker").join("1.txt"),
    ];
    for file in sources.iter().chain(&removed) {
        put(file, "{}");
    }
    let route = serde_json::json!({ "mode": "claude-current", "defaultProvider": "openai", "defaultModel": "gpt", "updatedAt": 1 });
    let routes_file = data.join(mixdog_core_session::session::gateway_routes::STORE_FILE);
    put(
        &routes_file,
        &serde_json::json!({ "version": 2, "updatedAt": 1, "sessions": { "sess_worker": route, "sess_kept": route }, "sessionHosts": {} }).to_string(),
    );
    let routed = || -> Vec<String> {
        let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&routes_file).unwrap()).unwrap();
        let mut sessions: Vec<String> = stored["sessions"].as_object().unwrap().keys().cloned().collect();
        sessions.sort();
        sessions
    };

    let stop = mixdog_rt::CancellationToken::new();
    let log = crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone());
    let mut config = tests::config_without_postgres(&data, dir.path(), log, stop, "the unconverted delete test must not install PostgreSQL");
    config.js_runtime.program = "node".into();
    let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, config))
        .await
        .expect("composition did not complete within 60 seconds")
        .expect("the daemon composes");
    for file in sources.iter().chain(&removed) {
        assert!(file.exists(), "composing removes nothing of the session: {}", file.display());
    }
    assert_eq!(routed(), ["sess_kept", "sess_worker"], "composing keeps the routes");

    let header = serde_json::json!({
        "id": "sess_worker", "agent": "worker", "owner": "agent", "visibility": "agent-only", "ownerSessionId": "sess_lead",
        "parentSessionId": "sess_lead", "createdAt": 1_700_000_000_000_u64, "lastUsedAt": 1_700_000_000_000_u64
    });
    core.session_directory().purge_unconverted("sess_worker", header.as_object().unwrap()).await;

    for file in &removed {
        assert!(!file.exists(), "the delete removes {}", file.display());
    }
    for file in &sources {
        assert!(file.exists(), "the delete leaves the earlier version's {} to the migration", file.display());
    }
    assert_eq!(routed(), ["sess_kept"], "the session's gateway route goes with its work, and no other");
    // The close line is written behind the delete.
    let events = data.join("tool-events.log");
    let closed = |text: &str| {
        text.lines().any(|line| line.contains("[session-close] owner=agent agent=worker reason=desktop-session-delete") && line.ends_with("id=sess_worker"))
    };
    let waited = mixdog_rt::time::timeout(Duration::from_secs(30), async {
        while !std::fs::read_to_string(&events).is_ok_and(|text| closed(&text)) {
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(waited.is_ok(), "the close of the session is logged: {:?}", std::fs::read_to_string(&events));
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("unconverted delete test")).await.expect("core shutdown did not complete within 30 seconds");
}

/// A measurement, not a check: the time the composed core's delete takes for the sessions a migration removed
/// unconverted. `MIXDOG_TAIL_DIR` names a folder the caller prepared: `data` (what a delete acts on of the earlier
/// version's data dir: read snapshots, scratch folders, the gateway routes, `tool-events.log`), `home` (the
/// `MIXDOG_HOME` of this process, with the `projects` the transcripts lie under) and `expired.jsonl` (each session with
/// the header it was judged by, as `migration_steps` lists them). The deletes run on `MIXDOG_TAIL_WORKERS` threads that
/// block on the runtime, as the migration's disposal runs them (`boot.rs` `ProductRetention::purge`).
#[test]
#[ignore = "measurement: consumes the folder MIXDOG_TAIL_DIR names"]
fn the_time_the_deletes_of_the_sessions_removed_unconverted_take() {
    crate::compose_test_support::on_marked_runtime(timed_deletes());
}

#[allow(clippy::disallowed_methods, reason = "Measurement over a folder the caller prepared.")]
#[allow(clippy::disallowed_types, reason = "Measurement over a folder the caller prepared.")]
async fn timed_deletes() {
    let dir = PathBuf::from(std::env::var_os("MIXDOG_TAIL_DIR").expect("MIXDOG_TAIL_DIR names the prepared folder"));
    let data = dir.join("data");
    // The transcripts are removed under this process's `MIXDOG_HOME`: never a person's own.
    assert_eq!(std::env::var_os("MIXDOG_HOME").map(PathBuf::from), Some(dir.join("home")), "MIXDOG_HOME is the prepared folder's home");
    assert!(!data.join("secrets").exists() && !data.join("mixdog-config.json").exists(), "the prepared data dir is not a person's profile");
    let workers: usize = std::env::var("MIXDOG_TAIL_WORKERS").ok().map_or(4, |workers| workers.parse().expect("a worker count"));
    let sessions: Vec<(String, mixdog_store::schema::record::Header)> = std::fs::read_to_string(dir.join("expired.jsonl"))
        .expect("expired.jsonl")
        .lines()
        .map(|line| {
            let entry: serde_json::Value = serde_json::from_str(line).expect("a session and its header");
            (entry["id"].as_str().expect("an id").to_owned(), entry["header"].as_object().expect("a header").clone())
        })
        .collect();
    let tokens = mixdog_rt::testing::tokens();
    let stop = mixdog_rt::CancellationToken::new();
    let log = crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone());
    let config = ComposeConfig {
        pg_install: Some(Arc::new(|_| {
            Box::pin(async { Err(mixdog_services::memory::error::MemoryError::Runtime("the measurement installs no PostgreSQL".into())) })
        })),
        ..tests::config_in(&data, &dir, log, stop)
    };
    let mut config = config;
    config.js_runtime.program = "node".into();
    let core = compose(&tokens, config).await.expect("the daemon composes");
    let directory = core.session_directory();
    let (runtime, next) = (tokio::runtime::Handle::current(), std::sync::atomic::AtomicUsize::new(0));
    let began = std::time::Instant::now();
    let (sessions, next) = (&sessions, &next);
    tokio::task::block_in_place(|| {
        std::thread::scope(|scope| {
            for _ in 0..workers.max(1) {
                let (runtime, directory) = (runtime.clone(), directory.clone());
                scope.spawn(move || {
                    while let Some((id, header)) = sessions.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)) {
                        runtime.block_on(directory.purge_unconverted(id, header));
                    }
                });
            }
        });
    });
    eprintln!("deleted {} sessions removed unconverted on {workers} threads in {:.1} s", sessions.len(), began.elapsed().as_secs_f64());
    mixdog_rt::time::timeout(Duration::from_secs(120), core.stop("unconverted delete measurement"))
        .await
        .expect("core shutdown did not complete within 120 seconds");
}
