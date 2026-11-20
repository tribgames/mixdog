//! The session-summary temp sweep: a temp the writer names `<target>.mixdog-tmp-<16 hex>` goes at ten minutes and not a millisecond before, and is not swept while a writer holds
//! the index lock.

use std::time::Duration;
use std::time::SystemTime;

use mixdog_app_server_daemon::stale_temps::sweep_stale_summary_temps;
use mixdog_rt::LaneToken;
use tokio_util::sync::CancellationToken;

const TEN_MINUTES: Duration = Duration::from_secs(10 * 60);

/// A temp file of the summary index whose last write is `modified`.
#[allow(
    clippy::disallowed_methods,
    reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
)]
#[allow(
    clippy::disallowed_types,
    reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
)]
fn summary_temp_modified(dir: &std::path::Path, modified: SystemTime) -> std::path::PathBuf {
    let temp = dir.join("session-summaries.json.mixdog-tmp-0123456789abcdef");
    mixdog_testkit::write(&temp, "{");
    std::fs::File::options().write(true).open(&temp).expect("open").set_modified(modified).expect("set the write time");
    temp
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
#[allow(
    clippy::disallowed_methods,
    reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
)]
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
