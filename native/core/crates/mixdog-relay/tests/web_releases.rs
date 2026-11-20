//! The renderer release registry, the per-device choice of release, the `/readyz` report and the hashed asset rule, on fixture trees built in each test.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use mixdog_fsio::Unlaned;
use mixdog_relay::web::hashed::{is_hashed_asset, is_hashed_asset_name};
use mixdog_relay::web::readiness::{Readiness, RendererReadiness, StaticResolution, inspect_renderer, resolve_static_target};
use mixdog_relay::web::releases::{Clock, DeviceReport, DeviceSeen, ReleaseEntry, ReleaseIndex, RendererCatalog, RetentionOptions};
use serde_json::{Value, json};

const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const NOW: f64 = 1_767_225_600_000.0; // Date.UTC(2026, 0, 1)

fn entry(id: &str, desktop_version: &str, added_at: f64, legacy: bool, shell_version: &str) -> ReleaseEntry {
    ReleaseEntry { id: id.to_owned(), desktop_version: desktop_version.to_owned(), shell_version: shell_version.to_owned(), added_at, legacy }
}

fn release(id: &str, desktop_version: &str, added_at: f64) -> ReleaseEntry {
    entry(id, desktop_version, added_at, false, "")
}

fn legacy() -> ReleaseEntry {
    entry("legacy", "", 1.0, true, "")
}

fn registry(releases: Vec<ReleaseEntry>) -> ReleaseIndex {
    ReleaseIndex::new(releases).expect("a valid registry")
}

fn report(app_version: &str, renderer_release: &str) -> DeviceReport {
    DeviceReport { app_version: app_version.to_owned(), renderer_release: renderer_release.to_owned() }
}

fn selected<'a>(index: &'a ReleaseIndex, report: &DeviceReport) -> &'a str {
    &index.select(report).expect("a release").id
}

fn parse_error(value: &Value) -> String {
    ReleaseIndex::parse(value).expect_err("an invalid registry").to_string()
}

#[test]
fn selection_requires_the_exact_reported_app_version() {
    let index = registry(vec![legacy(), release("r100", "1.0.0", 10.0), release("r102", "1.0.2", 20.0), release("r110", "1.1.0", 30.0)]);
    assert_eq!(selected(&index, &report("1.0.2", "")), "r102");
    for missing in ["1.0.5", "9.0.0", "1.0.5-beta.1", "1.1.0+build7", "0.9.0", "nightly"] {
        assert!(index.select(&report(missing, "")).is_none(), "{missing}");
    }
    assert_eq!(selected(&index, &DeviceReport::default()), "legacy");
    // Same desktop version deployed twice: the later build wins; at the same instant the later entry.
    let rebuilt = registry(vec![legacy(), release("a", "1.0.2", 20.0), release("b", "1.0.2", 25.0)]);
    assert_eq!(selected(&rebuilt, &report("1.0.2", "")), "b");
    let tied = registry(vec![legacy(), release("a", "1.0.2", 20.0), release("b", "1.0.2", 20.0)]);
    assert_eq!(selected(&tied, &report("1.0.2", "")), "b");
}

#[test]
fn a_shell_hash_pins_a_rebuild_but_cannot_override_a_reported_version() {
    let pinned = "c".repeat(64);
    let index = registry(vec![entry("old", "1.0.0", 10.0, false, &pinned), release("rebuilt", "1.0.0", 15.0), release("new", "1.1.0", 20.0)]);
    assert_eq!(selected(&index, &report("1.0.0", &pinned)), "old");
    assert_eq!(selected(&index, &report("1.1.0", &pinned)), "new");
    assert!(index.select(&report("1.2.0", &pinned)).is_none());
    assert_eq!(selected(&index, &DeviceReport::default()), "new");
    // A release id that no retained release carries falls through to the version rule.
    assert_eq!(selected(&index, &report("1.1.0", &"d".repeat(64))), "new");
    // The adopted entry has no version on disk, but the exact known hash can prove a match.
    let with_legacy = registry(vec![entry("legacy", "", 1.0, true, &pinned), release("new", "1.1.0", 20.0)]);
    assert_eq!(selected(&with_legacy, &report("", &pinned)), "legacy");
    assert_eq!(selected(&with_legacy, &report("1.0.0", &pinned)), "legacy");
    assert!(with_legacy.select(&report("1.0.0", "")).is_none());
    let conflict = registry(vec![entry("legacy", "", 1.0, true, &pinned), entry("new", "1.1.0", 20.0, false, &pinned)]);
    assert!(conflict.select(&report("1.0.0", &pinned)).is_none());
    assert_eq!(selected(&conflict, &report("1.1.0", &pinned)), "new");
}

#[test]
fn retention_keeps_legacy_the_newest_n_and_releases_recently_seen_devices_still_use() {
    let index = registry(vec![
        legacy(),
        release("v1", "1.0.0", 10.0),
        release("v2", "1.1.0", 20.0),
        release("v3", "1.2.0", 30.0),
        release("v4", "1.3.0", 40.0),
        release("v5", "1.4.0", 50.0),
    ]);
    let options = RetentionOptions { keep_latest: 2, max_retained: 3, ..RetentionOptions::at(NOW) };
    let seen = |app_version: &str, seen_at: f64| DeviceSeen { report: report(app_version, ""), seen_at };
    let plan = index.plan_retention(&[seen("1.0.0", NOW - DAY), seen("1.1.0", NOW - 90.0 * DAY)], &options);
    // v4/v5 newest-2; v1 is pinned by a device seen yesterday; v2's only user was last seen 90 days ago; v3 is nobody's.
    assert_eq!(plan.keep, ["legacy", "v1", "v4", "v5"]);
    assert_eq!(plan.drop, ["v2", "v3"]);
    // The retained count is bounded even when many old releases are in use.
    let crowded: Vec<DeviceSeen> = ["1.0.0", "1.1.0", "1.2.0"].iter().map(|version| seen(version, NOW)).collect();
    let bounded = index.plan_retention(&crowded, &options);
    assert_eq!(bounded.keep.iter().filter(|id| *id != "legacy").count(), 3);
    assert_eq!(bounded.keep, ["legacy", "v3", "v4", "v5"]);
    // A device whose last-seen time is not a number pins nothing.
    let unknown = index.plan_retention(&[seen("1.0.0", f64::NAN)], &options);
    assert_eq!(unknown.keep, ["legacy", "v4", "v5"]);
    // Without any registry pressure the legacy release is never collected.
    let only_legacy = registry(vec![legacy()]).plan_retention(&[], &options);
    assert_eq!((only_legacy.keep, only_legacy.drop), (vec!["legacy".to_owned()], Vec::<String>::new()));
    // The defaults: the newest three, at most six.
    let many: Vec<ReleaseEntry> = (1..=8).map(|n| release(&format!("r{n}"), &format!("1.{n}.0"), f64::from(n))).collect();
    let plan = registry(many).plan_retention(&[], &RetentionOptions::at(NOW));
    assert_eq!(plan.keep, ["r6", "r7", "r8"]);
}

#[test]
fn an_invalid_registry_is_rejected() {
    let doc = |releases: Vec<Value>| json!({ "schemaVersion": 1, "releases": releases });
    let raw =
        |id: &str, desktop: &str, added_at: Value| json!({ "id": id, "desktopVersion": desktop, "shellVersion": "", "addedAt": added_at, "legacy": false });
    assert!(parse_error(&doc(vec![raw("../x", "1.0.0", json!(1))])).contains("id"));
    assert!(parse_error(&doc(vec![raw("a", "", json!(1))])).contains("desktop version"));
    assert!(parse_error(&doc(vec![raw("a", "1.0.0", json!(1)), raw("a", "1.0.1", json!(2))])).contains("id"));
    assert!(parse_error(&json!({ "releases": [] })).contains("incompatible"));
    assert!(parse_error(&json!({ "schemaVersion": 2, "releases": [] })).contains("incompatible"));
    assert!(parse_error(&json!({ "schemaVersion": 1, "releases": {} })).contains("incompatible"));
    assert!(parse_error(&json!(null)).contains("incompatible"));
    assert_eq!(parse_error(&doc(vec![raw("a", "1.0.0", json!("soon"))])), "renderer release timestamp is invalid");
    let shell = json!({ "id": "a", "desktopVersion": "1.0.0", "shellVersion": "xyz", "addedAt": 1, "legacy": false });
    assert_eq!(parse_error(&doc(vec![shell])), "renderer release shell version is invalid");
    let two_legacy = |id: &str| json!({ "id": id, "desktopVersion": "", "addedAt": 1, "legacy": true });
    assert_eq!(parse_error(&doc(vec![two_legacy("a"), two_legacy("b")])), "renderer release index has more than one legacy release");
    assert_eq!(parse_error(&doc(vec![json!(null)])), "renderer release id is invalid");
    // The legacy entry may name no desktop version; a missing shell version reads as none.
    let parsed = ReleaseIndex::parse(&doc(vec![two_legacy("legacy")])).expect("a legacy registry");
    assert_eq!(parsed.releases, [entry("legacy", "", 1.0, true, "")]);
    // An id of 128 characters is the longest; the desktop version of 64.
    assert!(ReleaseIndex::parse(&doc(vec![raw(&"a".repeat(128), &"1".repeat(64), json!(1))])).is_ok());
    assert!(ReleaseIndex::parse(&doc(vec![raw(&"a".repeat(129), "1.0.0", json!(1))])).is_err());
    assert!(ReleaseIndex::parse(&doc(vec![raw("a", &"1".repeat(65), json!(1))])).is_err());
}

#[test]
fn the_registry_round_trips_through_its_document_and_a_release_is_added_once() {
    let index = registry(vec![legacy(), release("r1", "1.0.0", 10.0)]);
    let document = index.to_json();
    assert_eq!(
        mixdog_relay::js::wire(&document),
        r#"{"schemaVersion":1,"releases":[{"id":"legacy","desktopVersion":"","shellVersion":"","addedAt":1,"legacy":true},{"id":"r1","desktopVersion":"1.0.0","shellVersion":"","addedAt":10,"legacy":false}]}"#
    );
    assert_eq!(ReleaseIndex::parse(&document).expect("parses"), index);
    let again = index.with_release(release("r1", "9.9.9", 99.0)).expect("an id already registered is kept as it is");
    assert_eq!(again, index);
    let more = index.with_release(release("r2", "1.1.0", 20.0)).expect("added");
    assert_eq!(more.releases.len(), 3);
    assert!(index.with_release(release("bad id", "1.1.0", 20.0)).is_err());
    assert!(index.with_release(entry("second", "", 5.0, true, "")).is_err());
}

#[test]
fn oldest_supported_version_is_the_lowest_retained_non_legacy_desktop_version() {
    let index = registry(vec![legacy(), release("b", "1.10.0", 2.0), release("a", "1.2.4", 1.0), release("c", "1.3.2", 3.0)]);
    assert_eq!(index.oldest_supported_version(), "1.2.4");
    assert_eq!(registry(vec![legacy()]).oldest_supported_version(), "");
}

// ---- trees on disk ----

fn put(path: &Path, body: &str) {
    if let Some(parent) = path.parent() {
        mixdog_fsio::create_dir_all(&Unlaned, parent).expect("create the folder");
    }
    mixdog_fsio::write(&Unlaned, path, body).expect("write the file");
}

fn drop_file(path: &Path) {
    mixdog_fsio::remove_file(&Unlaned, path).expect("remove the file");
}

fn shell_document(label: &str, shell: &str) -> String {
    format!(
        "<!doctype html><head><meta name=\"mixdog-shell-version\" content=\"{shell}\">\
         <meta name=\"mixdog-shell-assets\" content=\"assets/main-12345678.js\">\
         <script type=\"module\" src=\"./assets/main-12345678.js\"></script></head><body>{label}</body>"
    )
}

fn write_release(root: &Path, label: &str, shell: &str) {
    put(&root.join("index.html"), &shell_document(label, shell));
    put(&root.join("assets/main-12345678.js"), &format!("export const label = '{label}';"));
    put(&root.join("boot.js"), "void 0;");
    put(&root.join("manifest.webmanifest"), r#"{"start_url":"/","icons":[{"src":"./icon.svg"}]}"#);
    put(&root.join("icon.svg"), &format!("<svg xmlns=\"http://www.w3.org/2000/svg\"><title>{label}</title></svg>"));
    put(&root.join("sw.js"), &format!("// worker {label}"));
}

fn write_registry(releases_dir: &Path, releases: &[ReleaseEntry]) {
    put(&releases_dir.join("index.json"), &mixdog_relay::js::wire(&registry(releases.to_vec()).to_json()));
}

struct Fixture {
    _guard: tempfile::TempDir,
    releases_dir: PathBuf,
    renderer_dir: PathBuf,
}

fn release_fixture() -> Fixture {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path().to_path_buf();
    let releases_dir = root.join("renderer-releases");
    let (legacy_shell, new_shell) = ("b".repeat(64), "c".repeat(64));
    write_release(&releases_dir.join("legacy"), "legacy", &legacy_shell);
    write_release(&releases_dir.join("2.0.0-new"), "new", &new_shell);
    write_release(&root.join("renderer"), "new", &new_shell);
    write_registry(&releases_dir, &[entry("legacy", "", 1.0, true, &legacy_shell), entry("2.0.0-new", "2.0.0", 2.0, false, &new_shell)]);
    Fixture { releases_dir, renderer_dir: root.join("renderer"), _guard: guard }
}

fn manual_clock() -> (Arc<AtomicI64>, Clock) {
    let time = Arc::new(AtomicI64::new(0));
    let reader = Arc::clone(&time);
    (time, Arc::new(move || reader.load(Ordering::SeqCst)))
}

#[test]
fn without_a_registry_the_relay_serves_the_single_renderer_to_everyone() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    write_release(&root.join("renderer"), "only", &"a".repeat(64));
    let catalog = RendererCatalog::new(root.join("renderer"), root.join("renderer-releases"));
    assert_eq!(catalog.dir_for(&report("9.9.9", "")), Some(root.join("renderer")));
    assert!(catalog.legacy_for(&report("9.9.9", "")).is_none());
    // An incomplete retained tree must not fall back to a different release.
    write_registry(&root.join("renderer-releases"), &[release("gone", "1.0.0", 1.0)]);
    let stale = RendererCatalog::new(root.join("renderer"), root.join("renderer-releases"));
    assert!(stale.dir_for(&report("1.0.0", "")).is_none());
    // No releases directory at all is a single-renderer relay.
    let plain = RendererCatalog::new(root.join("renderer"), "");
    assert_eq!(plain.dir_for(&report("1.0.0", "")), Some(root.join("renderer")));
    assert!(plain.index().expect("registry not configured").is_none());
}

#[test]
fn the_catalog_serves_each_device_the_release_for_its_reported_desktop_version() {
    let fixture = release_fixture();
    let catalog = RendererCatalog::new(&fixture.renderer_dir, &fixture.releases_dir);
    assert_eq!(catalog.dir_for(&report("2.0.0", "")), Some(fixture.releases_dir.join("2.0.0-new")));
    assert!(catalog.dir_for(&report("3.0.0", "")).is_none());
    assert_eq!(catalog.dir_for(&report("", &"c".repeat(64))), Some(fixture.releases_dir.join("2.0.0-new")));
    assert_eq!(catalog.dir_for(&DeviceReport::default()), Some(fixture.releases_dir.join("legacy")));
    // Only the older unmatched device is told it can update its PC.
    assert!(catalog.dir_for(&report("1.0.0", "")).is_none());
    assert_eq!(catalog.legacy_for(&report("1.0.0", "")).map(|notice| notice.min_version), Some("2.0.0".to_owned()));
    assert!(catalog.legacy_for(&report("2.0.0", "")).is_none());
    assert!(catalog.legacy_for(&report("3.0.0", "")).is_none());
}

#[test]
fn the_catalog_reads_the_registry_at_most_once_per_second() {
    let fixture = release_fixture();
    let (time, clock) = manual_clock();
    time.store(10_000, Ordering::SeqCst);
    let catalog = RendererCatalog::with_clock(&fixture.renderer_dir, &fixture.releases_dir, 1000, clock);
    assert_eq!(catalog.dir_for(&report("2.0.0", "")), Some(fixture.releases_dir.join("2.0.0-new")));
    // The registry is rewritten (a deploy added a release): not seen within the second.
    write_registry(
        &fixture.releases_dir,
        &[entry("legacy", "", 1.0, true, &"b".repeat(64)), entry("2.0.0-new", "2.0.0", 2.0, false, &"c".repeat(64)), release("9.0.0-x", "9.0.0", 3.0)],
    );
    time.store(10_999, Ordering::SeqCst);
    assert_eq!(catalog.index().expect("valid").expect("a registry").releases.len(), 2);
    time.store(11_000, Ordering::SeqCst);
    assert_eq!(catalog.index().expect("valid").expect("a registry").releases.len(), 3);
    // A bad registry must not silently enable single-renderer mode.
    put(&fixture.releases_dir.join("index.json"), "{ not json");
    time.store(12_000, Ordering::SeqCst);
    assert!(catalog.index().is_err());
    assert!(catalog.dir_for(&report("2.0.0", "")).is_none());
}

// ---- readiness ----

const VERSION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn verify_document() -> String {
    format!(
        "<!doctype html><head><meta name=\"mixdog-shell-version\" content=\"{VERSION}\">\
         <meta name=\"mixdog-shell-assets\" content=\"assets/main-12345678.js\">\
         <script type=\"module\" src=\"./assets/main-12345678.js\"></script>\
         <link rel=\"stylesheet\" href=\"./assets/style-12345678.css\"></head><body></body>"
    )
}

fn renderer_fixture(root: &Path) {
    put(&root.join("index.html"), &verify_document());
    put(&root.join("assets/main-12345678.js"), "export const ready = true;");
    put(&root.join("assets/style-12345678.css"), "body { color: white; }");
    put(&root.join("boot.js"), "void 0;");
    put(&root.join("manifest.webmanifest"), r#"{"start_url":"./","icons":[{"src":"./icon.svg"}]}"#);
    put(&root.join("icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    put(&root.join("sw.js"), "importScripts(\"/sw-shell.js\");");
    put(&root.join("sw-shell.js"), "void 0;");
}

const NOT_READY: &str = r#"{"status":"not-ready"}"#;

#[test]
fn a_complete_renderer_is_ready_and_the_body_is_the_published_one() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    renderer_fixture(guard.path());
    let inspected = inspect_renderer(guard.path()).expect("ready");
    assert_eq!(inspected.assets, 8);
    assert_eq!(inspected.version, VERSION);
    let ready = RendererReadiness::new(guard.path(), "").check();
    assert_eq!(ready.status_code(), 200);
    assert_eq!(
        ready.body_json(),
        format!(
            "{{\"status\":\"ready\",\"indexSha256\":\"b40ae110b021fe737d808bc9f113415294b5f4dcc891f0da31ed904e758b6ad3\",\"version\":\"{VERSION}\",\"assets\":8}}"
        )
    );
}

#[test]
fn readiness_notices_missing_bootstrap_css_and_imported_worker_files() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    renderer_fixture(root);
    let (time, clock) = manual_clock();
    let readiness = RendererReadiness::with_clock(root, "", 10, clock);
    assert_eq!(readiness.check().status_code(), 200);
    for asset in ["assets/main-12345678.js", "assets/style-12345678.css", "sw-shell.js"] {
        drop_file(&root.join(asset));
        time.fetch_add(11, Ordering::SeqCst);
        let answer = readiness.check();
        assert_eq!((answer.status_code(), answer.body_json()), (503, NOT_READY.to_owned()), "{asset}");
        put(&root.join(asset), "restored");
        time.fetch_add(11, Ordering::SeqCst);
        assert_eq!(readiness.check().status_code(), 200, "{asset}");
    }
}

#[test]
fn an_answer_is_reused_for_two_seconds() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    renderer_fixture(root);
    let (time, clock) = manual_clock();
    time.store(5_000, Ordering::SeqCst);
    let readiness = RendererReadiness::with_clock(root, "", 2000, clock);
    assert_eq!(readiness.check().status_code(), 200);
    drop_file(&root.join("boot.js"));
    time.store(6_999, Ordering::SeqCst);
    assert_eq!(readiness.check().status_code(), 200);
    time.store(7_000, Ordering::SeqCst);
    assert_eq!(readiness.check(), Readiness::NotReady);
}

#[test]
fn renderer_traversal_and_invalid_release_metadata_never_pass_readiness() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    renderer_fixture(root);
    let message = |root: &Path| inspect_renderer(root).expect_err("not ready").to_string();
    put(&root.join("index.html"), &verify_document().replace("content=\"assets/main", "content=\"../main"));
    assert_eq!(message(root), "invalid renderer asset path");
    put(&root.join("index.html"), "<html>unversioned shell</html>");
    assert_eq!(message(root), "renderer release metadata missing");
    // Every way a reference can leave the tree or name something that is not a plain relative file.
    for bad in ["a\\\\b.js", "a?b.js", "a#b.js", "c:evil.js", "a//b.js", "a/./b.js"] {
        put(&root.join("index.html"), &verify_document().replace("assets/main-12345678.js\"><script", &format!("{bad}\"><script")));
        assert_eq!(message(root), "invalid renderer asset path", "{bad:?}");
    }
    // The SPA fallback is never an asset: a missing script is missing, and so is a reference without an extension.
    put(&root.join("index.html"), &verify_document().replace("./assets/main-12345678.js\"></script>", "./assets/gone-12345678.js\"></script>"));
    assert_eq!(message(root), "required renderer asset missing");
    put(&root.join("index.html"), &verify_document().replace("content=\"assets/main-12345678.js\"", "content=\"assets/main-12345678.js,somewhere\""));
    assert_eq!(message(root), "required renderer asset missing");
}

#[test]
fn the_manifest_and_the_worker_are_checked() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    renderer_fixture(root);
    let manifest = root.join("manifest.webmanifest");
    for (body, expected) in [
        (r#"{"icons":[]}"#, "renderer manifest invalid"),
        (r#"{"start_url":""}"#, "renderer manifest invalid"),
        (r#"[]"#, "renderer manifest invalid"),
        (r#"null"#, "renderer manifest invalid"),
        (r#"{"start_url":"/","icons":"x.png"}"#, "renderer manifest invalid"),
        (r#"{"start_url":"/","icons":[{"src":"./missing.svg"}]}"#, "required renderer asset missing"),
        (r#"{"start_url":"/","icons":[{}]}"#, "invalid renderer asset path"),
    ] {
        put(&manifest, body);
        assert_eq!(inspect_renderer(root).expect_err(body).to_string(), expected, "{body}");
    }
    put(&manifest, r#"{"start_url":"/"}"#);
    inspect_renderer(root).expect("a manifest without icons");
    put(&manifest, r#"{"start_url":"/","icons":""}"#);
    inspect_renderer(root).expect("an empty icon list");
    put(&root.join("sw.js"), "importScripts( '/sw-shell.js' ); importScripts(\"/nope.js\");");
    assert_eq!(inspect_renderer(root).expect_err("a missing import").to_string(), "required renderer asset missing");
    put(&root.join("sw.js"), "// no imports");
    inspect_renderer(root).expect("a worker without imports");
    // A document or a manifest above 128 KiB is refused.
    put(&root.join("sw.js"), &"x".repeat(128 * 1024 + 1));
    assert_eq!(inspect_renderer(root).expect_err("too big").to_string(), "renderer metadata exceeds limit");
    assert_eq!(inspect_renderer(Path::new("")).expect_err("no renderer").to_string(), "renderer not configured");
}

#[test]
fn a_document_that_lists_more_than_128_assets_is_refused() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path();
    renderer_fixture(root);
    let names: Vec<String> = (0..130).map(|n| format!("assets/f{n}.js")).collect();
    for name in &names {
        put(&root.join(name), "x");
    }
    let declared = names.join(",");
    put(&root.join("index.html"), &verify_document().replace("content=\"assets/main-12345678.js\"", &format!("content=\"{declared}\"")));
    assert_eq!(inspect_renderer(root).expect_err("too many").to_string(), "renderer asset list exceeds limit");
}

#[test]
fn readiness_fails_when_any_retained_release_is_broken() {
    let fixture = release_fixture();
    let (time, clock) = manual_clock();
    let readiness = RendererReadiness::with_clock(&fixture.renderer_dir, &fixture.releases_dir, 10, clock);
    let healthy = readiness.check();
    assert_eq!(healthy.status_code(), 200);
    let Readiness::Ready(body) = &healthy else { panic!("ready") };
    let releases = body.releases.as_ref().expect("the registry's releases");
    assert_eq!(releases.len(), 2);
    assert_eq!((releases[0].id.as_str(), releases[0].legacy, releases[0].desktop_version.as_str()), ("legacy", true, ""));
    assert_eq!((releases[1].id.as_str(), releases[1].legacy, releases[1].desktop_version.as_str()), ("2.0.0-new", false, "2.0.0"));
    let json: Value = serde_json::from_str(&healthy.body_json()).expect("json");
    assert_eq!(json["releases"][1]["version"], "c".repeat(64));
    assert_eq!(
        json["releases"][0].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()),
        Some(["id", "desktopVersion", "legacy", "indexSha256", "version", "assets"].map(str::to_owned).to_vec())
    );
    // The current renderer is fine; only the legacy release loses an asset.
    let lost = fixture.releases_dir.join("legacy/assets/main-12345678.js");
    drop_file(&lost);
    time.fetch_add(11, Ordering::SeqCst);
    assert_eq!(readiness.check(), Readiness::NotReady);
    put(&lost, "restored");
    time.fetch_add(11, Ordering::SeqCst);
    assert_eq!(readiness.check().status_code(), 200);
    // A registry entry whose tree is a different build is not ready either.
    write_registry(&fixture.releases_dir, &[entry("legacy", "", 1.0, true, &"d".repeat(64)), entry("2.0.0-new", "2.0.0", 2.0, false, &"c".repeat(64))]);
    time.fetch_add(11, Ordering::SeqCst);
    assert_eq!(readiness.check().status_code(), 503);
}

#[test]
fn a_release_without_a_tree_or_a_broken_registry_is_not_ready() {
    let fixture = release_fixture();
    let (time, clock) = manual_clock();
    let readiness = RendererReadiness::with_clock(&fixture.renderer_dir, &fixture.releases_dir, 10, clock);
    assert_eq!(readiness.check().status_code(), 200);
    // The registry names a release that has no index.html.
    drop_file(&fixture.releases_dir.join("2.0.0-new/index.html"));
    time.fetch_add(11, Ordering::SeqCst);
    assert_eq!(readiness.check(), Readiness::NotReady);
    put(&fixture.releases_dir.join("2.0.0-new/index.html"), &shell_document("new", &"c".repeat(64)));
    // An invalid registry is not ready: it is not the same as none.
    put(&fixture.releases_dir.join("index.json"), "{\"schemaVersion\":1,\"releases\":[{}]}");
    time.fetch_add(11, Ordering::SeqCst);
    assert_eq!(readiness.check(), Readiness::NotReady);
    // No registry at all is the single-renderer body, without a releases list.
    drop_file(&fixture.releases_dir.join("index.json"));
    time.fetch_add(11, Ordering::SeqCst);
    let single = readiness.check();
    assert_eq!(single.status_code(), 200);
    assert!(!single.body_json().contains("releases"));
}

// ---- the static resolver readiness uses ----

#[test]
fn the_static_resolver_keeps_requests_inside_the_root() {
    let guard = tempfile::tempdir().expect("a temporary folder");
    let root = guard.path().join("renderer");
    renderer_fixture(&root);
    put(&guard.path().join("secret.txt"), "outside");
    put(&root.join("assets/main-12345678.js.br"), "br");
    put(&root.join("assets/main-12345678.js.GZ"), "gz");
    let found = |pathname: &str| matches!(resolve_static_target(&root, pathname), StaticResolution::Found(_));
    assert!(found("/boot.js"));
    assert!(found("/index.html"));
    // An extension-less route is the web app; a missing file with an extension is missing.
    let StaticResolution::Found(app) = resolve_static_target(&root, "/some/route") else { panic!("the web app") };
    assert_eq!(app.file_name().and_then(|name| name.to_str()), Some("index.html"));
    assert!(matches!(resolve_static_target(&root, "/gone.js"), StaticResolution::Missing));
    // A precompressed sibling is never requested directly.
    assert!(matches!(resolve_static_target(&root, "/assets/main-12345678.js.br"), StaticResolution::Missing));
    assert!(matches!(resolve_static_target(&root, "/assets/main-12345678.js.GZ"), StaticResolution::Missing));
    // An escape is forbidden, a missing root is missing.
    assert!(matches!(resolve_static_target(&root, "/../secret.txt"), StaticResolution::Forbidden));
    assert!(matches!(resolve_static_target(&root, "/assets/../../secret.txt"), StaticResolution::Forbidden));
    assert!(matches!(resolve_static_target(&guard.path().join("nowhere"), "/index.html"), StaticResolution::Missing));
    // Inside the root a `..` that stays inside is resolved.
    assert!(found("/assets/../boot.js"));
}

// ---- hashed asset names ----

#[test]
fn the_hashed_asset_name_rule() {
    for yes in ["main-12345678.js", "/assets/index-AbCdEf123.js", "a-b_c-ZZZZZZZZZ.css", "x-12345678.min", "-12345678.js"] {
        assert!(is_hashed_asset_name(yes), "{yes}");
    }
    for no in ["main-1234567.js", "main.js", "boot.js", "main-12345678", "main-12345678.min.js", "main-1234 5678.js", "main_12345678.js", "main-12345678."] {
        assert!(!is_hashed_asset_name(no), "{no}");
    }
    // Only under an `assets` directory.
    assert!(is_hashed_asset(&Path::new("renderer").join("assets").join("main-12345678.js")));
    assert!(!is_hashed_asset(&Path::new("renderer").join("main-12345678.js")));
    assert!(!is_hashed_asset(&Path::new("renderer").join("assets").join("boot.js")));
    assert!(!is_hashed_asset(&Path::new("renderer").join("assetsx").join("main-12345678.js")));
}
