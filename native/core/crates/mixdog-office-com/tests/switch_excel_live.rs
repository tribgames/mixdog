//! Ignored: starts Excel; run with `-- --ignored` on Windows with it and `MIXDOG_TEST_LIVE_OFFICE=1`, else a requested test ends at once.
#![cfg(windows)]

#[path = "support/switch_run.rs"]
mod switch_run;

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::com::live::create_object;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use switch_run::scenario_file;
use switch_run::transport;

const AREAS: [&str; 4] = ["session", "actions", "excel-read", "excel-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-switch-excel-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &dir);
    mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &dir).expect("a scratch directory");
    dir
}

fn remove(dir: &Path) {
    let _ = mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, dir);
}

fn excel_processes(platform: &WindowsPlatform) -> BTreeSet<i32> {
    platform.office_process_ids("xlsx").into_iter().collect()
}

/// Waits (at most 20 s) for Excel to be gone from what it was before.
fn wait_for_excel(platform: &WindowsPlatform, before: &BTreeSet<i32>) -> BTreeSet<i32> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while &excel_processes(platform) != before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    excel_processes(platform)
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn every_excel_scenario_through_the_transport_meets_what_it_expects_and_leaves_no_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = excel_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("data");
    let mut request_time = Duration::ZERO;
    let mut ran = 0;
    for area in AREAS {
        let file = scenario_file(area);
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| switch_run::is_scenario_of(scenario, "xlsx")) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let run = runtime.block_on(switch_run::run_scenario(&transport(data.clone()), scenario, scratch(&format!("{area}-{id}")), "xlsx"));
            assert_eq!(wait_for_excel(&platform, &before), before, "{label}: closing the sessions left a EXCEL process that was not there before");
            request_time += run.request_time;
            ran += 1;
            remove(&run.work);
        }
    }
    remove(&data);
    assert!(ran > 0, "no xlsx scenario was found");
    eprintln!("{ran} Excel scenarios through the Rust host: {request_time:?}");
}

// ---------------------------------------------------------------------------------------------------------------------
// A visible Excel of the test's own, started through the dispatch layer.

/// `Excel.Application` shown, with the saved workbook `name` in `dir` opened by `Workbooks.Open`.
struct UsersExcel {
    app: Obj,
    book: Obj,
    pid: i32,
}

impl UsersExcel {
    fn start(platform: &WindowsPlatform, dir: &Path, name: &str) -> Self {
        let path = dir.join(name).to_string_lossy().into_owned();
        let app = create_object("Excel.Application").expect("Excel");
        app.put("Visible", Com::Bool(true)).expect("shown");
        let books = app.get("Workbooks").expect("the workbooks");
        let fresh = books.call_member("Add", &[]).expect("a workbook").into_obj().expect("an object");
        fresh.call("SaveAs", &[Com::from(path.as_str()), Com::I4(51)]).expect("saved");
        fresh.call("Close", &[Com::Bool(false)]).expect("closed");
        let book = books.call_member("Open", &[Com::from(path.as_str())]).expect("the workbook opens").into_obj().expect("an object");
        let pid = platform.process_id_for_window(app.get("Hwnd").expect("a window").as_i64().unwrap_or(0));
        assert!(pid > 0, "the process of the user's Excel");
        Self { app, book, pid }
    }

    fn open_workbooks(&self) -> Option<i64> {
        self.app.get("Workbooks").and_then(|books| books.member("Count")).ok().and_then(|count| count.as_i64())
    }

    fn quit(self) {
        let _ = self.book.call("Close", &[Com::Bool(false)]);
        let _ = self.app.call("Quit", &[]);
    }
}

#[test]
#[ignore = "starts and shows Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn an_attach_session_leaves_the_users_excel_and_workbook_open() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = excel_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let work = scratch("attach");
    let data = scratch("attach-data");
    let users = UsersExcel::start(&platform, &work, "held.xlsx");
    for kind in ["rust"] {
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &data.join(kind)).expect("a data directory");
        let office = transport(data.join(kind));
        let (opened, closed) = runtime.block_on(async {
            let request = json!({"action": "open_session", "session": "at-xlsx", "format": "xlsx", "path": work.join("held.xlsx"), "mode": "attach"});
            let opened = office.open_session(&request, CallOptions::default()).await;
            let closed = office.close_session("at-xlsx", CloseOptions::default()).await;
            office.shutdown().await;
            (opened, closed)
        });
        assert_eq!(opened["ownership"], json!("attached"), "{kind}: {opened}");
        assert_eq!(closed["closed"], json!(true), "{kind}: {closed}");
        assert!(platform.process_exists(users.pid), "{kind}: the user's Excel is still running");
        assert_eq!(users.open_workbooks(), Some(1), "{kind}: the workbook is still open");
    }
    users.quit();
    assert_eq!(wait_for_excel(&platform, &before), before, "an EXCEL process was left that was not there before");
    remove(&work);
    remove(&data);
}

#[test]
#[ignore = "starts and shows Microsoft Excel and sends it a key; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_busy_excel_is_retried_and_then_answered_with_the_busy_text() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = excel_processes(&platform);
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let work = scratch("busy");
    let data = scratch("busy-data");
    let users = UsersExcel::start(&platform, &work, "held.xlsx");
    let request = json!({"action": "snapshot", "mode": "live", "format": "xlsx", "path": work.join("held.xlsx")});
    let options = || CallOptions { timeout: Duration::from_secs(120), cancel: CancellationToken::new() };
    // Excel is idle: the read answers.
    for kind in ["rust"] {
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &data.join(kind)).expect("a data directory");
        let office = transport(data.join(kind));
        let idle = runtime.block_on(office.call(&request, options()));
        assert_eq!(idle.value["ok"], json!(true), "{kind}: {}", idle.value);
        runtime.block_on(office.shutdown());
    }
    // A cell goes into edit mode (F2 on the active window), where Excel refuses COM calls.
    if let Some(window) = users.app.get("ActiveWindow").ok().and_then(|window| window.into_obj()) {
        let _ = window.call("Activate", &[]);
    }
    users.app.call("SendKeys", &[Com::from("{F2}"), Com::Bool(true)]).expect("the cell goes into edit mode");
    for kind in ["rust"] {
        let office = transport(data.join(kind));
        let started = Instant::now();
        let reply = runtime.block_on(office.call(&request, options()));
        let elapsed = started.elapsed();
        runtime.block_on(office.shutdown());
        let text = reply.value.to_string();
        assert_eq!(reply.value["ok"], json!(false), "{kind}: Excel was not busy (the cell did not reach edit mode): {text}");
        assert!(text.contains("remained busy after transient COM retries"), "{kind}: {text}");
        // 50 attempts 100 ms apart: the answer comes after the retries, not at once.
        assert!(elapsed >= Duration::from_secs(3), "{kind}: the busy answer came after {elapsed:?}, without the retries");
    }
    // The cell leaves edit mode, so the application can be closed. Excel may refuse this call too while the cell is in edit
    // mode: the test's own Excel is then ended by its process id.
    let pid = users.pid;
    let _ = users.app.call("SendKeys", &[Com::from("{ESC}"), Com::Bool(true)]);
    users.quit();
    if wait_for_excel(&platform, &before).contains(&pid) {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    assert_eq!(wait_for_excel(&platform, &before), before, "an EXCEL process was left that was not there before");
    remove(&work);
    remove(&data);
}
