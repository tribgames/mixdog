//! Node's recording `fixtures/atomic-file-temp-name-cases` (`record-atomic-file-temp-name-cases.mjs`, b6f10295a), case "every
//! stale-temp sweep still recognises the temp name the writer produces": the names Node's atomic writer created beside each target
//! (the code-graph cache and manifest, a crash capture, the session-summary index), `<target>.mixdog-tmp-<16 hex>` with the random
//! suffix written `<hex16>` in the recording. Whatever the previous version left of them, the core's startup recognises as the
//! temp of its target (the migration's stale-temp classifier), so a stale one is reclaimed and a user's file is not. What each sweep of Node\n//! decided about those names is compared too: the code-graph cache's temp patterns, the dead-writer reclamation of a crash capture's temp\n//! and the ten-minute sweep of the session-summary index's temp, as the core's start-up runs them (stale_temps).

use std::time::Duration;
use std::time::SystemTime;

use mixdog_app_server_daemon::stale_temps::reclaim_dead_capture_temps;
use mixdog_app_server_daemon::stale_temps::sweep_stale_summary_temps;
use mixdog_migrate::temp_files::atomic_publish_base;
use mixdog_tools::code_graph::is_tmp_name;
use serde_json::Value;

#[test]
fn every_temp_name_node_wrote_is_recognised_as_the_temp_of_its_target() {
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
    let swept = sweep_stale_summary_temps(data.path(), SystemTime::now() + Duration::from_secs(3 * 60 * 60));
    assert_eq!(Value::from(swept), observed["summarySwept"], "the summary sweep's count");
    assert_eq!(!mixdog_testkit::exists(&summary), observed["summaryReclaimed"] == true, "the summary temp");
}