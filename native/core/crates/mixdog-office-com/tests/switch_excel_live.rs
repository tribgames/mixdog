//! Excel through the transport against real Microsoft Excel, with the Rust host and with Windows PowerShell. Every test is
//! `#[ignore]`: it starts Excel, so it runs only on request (`cargo test -p mixdog-office-com --test switch_excel_live --
//! --ignored`) on a Windows machine with Excel, with `mixdogd` built (`cargo build -p mixdog-cli`; it is looked for beside the
//! test binaries' `deps` directory, or where `MIXDOG_TEST_MIXDOGD` names it) and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that
//! variable a test that was asked for ends at once and says it did nothing.
//!
//! Every xlsx scenario of `tests/scenarios/{session,actions,excel-read,excel-edit}.json` runs twice, in a directory of its
//! own each, through the transport API (`open_session`, `call`, `close_session`): once with the PowerShell host (the
//! transport's test list of Rust-served formats empty) and once with the Rust host (the compiled list, `mixdogd
//! office-com-host`). The PowerShell run is made here, on the machine that runs the test, so
//! the comparison does not depend on a recording of another Excel build or UI language. The answers must be equal after
//! normalisation (the work directory, process ids, window handles, times, dates, the script location a failure names), the saved
//! workbooks equal after OOXML normalisation, no EXCEL process may be left that was not there before, and the Rust runs may not
//! take longer in total than the PowerShell ones. Two more tests start a visible Excel of their own through the dispatch layer
//! (`Excel.Application`, `Visible = true`, `Workbooks.Open`): an attach session on its workbook leaves the application and the
//! workbook open, and an Excel with a cell in edit mode is retried and then answered with the busy text, by both hosts alike.
#![cfg(windows)]

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::com::live::create_object;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const AREAS: [&str; 4] = ["session", "actions", "excel-read", "excel-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

/// The Rust host: the daemon binary, `mixdogd office-com-host`.
fn mixdogd() -> PathBuf {
    let program = std::env::var_os("MIXDOG_TEST_MIXDOGD").map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().expect("the test binary's path");
        exe.parent().and_then(Path::parent).expect("the target directory").join("mixdogd.exe")
    });
    assert!(program.exists(), "build mixdogd first (cargo build -p mixdog-cli) or name it in MIXDOG_TEST_MIXDOGD: {}", program.display());
    program
}

/// The transport on the Rust host: the daemon binary, `mixdogd office-com-host`.
fn transport(data: PathBuf) -> OfficeCom {
    let mut config = OfficeComConfig::new(data, mixdog_rt::testing::tokens());
    config.rust_host_program = mixdogd();
    OfficeCom::new(config)
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

// ---------------------------------------------------------------------------------------------------------------------
// What a scenario asks.

/// `${work}` of every string of the request, the work directory.
fn substitute(value: &Json, work: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${work}", work)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, work)).collect()),
        Json::Object(fields) => Json::Object(fields.iter().map(|(key, item)| (key.clone(), substitute(item, work))).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// An application of its own that holds documents open.

struct HelperApp {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl HelperApp {
    fn start(dir: &Path, names: &[&str]) -> Self {
        // The helper application that holds documents open is started by a script of its own (`tests/support/host-app.ps1`).
        let path = crate_dir().join("tests").join("support").join("host-app.ps1");
        let powershell =
            Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let mut child = Command::new(powershell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .args(["-Format", "xlsx", "-Dir"])
            .arg(dir)
            .args(["-Names", &names.join(",")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("Windows PowerShell");
        let stdin = child.stdin.take();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().expect("stdout")).read_line(&mut ready).expect("the helper's first line");
        assert!(ready.contains("\"ready\":true"), "the helper application did not start: {ready}");
        Self { child, stdin }
    }
}

impl Drop for HelperApp {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = writeln!(stdin);
        }
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// One run of a scenario through the transport.

struct Run {
    request_time: Duration,
    work: PathBuf,
}

/// The directory a scenario's `copy` names its input in (`zero-dpi.xlsx`, `pixel.png`).
fn inputs() -> PathBuf {
    crate_dir().join("tests").join("inputs")
}

fn is_excel_scenario(scenario: &Json) -> bool {
    let mut formats = BTreeSet::new();
    for step in scenario["steps"].as_array().into_iter().flatten() {
        let request = step.get("oneShot").or_else(|| step.get("send").and_then(|send| send.get("request")));
        if let Some(format) = request.and_then(|request| request.get("format")).and_then(Json::as_str) {
            formats.insert(format.to_owned());
        }
    }
    formats.len() == 1 && formats.contains("xlsx")
}

async fn run_scenario(office: &OfficeCom, scenario: &Json, work: PathBuf) -> Run {
    let work_text = work.to_string_lossy().into_owned();
    // Session ids opened through each of the scenario's session hosts, in the order they were opened.
    let mut hosts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut helpers: Vec<HelperApp> = Vec::new();
    let mut request_time = Duration::ZERO;
    for (index, step) in scenario["steps"].as_array().expect("the steps").iter().enumerate() {
        let recorded = step.get("prepare").and_then(Json::as_bool) != Some(true);
        let label = step.get("label").and_then(Json::as_str).map_or_else(|| format!("step {index}"), str::to_owned);
        let timeout = Duration::from_millis(step.get("timeoutMs").and_then(Json::as_u64).unwrap_or(120_000));
        let options = || CallOptions { timeout, cancel: CancellationToken::new() };
        let started = Instant::now();
        let answer = if let Some(file) = step.get("copy").and_then(Json::as_str) {
            let name = step.get("as").and_then(Json::as_str).unwrap_or(file);
            let bytes = mixdog_fsio::read(&mixdog_fsio::Unlaned, &inputs().join(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
            mixdog_fsio::write(&mixdog_fsio::Unlaned, &work.join(name), &bytes).expect("the input is copied");
            None
        } else if let Some(request) = step.get("oneShot") {
            Some(office.call(&substitute(request, &work_text), options()).await.value)
        } else if let (Some(name), Some(true)) = (step.get("session").and_then(Json::as_str), step.get("start").and_then(Json::as_bool)) {
            hosts.insert(name.to_owned(), Vec::new());
            None
        } else if let Some(send) = step.get("send") {
            let host = send["session"].as_str().expect("a session host").to_owned();
            let request = substitute(&send["request"], &work_text);
            let id = request["session"].as_str().unwrap_or_default().to_owned();
            let answer = match request["action"].as_str().unwrap_or_default() {
                "open_session" => {
                    let opened = office.open_session(&request, options()).await;
                    if opened["ok"] == json!(true) {
                        hosts.entry(host).or_default().push(id);
                    }
                    opened
                }
                "close_session" => {
                    let close = CloseOptions { save: request["save"] == json!(true), timeout, ..CloseOptions::default() };
                    let closed = office.close_session(&id, close).await;
                    hosts.entry(host).or_default().retain(|open| *open != id);
                    closed
                }
                _ => office.call(&request, options()).await.value,
            };
            Some(answer)
        } else if let Some(milliseconds) = step.get("wait").and_then(Json::as_u64) {
            std::thread::sleep(Duration::from_millis(milliseconds));
            None
        } else if let Some(app) = step.get("hostApp") {
            let names: Vec<&str> = step["files"].as_array().expect("files").iter().filter_map(Json::as_str).collect();
            assert!(app.is_string() && step["format"] == json!("xlsx"), "only an Excel helper application is run");
            helpers.push(HelperApp::start(&work, &names));
            None
        } else if let Some(kill) = step.get("kill") {
            let host = kill["session"].as_str().expect("a session host");
            let id = hosts.get(host).and_then(|ids| ids.last()).unwrap_or_else(|| panic!("no session of host {host}"));
            let pid = office.session_identity(id).and_then(|identity| identity.app_pid).expect("the session's application process");
            let status =
                Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().expect("taskkill");
            assert!(status.success(), "the application process {pid} was not ended");
            None
        } else if let Some(host) = step.get("eof").and_then(Json::as_str) {
            // The host ends with its sessions still open: each one is closed without saving, as the host's own end does.
            for id in hosts.remove(host).unwrap_or_default() {
                let _ = office.close_session(&id, CloseOptions { timeout, ..CloseOptions::default() }).await;
            }
            None
        } else {
            panic!("{}: a step this test does not know: {step}", scenario["id"]);
        };
        if let Some(answer) = answer {
            // What the scenario says the answer holds (the text of its compact JSON).
            if let Some(expected) = step.get("expect").and_then(|expect| expect.get("contains")).and_then(Json::as_str) {
                assert!(answer.to_string().contains(expected), "{}: {label}: the answer lacks {expected}: {answer}", scenario["id"]);
            }
            if recorded {
                request_time += started.elapsed();
            }
        }
    }
    drop(helpers);
    for id in hosts.into_values().flatten() {
        let _ = office.close_session(&id, CloseOptions::default()).await;
    }
    Run { request_time, work }
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
        let text = mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &crate_dir().join("tests").join("scenarios").join(format!("{area}.json")))
            .expect("the scenarios");
        let file: Json = serde_json::from_str(&text).expect("the scenarios are JSON");
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| is_excel_scenario(scenario)) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let run = runtime.block_on(run_scenario(&transport(data.clone()), scenario, scratch(&format!("{area}-{id}"))));
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
