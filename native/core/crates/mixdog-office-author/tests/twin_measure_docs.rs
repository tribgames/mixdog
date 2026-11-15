//! Twin test `measure_docs`: the recording of Node's Word, Excel and PDF HTML routes (`native/core/fixtures/
//! office-measure-docs/golden.json`, written by `benchmarks/rust-core/recorders/record-office-measure-docs.mjs`)
//! against this crate.
//!
//! What needs no browser is replayed by `twin_measure_docs`: the printable area of every `@page` rule the recording
//! has, or the sentence that refused it.
//!
//! The documents themselves are laid out by a browser, whose fonts and rendering belong to the machine that recorded
//! them: `twin_live_measure_docs` (ignored: it starts a Chromium-family browser and Node) records again and runs Rust
//! against the same installed browser: the Word flow, the Excel sheets, the frame canvases and the printed PDFs
//! (page count, page sizes, outline titles, text of each page, document properties) must equal the recording
//! (integers exactly, floats within 1e-6). Without a browser it says so and passes, as Node's tests skip.
//! `pdf_html_print_route_holds_what_the_node_suite_held` is the port of `office-pdf-html.slow.test.mjs`, ignored for
//! the same reason.

use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;
use mixdog_office_author::html_browser::AuthorLanes;
use mixdog_office_author::html_browser::HtmlBrowser;
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::measure_deck::file_url;
use mixdog_office_author::measure_docx::DocxLayout;
use mixdog_office_author::measure_docx::DocxMeasureOptions;
use mixdog_office_author::measure_docx::measure_docx_html;
use mixdog_office_author::measure_xlsx::XlsxMeasureOptions;
use mixdog_office_author::measure_xlsx::measure_xlsx_html;
use mixdog_office_author::page::WaitUntil;
use mixdog_office_author::pdf_print::PrintOptions;
use mixdog_office_author::pdf_print::PrintableArea;
use mixdog_office_author::pdf_print::frame_canvas;
use mixdog_office_author::pdf_print::print_html_pdf;
use mixdog_office_author::pdf_print::printable_area;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::document::Document;
use mixdog_pdf::document::OpenOptions;
use mixdog_pdf::outline_read::OutlineItem;
use mixdog_pdf::outline_read::get_outline;
use mixdog_pdf::text::font_loader;
use mixdog_pdf::write::DocumentProperties;
use mixdog_pdf::write::LoadOptions;
use mixdog_pdf::write::PdfDocument;
use serde_json::Value;
use serde_json::json;

fn golden() -> Value {
    twin::load_golden("office-measure-docs")
}

fn array<'a>(value: &'a Value, what: &str) -> &'a [Value] {
    let items = value.as_array().unwrap_or_else(|| panic!("{what} is not an array"));
    assert!(!items.is_empty(), "{what} is empty");
    items
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

/// The area as the recording writes it.
fn area_json(area: &PrintableArea) -> Value {
    json!({
        "sheet": { "width": area.sheet.width, "height": area.sheet.height },
        "margin": { "top": area.margin.top, "right": area.margin.right, "bottom": area.margin.bottom, "left": area.margin.left },
        "width": area.width,
        "height": area.height,
    })
}

/// Integers equal exactly, floats within 1e-6, everything else equal.
fn close(path: &str, want: &Value, got: &Value, failures: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            let ok = if want.is_i64() || want.is_u64() { a == b } else { (a - b).abs() <= 1e-6 };
            if !ok {
                failures.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => close(&format!("{path}/{key}"), value, other, failures),
                    None => failures.push(format!("{path}/{key}: missing from the output")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                failures.push(format!("{path}/{key}: not in the recording"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                failures.push(format!("{path}: {} items recorded, {} produced", a.len(), b.len()));
                return;
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                close(&format!("{path}/{index}"), x, y, failures);
            }
        }
        _ => {
            if want != got {
                failures.push(format!("{path}: recorded {want}, produced {got}"));
            }
        }
    }
}

fn every_area_equals_the_recording() {
    let g = golden();
    let mut failures = Vec::new();
    for case in array(&g["areas"], "areas") {
        let rule = &case["rule"];
        match (case["error"].as_str(), printable_area(rule)) {
            (None, Ok(area)) => close(&rule.to_string(), &case["output"], &area_json(&area), &mut failures),
            (Some(error), Err(message)) if message == error => {}
            (error, produced) => failures.push(format!("{rule}: recorded {error:?}, produced {:?}", produced.map(|_| "an area"))),
        }
    }
    no_failures("areas", array(&g["areas"], "areas").len(), &failures);
}

#[test]
fn twin_measure_docs() {
    every_area_equals_the_recording();
    let g = golden();
    // A recording that holds the documents the plan names and the refusals.
    assert_eq!(array(&g["docx"], "docx").len(), 2);
    assert_eq!(array(&g["xlsx"], "xlsx").len(), 2);
    assert_eq!(array(&g["frames"], "frames").iter().filter(|frame| frame["error"].is_string()).count(), 2);
    let prints = array(&g["prints"], "prints");
    assert!(prints.iter().any(|print| print["result"]["layout"].is_array()));
    assert!(prints.iter().any(|print| print["frame"] == json!(true) && print["result"]["charts"].is_u64()));
}

// ---- the browser the live replay runs against ------------------------------------------------------------------------

/// A Chromium-family browser started for this test, as the extension host starts the render browser.
struct LocalBrowser {
    child: Mutex<Child>,
    endpoint: String,
    profile: PathBuf,
}

impl Drop for LocalBrowser {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).kill();
        clear_quietly(&self.profile);
    }
}

#[async_trait::async_trait]
impl BrowserEndpoint for LocalBrowser {
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        Ok((self.endpoint.clone(), Box::new(())))
    }
}

fn clear(path: &Path) {
    if mixdog_testkit::exists(path) {
        mixdog_testkit::remove_dir_all(path);
    }
}

/// [`clear`] for a folder a just-killed browser may still hold open: it is left behind when it cannot be removed.
fn clear_quietly(path: &Path) {
    let path = path.to_path_buf();
    let _ = std::panic::catch_unwind(move || clear(&path));
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
    let profile = std::env::temp_dir().join(format!("mixdog-measure-docs-twin-{}", std::process::id()));
    clear(&profile);
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

fn on_runtime<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime").block_on(future)
}

fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-measure-docs-{tag}-{}", std::process::id()));
    clear(&dir);
    mixdog_testkit::create_dir_all(&dir);
    dir
}

fn lanes() -> AuthorLanes {
    AuthorLanes::new(mixdog_rt::testing::tokens())
}

// ---- a finished PDF, summarised as the recording summarises it ---------------------------------------------------------

fn flatten(items: &[OutlineItem], into: &mut Vec<String>) {
    for item in items {
        into.push(item.title.clone());
        flatten(&item.items, into);
    }
}

fn nullable(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::String)
}

/// Page count, page sizes, the outline titles in order, the text of each page and the document properties.
fn summarise(bytes: &[u8]) -> Value {
    let editable = PdfDocument::load(bytes.to_vec(), &LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() }).expect("a PDF");
    let sizes: Vec<Value> = editable
        .pages()
        .iter()
        .map(|page| {
            let media = editable.media_box(*page).expect("a media box");
            json!([media.width, media.height])
        })
        .collect();
    let reader = Document::open(bytes.to_vec(), &OpenOptions::default()).expect("a readable PDF");
    let mut outline = Vec::new();
    if let Some(items) = get_outline(&reader).expect("an outline") {
        flatten(&items, &mut outline);
    }
    let fonts = font_loader(&reader);
    let mut text = Vec::new();
    for index in 0..usize::try_from(reader.num_pages()).expect("a page count") {
        let content = reader.page(index).expect("a page").text_content(&reader, &fonts).expect("the text of a page");
        text.push(content.items.iter().map(|item| format!("{}{}", item.text(), if item.has_eol { "\n" } else { "" })).collect::<String>());
    }
    json!({
        "pageCount": editable.page_count(),
        "sizes": sizes,
        "outline": outline,
        "text": text,
        "info": {
            "title": nullable(editable.title()),
            "author": nullable(editable.author()),
            "subject": nullable(editable.subject()),
            "keywords": nullable(editable.keywords()),
        },
    })
}

fn properties_of(recorded: &Value) -> DocumentProperties {
    let text = |key: &str| recorded[key].as_str().map(str::to_string);
    DocumentProperties {
        title: text("title"),
        author: text("author"),
        subject: text("subject"),
        keywords: recorded["keywords"].as_array().map(|words| words.iter().map(|word| word.as_str().unwrap_or_default().to_string()).collect()),
    }
}

// ---- the documents ---------------------------------------------------------------------------------------------------

fn docx_shape(layout: &DocxLayout, print: &[u8]) -> Value {
    json!({
        "area": area_json(&layout.area),
        "flow": layout.flow,
        "chartWarnings": layout.chart_warnings,
        "title": layout.title,
        "captured": layout.captures.len(),
        "print": summarise(print),
    })
}

async fn docx_cases(browser: &LocalBrowser, g: &Value, failures: &mut Vec<String>) {
    for case in array(&g["docx"], "docx") {
        let name = case["name"].as_str().expect("name");
        let scratch = scratch_dir("docx");
        let (source, print) = (scratch.join("doc.html"), scratch.join("print.pdf"));
        let note = Noted(Mutex::new(Vec::new()));
        let produced = measure_docx_html(browser, &lanes(), &note, case["html"].as_str().expect("html"), DocxMeasureOptions::new(&source, &print, &scratch)).await;
        match (case["error"].as_str(), produced) {
            (None, Ok(layout)) => close(name, &case["output"], &docx_shape(&layout, &mixdog_testkit::read(&print)), failures),
            (Some(error), Err(RunError::Failed(message))) if message == error => {}
            (error, produced) => failures.push(format!("{name}: recorded {error:?}, produced {:?}", produced.map(|_| "a layout"))),
        }
        clear(&scratch);
    }
}

async fn xlsx_cases(browser: &LocalBrowser, g: &Value, failures: &mut Vec<String>) {
    for case in array(&g["xlsx"], "xlsx") {
        let name = case["name"].as_str().expect("name");
        let scratch = scratch_dir("xlsx");
        let source = scratch.join("book.html");
        let note = Noted(Mutex::new(Vec::new()));
        let produced = measure_xlsx_html(browser, &lanes(), &note, case["html"].as_str().expect("html"), XlsxMeasureOptions::new(&source, &scratch)).await;
        match (case["error"].as_str(), produced) {
            (None, Ok(measured)) => close(name, &case["output"], &json!({ "measure": measured.measure, "captured": measured.captures.len() }), failures),
            (Some(error), Err(RunError::Failed(message))) if message == error => {}
            (error, produced) => failures.push(format!("{name}: recorded {error:?}, produced {:?}", produced.map(|_| "a measure"))),
        }
        clear(&scratch);
    }
}

async fn frame_of(browser: &LocalBrowser, html: &str, scratch: &Path) -> Result<Value, String> {
    let source = scratch.join("frame.html");
    lanes().write_file(&source, html.as_bytes().to_vec()).await?;
    let held = HtmlBrowser::launch(browser).await?;
    let result = async {
        let page = held.new_page().await?;
        page.goto(&file_url(&source)?, WaitUntil::Load).await?;
        let canvas = frame_canvas(&page).await?;
        Ok(json!({ "width": canvas.width, "height": canvas.height, "inchWidth": canvas.inch_width, "inchHeight": canvas.inch_height }))
    }
    .await;
    held.close().await;
    result
}

async fn frame_cases(browser: &LocalBrowser, g: &Value, failures: &mut Vec<String>) {
    for case in array(&g["frames"], "frames") {
        let name = case["name"].as_str().expect("name");
        let scratch = scratch_dir("frame");
        let produced = frame_of(browser, case["html"].as_str().expect("html"), &scratch).await;
        match (case["error"].as_str(), produced) {
            (None, Ok(canvas)) => close(name, &case["output"], &canvas, failures),
            (Some(error), Err(message)) if message == error => {}
            (error, produced) => failures.push(format!("{name}: recorded {error:?}, produced {produced:?}")),
        }
        clear(&scratch);
    }
}

/// What `print_html_pdf` answered, as the recording has it (without the file, its size and the time), and the summary
/// of the PDF it wrote.
async fn print_of(browser: &LocalBrowser, case: &Value, scratch: &Path) -> (Value, Option<Value>) {
    let output = scratch.join("out.pdf");
    let source = mixdog_office_author::pdf_print::pdf_html_source_path(&output);
    let mut options = PrintOptions::new(&source);
    options.frame = case["frame"] == json!(true);
    if case["properties"].is_object() {
        options.properties = properties_of(&case["properties"]);
    }
    let mut result = print_html_pdf(browser, mixdog_rt::testing::tokens(), case["html"].as_str().expect("html"), &output, options).await.expect("not cancelled");
    if let Some(object) = result.as_object_mut() {
        for key in ["output", "bytes", "elapsedMs"] {
            object.remove(key);
        }
    }
    let pdf = (result["ok"] == json!(true)).then(|| summarise(&mixdog_testkit::read(&output)));
    (result, pdf)
}

async fn print_cases(browser: &LocalBrowser, g: &Value, failures: &mut Vec<String>) {
    for case in array(&g["prints"], "prints") {
        let name = case["name"].as_str().expect("name");
        let scratch = scratch_dir("print");
        let (result, pdf) = print_of(browser, case, &scratch).await;
        close(&format!("{name}/result"), &case["result"], &result, failures);
        match pdf {
            Some(pdf) => close(&format!("{name}/pdf"), &case["pdf"], &pdf, failures),
            None => {
                if !case["pdf"].is_null() {
                    failures.push(format!("{name}: a PDF was recorded and none was written"));
                }
            }
        }
        clear(&scratch);
    }
}

fn every_document_equals_the_recording() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the documents are not laid out");
        return;
    };
    let g = golden();
    on_runtime(async {
        let browser = start_browser(&program).await;
        let mut failures = Vec::new();
        docx_cases(&browser, &g, &mut failures).await;
        xlsx_cases(&browser, &g, &mut failures).await;
        frame_cases(&browser, &g, &mut failures).await;
        print_cases(&browser, &g, &mut failures).await;
        no_failures("documents", 0, &failures);
    });
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_measure_docs -- --ignored`.
#[test]
#[ignore = "re-records through Node and starts the installed browser"]
fn twin_live_measure_docs() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-measure-docs.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_area_equals_the_recording();
    every_document_equals_the_recording();
}

// ---- office-pdf-html.slow.test.mjs ------------------------------------------------------------------------------------

fn print_entry<'a>(g: &'a Value, prefix: &str) -> &'a Value {
    array(&g["prints"], "prints").iter().find(|entry| entry["name"].as_str().is_some_and(|name| name.starts_with(prefix))).unwrap_or_else(|| panic!("no print recorded for {prefix}"))
}

/// The four tests of the Node suite, on the same documents: the PDF route prints under the document's `@page` rules,
/// designed pages print one sheet each with their chart, icon and two-line heading, the layout check refuses what print
/// would cut, and a document that declares no sheet or a margin on designed pages is refused with nothing written.
#[test]
#[ignore = "starts the installed browser"]
fn pdf_html_print_route_holds_what_the_node_suite_held() {
    let Some(program) = installed_browser() else {
        eprintln!("no Chrome, Chromium or Edge: the PDF documents are not printed");
        return;
    };
    let g = golden();
    on_runtime(async {
        let browser = start_browser(&program).await;

        // author prints an HTML document to a PDF under its @page rules; a second print replaces the first.
        let scratch = scratch_dir("slow-report");
        let report = print_entry(&g, "report");
        let (result, pdf) = print_of(&browser, report, &scratch).await;
        assert_eq!(result["ok"], json!(true), "{result}");
        assert!(result["pageCount"].as_u64().unwrap_or(0) >= 2, "sixty paragraphs flow onto a second sheet");
        let pdf = pdf.expect("a PDF");
        let first = &pdf["sizes"][0];
        assert!((first[0].as_f64().unwrap() - 595.28).abs() < 1.0 && (first[1].as_f64().unwrap() - 841.89).abs() < 1.0, "the sheet is A4: {first}");
        assert!(pdf["text"][0].as_str().unwrap().contains("운영 보고서"));
        assert!(pdf["text"][0].as_str().unwrap().contains("1 / "), "the margin box numbers the page");
        let titles: Vec<&str> = pdf["outline"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(titles.contains(&"운영 보고서") && titles.contains(&"결론"), "headings become bookmarks: {titles:?}");
        let (again, _) = print_of(&browser, report, &scratch).await;
        assert_eq!(again["ok"], json!(true), "a re-author replaces the PDF it wrote before");
        clear(&scratch);

        // designed pages run the deck frame and print one sheet each.
        let scratch = scratch_dir("slow-designed");
        let (result, pdf) = print_of(&browser, print_entry(&g, "designed pages (office"), &scratch).await;
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["pageCount"], json!(2));
        assert_eq!(result["charts"], json!(1), "the data-chart is drawn");
        let pdf = pdf.expect("a PDF");
        assert!(pdf["text"][0].as_str().unwrap().contains("2,400건\n이번 분기 처리량"), "the numeral and its label read as two lines");
        assert!(pdf["outline"].as_array().unwrap().iter().any(|title| title == "세부 내역"), "a heading set on two lines keeps its space in the bookmark: {}", pdf["outline"]);
        assert!(pdf["text"][1].as_str().unwrap().contains("2,400"), "the chart prints its value labels as text");
        clear(&scratch);

        // the layout check refuses what print would cut, and nothing lands.
        let scratch = scratch_dir("slow-refused");
        let (result, pdf) = print_of(&browser, print_entry(&g, "layout check"), &scratch).await;
        assert_eq!(result["ok"], json!(false));
        let mut codes: Vec<&str> = result["layout"].as_array().unwrap().iter().filter_map(|finding| finding["code"].as_str()).collect();
        codes.sort_unstable();
        assert_eq!(codes, ["overflow_x", "remote_image"]);
        assert!(pdf.is_none());
        assert!(!mixdog_testkit::exists(&scratch.join("out.pdf")), "no file was written");
        let (unsized_page, _) = print_of(&browser, print_entry(&g, "no @page size"), &scratch).await;
        assert!(unsized_page["error"]["message"].as_str().unwrap().contains("@page size"));
        clear(&scratch);

        // designed pages are gated: a margin is refused (the plan gate itself belongs to the author action).
        let scratch = scratch_dir("slow-margin");
        let refused = frame_of(&browser, g["frames"][1]["html"].as_str().expect("html"), &scratch).await;
        assert!(refused.unwrap_err().contains("full-bleed"));
        clear(&scratch);
    });
}
