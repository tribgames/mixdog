//! The Microsoft Office live suite: the ports of `src/runtime/office/office-live-runtime.test.mjs` (62 test blocks) and of the
//! profile selection of `scripts/office-live-test-plan.mjs`, driving [`Engine::execute`] against a real Word, Excel and PowerPoint.
//!
//! Every test is `#[ignore]`d: it starts Office, shows windows (the visible and attach cases) and drives the foreground, so it runs
//! only on a Windows machine with Office, on request, with `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked
//! for returns at once and says it did nothing (the Node suite's `skip`).
//!
//! The Word, Excel and PowerPoint documents are served by the Rust session host, `mixdogd office-com-host`, so build it first
//! (`cargo build -p mixdog-cli`); `MIXDOG_TEST_MIXDOGD` names another build of it.
//!
//! The profiles of the Node plan (`excel`, `word`, `powerpoint`, `author`, `attach`, `contract`, `compat`, `all`) are name filters
//! over the tests. The tests share one Office and its foreground, so they hold a lock of their own and run one at a time:
//!
//! ```text
//! cargo test -p mixdog-office --offline --test live_com -- --ignored excel::
//! cargo test -p mixdog-office --offline --test live_com -- --ignored word::
//! cargo test -p mixdog-office --offline --test live_com -- --ignored powerpoint::
//! cargo test -p mixdog-office --offline --test live_com -- --ignored other::author_
//! cargo test -p mixdog-office --offline --test live_com -- --ignored other::attach_
//! cargo test -p mixdog-office --offline --test live_com -- --ignored other::contract_
//! cargo test -p mixdog-office --offline --test live_com -- --ignored other::compat_
//! cargo test -p mixdog-office --offline --test live_com -- --ignored            (all)
//! ```
//!
//! A filter that selects no test runs none and passes: read the line `running N tests` (the Node runner failed an empty selection).
//!
//! `Live::call` is Node's `value(await executeOfficeTool(args, { cwd }))`, `Live::raw` the result itself; the helpers below
//! (`text_of`, `matches`, `capture`, `all_matches`, `package`) are the few things the assertions of the Node file use that
//! `serde_json` does not give.
#![cfg(windows)]

mod excel;
mod other;
mod powerpoint;
mod word;

use std::future::Future;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use mixdog_core_api::domain::ext::{BrowserEndpoint, BrowserHold};
use mixdog_fonts::discovery::{HostEnv, scan};
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::Unlaned;
use mixdog_js::JsRegex;
use mixdog_office::batch::BatchHost;
use mixdog_office::engine::{Engine, Platform};
use mixdog_office_base::write_note::{NoWriteNote, WriteNote};
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_design::library::{Environment as DesignEnvironment, Fetch, FetchRequest, FetchResponse, TemplateIndexer};
use mixdog_office_design::templates::index::OfficeTemplateIndexer;
use mixdog_office_pdf::content_ops::ContentOperations;
use mixdog_office_pdf::render::{RenderPagesOptions, render_pdf_pages};
use mixdog_office_pdf::writer::create_chart_pdf;
use mixdog_office_quality::document_brief::BriefReadings;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::zipio::Package;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, LaneTokens};
use serde_json::Value;

// ---- the platform of the engine ---------------------------------------------------------------------------------------------

/// The brief readings of the authoring crate.
struct AuthoringBriefs;

impl BriefReadings for AuthoringBriefs {
    fn html_brief_script(&self, html: &str) -> String {
        mixdog_office_author::brief::html_brief_script(html)
    }

    fn parse_authoring_brief(&self, script: &str) -> Value {
        mixdog_office_author::brief::parse_authoring_brief(script)
    }

    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_fact_coverage(document, brief)
    }

    fn review_source_grounding(&self, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_source_grounding(brief)
    }
}

/// The machine of a batch: the PDF operation set, a Word chart drawn into a PDF and its first page rasterised three pixels a point,
/// and the brief readings.
struct Machine {
    lanes: LaneTokens,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
}

impl BatchHost for Machine {
    fn pdf_operations(&self, _data_dir: &Path, cancel: Option<CancellationToken>) -> ContentOperations {
        ContentOperations::new(self.font_env.clone(), SvgFonts::none(), None, cancel)
    }

    fn chart_picture(&self, block: &Value, width: f64, pdf: &Path) -> impl Future<Output = Result<String, String>> {
        let (block, pdf, lanes, fonts, font_env) = (block.clone(), pdf.to_path_buf(), self.lanes, Arc::clone(&self.fonts), self.font_env.clone());
        async move {
            create_chart_pdf(&Unlaned, &font_env, &pdf.to_string_lossy(), &block, width, None).map_err(|error| error.to_string())?;
            let note: Arc<dyn WriteNote> = Arc::new(NoWriteNote);
            let options = RenderPagesOptions { pages: Some(vec![1.0]), max_width: (width * 3.0).round(), maximum_scale: 3.0, cancel: None, write_images: true };
            let rendered = render_pdf_pages(lanes, fonts, note, &pdf, options).await.map_err(|error| error.to_string())?;
            rendered.images.first().map(|image| image.path().to_owned()).ok_or_else(|| "the chart rendered no page".to_owned())
        }
    }

    fn brief_readings(&self) -> &dyn BriefReadings {
        &AuthoringBriefs
    }
}

/// No network: the design library's pack is never fetched in a live test.
struct NoNetwork;

impl Fetch for NoNetwork {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        Err(format!("the live suite has no network: {}", request.url))
    }
}

/// No browser: the live suite authors nothing from HTML.
struct NoBrowser;

impl BrowserEndpoint for NoBrowser {
    fn lease<'life0, 'async_trait>(&'life0 self) -> Pin<Box<dyn Future<Output = Result<(String, BrowserHold), String>> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async { Err("the live suite has no browser".to_owned()) })
    }
}

/// A headless Chrome or Edge the engine's HTML routes lease.
struct LocalBrowser {
    child: Mutex<Child>,
    endpoint: String,
    profile: PathBuf,
}

impl Drop for LocalBrowser {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).kill();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

impl BrowserEndpoint for LocalBrowser {
    fn lease<'life0, 'async_trait>(&'life0 self) -> Pin<Box<dyn Future<Output = Result<(String, BrowserHold), String>> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        let endpoint = self.endpoint.clone();
        Box::pin(async move { Ok((endpoint, Box::new(()) as BrowserHold)) })
    }
}

/// What the engine runs with here: the real Office transport and the system's fonts, no network and no browser.
struct LivePlatform {
    lanes: LaneTokens,
    office: OfficeCom,
    fonts: Arc<FontRegistry>,
    font_env: FontEnv,
    svg_fonts: SvgFonts,
    environment: DesignEnvironment,
    validator: ValidatorEnvironment,
    machine: Machine,
    endpoint: Box<dyn BrowserEndpoint>,
}

impl Platform for LivePlatform {
    type Batch = Machine;

    fn lanes(&self) -> LaneTokens {
        self.lanes
    }

    fn office(&self) -> &OfficeCom {
        &self.office
    }

    fn fonts(&self) -> Arc<FontRegistry> {
        Arc::clone(&self.fonts)
    }

    fn font_env(&self) -> &FontEnv {
        &self.font_env
    }

    fn svg_fonts(&self) -> &SvgFonts {
        &self.svg_fonts
    }

    fn endpoint(&self) -> &dyn BrowserEndpoint {
        self.endpoint.as_ref()
    }

    fn design_environment(&self) -> &DesignEnvironment {
        &self.environment
    }

    fn fetch(&self) -> &dyn Fetch {
        &NoNetwork
    }

    fn indexer(&self) -> &dyn TemplateIndexer<Unlaned> {
        &OfficeTemplateIndexer
    }

    fn validator(&self) -> &ValidatorEnvironment {
        &self.validator
    }

    fn batch_host(&self) -> &Machine {
        &self.machine
    }
}

// ---- one live session of the suite ------------------------------------------------------------------------------------------

/// The tests share one machine's Office (and its foreground), so they run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

const SCRATCH_PREFIX: &str = "mixdog-office-live-";

/// The scratch folder. A plain `TempDir` drops its failure to remove the folder silently, which is how a `.pptx` that Office
/// still held stayed behind unnoticed: this one retries (Office releases a file moments after its process ends) and then says
/// which folder it could not remove and why. A killed or timed-out run never reaches the drop, so the next start sweeps the
/// folders of earlier runs that are old enough not to be a live one.
struct Scratch(Option<tempfile::TempDir>);

impl Drop for Scratch {
    fn drop(&mut self) {
        let Some(dir) = self.0.take() else { return };
        let path = dir.path().to_path_buf();
        for attempt in 0..10 {
            if !path.exists() {
                return;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => return,
                Err(error) if attempt == 9 => {
                    let held: Vec<_> = std::fs::read_dir(&path).into_iter().flatten().flatten().map(|entry| entry.file_name()).collect();
                    eprintln!("the live Office scratch folder {} was not removed: {error}; still in it: {held:?}", path.display());
                }
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
        }
        drop(dir);
    }
}

#[test]
fn the_scratch_folder_and_what_is_in_it_are_removed_when_the_test_ends() {
    let scratch = Scratch::new();
    let path = scratch.path().to_path_buf();
    std::fs::create_dir_all(path.join("com")).unwrap();
    std::fs::write(path.join("발표.pptx"), b"deck").unwrap();
    drop(scratch);
    assert!(!path.exists());
}

/// A scratch folder (Node's `mkdtemp(join(tmpdir(), 'mixdog-office-live-'))`), an engine over a real Office, and what removes both
/// when the test ends (Node's `resetOfficeSessionsForTest` and `rm(cwd)`).
pub struct Live {
    engine: Arc<Engine<LivePlatform>>,
    runtime: tokio::runtime::Runtime,
    cwd: Scratch,
    _serial: MutexGuard<'static, ()>,
}

impl Drop for Live {
    fn drop(&mut self) {
        self.runtime.block_on(self.engine.shutdown());
    }
}

// ---- reading what a call answered -------------------------------------------------------------------------------------------

/// `result.content[0].text`.
pub fn text_of(result: &Value) -> String {
    result["content"][0]["text"].as_str().unwrap_or_default().to_owned()
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    value.to_string()
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `value.length` of an array (an absent one reads as none).
pub fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// A number read as the JavaScript `Number` it is.
pub fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

/// `/pattern/flags.test(text)`.
pub fn matches(pattern: &str, flags: &str, text: &str) -> bool {
    JsRegex::new_static(pattern, flags).is_match(text)
}

/// The group `group` of `/pattern/flags.exec(text)`.
pub fn capture(pattern: &str, flags: &str, text: &str, group: usize) -> Option<String> {
    JsRegex::new_static(pattern, flags).captures(text).and_then(|found| found.get(group).map(str::to_owned))
}

/// `[...text.matchAll(/pattern/g)].map((match) => match[0])`.
pub fn all_matches(pattern: &str, text: &str) -> Vec<String> {
    all_groups(pattern, text, 0)
}

/// `[...text.matchAll(/pattern/g)].map((match) => match[group])`.
pub fn all_groups(pattern: &str, text: &str, group: usize) -> Vec<String> {
    JsRegex::new_static(pattern, "g").captures_iter(text).filter_map(|found| found.get(group).map(str::to_owned)).collect()
}

/// `[...text.matchAll(/pattern/g)]`: every match's groups `0..=groups` (a group that did not take part is empty).
pub fn all_captures(pattern: &str, text: &str, groups: usize) -> Vec<Vec<String>> {
    JsRegex::new_static(pattern, "g")
        .captures_iter(text)
        .map(|found| (0..=groups).map(|group| found.get(group).unwrap_or_default().to_owned()).collect())
        .collect()
}

/// `text.replace(/pattern/g, '')`.
pub fn strip(pattern: &str, text: &str) -> String {
    JsRegex::new_static(pattern, "g").replace_all_with(text, |_| String::new())
}

/// The text of a Word paragraph's runs, joined (`<w:t>` bodies).
pub fn paragraph_text(xml: &str) -> String {
    all_groups(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", xml, 1).join("")
}

/// Whether `value` (any JSON) serialises to a text holding `needle`.
pub fn mentions(value: &Value, needle: &str) -> bool {
    value.to_string().contains(needle)
}

/// `PNG_PIXEL` of `office-test-support.mjs`: a 1 x 1 PNG.
pub fn png_pixel() -> Vec<u8> {
    let hex = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082";
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex")).collect()
}

/// `Buffer.from(text, 'base64')`.
pub fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut bits, mut held) = (0u32, 0u32);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

/// `waitForProcessExit(processId)`: whether the process was gone within ten seconds.
pub fn wait_for_process_exit(process_id: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let listed = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {process_id}"), "/NH"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
            .unwrap_or_default();
        if !listed.split_whitespace().any(|word| word == process_id.to_string()) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

// ---- a user's own Excel -----------------------------------------------------------------------------------------------------

/// An Excel a PowerShell process started visible with a workbook open (`startExternalExcel`).
pub struct ExternalExcel {
    child: Child,
    lines: Receiver<String>,
    pub hwnd: u64,
    pub process_id: u64,
}

const EXTERNAL_EXCEL: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MixdogExcelTestWindow {
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int ProcessId(long hWnd) {
    uint processId;
    GetWindowThreadProcessId(new IntPtr(hWnd), out processId);
    return unchecked((int)processId);
  }
}
'@
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $true
$excel.DisplayAlerts = $false
$workbook = $excel.Workbooks.Open($args[0])
[Console]::Out.WriteLine("READY:$($excel.Hwnd):$([MixdogExcelTestWindow]::ProcessId([long]$excel.Hwnd))")
$null = [Console]::In.ReadLine()
try { $workbook.Close($false) } catch {}
try { $excel.Quit() } catch {}
try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($workbook) } catch {}
try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) } catch {}
"#;

impl Drop for ExternalExcel {
    fn drop(&mut self) {
        if self.running() {
            let _ = self.child.kill();
        }
    }
}


/// `process.platform === 'win32' && process.env.MIXDOG_TEST_LIVE_OFFICE === '1'`.
fn enabled() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").is_ok_and(|value| value == "1")
}
impl LocalBrowser {
    /// The installed browser (`PUPPETEER_EXECUTABLE_PATH`, else Chrome, else Edge).
    fn installed() -> PathBuf {
        let explicit = std::env::var_os("PUPPETEER_EXECUTABLE_PATH").map(PathBuf::from);
        let program_files = std::env::var_os("PROGRAMFILES").map_or_else(|| PathBuf::from("C:/Program Files"), PathBuf::from);
        let program_files_x86 = std::env::var_os("PROGRAMFILES(X86)").map_or_else(|| PathBuf::from("C:/Program Files (x86)"), PathBuf::from);
        let candidates = [
            program_files.join("Google/Chrome/Application/chrome.exe"),
            program_files_x86.join("Google/Chrome/Application/chrome.exe"),
            program_files.join("Microsoft/Edge/Application/msedge.exe"),
            program_files_x86.join("Microsoft/Edge/Application/msedge.exe"),
        ];
        explicit.into_iter().chain(candidates).find(|path| path.exists()).expect("an installed Chrome or Edge (or PUPPETEER_EXECUTABLE_PATH)")
    }

    /// Starts the browser with the flags the render browser has and waits (at most 30 seconds) for its DevTools address.
    fn start(scratch: &Path) -> Self {
        let profile = scratch.join("browser-profile");
        std::fs::create_dir_all(&profile).expect("a browser profile folder");
        let mut command = Command::new(Self::installed());
        command
            .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "--font-render-hinting=none", "--hide-scrollbars", "--mute-audio"])
            .arg(format!("--user-data-dir={}", profile.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("the browser starts");
        let announced = profile.join("DevToolsActivePort");
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&announced) {
                let mut lines = text.lines();
                if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                    return Self { child: Mutex::new(child), endpoint: format!("ws://127.0.0.1:{port}{path}"), profile };
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        panic!("the browser did not announce its DevTools address");
    }
}
/// The Rust session host: the daemon binary, `mixdogd office-com-host`.
fn mixdogd() -> PathBuf {
    let program = std::env::var_os("MIXDOG_TEST_MIXDOGD").map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().expect("the test binary's path");
        exe.parent().and_then(Path::parent).expect("the target directory").join("mixdogd.exe")
    });
    assert!(program.exists(), "build mixdogd first (cargo build -p mixdog-cli) or name it in MIXDOG_TEST_MIXDOGD: {}", program.display());
    program
}
/// The system's fonts, scanned once on this thread.
fn system_fonts() -> Arc<FontRegistry> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let env = HostEnv::current(&|name| std::env::var(name).ok(), Path::new(&home));
    Arc::new(scan(&Unlaned, &env).registry)
}
impl Scratch {
    fn new() -> Self {
        Self(Some(tempfile::Builder::new().prefix(SCRATCH_PREFIX).tempdir().expect("a scratch folder")))
    }

    fn path(&self) -> &Path {
        self.0.as_ref().expect("the folder lives until the drop").path()
    }

    fn sweep_stale() {
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
        for entry in entries.flatten() {
            let old = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(3600));
            if old && entry.file_name().to_string_lossy().starts_with(SCRATCH_PREFIX) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}
impl Live {
    /// `None` when the live suite was not asked for (the test then does nothing).
    pub fn start() -> Option<Self> {
        Self::boot(false)
    }

    /// As [`Live::start`], with an installed Chrome or Edge started headless for the author routes that print or measure HTML.
    pub fn start_with_browser() -> Option<Self> {
        Self::boot(true)
    }

    fn boot(browser: bool) -> Option<Self> {
        if !enabled() {
            eprintln!("needs Windows with MIXDOG_TEST_LIVE_OFFICE=1: nothing was run");
            return None;
        }
        let serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
        Scratch::sweep_stale();
        let cwd = Scratch::new();
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().expect("a runtime");
        let lanes = mixdog_rt::testing::tokens();
        let mut config = OfficeComConfig::new(cwd.path().join("com"), lanes);
        config.rust_host_program = mixdogd();
        let office = runtime.block_on(async { OfficeCom::new(config) });
        let fonts = system_fonts();
        let font_env = FontEnv::host();
        let machine = Machine { lanes, fonts: Arc::clone(&fonts), font_env: font_env.clone() };
        let platform = LivePlatform {
            lanes,
            office,
            fonts,
            font_env,
            svg_fonts: SvgFonts::none(),
            environment: DesignEnvironment::process(),
            validator: ValidatorEnvironment::from_process(),
            machine,
            endpoint: if browser { Box::new(LocalBrowser::start(cwd.path())) } else { Box::new(NoBrowser) },
        };
        Some(Self { engine: Engine::new(platform), runtime, cwd, _serial: serial })
    }

    /// The scratch folder (`cwd`).
    pub fn dir(&self) -> &Path {
        self.cwd.path()
    }

    /// `join(cwd, name)`, as the text a request carries.
    pub fn path(&self, name: &str) -> String {
        self.cwd.path().join(name).to_string_lossy().into_owned()
    }

    /// `await executeOfficeTool(args, { cwd })`: the tool result as it came back.
    pub fn raw(&self, args: Value) -> Value {
        let (result, _changes) = self.runtime.block_on(self.engine.execute(args, self.cwd.path().to_path_buf(), Some(self.cwd.path().join("mixdog-data")), None, CancellationToken::new()));
        result
    }

    /// `value(await executeOfficeTool(args, { cwd }))`: the call must not be an error; its text parsed.
    pub fn call(&self, args: Value) -> Value {
        let result = self.raw(args);
        assert!(result.get("isError").is_none(), "{}", text_of(&result));
        serde_json::from_str(&text_of(&result)).unwrap_or_else(|error| panic!("the answer is not JSON ({error}): {}", text_of(&result)))
    }

    /// `executeOfficeTool(...)` that must fail: the error text.
    pub fn refused(&self, args: Value) -> String {
        let result = self.raw(args);
        assert_eq!(result["isError"], true, "the call was expected to fail: {}", text_of(&result));
        text_of(&result)
    }

    /// `create` of `name` in the scratch folder, in `mode` with `operations` (the batch that runs as the document is made).
    pub fn create(&self, name: &str, format: &str, mode: &str, operations: Value) -> Value {
        self.call(serde_json::json!({ "action": "create", "path": self.path(name), "format": format, "mode": mode, "operations": operations }))
    }

    /// `close` of a session.
    pub fn close(&self, session: &Value) {
        self.call(serde_json::json!({ "action": "close", "session": session }));
    }

    /// `snapshot` of a session: the `document` of the answer.
    pub fn document(&self, session: &Value) -> Value {
        self.call(serde_json::json!({ "action": "snapshot", "session": session }))["document"].clone()
    }

    /// The package saved at `path` (a name inside the scratch folder or an absolute path).
    pub fn package(&self, path: &str) -> Package {
        let full = if Path::new(path).is_absolute() { PathBuf::from(path) } else { self.cwd.path().join(path) };
        let bytes = std::fs::read(&full).unwrap_or_else(|error| panic!("{}: {error}", full.display()));
        Package::load_unchecked(&bytes).unwrap_or_else(|error| panic!("{}: {error}", full.display()))
    }
}
impl ExternalExcel {
    /// Starts the PowerShell host (`-Sta`, no console window) and waits up to twenty seconds for it to say READY.
    pub fn start(live: &Live, path: &str) -> Self {
        let script = live.dir().join(format!("external-excel-{}.ps1", live.dir().file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()));
        let mut body = vec![0xEF, 0xBB, 0xBF];
        body.extend_from_slice(EXTERNAL_EXCEL.as_bytes());
        std::fs::write(&script, body).expect("the host script");
        let powershell = std::env::var("SystemRoot").map_or_else(|_| PathBuf::from("powershell.exe"), |root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        let mut command = Command::new(powershell);
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).arg(path);
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("the external Excel host");
        let stdout = child.stdout.take().expect("stdout");
        let (send, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match lines.recv_timeout(left) {
                Ok(line) => {
                    if let Some(rest) = line.trim().strip_prefix("READY:") {
                        let mut parts = rest.split(':').map(|part| part.parse::<u64>().expect("a number"));
                        let (hwnd, process_id) = (parts.next().expect("hwnd"), parts.next().expect("pid"));
                        return Self { child, lines, hwnd, process_id };
                    }
                }
                Err(_) => {
                    let _ = child.kill();
                    panic!("Timed out opening external Excel workbook (or the host exited early): {path}");
                }
            }
        }
    }

    /// Whether the host process is still running (`child.exitCode === null`).
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// `stopExternalExcel`: the host is told to close the workbook and quit, and has fifteen seconds to be gone.
    pub fn stop(&mut self) {
        if !self.running() {
            return;
        }
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"\n");
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if !self.running() {
                while self.lines.try_recv().is_ok() {}
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        panic!("External Excel host did not close");
    }
}
