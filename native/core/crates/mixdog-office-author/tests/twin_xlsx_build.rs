//! Twin test `xlsx_build`: the recording of Node's Excel HTML builder (`native/core/fixtures/office-xlsx-build/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-xlsx-build.mjs`) against this crate's `xlsx_build` and
//! `xlsx_html_runner`.
//!
//! Replayed without a browser: every recorded measure (the two workbooks of the Excel suite as the browser read them, and the
//! measures of their own) built by `build_xlsx_from_sheets` must give the recorded package, every entry in the recorded order
//! and every part equal (the two timestamps of `docProps/core.xml` are masked), the same notes; a measure Node refused must be
//! refused with the text it threw.
//!
//! The workbooks themselves are laid out by a browser, whose fonts and rendering belong to the machine that recorded them (a
//! recording made with `--browser`): `twin_live_xlsx_build` (ignored: it starts Node and a Chromium-family browser) records
//! again and runs Rust against the same installed browser. The ports of `office-xlsx-html.slow.test.mjs` are the
//! `html_run_*` tests (ignored for the same reason) and the offline tests on the recorded builds.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_author::xlsx_build::build_xlsx_from_sheets;
use mixdog_office_author::xlsx_html_runner::XlsxRunOptions;
use mixdog_office_author::xlsx_html_runner::run_xlsx_html_authoring;
use mixdog_office_author::xlsx_html_runner::xlsx_html_artifacts;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_ooxml::zipio::Package;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    twin::load_golden("office-xlsx-build")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    let items = value.as_array().unwrap_or_else(|| panic!("{what} is not an array"));
    assert!(!items.is_empty(), "{what} is empty");
    items
}

fn array_or_empty(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

fn scratch_dir(tag: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("mixdog-xlsx-build-{tag}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    if mixdog_testkit::exists(&dir) {
        mixdog_testkit::remove_dir_all(&dir);
    }
    mixdog_testkit::create_dir_all(&dir);
    dir
}

fn on_runtime<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(future)
}

// ---- comparisons -------------------------------------------------------------------------------------------------------

fn blob<'a>(g: &'a Value, id: &Value) -> &'a Value {
    let id = id.as_str().expect("a blob id");
    g["blobs"].get(id).unwrap_or_else(|| panic!("blob {id} is not in the recording"))
}

fn blob_bytes(g: &Value, id: &Value) -> Vec<u8> {
    let body = blob(g, id);
    match (body["text"].as_str(), body["base64"].as_str()) {
        (Some(text), _) => text.as_bytes().to_vec(),
        (_, Some(encoded)) => STANDARD.decode(encoded).expect("base64"),
        _ => panic!("a blob with neither text nor base64"),
    }
}

/// The two timestamps of `docProps/core.xml`, which are the moment of writing, as the recording masks them.
fn masked_time(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(at) = rest.find("<dcterms:") {
        let Some(close) = rest[at..].find('>') else { break };
        let from = at + close + 1;
        let Some(len) = rest[from..].find('<') else { break };
        out.push_str(&rest[..from]);
        out.push_str(if rest[at..from].starts_with("<dcterms:created") || rest[at..from].starts_with("<dcterms:modified") { "@TIME@" } else { &rest[from..from + len] });
        rest = &rest[from + len..];
    }
    out.push_str(rest);
    out
}

/// Entry by entry, in the recorded order, the files of the package: a text part equal, any other part the same bytes. The
/// folder entries of the archive are not parts.
fn compare_package(name: &str, g: &Value, parts: &[Value], package: &Package, failures: &mut Vec<String>) {
    let wanted: Vec<&Value> = parts.iter().filter(|part| part["dir"] != json!(true)).collect();
    let names: Vec<String> = package.names().into_iter().filter(|entry| !entry.ends_with('/')).collect();
    let recorded: Vec<&str> = wanted.iter().map(|part| part["name"].as_str().expect("a part name")).collect();
    if names.iter().map(String::as_str).collect::<Vec<_>>() != recorded {
        failures.push(format!("{name}: the entries are {names:?}, recorded {recorded:?}"));
        return;
    }
    for part in wanted {
        let part_name = part["name"].as_str().expect("a part name");
        let body = blob(g, &part["blob"]);
        match body["text"].as_str() {
            Some(text) => {
                let (made, expected) = (masked_time(&package.text(part_name)), masked_time(text));
                if made != expected {
                    let at = made.bytes().zip(expected.bytes()).take_while(|(a, b)| a == b).count();
                    let window = |text: &str| text.get(at.saturating_sub(60)..(at + 120).min(text.len())).unwrap_or_default().to_owned();
                    failures.push(format!("{name}: {part_name} differs at byte {at}\n  made    {}\n  recorded {}", window(&made), window(text)));
                }
            }
            None => {
                if package.file(part_name) != Some(blob_bytes(g, &part["blob"]).as_slice()) {
                    failures.push(format!("{name}: {part_name} is not the recorded part"));
                }
            }
        }
    }
}

/// The recorded measure built in a folder of its own that holds its photographs, as the recorder had them.
fn measuring_registry() -> Registry {
    // Node measured in the fonts of the machine that recorded (Windows: Calibri sets the digit width of a workbook, Malgun Gothic
    // and Arial the cells); the same faces are read from the system font folder.
    let mut registry = Registry::new();
    let folder = PathBuf::from(std::env::var("windir").unwrap_or_else(|_| "C:/Windows".to_owned())).join("Fonts");
    for file in ["calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf", "malgun.ttf", "malgunbd.ttf", "arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"] {
        let _ = registry.register_file(&Unlaned, &folder.join(file), None);
    }
    registry
}

fn build_record(g: &Value, record: &Value) -> Result<(Vec<u8>, Vec<String>, usize), String> {
    let dir = scratch_dir("case");
    let mut captures = BTreeMap::new();
    for (number, picture) in record["captures"].as_object().expect("captures") {
        let path = dir.join(picture["name"].as_str().expect("a picture name"));
        mixdog_testkit::write(&path, blob_bytes(g, &picture["blob"]));
        captures.insert(number.parse::<usize>().expect("a capture number"), path);
    }
    let built = build_xlsx_from_sheets(&Unlaned, &measuring_registry(), &record["measure"], &captures, record["title"].as_str().unwrap_or_default());
    mixdog_testkit::remove_dir_all(&dir);
    built.map(|built| (built.bytes, built.notes, built.operations))
}

fn every_build_equals_the_recording() {
    let g = golden();
    let builds = array(&g["builds"], "builds");
    let mut failures = Vec::new();
    let (mut built_count, mut refused_count) = (0, 0);
    for record in builds {
        let name = record["name"].as_str().expect("name");
        match (record["error"].as_str(), build_record(&g, record)) {
            (None, Ok((bytes, notes, operations))) => {
                built_count += 1;
                let package = Package::load(&bytes).expect("a package");
                compare_package(name, &g, array(&record["parts"], "parts"), &package, &mut failures);
                let recorded: Vec<String> = array_or_empty(&record["notes"]).iter().map(|note| note.as_str().expect("a note").to_owned()).collect();
                if notes != recorded {
                    failures.push(format!("{name}: the notes are {notes:?}, recorded {recorded:?}"));
                }
                if json!(operations) != record["operations"] {
                    failures.push(format!("{name}: {operations} operations, recorded {}", record["operations"]));
                }
            }
            (Some(thrown), Err(message)) => {
                refused_count += 1;
                if message != thrown {
                    failures.push(format!("{name}: recorded the error {thrown:?}, produced {message:?}"));
                }
            }
            (thrown, produced) => failures.push(format!("{name}: recorded {thrown:?}, produced {:?}", produced.map(|_| "a workbook"))),
        }
    }
    assert!(built_count >= 8 && refused_count == 3, "the recording holds the workbooks and the three refusals: {built_count} built, {refused_count} refused");
    no_failures("builds", builds.len(), &failures);
}

#[test]
fn twin_xlsx_build() {
    every_build_equals_the_recording();
}

#[test]
fn the_time_mask_covers_the_two_dates_and_nothing_else() {
    assert_eq!(masked_time("<dc:title>a</dc:title><dcterms:created xsi:type=\"x\">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified>now</dcterms:modified>"), "<dc:title>a</dc:title><dcterms:created xsi:type=\"x\">@TIME@</dcterms:created><dcterms:modified>@TIME@</dcterms:modified>");
}

// ---- what office-xlsx-html.slow.test.mjs holds, on the recorded builds -------------------------------------------------------

fn built_package(name: &str) -> Package {
    let g = golden();
    let record = array(&g["builds"], "builds").iter().find(|build| build["name"] == json!(name)).unwrap_or_else(|| panic!("{name} is not in the recording"));
    let (bytes, _, _) = build_record(&g, record).unwrap_or_else(|message| panic!("{message}"));
    Package::load(&bytes).expect("a package")
}

/// The HTML report is a native, live workbook: `{id}` placeholders land on the cells those elements became (the KPI reads the
/// table, the table reads the data sheet), a table stretched by the grid row beside it holds one line a cell, each card text
/// spans its card, dated categories stay dates read in their cells' format, `data-note` is the cell note and `data-table` an
/// Excel table. (The cached values of the formulas are the author action's recalculation.)
#[test]
fn the_report_is_a_native_live_workbook() {
    let package = built_package("suite: excel suite workbook");
    let sheet = package.text("xl/worksheets/sheet1.xml");
    let formulas: Vec<&str> = sheet.split("<f>").skip(1).filter_map(|rest| rest.split("</f>").next()).collect();
    assert!(formulas.iter().any(|formula| formula.contains('-') && formula.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')), "{formulas:?}");
    assert!(formulas.iter().any(|formula| formula.strip_prefix("SUMIFS(Ops[처리량],Ops[월],").and_then(|rest| rest.strip_suffix(')')).is_some_and(|cell| cell.trim_start_matches(|c: char| c.is_ascii_uppercase()).len() < cell.len() && cell.trim_start_matches(|c: char| c.is_ascii_uppercase()).chars().all(|c| c.is_ascii_digit()) && !cell.ends_with(|c: char| c.is_ascii_uppercase()))), "{formulas:?}");
    assert!(!formulas.iter().any(|formula| formula.contains('{')), "{formulas:?}");
    let figure = sheet.split("<c ").find(|cell| cell.contains("SUMIFS(Ops[처리량]")).expect("a figure cell");
    let style: usize = figure.split("s=\"").nth(1).and_then(|rest| rest.split('"').next()).and_then(|index| index.parse().ok()).expect("a style");
    let styles = package.text("xl/styles.xml");
    let xf = styles.split("<cellXfs").nth(1).and_then(|rest| rest.split("<xf ").nth(style + 1)).expect("the cell's format");
    assert!(!xf.contains("wrapText=\"1\""), "one line a cell: {xf}");
    assert!(sheet.matches("<mergeCell ").count() >= 2, "each card text spans its card");
    let chart = package.text("xl/charts/chart1.xml");
    assert!(chart.contains("<c:cat><c:numRef><c:f>&apos;보고&apos;!$B$10:$B$11</c:f><c:numCache><c:formatCode>m&quot;월&quot;</c:formatCode>"), "dated categories stay dates");
    assert!(chart.contains("<c:catAx>") && chart.contains("<c:numFmt formatCode=\"m&quot;월&quot;\" sourceLinked=\"1\"/>"), "the axis shows 6월, never the serial");
    assert!(package.text("xl/comments1.xml").contains("자료: 표본 데이터"), "data-note is the cell note");
    assert!(package.text("xl/tables/table1.xml").contains("name=\"Ops\""), "data-table is an Excel table");
}

/// Table values keep identifiers and text while valid figures are typed: "007", "1,2", "1 2" and "1e3" stay text, "184,200"
/// is a number, "+12.0%" is 0.12 in `+0.0%;-0.0%;0.0%`, an ISO date is its serial; `data-value` is written as given.
#[test]
fn table_values_keep_identifiers_and_type_figures() {
    let package = built_package("table values: figures typed, identifiers kept");
    let sheet = package.text("xl/worksheets/sheet1.xml");
    let cell = |reference: &str| -> String {
        let at = sheet.find(&format!("<c r=\"{reference}\"")).unwrap_or_else(|| panic!("{reference} is not in the sheet"));
        sheet[at..].split("</c>").next().unwrap_or_default().to_owned()
    };
    for (row, text) in [(2, "007"), (3, "1,2"), (4, "1 2"), (5, "1e3")] {
        for column in ["A", "B"] {
            assert!(cell(&format!("{column}{row}")).contains(&format!("<t>{text}</t>")), "{column}{row}: {text}");
        }
    }
    for (row, number) in [(6, "184200"), (7, "0.12"), (8, "46295")] {
        for column in ["A", "B"] {
            assert!(cell(&format!("{column}{row}")).contains(&format!("<v>{number}</v>")), "{column}{row}: {number}");
        }
    }
    assert!(package.text("xl/styles.xml").contains("formatCode=\"+0.0%;-0.0%;0.0%\""));
    assert!(cell("A9").contains("<v>-5</v>") && cell("B9").contains("<t>\u{2212}5</t>"), "a typographic minus is typed in the shown text only");
}

/// A workbook without a `data-sheet` section is refused with the sentence that names the attribute.
#[test]
fn a_workbook_without_a_sheet_is_refused() {
    let g = golden();
    let record = array(&g["builds"], "builds").iter().find(|build| build["name"] == json!("refused: no sheet")).expect("the refusal");
    let message = build_record(&g, record).expect_err("a refusal");
    assert!(message.contains("data-sheet"), "{message}");
    assert_eq!(record["error"].as_str(), Some(message.as_str()));
}

// ---- the browser the live replay runs against ----------------------------------------------------------------------------

/// A Chromium-family browser started for this test, as the extension host starts the render browser.
struct LocalBrowser {
    child: Mutex<Child>,
    endpoint: String,
    profile: PathBuf,
}

impl Drop for LocalBrowser {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        let profile = self.profile.clone();
        let _ = std::panic::catch_unwind(move || {
            if mixdog_testkit::exists(&profile) {
                mixdog_testkit::remove_dir_all(&profile);
            }
        });
    }
}

#[async_trait::async_trait]
impl BrowserEndpoint for LocalBrowser {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        Ok((self.endpoint.clone(), Box::new(())))
    }
}

fn installed_browser() -> Option<PathBuf> {
    let explicit = std::env::var_os("PUPPETEER_EXECUTABLE_PATH").map(PathBuf::from);
    let program_files = std::env::var_os("PROGRAMFILES").map_or_else(|| PathBuf::from("C:/Program Files"), PathBuf::from);
    let program_files_x86 = std::env::var_os("PROGRAMFILES(X86)").map_or_else(|| PathBuf::from("C:/Program Files (x86)"), PathBuf::from);
    let candidates = [
        program_files.join("Google/Chrome/Application/chrome.exe"),
        program_files_x86.join("Google/Chrome/Application/chrome.exe"),
        program_files.join("Microsoft/Edge/Application/msedge.exe"),
        program_files_x86.join("Microsoft/Edge/Application/msedge.exe"),
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    explicit.into_iter().chain(candidates).find(|path| mixdog_testkit::exists(path))
}

/// Starts the browser with the flags the render browser has and waits (at most 30 seconds) for its DevTools address.
async fn start_browser(program: &Path) -> LocalBrowser {
    let profile = std::env::temp_dir().join(format!("mixdog-xlsx-build-browser-{}", std::process::id()));
    if mixdog_testkit::exists(&profile) {
        mixdog_testkit::remove_dir_all(&profile);
    }
    mixdog_testkit::create_dir_all(&profile);
    let flags = [
        "--headless=new".to_string(),
        "--remote-debugging-port=0".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--force-color-profile=srgb".to_string(),
        "--font-render-hinting=none".to_string(),
        "--hide-scrollbars".to_string(),
        "--mute-audio".to_string(),
        format!("--user-data-dir={}", profile.display()),
    ];
    let args: Vec<&std::ffi::OsStr> = flags.iter().map(std::ffi::OsStr::new).collect();
    let child = mixdog_testkit::spawn_piped(program, &args);
    let announced = profile.join("DevToolsActivePort");
    for _ in 0..300 {
        if mixdog_testkit::exists(&announced) {
            let text = mixdog_testkit::read_string(&announced);
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                return LocalBrowser { child: Mutex::new(child), endpoint: format!("ws://127.0.0.1:{port}{path}"), profile };
            }
        }
        mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{} did not announce its DevTools address", program.display());
}

struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(path.to_path_buf());
    }
}

/// What a run answers that does not depend on where it ran: everything but the output, its size, the paths and the time,
/// and the number of page images in place of their paths.
fn comparable(result: &Value) -> Value {
    let mut result = result.clone();
    let map = result.as_object_mut().expect("a result object");
    for key in ["output", "bytes", "htmlSource", "elapsedMs"] {
        map.remove(key);
    }
    let pages = map.remove("htmlPages").and_then(|pages| pages.as_array().map(Vec::len)).unwrap_or(0);
    map.insert("pages".into(), json!(pages));
    result
}

fn every_run_equals_the_recording_in_the_browser() {
    let g = golden();
    let runs = array_or_empty(&g["runs"]);
    if runs.is_empty() {
        eprintln!("the recording holds no browser runs (it was made without --browser): record again with it");
        return;
    }
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the workbooks are not laid out");
        return;
    };
    on_runtime(async {
        let browser = start_browser(&program).await;
        let mut failures = Vec::new();
        for run in runs {
            let name = run["name"].as_str().expect("name");
            let dir = scratch_dir("run");
            let target = dir.join("report.xlsx");
            let staged = dir.join("staged.xlsx");
            let note = Arc::new(Noted(Mutex::new(Vec::new())));
            let answered = run_xlsx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, run["html"].as_str().expect("html"), &staged, XlsxRunOptions::new(&target)).await;
            match answered {
                Ok(result) => {
                    if comparable(&result) != run["result"] {
                        failures.push(format!("{name}: recorded {}, produced {}", run["result"], comparable(&result)));
                    }
                    if result["ok"] == json!(true) {
                        let package = Package::load(&mixdog_testkit::read(&staged)).expect("a package");
                        compare_package(name, &g, array(&run["parts"], "parts"), &package, &mut failures);
                    }
                    let source = xlsx_html_artifacts(&target).source();
                    if mixdog_testkit::read_string(&source) != run["html"].as_str().expect("html") {
                        failures.push(format!("{name}: the kept source is not the HTML"));
                    }
                }
                Err(error) => failures.push(format!("{name}: {}", error.message())),
            }
            mixdog_testkit::remove_dir_all(&dir);
        }
        no_failures("runs in the browser", runs.len(), &failures);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_xlsx_build -- --ignored`.
#[test]
#[ignore = "re-records through Node and starts the installed browser"]
fn twin_live_xlsx_build() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-build.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_build_equals_the_recording();
    every_run_equals_the_recording_in_the_browser();
}

/// The HTML workbook of `office-xlsx-html.slow.test.mjs` is laid out, built and kept beside the workbook: the sheet pictures
/// come back as page images, the formulas are live, the chart is native, the note and the table are written.
#[test]
#[ignore = "starts the installed browser"]
fn html_run_writes_a_native_live_workbook() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the workbook is not laid out");
        return;
    };
    let measured = twin::load_golden("office-measure-docs");
    let html = measured["xlsx"][0]["html"].as_str().expect("the HTML of the Excel suite workbook");
    on_runtime(async {
        let browser = start_browser(&program).await;
        let dir = scratch_dir("suite");
        let target = dir.join("report.xlsx");
        let note = Arc::new(Noted(Mutex::new(Vec::new())));
        let result = run_xlsx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, html, &target, XlsxRunOptions::new(&target)).await.expect("a run");
        assert_eq!(result["ok"], json!(true), "{result}");
        assert!(result["htmlPages"].as_array().is_some_and(|pages| !pages.is_empty()), "the HTML sheet comes back as a picture");
        let package = Package::load(&mixdog_testkit::read(&target)).expect("a package");
        assert!(package.text("xl/worksheets/sheet1.xml").contains("<f>"), "the formulas are live");
        assert!(package.text("xl/charts/chart1.xml").contains("<c:barChart>"), "the chart is native");
        assert!(package.text("xl/comments1.xml").contains("자료: 표본 데이터"), "data-note is the cell note");
        assert!(package.text("xl/tables/table1.xml").contains("name=\"Ops\""), "data-table is an Excel table");
        mixdog_testkit::remove_dir_all(&dir);
    });
}

/// A workbook without a `data-sheet` section is refused: the failure names the attribute and no workbook is written.
#[test]
#[ignore = "starts the installed browser"]
fn html_run_refuses_a_workbook_without_a_sheet() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the workbook is not laid out");
        return;
    };
    on_runtime(async {
        let browser = start_browser(&program).await;
        let dir = scratch_dir("bare");
        let target = dir.join("bare.xlsx");
        let note = Arc::new(Noted(Mutex::new(Vec::new())));
        let html = "<!doctype html><html><body><p>본문</p></body></html>";
        let result = run_xlsx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, html, &target, XlsxRunOptions::new(&target)).await.expect("a failure result");
        assert_eq!(result["ok"], json!(false), "{result}");
        assert!(result["error"]["message"].as_str().is_some_and(|message| message.contains("data-sheet")), "{result}");
        assert!(!mixdog_testkit::exists(&target), "nothing landed");
        mixdog_testkit::remove_dir_all(&dir);
    });
}
