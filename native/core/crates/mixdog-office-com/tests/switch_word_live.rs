//! Ignored: starts Word; run with `-- --ignored` on Windows with it and `MIXDOG_TEST_LIVE_OFFICE=1`, else a requested test ends at once.
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
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use switch_run::scenario_file;
use switch_run::transport;

const AREAS: [&str; 4] = ["session", "actions", "word-read", "word-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-switch-word-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &dir);
    mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &dir).expect("a scratch directory");
    dir
}

fn remove(dir: &Path) {
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, dir);
}

fn word_processes(platform: &WindowsPlatform) -> BTreeSet<i32> {
    platform.office_process_ids("docx").into_iter().collect()
}

/// Waits (at most 20 s) for Word to be gone from what it was before.
fn wait_for_word(platform: &WindowsPlatform, before: &BTreeSet<i32>) -> BTreeSet<i32> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while &word_processes(platform) != before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    word_processes(platform)
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn every_word_scenario_through_the_transport_meets_what_it_expects_and_leaves_no_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = word_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("data");
    let mut request_time = Duration::ZERO;
    let mut ran = 0;
    for area in AREAS {
        let file = scenario_file(area);
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| switch_run::is_scenario_of(scenario, "docx")) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let run = runtime.block_on(switch_run::run_scenario(&transport(data.clone()), scenario, scratch(&format!("{area}-{id}")), "docx"));
            assert_eq!(wait_for_word(&platform, &before), before, "{label}: closing the sessions left a WINWORD process that was not there before");
            request_time += run.request_time;
            ran += 1;
            remove(&run.work);
        }
    }
    remove(&data);
    assert!(ran > 0, "no docx scenario was found");
    eprintln!("{ran} Word scenarios through the Rust host: {request_time:?}");
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn cancelling_a_long_render_closes_the_document_and_the_host_exits_by_itself() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = word_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let work = scratch("cancel");
    let data = scratch("cancel-data");
    let document = work.join("long.docx").to_string_lossy().into_owned();
    let output = work.join("long.pdf").to_string_lossy().into_owned();
    runtime.block_on(async {
        let office = transport(data.clone());
        let opened = office.open_session(&json!({"session": "long", "format": "docx", "path": document, "mode": "background", "create": true}), CallOptions::default()).await;
        assert_eq!(opened["ok"], json!(true), "{opened}");
        // About two hundred pages: a render of them takes much longer than the cancel below.
        for batch in 0..12 {
            let operations: Vec<Json> = (0..500).map(|n| json!({"op": "append_text", "text": format!("Paragraph {} of a long document. {}", batch * 500 + n, "Words fill the line and wrap onto the next one. ".repeat(6))})).collect();
            let done = office.call(&json!({"action": "batch", "session": "long", "operations": operations}), CallOptions { timeout: Duration::from_secs(300), ..CallOptions::default() }).await;
            assert_eq!(done.value["ok"], json!(true), "batch {batch}");
        }
        let closed = office.close_session("long", CloseOptions { save: true, timeout: Duration::from_secs(300), ..CloseOptions::default() }).await;
        assert_eq!(closed["ok"], json!(true), "{closed}");

        let cancel = CancellationToken::new();
        let later = cancel.clone();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(400)).await;
            later.cancel();
        });
        let render = json!({"action": "render", "format": "docx", "path": document, "output": output});
        let reply = office.call(&render, CallOptions { timeout: Duration::from_secs(300), cancel }).await;
        assert_eq!(reply.value["ok"], json!(false), "the render finished before it was cancelled: make the document longer: {}", reply.value);
        assert_eq!(reply.value["cancelled"], json!(true), "{}", reply.value);
        assert_eq!(reply.value["operationMayHaveCompleted"], json!(true), "{}", reply.value);
        // The host ends by itself: its cleanup ran (`hostExited`, `ok`) and nothing killed it.
        assert_eq!(reply.value["cleanup"]["hostExited"], json!(true), "{}", reply.value);
        assert_eq!(reply.value["cleanup"]["ok"], json!(true), "{}", reply.value);
        if let Some(exit) = reply.host_exit {
            mixdog_rt::time::timeout(Duration::from_secs(60), exit.wait()).await.expect("the host exits");
        }
        office.shutdown().await;
    });
    assert_eq!(wait_for_word(&platform, &before), before, "the cancelled render left a WINWORD process that was not there before");
    remove(&work);
    remove(&data);
}
