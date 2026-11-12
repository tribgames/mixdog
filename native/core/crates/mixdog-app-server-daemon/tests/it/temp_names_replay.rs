//! Node's recording `fixtures/atomic-file-temp-name-cases` (`record-atomic-file-temp-name-cases.mjs`, b6f10295a), case "every
//! stale-temp sweep still recognises the temp name the writer produces": the names Node's atomic writer created beside each target
//! (the code-graph cache and manifest, a crash capture, the session-summary index), `<target>.mixdog-tmp-<16 hex>` with the random
//! suffix written `<hex16>` in the recording. Whatever the previous version left of them, the core's startup recognises as the
//! temp of its target (the migration's stale-temp classifier), so a stale one is reclaimed and a user's file is not. What each sweep of Node\n//! decided about those names is compared too: the code-graph cache's temp patterns, the dead-writer reclamation of a crash capture's temp\n//! and the ten-minute sweep of the session-summary index's temp, as the core's start-up runs them (stale_temps).

use std::time::Duration;
use std::time::SystemTime;

use mixdog_app_server_daemon::crash_record::pid_alive;
use mixdog_app_server_daemon::stale_temps::reclaim_dead_capture_temps;
use mixdog_app_server_daemon::verdict::ProcessIdentity;
use mixdog_app_server_daemon::verdict::ProcessInfo;
use mixdog_app_server_daemon::verdict::ProcessTable;
use mixdog_rt::LaneToken;
use tokio_util::sync::CancellationToken;
use mixdog_app_server_daemon::stale_temps::sweep_stale_summary_temps;
use mixdog_migrate::temp_files::atomic_publish_base;
use mixdog_tools::code_graph::is_tmp_name;
use serde_json::Value;

#[tokio::test]
async fn every_temp_name_node_wrote_is_recognised_as_the_temp_of_its_target() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/atomic-file-temp-name-cases/golden.json")).expect("golden.json");
    let observed = &golden["cases"][0]["observed"];
    let targets: Vec<&str> = observed["written"].as_array().expect("written").iter().map(|t| t.as_str().expect("a target")).collect();
    let names = observed["names"].as_object().expect("names");
    assert_eq!(names.len(), targets.len(), "one temp name per written target");
    for ((kind, recorded), target) in names.iter().zip(&targets) {
        let recorded = recorded.as_array().expect("names of one write");
        assert_eq!(recorded.len(), 1, "{kind}: the writer creates one temp file");
        // The recording writes the writer's random suffix as `<hex16>`: any 16 lowercase hex digits stand for it.
        let name = recorded[0].as_str().expect("a name").replace("<hex16>", "0123456789abcdef");
        assert_eq!(atomic_publish_base(&name), Some(*target), "{kind}: {name}");
    }

    // `<hex16>` stands for the random suffix: any 16 lowercase hex digits.
    let recorded_name = |kind: &str| observed["names"][kind][0].as_str().expect("a name").replace("<hex16>", "0123456789abcdef");

    let patterns = observed["cachePatterns"].as_object().expect("cachePatterns");
    assert_eq!(patterns.len(), 3, "the three cache names the recording judged");
    for (kind, recognised) in patterns {
        let name = recorded_name(kind);
        assert_eq!(Value::Bool(is_tmp_name(&name)), *recognised, "{kind}: the cache sweep's verdict on {name}");
    }

    // A crash capture's temp whose writer (the pid in its name) is gone is reclaimed.
    let captures = tempfile::tempdir().expect("capture folder");
    let capture = captures.path().join(recorded_name("capture"));
    mixdog_testkit::write(&capture, "{");
    assert_eq!(reclaim_dead_capture_temps(captures.path(), &|_| false), usize::from(observed["captureReclaimed"] == true));
    assert_eq!(!mixdog_testkit::exists(&capture), observed["captureReclaimed"] == true, "the capture temp of a dead writer");

    // The session-summary index's temp is swept once it is three hours old.
    let data = tempfile::tempdir().expect("data folder");
    let summary = data.path().join(recorded_name("summary"));
    mixdog_testkit::write(&summary, "{");
    let written = written_at(&summary);
    let swept = sweep(data.path(), written + Duration::from_secs(3 * 60 * 60)).await;
    assert_eq!(Value::from(swept), observed["summarySwept"], "the summary sweep's count");
    assert_eq!(!mixdog_testkit::exists(&summary), observed["summaryReclaimed"] == true, "the summary temp");
}

const TEN_MINUTES: Duration = Duration::from_secs(10 * 60);

/// A temp file of the summary index whose last write is `modified`.
fn summary_temp_modified(dir: &std::path::Path, modified: SystemTime) -> std::path::PathBuf {
    let temp = dir.join("session-summaries.json.mixdog-tmp-0123456789abcdef");
    mixdog_testkit::write(&temp, "{");
    std::fs::File::options().write(true).open(&temp).expect("open").set_modified(modified).expect("set the write time");
    temp
}

fn written_at(path: &std::path::Path) -> SystemTime {
    std::fs::metadata(path).and_then(|meta| meta.modified()).expect("the write time")
}

/// `sweepStaleSummaryTempFiles({ now })` as a lane job, on the clock the test gives it.
async fn sweep(dir: &std::path::Path, now: SystemTime) -> usize {
    let dir = dir.to_path_buf();
    mixdog_rt::testing::tokens()
        .maintenance_io
        .submit(&CancellationToken::new(), move |lane| sweep_stale_summary_temps(lane, &dir, now))
        .expect("the lane takes the job")
        .await
        .expect("the job ran")
}

/// `now - mtimeMs < minAgeMs` keeps the temp: a temp one millisecond short of ten minutes stays, one of exactly ten minutes goes.
#[tokio::test]
async fn a_summary_temp_goes_at_ten_minutes_and_not_a_millisecond_before() {
    let data = tempfile::tempdir().expect("data folder");
    let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let temp = summary_temp_modified(data.path(), modified);
    assert_eq!(sweep(data.path(), modified + TEN_MINUTES - Duration::from_millis(1)).await, 0);
    assert!(mixdog_testkit::exists(&temp), "nine minutes fifty-nine seconds old");
    assert_eq!(sweep(data.path(), modified + TEN_MINUTES).await, 1);
    assert!(!mixdog_testkit::exists(&temp), "ten minutes old");
}

/// A writer holds `session-summaries.json.lock` for its whole write: while another holds it, nothing is swept, however old the
/// temp, and the holder's lock is left as it is (Node: ELOCKCONTENDED, swallowed).
#[tokio::test]
async fn a_summary_temp_is_not_swept_while_a_writer_holds_the_index_lock() {
    let data = tempfile::tempdir().expect("data folder");
    let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let temp = summary_temp_modified(data.path(), modified);
    let lock = data.path().join("session-summaries.json.lock");
    let record = format!("{} 0 foreign-token\n", std::process::id());
    mixdog_testkit::write(&lock, &record);
    assert_eq!(sweep(data.path(), modified + 3 * TEN_MINUTES).await, 0);
    assert!(mixdog_testkit::exists(&temp), "a live writer's temp");
    assert_eq!(std::fs::read_to_string(&lock).expect("the holder's lock"), record, "the holder's lock is untouched");
    std::fs::remove_file(&lock).expect("release");
    assert_eq!(sweep(data.path(), modified + 3 * TEN_MINUTES).await, 1);
    assert!(!mixdog_testkit::exists(&temp));
    assert!(!mixdog_testkit::exists(&lock), "the sweep's own lock is released");
}

/// A capture temp is debris only when its writer is proven gone: a live writer keeps it, and so does a process table that cannot answer.
#[test]
fn a_capture_temp_is_kept_unless_its_writer_is_proven_gone() {
    struct Table(std::io::Result<bool>);
    impl ProcessTable for Table {
        fn query(&self, _: u64) -> std::io::Result<Option<ProcessInfo>> {
            match &self.0 {
                Ok(true) => Ok(Some(ProcessInfo { identity: ProcessIdentity { pid: 1, start_ms: 0 }, image: None, command_line: None })),
                Ok(false) => Ok(None),
                Err(error) => Err(std::io::Error::new(error.kind(), "table unreadable")),
            }
        }
        fn listens(&self, _: u32, _: u16) -> std::io::Result<bool> {
            Ok(false)
        }
    }
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/atomic-file-temp-name-cases/golden.json")).expect("golden.json");
    let name = golden["cases"][0]["observed"]["names"]["capture"][0].as_str().expect("a name").replace("<hex16>", "0123456789abcdef");
    for (table, reclaimed) in [(Ok(true), false), (Err(std::io::ErrorKind::PermissionDenied), false), (Ok(false), true)] {
        let captures = tempfile::tempdir().expect("capture folder");
        let capture = captures.path().join(&name);
        mixdog_testkit::write(&capture, "{");
        let table = Table(table.map_err(std::io::Error::from));
        assert_eq!(reclaim_dead_capture_temps(captures.path(), &|pid| pid_alive(&table, pid)), usize::from(reclaimed));
        assert_eq!(!mixdog_testkit::exists(&capture), reclaimed);
    }
}