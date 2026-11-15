//! Word through the transport against real Microsoft Word, with the Rust host and with Windows PowerShell. Every test is
//! `#[ignore]`: it starts Word, so it runs only on request (`cargo test -p mixdog-office-com --test switch_word_live --
//! --ignored`) on a Windows machine with Word, with `mixdogd` built (`cargo build -p mixdog-cli`; it is looked for beside the
//! test binaries' `deps` directory, or where `MIXDOG_TEST_MIXDOGD` names it) and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that
//! variable a test that was asked for ends at once and says it did nothing.
//!
//! Every docx scenario of `recorder/scenarios/{session,actions,word-read,word-edit}.json` runs twice, in a directory of its
//! own each, through the transport API (`open_session`, `call`, `close_session`, `detect`): once with the PowerShell host
//! (the transport's test list of Rust-served formats empty) and once with the Rust host (the compiled list, `mixdogd
//! office-com-host`). The recordings of the PowerShell host (`tests/fixtures/<area>/<scenario>.json`) are written on a PC
//! with Word by `recorder/record-office-com.mjs`; the PowerShell run made here is the same host on the machine that runs the
//! test, so the comparison does not depend on a recording of another Word build. The answers must be equal after
//! normalisation (the work directory, process ids, window handles, times, dates, the script location a failure names), the
//! saved documents equal after OOXML normalisation, no WINWORD process may be left that was not there before, and the Rust
//! runs may not take longer in total than the PowerShell ones. A second test cancels a long Word render and checks that the
//! host closes the document and exits by itself.
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
use std::time::Duration;
use std::time::Instant;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use regex::Regex;
use serde_json::Value as Json;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const AREAS: [&str; 4] = ["session", "actions", "word-read", "word-edit"];

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

/// The Rust host: the daemon binary, `mixdogd office-com-host`.
fn mixdogd() -> PathBuf {
    let program = std::env::var_os("MIXDOG_TEST_MIXDOGD").map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().expect("the test binary's path");
        exe.parent().and_then(Path::parent).expect("the target directory").join("mixdogd.exe")
    });
    assert!(program.exists(), "build mixdogd first (cargo build -p mixdog-cli) or name it in MIXDOG_TEST_MIXDOGD: {}", program.display());
    program
}

/// The transport on the PowerShell host (`rust == false`) or on the Rust host.
fn transport(data: PathBuf, rust: bool) -> OfficeCom {
    let mut config = OfficeComConfig::new(data, mixdog_rt::testing::tokens());
    if rust {
        config.rust_host_program = mixdogd();
    } else {
        config = config.with_rust_host_formats(&[]);
    }
    OfficeCom::new(config)
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

// ---------------------------------------------------------------------------------------------------------------------
// What is compared.

/// `${work}` of every string of the request, the work directory.
fn substitute(value: &Json, work: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${work}", work)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, work)).collect()),
        Json::Object(fields) => Json::Object(fields.iter().map(|(key, item)| (key.clone(), substitute(item, work))).collect()),
        other => other.clone(),
    }
}

struct Rules {
    location: Regex,
    date: Regex,
    guid: Regex,
    handle: Regex,
    volatile_key: Regex,
}

impl Rules {
    fn new() -> Self {
        Self {
            location: Regex::new(r"failed at [^ ]+: ").expect("the location pattern"),
            date: Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?").expect("the date pattern"),
            guid: Regex::new(r"(?i)\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?|\b[0-9a-f]{32}\b").expect("the guid pattern"),
            handle: Regex::new(r"\b(rcw|hwnd):\d+").expect("the handle pattern"),
            volatile_key: Regex::new(r"(?i)(^|[a-z])(pid|processid)$|hwnd|handle|^foreground|(^|[a-z])(ms|elapsed|duration|ticks)$|^elapsed|^duration").expect("the key pattern"),
        }
    }

    fn text(&self, input: &str, work: &str) -> String {
        let forward = work.replace('\\', "/");
        let mut out = input.replace(work, "<work>").replace(&forward, "<work>");
        out = self.location.replace_all(&out, "failed at <location>: ").into_owned();
        out = self.handle.replace_all(&out, "$1:<n>").into_owned();
        out = self.date.replace_all(&out, "<date>").into_owned();
        self.guid.replace_all(&out, "<guid>").into_owned()
    }

    /// An answer with what differs from one run to the next replaced: ids, handles and times by `<n>`, the work directory,
    /// dates, GUIDs and the script location a failure names by markers.
    fn normalise(&self, value: &Json, work: &str, key: Option<&str>) -> Json {
        match value {
            Json::Array(items) => Json::Array(items.iter().map(|item| self.normalise(item, work, key)).collect()),
            Json::Object(fields) => Json::Object(fields.iter().map(|(name, item)| (self.text(name, work), self.normalise(item, work, Some(name)))).collect()),
            Json::String(text) => Json::String(self.text(text, work)),
            Json::Number(_) if key.is_some_and(|key| self.volatile_key.is_match(key)) => json!("<n>"),
            other => other.clone(),
        }
    }
}

/// The parts of a saved document: the XML with the attributes and elements that differ from one save to the next taken out,
/// the other parts reduced to their size.
fn normalised_parts(path: &Path, rules: &Rules) -> BTreeMap<String, String> {
    let bytes = mixdog_fsio::read(&mixdog_fsio::Unlaned, path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("a document is a zip");
    let volatile = Regex::new(r#"\s(?:w:rsid\w*|w14:paraId|w14:textId)="[^"]*""#).expect("the volatile attributes");
    let stamps = Regex::new(r"<(dcterms:created|dcterms:modified|TotalTime|cp:revision)\b[^>]*>[^<]*</[^>]+>").expect("the stamps");
    let rsids = Regex::new(r"<w:rsid\b[^>]*/>").expect("the rsid list");
    let mut parts = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).expect("a part");
        let name = file.name().to_owned();
        let mut content = Vec::new();
        file.read_to_end(&mut content).expect("a part reads");
        let text = if name.ends_with(".xml") || name.ends_with(".rels") {
            let xml = String::from_utf8_lossy(&content);
            let xml = volatile.replace_all(&xml, "");
            let xml = stamps.replace_all(&xml, "");
            let xml = rsids.replace_all(&xml, "");
            rules.guid.replace_all(&xml, "<guid>").into_owned()
        } else {
            format!("{} bytes", content.len())
        };
        parts.insert(name, text);
    }
    parts
}

fn same_file(rust: &Path, shell: &Path, rules: &Rules, label: &str) {
    match rust.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("docx" | "docm" | "dotx") => assert_eq!(normalised_parts(rust, rules), normalised_parts(shell, rules), "{label}: the saved documents differ"),
        // A PDF holds its own creation time and identifiers: both runs must have written one.
        Some("pdf") => {
            let sizes = [rust, shell].map(|path| mixdog_fsio::read(&mixdog_fsio::Unlaned, path).map(|bytes| bytes.len()).unwrap_or(0));
            assert!(sizes.iter().all(|size| *size > 0), "{label}: a PDF is missing or empty ({sizes:?})");
        }
        _ => assert_eq!(
            mixdog_fsio::read(&mixdog_fsio::Unlaned, rust).ok(),
            mixdog_fsio::read(&mixdog_fsio::Unlaned, shell).ok(),
            "{label}: the files differ"
        ),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// An application of its own that holds documents open (the recorder's helper, taken from its source so there is one copy).

struct HelperApp {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl HelperApp {
    fn start(dir: &Path, names: &[&str]) -> Self {
        let source = mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &crate_dir().join("recorder").join("record-office-com.mjs")).expect("the recorder");
        let from = source.find("const HOST_APP_SCRIPT = `").expect("the helper script") + "const HOST_APP_SCRIPT = `".len();
        let script = &source[from..from + source[from..].find("\n`;").expect("the end of the helper script")];
        let path = dir.join("host-app.ps1");
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, script.as_bytes()).expect("the helper script is written");
        let powershell = Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let mut child = Command::new(powershell)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .args(["-Format", "docx", "-Dir"])
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
    answers: Vec<(String, Json)>,
    request_time: Duration,
    work: PathBuf,
}

fn inputs_of(area: &str) -> PathBuf {
    crate_dir().join("tests").join("fixtures").join(area).join("inputs")
}

fn is_word_scenario(scenario: &Json) -> bool {
    let mut formats = BTreeSet::new();
    for step in scenario["steps"].as_array().into_iter().flatten() {
        let request = step.get("oneShot").or_else(|| step.get("send").and_then(|send| send.get("request")));
        if let Some(format) = request.and_then(|request| request.get("format")).and_then(Json::as_str) {
            formats.insert(format.to_owned());
        }
    }
    formats.len() == 1 && formats.contains("docx")
}

async fn run_scenario(office: &OfficeCom, area: &str, scenario: &Json, work: PathBuf, rules: &Rules) -> Run {
    let work_text = work.to_string_lossy().into_owned();
    // Session ids opened through each of the scenario's session hosts, in the order they were opened.
    let mut hosts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut helpers: Vec<HelperApp> = Vec::new();
    let mut answers = Vec::new();
    let mut request_time = Duration::ZERO;
    for (index, step) in scenario["steps"].as_array().expect("the steps").iter().enumerate() {
        let recorded = step.get("prepare").and_then(Json::as_bool) != Some(true);
        let label = step.get("label").and_then(Json::as_str).map_or_else(|| format!("step {index}"), str::to_owned);
        let timeout = Duration::from_millis(step.get("timeoutMs").and_then(Json::as_u64).unwrap_or(120_000));
        let options = || CallOptions { timeout, cancel: CancellationToken::new() };
        let started = Instant::now();
        let answer = if let Some(file) = step.get("copy").and_then(Json::as_str) {
            let name = step.get("as").and_then(Json::as_str).unwrap_or(file);
            let bytes = mixdog_fsio::read(&mixdog_fsio::Unlaned, &inputs_of(area).join(file)).unwrap_or_else(|error| panic!("{file}: {error}"));
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
            assert!(app.is_string() && step["format"] == json!("docx"), "only a Word helper application is run");
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
        if recorded {
            if let Some(answer) = answer {
                request_time += started.elapsed();
                answers.push((label, rules.normalise(&answer, &work_text, None)));
            }
        }
    }
    drop(helpers);
    for id in hosts.into_values().flatten() {
        let _ = office.close_session(&id, CloseOptions::default()).await;
    }
    Run { answers, request_time, work }
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn every_word_scenario_through_the_transport_equals_the_powershell_host_and_is_not_slower() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let before = word_processes(&platform);
    let rules = Rules::new();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let data = scratch("data");
    for kind in ["shell", "rust"] {
        mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, &data.join(kind)).expect("a data directory");
    }
    let mut shell_time = Duration::ZERO;
    let mut rust_time = Duration::ZERO;
    let mut ran = 0;
    for area in AREAS {
        let text = mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &crate_dir().join("recorder").join("scenarios").join(format!("{area}.json"))).expect("the scenarios");
        let file: Json = serde_json::from_str(&text).expect("the scenarios are JSON");
        for scenario in file["scenarios"].as_array().expect("scenarios").iter().filter(|scenario| is_word_scenario(scenario)) {
            let id = scenario["id"].as_str().expect("an id");
            let label = format!("{area}/{id}");
            let shell = runtime.block_on(run_scenario(&transport(data.join("shell"), false), area, scenario, scratch(&format!("{area}-{id}-powershell")), &rules));
            assert_eq!(wait_for_word(&platform, &before), before, "{label}: the PowerShell host left a WINWORD process");
            let rust = runtime.block_on(run_scenario(&transport(data.join("rust"), true), area, scenario, scratch(&format!("{area}-{id}-rust")), &rules));
            assert_eq!(rust.answers, shell.answers, "{label}: the answers differ");
            for name in scenario["collect"].as_array().into_iter().flatten().filter_map(Json::as_str) {
                same_file(&rust.work.join(name), &shell.work.join(name), &rules, &format!("{label}/{name}"));
            }
            assert_eq!(wait_for_word(&platform, &before), before, "{label}: closing the sessions left a WINWORD process that was not there before");
            shell_time += shell.request_time;
            rust_time += rust.request_time;
            ran += 1;
            remove(&shell.work);
            remove(&rust.work);
        }
    }
    remove(&data);
    assert!(ran > 0, "no docx scenario was found");
    eprintln!("{ran} Word scenarios: Rust host {rust_time:?}, PowerShell host {shell_time:?}");
    assert!(rust_time <= shell_time, "the Rust host's requests took {rust_time:?}, the PowerShell host's {shell_time:?}");
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
        let office = transport(data.clone(), true);
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
