//! PowerPoint through the transport against real Microsoft PowerPoint (and the Excel it starts for chart data), with the Rust
//! host and with Windows PowerShell. Every test is `#[ignore]`: it starts PowerPoint, so it runs only on request (`cargo test -p
//! mixdog-office-com --test switch_powerpoint_live -- --ignored`) on a Windows machine with PowerPoint and Excel, with `mixdogd`
//! built (`cargo build -p mixdog-cli`; it is looked for beside the test binaries' `deps` directory, or where
//! `MIXDOG_TEST_MIXDOGD` names it) and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once
//! and says it did nothing.
//!
//! Every pptx scenario of `tests/scenarios/{session,actions,ppt-read,ppt-edit}.json` runs twice, in a directory of its own
//! each, through the transport API (`open_session`, `call`, `close_session`): once with the PowerShell host (the transport's test
//! list of Rust-served formats empty) and once with the Rust host (the compiled list, `mixdogd office-com-host`). The recordings of
//! the PowerShell host (`tests/fixtures/<area>/<scenario>.json`) are written on a PC with PowerPoint by
//! `recorder/record-office-com.mjs`; the PowerShell run made here is the same host on the machine that runs the test, so the
//! comparison does not depend on a recording of another Office build or UI language. The answers must be equal after
//! normalisation (the work directory, process ids, window handles, times, dates, the script location a failure names), the saved
//! decks equal after OOXML normalisation, no POWERPNT process and no EXCEL process (the chart data sheet's) may be left that was
//! not there before, and the Rust runs may not take longer in total than the PowerShell ones. Three more tests follow the paths of
//! the extension host: the authoring flow (a background session, `reload_document` after the deck was authored elsewhere, two
//! renders that each write a fresh PDF, `post_save_validate`, close), the read-only one-shot render of the file preview with a
//! password given, and the cancellation of a chart creation, after which no window is visible and the host ends by itself.
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
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const AREAS: [&str; 4] = ["session", "actions", "ppt-read", "ppt-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
        let powershell = Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let mut child = Command::new(powershell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .args(["-Format", "pptx", "-Dir"])
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

/// The directory a scenario's `copy` is resolved against, as the recorder resolves it (`tests/fixtures/inputs`): the
/// scenarios name their inputs from there (`../actions/inputs/zero-dpi.xlsx`, `../ppt-read/inputs/pixel.png`).
fn inputs() -> PathBuf {
    crate_dir().join("tests").join("fixtures").join("inputs")
}

fn is_powerpoint_scenario(scenario: &Json) -> bool {
    let mut formats = BTreeSet::new();
    for step in scenario["steps"].as_array().into_iter().flatten() {
        let request = step.get("oneShot").or_else(|| step.get("send").and_then(|send| send.get("request")));
        if let Some(format) = request.and_then(|request| request.get("format")).and_then(Json::as_str) {
            formats.insert(format.to_owned());
        }
    }
    formats.len() == 1 && formats.contains("pptx")
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
            assert!(app.is_string() && step["format"] == json!("pptx"), "only a PowerPoint helper application is run");
            helpers.push(HelperApp::start(&work, &names));
            None
        } else if let Some(kill) = step.get("kill") {
            let host = kill["session"].as_str().expect("a session host");
            let id = hosts.get(host).and_then(|ids| ids.last()).unwrap_or_else(|| panic!("no session of host {host}"));
            let pid = office.session_identity(id).and_then(|identity| identity.app_pid).expect("the session's application process");
            let status = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().expect("taskkill");
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
        let text = mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &crate_dir().join("tests").join("scenarios").join(format!("{area}.json"))).expect("the scenarios");
        let file: Json = serde_json::from_str(&text).expect("the scenarios are JSON");
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| is_powerpoint_scenario(scenario)) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let run = runtime.block_on(run_scenario(&transport(data.clone()), scenario, scratch(&format!("{area}-{id}"))));
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
    let made = office.open_session(&json!({"action": "open_session", "session": "made", "format": "pptx", "path": path("src.pptx"), "mode": "background", "create": true}), options()).await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let slides = office.call(&json!({"action": "batch", "session": "made", "operations": [{"op": "add_slide"}, {"op": "add_slide"}]}), options()).await.value;
    assert_eq!(slides["ok"], json!(true), "{slides}");
    let saved = office.close_session("made", CloseOptions { save: true, timeout: Duration::from_secs(180), ..CloseOptions::default() }).await;
    assert_eq!(saved["ok"], json!(true), "{saved}");

    let opened = office.open_session(&json!({"action": "open_session", "session": "author", "format": "pptx", "path": path("deck.pptx"), "mode": "background", "create": true}), options()).await;
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
    for request in [
        json!({"action": "render", "session": "author", "output": path("r1.pdf")}),
        json!({"action": "post_save_validate", "session": "author"}),
    ] {
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
            let made = office.open_session(&json!({"action": "open_session", "session": "mk", "format": "pptx", "path": deck, "mode": "background", "create": true}), options()).await;
            assert_eq!(made["ok"], json!(true), "{made}");
            let closed = office.close_session("mk", CloseOptions { save: true, timeout: Duration::from_secs(180), ..CloseOptions::default() }).await;
            assert_eq!(closed["ok"], json!(true), "{closed}");
            let before_preview = mixdog_fsio::read(&mixdog_fsio::Unlaned, work.join("d.pptx")).expect("the saved deck");
            let request = json!({"action": "render", "format": "pptx", "path": deck, "output": output, "readOnly": true, "password": "a password nobody needs"});
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
