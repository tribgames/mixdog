//! Ignored: starts PowerPoint and Excel; run with `-- --ignored` on Windows with it and `MIXDOG_TEST_LIVE_OFFICE=1`, else a requested test ends at once.
#![cfg(windows)]

#[path = "support/switch_run.rs"]
mod switch_run;

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use switch_run::scenario_file;
use switch_run::transport;

const AREAS: [&str; 4] = ["session", "actions", "ppt-read", "ppt-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-switch-powerpoint-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &dir);
    mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &dir).expect("a scratch directory");
    dir
}

fn remove(dir: &Path) {
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, dir);
}

fn office_processes(platform: &WindowsPlatform) -> BTreeSet<i32> {
    platform.office_process_ids("pptx").into_iter().chain(platform.excel_process_ids()).collect()
}

/// Waits (at most 20 s) for PowerPoint and Excel to be gone from what they were before.
fn wait_for_office(platform: &WindowsPlatform, before: &BTreeSet<i32>) -> BTreeSet<i32> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while &office_processes(platform) != before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    office_processes(platform)
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn every_powerpoint_scenario_through_the_transport_meets_what_it_expects_and_leaves_no_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = office_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("data");
    let mut request_time = Duration::ZERO;
    let mut ran = 0;
    for area in AREAS {
        let file = scenario_file(area);
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| switch_run::is_scenario_of(scenario, "pptx")) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let run = runtime.block_on(switch_run::run_scenario(&transport(data.clone()), scenario, scratch(&format!("{area}-{id}")), "pptx"));
            assert_eq!(wait_for_office(&platform, &before), before, "{label}: closing the sessions left a POWERPNT or EXCEL process that was not there before");
            request_time += run.request_time;
            ran += 1;
            remove(&run.work);
        }
    }
    remove(&data);
    assert!(ran > 0, "no pptx scenario was found");
    eprintln!("{ran} PowerPoint scenarios through the Rust host: {request_time:?}");
}

// ---------------------------------------------------------------------------------------------------------------------
// The paths of the extension host.

async fn run_authoring_flow(office: &OfficeCom, work: &Path) -> Vec<Json> {
    let options = || CallOptions { timeout: Duration::from_secs(180), cancel: CancellationToken::new() };
    let path = |name: &str| work.join(name).to_string_lossy().into_owned();
    let mut answers = Vec::new();
    // The deck authored elsewhere (what the authoring flow of the extension host builds outside the session).
    let made = office
        .open_session(
            &json!({"action": "open_session", "session": "made", "format": "pptx", "path": path("src.pptx"), "mode": "background", "create": true}),
            options(),
        )
        .await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let slides = office.call(&json!({"action": "batch", "session": "made", "operations": [{"op": "add_slide"}, {"op": "add_slide"}]}), options()).await.value;
    assert_eq!(slides["ok"], json!(true), "{slides}");
    let saved = office.close_session("made", CloseOptions { save: true, timeout: Duration::from_secs(180), ..CloseOptions::default() }).await;
    assert_eq!(saved["ok"], json!(true), "{saved}");

    let opened = office
        .open_session(
            &json!({"action": "open_session", "session": "author", "format": "pptx", "path": path("deck.pptx"), "mode": "background", "create": true}),
            options(),
        )
        .await;
    assert_eq!(opened["ok"], json!(true), "{opened}");
    answers.push(opened);
    for request in [
        json!({"action": "reload_document", "session": "author", "source": path("src.pptx")}),
        json!({"action": "render", "session": "author", "output": path("r1.pdf")}),
    ] {
        let answer = office.call(&request, options()).await.value;
        assert_eq!(answer["ok"], json!(true), "{answer}");
        answers.push(answer);
    }
    let pdf = work.join("r1.pdf");
    let first_time = mixdog_fsio::metadata(&mixdog_fsio::Unlaned, &pdf).expect("the first render wrote a PDF").modified().expect("a modification time");
    let first_bytes = mixdog_fsio::read(&mixdog_fsio::Unlaned, &pdf).expect("the first PDF");
    assert!(first_bytes.starts_with(b"%PDF"), "the first render is a PDF");
    // The deck changes, then the second render goes to the same path: it is a fresh file, not the first one left in place.
    let edited = office.call(&json!({"action": "batch", "session": "author", "operations": [{"op": "add_slide"}]}), options()).await.value;
    assert_eq!(edited["ok"], json!(true), "{edited}");
    std::thread::sleep(Duration::from_millis(1100));
    for request in [json!({"action": "render", "session": "author", "output": path("r1.pdf")}), json!({"action": "post_save_validate", "session": "author"})] {
        let answer = office.call(&request, options()).await.value;
        assert_eq!(answer["ok"], json!(true), "{answer}");
        answers.push(answer);
    }
    let second_time = mixdog_fsio::metadata(&mixdog_fsio::Unlaned, &pdf).expect("the second render wrote a PDF").modified().expect("a modification time");
    let second_bytes = mixdog_fsio::read(&mixdog_fsio::Unlaned, &pdf).expect("the second PDF");
    assert!(second_time > first_time, "the second render did not write a fresh PDF");
    assert!(second_bytes.starts_with(b"%PDF") && second_bytes != first_bytes, "the second render is the first PDF left in place");
    let closed = office.close_session("author", CloseOptions { save: true, timeout: Duration::from_secs(180), ..CloseOptions::default() }).await;
    assert_eq!(closed["ok"], json!(true), "{closed}");
    answers.push(closed);
    answers
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_authoring_flow_of_the_extension_host_runs_on_the_rust_host() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = office_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("author-data");
    let mut works = Vec::new();
    for kind in ["rust"] {
        let work = scratch(&format!("author-{kind}"));
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &data.join(kind)).expect("a data directory");
        let office = transport(data.join(kind));
        runtime.block_on(async {
            let answers = run_authoring_flow(&office, &work).await;
            office.shutdown().await;
            answers
        });
        assert_eq!(wait_for_office(&platform, &before), before, "{kind}: the authoring flow left a POWERPNT or EXCEL process that was not there before");
        works.push(work);
    }
    for work in &works {
        remove(work);
    }
    remove(&data);
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_read_only_preview_of_a_deck_with_a_password_given_renders_and_writes_nothing_back() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = office_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("preview-data");
    let mut works = Vec::new();
    for kind in ["rust"] {
        let work = scratch(&format!("preview-{kind}"));
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &data.join(kind)).expect("a data directory");
        let office = transport(data.join(kind));
        let deck = work.join("d.pptx").to_string_lossy().into_owned();
        let output = work.join("p.pdf").to_string_lossy().into_owned();
        let preview = runtime.block_on(async {
            let options = || CallOptions { timeout: Duration::from_secs(180), cancel: CancellationToken::new() };
            let made = office
                .open_session(
                    &json!({"action": "open_session", "session": "mk", "format": "pptx", "path": deck, "mode": "background", "create": true}),
                    options(),
                )
                .await;
            assert_eq!(made["ok"], json!(true), "{made}");
            let closed = office.close_session("mk", CloseOptions { save: true, timeout: Duration::from_secs(180), ..CloseOptions::default() }).await;
            assert_eq!(closed["ok"], json!(true), "{closed}");
            let before_preview = mixdog_fsio::read(&mixdog_fsio::Unlaned, work.join("d.pptx")).expect("the saved deck");
            let request =
                json!({"action": "render", "format": "pptx", "path": deck, "output": output, "readOnly": true, "password": "a password nobody needs"});
            let preview = office.call(&request, options()).await.value;
            office.shutdown().await;
            assert_eq!(mixdog_fsio::read(&mixdog_fsio::Unlaned, work.join("d.pptx")).expect("the deck"), before_preview, "the preview wrote to the deck");
            preview
        });
        assert_eq!(preview["ok"], json!(true), "{kind}: {preview}");
        let pdf = mixdog_fsio::read(&mixdog_fsio::Unlaned, work.join("p.pdf")).expect("the preview wrote its PDF");
        assert!(pdf.starts_with(b"%PDF"), "{kind}: the preview is a PDF");
        assert_eq!(wait_for_office(&platform, &before), before, "{kind}: the preview left a POWERPNT or EXCEL process that was not there before");
        works.push(work);
    }
    for work in &works {
        remove(work);
    }
    remove(&data);
}

/// Samples, every 50 ms until `stop` is set, the visible windows of the POWERPNT and EXCEL processes that are not in
/// `before`; what it saw.
fn watch_windows(before: BTreeSet<i32>, stop: std::sync::Arc<std::sync::atomic::AtomicBool>) -> std::thread::JoinHandle<Vec<String>> {
    std::thread::spawn(move || {
        let _apartment = Sta::enter().expect("an apartment");
        let platform = WindowsPlatform::new().expect("the Windows layer");
        let mut seen = Vec::new();
        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            for pid in office_processes(&platform).difference(&before) {
                seen.extend(platform.visible_window_descriptions_for_process(*pid));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        seen
    })
}

#[test]
#[ignore = "starts Microsoft PowerPoint and Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn cancelling_a_chart_creation_leaves_no_visible_window_and_the_host_cleans_up_by_itself() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = office_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let work = scratch("cancel");
    let data = scratch("cancel-data");
    let deck = work.join("charts.pptx").to_string_lossy().into_owned();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = watch_windows(before.clone(), stop.clone());
    runtime.block_on(async {
        let office = transport(data.clone());
        let opened = office.open_session(&json!({"action": "open_session", "session": "ch", "format": "pptx", "path": deck, "mode": "background", "create": true}), CallOptions::default()).await;
        assert_eq!(opened["ok"], json!(true), "{opened}");
        let slide = office.call(&json!({"action": "batch", "session": "ch", "operations": [{"op": "add_slide"}]}), CallOptions::default()).await;
        assert_eq!(slide.value["ok"], json!(true), "{}", slide.value);
        // Many charts in one batch: each one fills a data sheet in Excel, so the batch outlasts the cancel below.
        let charts: Vec<Json> = (0..12)
            .map(|n| json!({"op": "add_chart", "slide": 1, "left": 20, "top": 20, "width": 300, "height": 200, "chartType": "column", "title": format!("Chart {n}"), "categories": ["a", "b", "c"], "series": [{"name": "S", "values": [1, 2, 3 + n]}]}))
            .collect();
        let cancel = CancellationToken::new();
        let later = cancel.clone();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(1500)).await;
            later.cancel();
        });
        let reply = office.call(&json!({"action": "batch", "session": "ch", "operations": charts}), CallOptions { timeout: Duration::from_secs(300), cancel }).await;
        assert_eq!(reply.value["ok"], json!(false), "the batch finished before it was cancelled: add more charts: {}", reply.value);
        assert_eq!(reply.value["cancelled"], json!(true), "{}", reply.value);
        // The host ends by itself: its cleanup ran (`hostExited`, `ok`) and nothing killed it.
        assert_eq!(reply.value["cleanup"]["hostExited"], json!(true), "{}", reply.value);
        assert_eq!(reply.value["cleanup"]["ok"], json!(true), "{}", reply.value);
        if let Some(exit) = reply.host_exit {
            mixdog_rt::time::timeout(Duration::from_secs(60), exit.wait()).await.expect("the host exits");
        }
        office.shutdown().await;
    });
    let left = wait_for_office(&platform, &before);
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let visible = watcher.join().expect("the window watcher");
    assert!(visible.is_empty(), "a window of the background session was visible: {visible:?}");
    assert_eq!(left, before, "the cancelled chart creation left a POWERPNT or EXCEL process that was not there before");
    remove(&work);
    remove(&data);
}
