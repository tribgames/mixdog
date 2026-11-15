//! `mixdog-relay renderer-releases --action=prepare`: the cases of `apps/relay/deploy/renderer-releases.test.mjs`, and the
//! `index.json` the tool writes for a fixture history equal byte for byte to the one the Node tool wrote for it
//! (`tests/fixtures/renderer-releases-index.json`, recorded by `tests/renderer_releases_record.mjs`).

use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_relay::js;
use mixdog_relay::tools::renderer_releases::{
    PrepareOptions, PrepareOutcome, link_tree, prepare_releases, read_reporting_devices, release_id_for, run,
};
use mixdog_relay::web::releases::{DeviceReport, DeviceSeen, ReleaseIndex};
use serde_json::Value;

const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const NOW: f64 = 1_767_225_600_000.0; // Date.UTC(2026, 0, 1)

/// A staged renderer whose shell version is `label` repeated; returns that shell version.
fn staged(dir: &Path, label: &str) -> String {
    let shell = label.repeat(64)[..64].to_owned();
    mixdog_fsio::create_dir_all(&Unlaned, dir).expect("a folder");
    let page = format!("<!doctype html><meta name=\"mixdog-shell-version\" content=\"{shell}\"><body>{label}</body>");
    mixdog_fsio::write(&Unlaned, dir.join("index.html"), page).expect("a page");
    mixdog_fsio::write(&Unlaned, dir.join("app.js"), format!("// {label}")).expect("a script");
    shell
}

fn prepare(releases: &Path, renderer: &Path, version: &str, legacy: Option<&Path>, devices: &[DeviceSeen], now: f64) -> PrepareOutcome {
    prepare_releases(&PrepareOptions {
        releases_dir: releases.to_owned(),
        renderer_dir: renderer.to_owned(),
        desktop_version: version.to_owned(),
        legacy_dir: legacy.map(Path::to_owned),
        devices: devices.to_vec(),
        now,
    })
    .expect("the deploy step")
}

fn failure(releases: &Path, renderer: &Path, version: &str, now: f64) -> String {
    prepare_releases(&PrepareOptions {
        releases_dir: releases.to_owned(),
        renderer_dir: renderer.to_owned(),
        desktop_version: version.to_owned(),
        legacy_dir: None,
        devices: Vec::new(),
        now,
    })
    .expect_err("a refused deploy")
    .to_string()
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = mixdog_fsio::read_dir(&Unlaned, dir)
        .expect("a listing")
        .map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

fn sorted(mut list: Vec<&str>) -> Vec<String> {
    list.sort_unstable();
    list.into_iter().map(str::to_owned).collect()
}

fn text(path: impl AsRef<Path>) -> String {
    mixdog_fsio::read_to_string(&Unlaned, path).expect("a file")
}

fn present(path: impl AsRef<Path>) -> bool {
    mixdog_fsio::exists(&Unlaned, path).expect("a probe")
}

fn outcome(release_id: &str, added: bool, legacy: &str, kept: &[&str], dropped: &[&str]) -> PrepareOutcome {
    let owned = |list: &[&str]| list.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>();
    PrepareOutcome { release_id: release_id.to_owned(), added, legacy: legacy.to_owned(), kept: owned(kept), dropped: owned(dropped) }
}

fn sandbox() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path().to_owned();
    let releases = root.join("renderer-releases");
    (guard, root, releases)
}

fn seen(version: &str, at: f64) -> DeviceSeen {
    DeviceSeen { report: DeviceReport { app_version: version.to_owned(), renderer_release: String::new() }, seen_at: at }
}

#[test]
fn the_first_deploy_adopts_the_installed_renderer_as_legacy_and_adds_the_new_one_beside_it() {
    let (_guard, root, releases) = sandbox();
    let installed_shell = staged(&root.join("installed"), "a");
    let new_shell = staged(&root.join("next"), "b");
    let result = prepare(&releases, &root.join("next"), "1.5.0", Some(&root.join("installed")), &[], NOW);
    let id = release_id_for("1.5.0", &new_shell);
    assert_eq!(result, outcome(&id, true, "legacy", &["legacy", &id], &[]));
    assert!(text(releases.join("legacy").join("index.html")).contains("<body>a</body>"));
    assert!(text(releases.join(&id).join("index.html")).contains("<body>b</body>"));
    let index = ReleaseIndex::read(&releases).expect("a registry").expect("one");
    assert_eq!(index.releases.iter().find(|entry| entry.legacy).expect("legacy").shell_version, installed_shell);
    // Releases are hardlinks of the staged tree: no second copy on disk (a write through the staged file shows in the release).
    mixdog_fsio::write(&Unlaned, root.join("next").join("app.js"), "// changed").expect("a write");
    assert_eq!(text(releases.join(&id).join("app.js")), "// changed");

    // Redeploying the same build is idempotent; a relay-only deploy (no desktop version) registers nothing and keeps the registry.
    assert!(!prepare(&releases, &root.join("next"), "1.5.0", None, &[], NOW).added);
    let relay_only = prepare(&releases, &root.join("next"), "", None, &[], NOW);
    assert_eq!(relay_only, outcome("", false, "legacy", &["legacy", &id], &[]));
}

#[test]
fn garbage_collection_applies_the_retention_rule_and_spares_the_installed_tree_it_was_linked_from() {
    let (_guard, root, releases) = sandbox();
    staged(&root.join("installed"), "a");
    let mut ids = Vec::new();
    for (step, label) in ["b", "c", "d", "e", "f"].iter().enumerate() {
        staged(&root.join("stage").join(label), label);
        let now = NOW + step as f64;
        let result = prepare(&releases, &root.join("stage").join(label), &format!("1.{step}.0"), Some(&root.join("installed")), &[], now);
        ids.push(result.release_id);
    }
    // legacy + newest 3 survive; 1.0.0 and 1.1.0 were collected.
    assert_eq!(names(&releases), sorted(vec!["index.json", "legacy", &ids[2], &ids[3], &ids[4]]));

    // A device seen recently on 1.2.0 pins that release even after it falls out of the newest three; one unseen for months does not.
    staged(&root.join("stage").join("1"), "1");
    staged(&root.join("stage").join("2"), "2");
    let live = root.join("live").join("renderer-releases");
    link_tree(&releases, &live).expect("a clone");
    let devices = [seen("1.2.0", NOW - DAY), seen("1.3.0", NOW - 90.0 * DAY)];
    // 1.2.0 is no longer among the newest three, but a recent device uses it.
    assert!(prepare(&live, &root.join("stage").join("1"), "1.8.0", None, &devices, NOW + 10.0).dropped.is_empty());
    let result = prepare(&live, &root.join("stage").join("2"), "1.9.0", None, &devices, NOW + 11.0);
    assert_eq!(result.dropped, vec![ids[3].clone()]);
    assert!(result.kept.contains(&ids[2]));
    // The staged copy was collected; the installed registry it was cloned from (what a rollback restores) is untouched.
    assert!(!present(live.join(&ids[3])));
    assert!(text(releases.join(&ids[3]).join("index.html")).contains("<body>e</body>"));
    let installed = ReleaseIndex::read(&releases).expect("a registry").expect("one");
    assert!(installed.releases.iter().any(|entry| entry.id == ids[3]));
}

#[test]
fn unregistered_leftovers_from_an_interrupted_run_are_collected_and_bad_input_is_refused() {
    let (_guard, root, releases) = sandbox();
    staged(&root.join("next"), "b");
    staged(&releases.join("orphan"), "c");
    let result = prepare(&releases, &root.join("next"), "2.0.0", None, &[], NOW);
    assert_eq!(names(&releases), sorted(vec!["index.json", &result.release_id]));
    assert!(failure(&releases, &root.join("next"), "../x", NOW).contains("desktop version"));
    mixdog_fsio::write(&Unlaned, root.join("next").join("index.html"), "<html>unversioned</html>").expect("a page");
    assert!(failure(&releases, &root.join("next"), "2.0.1", NOW).contains("metadata missing"));
}

#[test]
fn the_cli_reads_reporting_devices_from_devices_json_and_prints_one_json_result() {
    let (_guard, root, releases) = sandbox();
    let shell = staged(&root.join("next"), "b");
    let devices = root.join("devices.json");
    let rows = concat!(
        "{\"one\":{\"appVersion\":\"1.0.0\",\"versionSeenAt\":5},",
        "\"silent\":{\"secretHash\":\"x\"},",
        "\"bad\":{\"appVersion\":\"1.0.0\",\"versionSeenAt\":\"yesterday\"}}"
    );
    mixdog_fsio::write(&Unlaned, &devices, rows).expect("devices");
    assert_eq!(read_reporting_devices(Some(&devices)).expect("rows"), vec![seen("1.0.0", 5.0)]);
    assert!(read_reporting_devices(Some(&root.join("missing.json"))).expect("none").is_empty());
    assert!(read_reporting_devices(None).expect("none").is_empty());

    let args = vec![
        "--action=prepare".to_owned(),
        format!("--releases={}", releases.display()),
        format!("--renderer={}", root.join("next").display()),
        "--desktop-version=3.1.4".to_owned(),
        format!("--devices={}", devices.display()),
    ];
    let line = run(&args).expect("a result line");
    let printed: Value = js::parse(&line).expect("one JSON value");
    assert_eq!(printed["releaseId"], release_id_for("3.1.4", &shell));
    assert_eq!(printed["added"], true);
    assert!(!line.contains('\n'));

    let unknown = run(&["--action=nope".to_owned()]).expect_err("an unknown action").to_string();
    assert_eq!(unknown, "Unknown renderer-releases action: nope");
    assert_eq!(run(&[]).expect_err("no action").to_string(), "Unknown renderer-releases action: (missing)");
    assert_eq!(run(&["prepare".to_owned()]).expect_err("a bare word").to_string(), "Invalid argument: prepare");
}

fn same_results(recorded: &Value, ran: &[PrepareOutcome]) {
    let wanted = recorded["results"].as_array().expect("results");
    assert_eq!(wanted.len(), ran.len());
    for (wanted, ran) in wanted.iter().zip(ran) {
        assert_eq!(js::wire(wanted), js::wire(&ran.to_json()));
    }
}

#[test]
fn index_json_is_byte_equal_to_the_one_the_node_tool_writes() {
    let recording = js::parse(include_str!("fixtures/renderer-releases-index.json")).expect("the recording");

    // History one: adopt, add, redeploy, relay-only (`tests/renderer_releases_record.mjs`).
    let (_guard, root, releases) = sandbox();
    staged(&root.join("installed"), "a");
    staged(&root.join("next"), "b");
    let ran = [
        prepare(&releases, &root.join("next"), "1.5.0", Some(&root.join("installed")), &[], NOW),
        prepare(&releases, &root.join("next"), "1.5.0", None, &[], NOW),
        prepare(&releases, &root.join("next"), "", None, &[], NOW),
    ];
    same_results(&recording["adopt"], &ran);
    assert_eq!(text(releases.join("index.json")), recording["adopt"]["index"].as_str().expect("index text"));

    // History two: five deploys, then two into a clone of the registry with recent and long unseen devices.
    let (_guard, root, registry) = sandbox();
    staged(&root.join("installed"), "a");
    let mut ran = Vec::new();
    for (step, label) in ["b", "c", "d", "e", "f"].iter().enumerate() {
        staged(&root.join("stage").join(label), label);
        let now = NOW + step as f64;
        ran.push(prepare(&registry, &root.join("stage").join(label), &format!("1.{step}.0"), Some(&root.join("installed")), &[], now));
    }
    staged(&root.join("stage").join("1"), "1");
    staged(&root.join("stage").join("2"), "2");
    let live = root.join("live").join("renderer-releases");
    link_tree(&registry, &live).expect("a clone");
    let devices = [seen("1.2.0", NOW - DAY), seen("1.3.0", NOW - 90.0 * DAY)];
    for (label, version, offset) in [("1", "1.8.0", 10.0), ("2", "1.9.0", 11.0)] {
        ran.push(prepare(&live, &root.join("stage").join(label), version, None, &devices, NOW + offset));
    }
    same_results(&recording["gc"], &ran);
    assert_eq!(text(live.join("index.json")), recording["gc"]["index"].as_str().expect("index text"));
}
