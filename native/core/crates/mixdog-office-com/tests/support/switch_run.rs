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
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The scenarios of `tests/scenarios/<area>.json`.
pub fn scenario_file(area: &str) -> Json {
    let text =
        mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &crate_dir().join("tests").join("scenarios").join(format!("{area}.json"))).expect("the scenarios");
    serde_json::from_str(&text).expect("the scenarios are JSON")
}
fn mixdogd() -> PathBuf {
    let program = std::env::var_os("MIXDOG_TEST_MIXDOGD").map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().expect("the test binary's path");
        exe.parent().and_then(Path::parent).expect("the target directory").join("mixdogd.exe")
    });
    assert!(program.exists(), "build mixdogd first (cargo build -p mixdog-cli) or name it in MIXDOG_TEST_MIXDOGD: {}", program.display());
    program
}

pub fn transport(data: PathBuf) -> OfficeCom {
    let mut config = OfficeComConfig::new(data, mixdog_rt::testing::tokens());
    config.rust_host_program = mixdogd();
    OfficeCom::new(config)
}

pub fn substitute(value: &Json, work: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${work}", work)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, work)).collect()),
        Json::Object(fields) => Json::Object(fields.iter().map(|(key, item)| (key.clone(), substitute(item, work))).collect()),
        other => other.clone(),
    }
}

pub struct HelperApp {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl HelperApp {
    pub fn start(format: &str, dir: &Path, names: &[&str]) -> Self {
        let path = crate_dir().join("tests").join("support").join("host-app.ps1");
        let powershell =
            Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let mut child = Command::new(powershell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .args(["-Format", format, "-Dir"])
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

pub struct Run {
    pub request_time: Duration,
    pub work: PathBuf,
}

/// The directory a scenario's `copy` names its input in (`zero-dpi.xlsx`, `pixel.png`).
fn inputs() -> PathBuf {
    crate_dir().join("tests").join("inputs")
}

pub fn is_scenario_of(scenario: &Json, format: &str) -> bool {
    let mut formats = BTreeSet::new();
    for step in scenario["steps"].as_array().into_iter().flatten() {
        let request = step.get("oneShot").or_else(|| step.get("send").and_then(|send| send.get("request")));
        if let Some(format) = request.and_then(|request| request.get("format")).and_then(Json::as_str) {
            formats.insert(format.to_owned());
        }
    }
    formats.len() == 1 && formats.contains(format)
}

pub async fn run_scenario(office: &OfficeCom, scenario: &Json, work: PathBuf, format: &str) -> Run {
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
            assert!(app.is_string() && step["format"] == json!(format), "only a {format} helper application is run");
            helpers.push(HelperApp::start(format, &work, &names));
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
