//! The PowerPoint editor against real Microsoft PowerPoint and Excel. The test is `#[ignore]`d: it starts both, so it runs only on
//! request (`cargo test -p mixdog-office-com --test ppt_edit_live -- --ignored`) on a Windows machine with Microsoft PowerPoint and
//! Excel and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! Every scenario of `recorder/scenarios/ppt-edit.json` runs twice, in a directory of its own each: through the unchanged
//! PowerShell session host (`assets/office-com-session-host.ps1`), and through the Rust session lifecycle and actions in this
//! process. The answers must be equal after normalisation (the work directory, the location a failure names), the saved decks
//! must be equal after OOXML normalisation (the part names, the ids and revision stamps taken out of the XML), no window of the
//! owned PowerPoint or of a chart's Excel may be visible at any moment of a background batch (a thread polls for it), no POWERPNT
//! or EXCEL process may be left that was not there before, and the Rust run may not take longer than the PowerShell host.
#![cfg(windows)]

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_fsio::Unlaned;
use mixdog_office_com::actions::Actions;
use mixdog_office_com::actions::session_actions::invoke_session_action;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::SessionState;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_response;
use mixdog_office_com::state::open_session_state;
use regex::Regex;
use serde_json::Value as Json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-ppt-edit-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

/// `${work}` of every string of the request, the work directory.
fn substitute(value: &Json, work: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${work}", work)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, work)).collect()),
        Json::Object(fields) => Json::Object(fields.iter().map(|(key, item)| (key.clone(), substitute(item, work))).collect()),
        other => other.clone(),
    }
}

/// What an answer is held to between the two runs: whether it succeeded, the records of a batch and the failure with the script
/// location taken out (the PowerShell host names `office-com-host.ps1:<line>`, this port its own source).
fn essentials(answer: &Json, work: &str) -> Json {
    let location = Regex::new(r"failed at [^ ]+: ").expect("the location pattern");
    let mut kept = serde_json::Map::new();
    for key in ["ok", "results", "undoUnits", "closed", "saved"] {
        if let Some(value) = answer.get(key) {
            kept.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(error) = answer.get("error").and_then(Json::as_str) {
        kept.insert("error".to_owned(), Json::String(location.replace_all(&error.replace(work, "<work>"), "failed at <location>: ").into_owned()));
    }
    Json::Object(kept)
}

// ---------------------------------------------------------------------------------------------------------------------
// The PowerShell host.

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
}

fn start_host() -> Host {
    let script = crate_dir().join("assets").join("office-com-session-host.ps1");
    let powershell = Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let mut child = Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("Windows PowerShell");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout");
    let (sender, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Host { child, stdin, lines }
}

/// One request to the PowerShell host and its answer (the line that carries the request's id), within two minutes.
fn host_answer(host: &mut Host, request: &Json, id: u64) -> Json {
    let mut tagged = request.clone();
    tagged["requestId"] = Json::String(format!("live_{id}"));
    let stdin = host.stdin.as_mut().expect("the host's input is open");
    writeln!(stdin, "{tagged}").expect("the request is written");
    stdin.flush().expect("the request is sent");
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = host.lines.recv_timeout(left).unwrap_or_else(|_| panic!("the PowerShell host did not answer {request}"));
        if let Ok(answer) = serde_json::from_str::<Json>(&line) {
            if answer.get("requestId").and_then(Json::as_str) == tagged["requestId"].as_str() {
                return answer;
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// One run of a scenario: the answers of its steps, the time of its requests and its files.

struct Run {
    answers: Vec<(String, Json)>,
    request_time: Duration,
    work: PathBuf,
}

fn steps_of(scenario: &Json) -> Vec<&Json> {
    scenario["steps"].as_array().expect("the steps").iter().collect()
}

fn copy_input(step: &Json, work: &Path) {
    let from = crate_dir().join("tests").join("fixtures").join("inputs").join(step["copy"].as_str().expect("a file"));
    let name = step.get("as").and_then(Json::as_str).unwrap_or_else(|| step["copy"].as_str().expect("a file"));
    let bytes = mixdog_fsio::read(&Unlaned, &from).unwrap_or_else(|error| panic!("{}: {error}", from.display()));
    mixdog_fsio::write(&Unlaned, &work.join(name), &bytes).expect("the input is copied");
}

fn run_with_powershell(scenario: &Json, work: PathBuf) -> Run {
    let work_text = work.to_string_lossy().into_owned();
    let mut hosts: BTreeMap<String, Host> = BTreeMap::new();
    let mut answers = Vec::new();
    let mut request_time = Duration::ZERO;
    let mut counter = 0;
    for step in steps_of(scenario) {
        if step.get("copy").is_some() {
            copy_input(step, &work);
        } else if let (Some(name), Some(true)) = (step.get("session").and_then(Json::as_str), step.get("start").and_then(Json::as_bool)) {
            hosts.insert(name.to_owned(), start_host());
        } else if let Some(send) = step.get("send") {
            let name = send["session"].as_str().expect("a session");
            let host = hosts.get_mut(name).unwrap_or_else(|| panic!("no PowerShell host {name}"));
            counter += 1;
            let started = Instant::now();
            let answer = host_answer(host, &substitute(&send["request"], &work_text), counter);
            request_time += started.elapsed();
            let label = step.get("label").and_then(Json::as_str).unwrap_or("step").to_owned();
            answers.push((label, essentials(&answer, &work_text)));
        } else if let Some(name) = step.get("eof").and_then(Json::as_str) {
            if let Some(mut host) = hosts.remove(name) {
                drop(host.stdin.take());
                let _ = host.child.wait();
            }
        }
    }
    for (_, mut host) in hosts {
        let _ = host.child.kill();
    }
    Run { answers, request_time, work }
}

fn run_in_process(env: &Env<'_>, scenario: &Json, work: PathBuf, watching: &AtomicBool) -> Run {
    let work_text = work.to_string_lossy().into_owned();
    let mut states: BTreeMap<String, SessionState> = BTreeMap::new();
    let mut answers = Vec::new();
    let mut request_time = Duration::ZERO;
    for step in steps_of(scenario) {
        if step.get("copy").is_some() {
            copy_input(step, &work);
            continue;
        }
        let Some(send) = step.get("send") else { continue };
        let request = substitute(&send["request"], &work_text);
        let parsed = payload::parse_payload(&request.to_string()).expect("a request");
        let action = request["action"].as_str().unwrap_or_default().to_owned();
        let id = request["session"].as_str().unwrap_or_default().to_owned();
        let background_batch = action == "batch" && states.get(&id).is_some_and(|state| state.mode.as_str() == "background");
        watching.store(background_batch, Ordering::SeqCst);
        let started = Instant::now();
        let answer = match action.as_str() {
            "open_session" => {
                let mut out = Emitter::stdio();
                match open_session_state(&Unlaned, env, &mut out, &parsed) {
                    Ok(mut state) => {
                        let opened = open_session_response(&mut state, env).map(|value| emit_json(&value));
                        states.insert(id.clone(), state);
                        opened.map_or_else(|message| serde_json::json!({"ok": false, "error": message}), |text| serde_json::from_str(&text).expect("the answer is JSON"))
                    }
                    Err(message) => serde_json::json!({"ok": false, "error": message}),
                }
            }
            "close_session" => {
                let state = states.get_mut(&id).unwrap_or_else(|| panic!("no session {id}"));
                let closed = close_session(state, env, &parsed).expect("the close answers");
                let answer: Json = serde_json::from_str(&emit_json(&closed.result)).expect("the answer is JSON");
                if closed.closed {
                    states.remove(&id);
                }
                answer
            }
            _ => {
                let state = states.get_mut(&id).unwrap_or_else(|| panic!("no session {id}"));
                let actions = Actions { env: *env, proof: &Unlaned, drivers: Drivers::registered() };
                let mut out = Emitter::stdio();
                match invoke_session_action(&actions, &mut out, state, &parsed) {
                    Ok(value) => serde_json::from_str(&emit_json(&value)).expect("the answer is JSON"),
                    Err(message) => serde_json::json!({"ok": false, "error": message}),
                }
            }
        };
        request_time += started.elapsed();
        watching.store(false, Ordering::SeqCst);
        let label = step.get("label").and_then(Json::as_str).unwrap_or("step").to_owned();
        answers.push((label, essentials(&answer, &work_text)));
    }
    Run { answers, request_time, work }
}

// ---------------------------------------------------------------------------------------------------------------------
// The files: a deck after OOXML normalisation.

/// The parts of a deck, each with its XML stripped of what differs from one save to the next (ids, revision stamps, times) and
/// the embedded binaries and document properties reduced to their names.
fn normalised_parts(path: &Path) -> BTreeMap<String, String> {
    let bytes = mixdog_fsio::read(&Unlaned, path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("a deck is a zip");
    let volatile = Regex::new(r#"\s(?:r:id|r:embed|r:link|id|rsid\w*|dt|created|modified|lastModifiedBy|uid|descr)="[^"]*""#).expect("the volatile attributes");
    let mut parts = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).expect("a part");
        let name = file.name().to_owned();
        let mut content = Vec::new();
        file.read_to_end(&mut content).expect("a part reads");
        let keep = name.ends_with(".xml") && !name.starts_with("docProps/") && !name.starts_with("customXml/");
        let text = if keep { volatile.replace_all(&String::from_utf8_lossy(&content), "").into_owned() } else { String::new() };
        parts.insert(name, text);
    }
    parts
}

// ---------------------------------------------------------------------------------------------------------------------
// The windows of the owned applications, polled.

fn office_processes(platform: &WindowsPlatform) -> BTreeSet<i32> {
    ["pptx", "xlsx"].iter().flat_map(|format| platform.office_process_ids(format)).collect()
}

#[test]
#[ignore = "starts Microsoft PowerPoint and Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_editor_does_what_the_powershell_host_does_and_is_not_slower() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let text = mixdog_fsio::read_to_string(&Unlaned, &crate_dir().join("recorder").join("scenarios").join("ppt-edit.json")).expect("the scenarios");
    let file: Json = serde_json::from_str(&text).expect("the scenarios are JSON");
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let before = office_processes(&platform);

    // The poll: while a background batch runs, no window of a process that was not there before may be visible.
    let watching = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let violations: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let poller = {
        let (watching, stop, violations, before) = (Arc::clone(&watching), Arc::clone(&stop), Arc::clone(&violations), before.clone());
        std::thread::spawn(move || {
            let platform = WindowsPlatform::new().expect("the Windows layer of the poll");
            while !stop.load(Ordering::SeqCst) {
                if watching.load(Ordering::SeqCst) {
                    for process in office_processes(&platform).difference(&before) {
                        if platform.visible_window_count_for_process(*process) > 0 {
                            violations.lock().expect("the list").extend(platform.visible_window_descriptions_for_process(*process));
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };

    let mut shell_time = Duration::ZERO;
    let mut rust_time = Duration::ZERO;
    for scenario in file["scenarios"].as_array().expect("scenarios") {
        let id = scenario["id"].as_str().expect("an id");
        let shell = run_with_powershell(scenario, scratch(&format!("{id}-powershell")));
        let rust = run_in_process(&env, scenario, scratch(&format!("{id}-rust")), &watching);
        assert_eq!(rust.answers, shell.answers, "{id}: the answers differ");
        for name in scenario["collect"].as_array().into_iter().flatten().filter_map(Json::as_str) {
            assert_eq!(normalised_parts(&rust.work.join(name)), normalised_parts(&shell.work.join(name)), "{id}/{name}: the saved decks differ");
        }
        shell_time += shell.request_time;
        rust_time += rust.request_time;
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &shell.work);
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &rust.work);
    }
    stop.store(true, Ordering::SeqCst);
    poller.join().expect("the poll ends");
    assert!(violations.lock().expect("the list").is_empty(), "a window of the owned applications was visible during a background batch: {:?}", violations.lock().expect("the list"));

    // No process is left that was not there before (the applications quit on their own: the wait is bounded).
    let deadline = Instant::now() + Duration::from_secs(20);
    while office_processes(&platform) != before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(office_processes(&platform), before, "POWERPNT or EXCEL was left running");
    assert!(rust_time <= shell_time, "the editor's requests took {rust_time:?}, the PowerShell host's {shell_time:?}");
}
