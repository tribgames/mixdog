//! Twin test `docx_build`: the recording of Node's Word HTML builder (`native/core/fixtures/office-docx-build/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-docx-build.mjs`) against this crate's `docx_build` and
//! `docx_html_runner`.
//!
//! Replayed without a browser: every recorded flow (the two documents of the Word suite as the browser read them, and the
//! flows of their own) built by `build_docx_from_flow` must give the recorded package, every entry in the recorded order and
//! every part equal (the two timestamps of `docProps/core.xml` are masked), the same notes; a flow Node refused must be
//! refused with the text it threw.
//!
//! The documents themselves are laid out by a browser, whose fonts and rendering belong to the machine that recorded them
//! (a recording made with `--browser`): `twin_live_docx_build` (ignored: it starts Node and a Chromium-family browser)
//! records again and runs Rust against the same installed browser. The ports of `office-docx-html.slow.test.mjs` are the
//! `html_run_*` tests, ignored for the same reason.

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
use mixdog_office_author::docx_build::DocxPage;
use mixdog_office_author::docx_build::build_docx_from_flow;
use mixdog_office_author::docx_build::inline_pictures;
use mixdog_office_author::docx_html_runner::DocxRunOptions;
use mixdog_office_author::docx_html_runner::docx_html_artifacts;
use mixdog_office_author::docx_html_runner::run_docx_html_authoring;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_ooxml::zipio::Package;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    twin::load_golden("office-docx-build")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    let items = value.as_array().unwrap_or_else(|| panic!("{what} is not an array"));
    assert!(!items.is_empty(), "{what} is empty");
    items
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

fn scratch_dir(tag: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("mixdog-docx-build-{tag}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
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
                    failures.push(format!("{name}: {part_name} is not the recorded picture"));
                }
            }
        }
    }
}

fn page_of(record: &Value) -> DocxPage {
    let (sheet, margin) = (&record["page"]["sheet"], &record["page"]["margin"]);
    let number = |value: &Value| value.as_f64().expect("a number");
    DocxPage { width: number(&sheet["width"]), height: number(&sheet["height"]), top: number(&margin["top"]), right: number(&margin["right"]), bottom: number(&margin["bottom"]), left: number(&margin["left"]) }
}

/// The recorded flow built in a folder of its own that holds its pictures, as the recorder had them.
fn build_record(g: &Value, record: &Value) -> Result<(Vec<u8>, Vec<String>, PathBuf), (String, PathBuf)> {
    let dir = scratch_dir("case");
    let url = url::Url::from_directory_path(&dir).expect("a folder url").to_string();
    let url = url.trim_end_matches('/');
    let mut captures = BTreeMap::new();
    for (number, picture) in record["captures"].as_object().expect("captures") {
        let path = dir.join(picture["name"].as_str().expect("a picture name"));
        mixdog_testkit::write(&path, blob_bytes(g, &picture["blob"]));
        captures.insert(number.parse::<usize>().expect("a capture number"), path);
    }
    mixdog_testkit::write(dir.join("logo.png"), blob_bytes(g, &g["logo"]));
    let flow: Value = serde_json::from_str(&record["flow"].to_string().replace(g["pictures"].as_str().expect("the picture token"), url)).expect("the flow");
    let mut inline = BTreeMap::new();
    for (index, picture) in inline_pictures(&flow).into_iter().enumerate() {
        let path = dir.join(format!("inline-{index}.{}", picture.extension));
        mixdog_testkit::write(&path, &picture.bytes);
        inline.insert(picture.src, path);
    }
    match build_docx_from_flow(&Unlaned, &Registry::new(), &flow, &page_of(record), &captures, &inline, record["title"].as_str().unwrap_or_default()) {
        Ok(built) => Ok((built.bytes, built.notes, dir)),
        Err(message) => Err((message, dir)),
    }
}

/// The text of an error with the folder of the case and the direction of its slashes taken out.
fn plain(message: &str, dir: &Path) -> String {
    let folder = dir.display().to_string();
    message.replace(&folder, "@PICTURES@").replace(&folder.replace('\\', "/"), "@PICTURES@").replace('\\', "/")
}

fn every_build_equals_the_recording() {
    let g = golden();
    let builds = array(&g["builds"], "builds");
    let mut failures = Vec::new();
    let (mut built_count, mut refused_count) = (0, 0);
    for record in builds {
        let name = record["name"].as_str().expect("name");
        match (record["error"].as_str(), build_record(&g, record)) {
            (None, Ok((bytes, notes, dir))) => {
                built_count += 1;
                let package = Package::load(&bytes).expect("a package");
                compare_package(name, &g, array(&record["parts"], "parts"), &package, &mut failures);
                let recorded: Vec<String> = array_or_empty(&record["notes"]).iter().map(|note| note.as_str().expect("a note").to_owned()).collect();
                if notes != recorded {
                    failures.push(format!("{name}: the notes are {notes:?}, recorded {recorded:?}"));
                }
                mixdog_testkit::remove_dir_all(&dir);
            }
            (Some(thrown), Err((message, dir))) => {
                refused_count += 1;
                if plain(&message, &dir) != thrown.replace('\\', "/") {
                    failures.push(format!("{name}: recorded the error {thrown:?}, produced {:?}", plain(&message, &dir)));
                }
                mixdog_testkit::remove_dir_all(&dir);
            }
            (thrown, produced) => failures.push(format!("{name}: recorded {thrown:?}, produced {:?}", produced.map(|_| "a document").map_err(|(message, _)| message))),
        }
    }
    assert!(built_count >= 11 && refused_count == 3, "the recording holds the documents and the three refusals: {built_count} built, {refused_count} refused");
    no_failures("builds", builds.len(), &failures);
}

fn array_or_empty(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

#[test]
fn twin_docx_build() {
    every_build_equals_the_recording();
}

#[test]
fn the_time_mask_covers_the_two_dates_and_nothing_else() {
    assert_eq!(masked_time("<dc:title>a</dc:title><dcterms:created xsi:type=\"x\">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified>now</dcterms:modified>"), "<dc:title>a</dc:title><dcterms:created xsi:type=\"x\">@TIME@</dcterms:created><dcterms:modified>@TIME@</dcterms:modified>");
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
    let profile = std::env::temp_dir().join(format!("mixdog-docx-build-browser-{}", std::process::id()));
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
        eprintln!("no Chrome, Chromium or Edge: the documents are not laid out");
        return;
    };
    on_runtime(async {
        let browser = start_browser(&program).await;
        let mut failures = Vec::new();
        for run in runs {
            let name = run["name"].as_str().expect("name");
            let dir = scratch_dir("run");
            let target = dir.join("report.docx");
            let staged = dir.join("staged.docx");
            let note = Arc::new(Noted(Mutex::new(Vec::new())));
            let answered = run_docx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, run["html"].as_str().expect("html"), &staged, DocxRunOptions::new(&target)).await;
            match answered {
                Ok(result) => {
                    if comparable(&result) != run["result"] {
                        failures.push(format!("{name}: recorded {}, produced {}", run["result"], comparable(&result)));
                    }
                    if result["ok"] == json!(true) {
                        let package = Package::load(&mixdog_testkit::read(&staged)).expect("a package");
                        compare_package(name, &g, array(&run["parts"], "parts"), &package, &mut failures);
                        let source = docx_html_artifacts(&target).source();
                        if mixdog_testkit::read_string(&source) != run["html"].as_str().expect("html") {
                            failures.push(format!("{name}: the kept source is not the HTML"));
                        }
                    }
                }
                Err(error) => failures.push(format!("{name}: {}", error.message())),
            }
            mixdog_testkit::remove_dir_all(&dir);
        }
        no_failures("runs in the browser", runs.len(), &failures);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_docx_build -- --ignored`.
#[test]
#[ignore = "re-records through Node and starts the installed browser"]
fn twin_live_docx_build() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-build.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_build_equals_the_recording();
    every_run_equals_the_recording_in_the_browser();
}

/// The HTML document of `office-docx-html.slow.test.mjs` is laid out, built and kept beside the document: the @page sheet is
/// the Word page, h1 is Heading 1 with the h1 size, the cards are two filled cells, a list item is a Word list item, the
/// header row repeats, a data-chart is a picture and `{page} / {pages}` is the page field with the total.
#[test]
#[ignore = "starts the installed browser"]
fn html_run_writes_a_native_word_document() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the document is not laid out");
        return;
    };
    let measured = twin::load_golden("office-measure-docs");
    let html = measured["docx"][0]["html"].as_str().expect("the HTML of the Word suite document");
    on_runtime(async {
        let browser = start_browser(&program).await;
        let dir = scratch_dir("suite");
        let target = dir.join("report.docx");
        let note = Arc::new(Noted(Mutex::new(Vec::new())));
        let result = run_docx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, html, &target, DocxRunOptions::new(&target)).await.expect("a run");
        assert_eq!(result["ok"], json!(true), "{result}");
        assert!(result["htmlPages"].as_array().is_some_and(|pages| !pages.is_empty()), "the HTML print comes back as page images");
        let package = Package::load(&mixdog_testkit::read(&target)).expect("a package");
        let document = package.text("word/document.xml");
        let styles = package.text("word/styles.xml");
        assert!(document.contains("<w:pgSz w:w=\"11906\" w:h=\"16838\""), "the @page sheet is the Word page");
        assert!(document.contains("<w:pStyle w:val=\"Heading1\"/>") && document.contains("처리량은 184,200건이었다"), "h1 is Heading 1");
        assert!(styles.contains("w:styleId=\"Heading1\"") && styles.contains("<w:sz w:val=\"48\"/>"), "Heading 1 carries the h1 size");
        assert_eq!(document.matches("w:fill=\"EEF4F1\"").count(), 2, "the two cards are two filled cells");
        assert!(document.contains("<w:numPr><w:ilvl w:val=\"0\"/>"), "li is a Word list item");
        assert!(document.contains("<w:tblHeader/>"), "thead repeats");
        assert!(document.contains("<w:drawing>"), "the data-chart is a picture");
        let footer = ["word/footer1.xml", "word/footer2.xml"].iter().map(|name| package.text(name)).find(|text| !text.is_empty()).expect("a footer");
        assert!(footer.contains("NUMPAGES"), "{{page}} / {{pages}} is the page field and the total");
        mixdog_testkit::remove_dir_all(&dir);
    });
}

/// A page break before a table survives to the Word document: the table's page break is a paragraph of its own before it.
#[test]
fn a_page_break_before_a_table_is_a_paragraph_before_it() {
    let g = golden();
    let record = array(&g["builds"], "builds").iter().find(|build| build["name"] == json!("tables")).expect("the tables flow");
    let (bytes, _, dir) = build_record(&g, record).unwrap_or_else(|(message, _)| panic!("{message}"));
    let document = Package::load(&bytes).expect("a package").text("word/document.xml");
    assert!(document.contains("<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"20\" w:lineRule=\"exact\"/>"), "{document}");
    mixdog_testkit::remove_dir_all(&dir);
}

/// A Latin-led font stack sets Hangul in the stack's Korean face: the run names both faces and the style does too.
#[test]
fn a_run_names_its_korean_face_beside_the_latin_one() {
    let g = golden();
    let record = array(&g["builds"], "builds").iter().find(|build| build["name"] == json!("headings and body face")).expect("the headings flow");
    let (bytes, _, dir) = build_record(&g, record).unwrap_or_else(|(message, _)| panic!("{message}"));
    let package = Package::load(&bytes).expect("a package");
    let xml = format!("{}{}", package.text("word/document.xml"), package.text("word/styles.xml"));
    assert!(xml.contains("w:ascii=\"Georgia\""), "the Latin face stays the author's");
    assert!(xml.contains("w:eastAsia=\"Batang\""), "Hangul takes the Korean face");
    assert!(!xml.contains("w:eastAsia=\"Georgia\""));
    mixdog_testkit::remove_dir_all(&dir);
}

/// A document without an `@page` size is refused before anything lands: the failure names the size and no document is
/// written.
#[test]
#[ignore = "starts the installed browser"]
fn html_run_refuses_a_document_without_a_page_size() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the document is not laid out");
        return;
    };
    on_runtime(async {
        let browser = start_browser(&program).await;
        let dir = scratch_dir("bare");
        let target = dir.join("bare.docx");
        let note = Arc::new(Noted(Mutex::new(Vec::new())));
        let html = "<!doctype html><html><body><p>본문</p></body></html>";
        let result = run_docx_html_authoring(&browser, mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, html, &target, DocxRunOptions::new(&target)).await.expect("a failure result");
        assert_eq!(result["ok"], json!(false), "{result}");
        assert!(result["error"]["message"].as_str().is_some_and(|message| message.contains("@page size")), "{result}");
        assert!(!mixdog_testkit::exists(&target), "nothing landed");
        mixdog_testkit::remove_dir_all(&dir);
    });
}
