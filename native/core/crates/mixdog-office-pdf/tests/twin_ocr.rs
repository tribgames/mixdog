//! Twin test `ocr`: the lines and the invisible text layer of Node's `ocrTextLines` and `ocrPdf`
//! (`native/core/fixtures/office-ocr/golden.json`, written by `benchmarks/rust-core/recorders/record-office-ocr.mjs`) against
//! this crate. Each case is a generated scanned-looking page and the engine's recognition (its text and its table of words);
//! Node ran the product's code with the engine standing in, so does this test: the engine hands out the recorded recognition
//! page by page. Rust must equal the lines, the result of the call and the sizes of the images the engine was handed
//! exactly, and the placed runs of text (the position and size each line or word is fitted to) to 1e-9; the saved PDF must
//! carry exactly those texts, and the call must leave nothing beside the PDF. Re-recording is `twin_live_ocr` (ignored: it
//! runs Node).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::to_number;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::ocr::engine::{BoxFuture, EngineConfig, EngineProcess, EngineStarter, Image, OcrEngines, Recognition};
use mixdog_office_pdf::ocr::layer::{RecognizedPage, Tally, plan_page};
use mixdog_office_pdf::ocr::tsv::ocr_text_lines;
use mixdog_office_pdf::ocr::{OcrContext, ocr_pdf};
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::embed::{Font, StandardFontName};
use mixdog_rt::CancellationToken;
use serde_json::Value;

const SET: &str = "office-ocr";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-ocr.mjs";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

struct NoNote;

impl WriteNote for NoNote {
    fn note_write(&self, _path: &Path) {}
}

/// The recorded recognitions, handed out in order; the size of each image it is handed is kept.
#[derive(Default)]
struct Replay {
    answers: Mutex<VecDeque<Recognition>>,
    sizes: Mutex<Vec<(u32, u32)>>,
}

struct ReplayProcess(Arc<Replay>);

impl EngineProcess for ReplayProcess {
    fn recognize<'a>(&'a self, image: Image, _with_words: bool, _cancel: &'a CancellationToken) -> BoxFuture<'a, Result<Recognition, String>> {
        Box::pin(async move {
            let Image::Path(path) = image else { return Err("the call hands the engine a file".to_owned()) };
            let decoded = mixdog_raster::Image::decode(&mixdog_testkit::read(&path)).map_err(|error| error.to_string())?;
            self.0.sizes.lock().expect("sizes").push((decoded.width(), decoded.height()));
            self.0.answers.lock().expect("answers").pop_front().ok_or_else(|| "no recognition left".to_owned())
        })
    }

    fn terminate(&self) {}
}

struct ReplayStarter(Arc<Replay>);

impl EngineStarter for ReplayStarter {
    fn start(&self, _config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>> {
        let replay = Arc::clone(&self.0);
        Box::pin(async move {
            let process: Arc<dyn EngineProcess> = Arc::new(ReplayProcess(replay));
            Ok(process)
        })
    }
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_time().build().expect("runtime").block_on(future)
}

/// The pages the call reads, as `selectedPages` names them.
fn pages_of(operation: &Value, count: usize) -> Vec<usize> {
    if let Some(pages) = operation["pages"].as_array().filter(|pages| !pages.is_empty()) {
        return pages.iter().map(|page| page.as_u64().expect("page") as usize).collect();
    }
    if let Some(page) = operation["page"].as_u64() {
        return vec![page as usize];
    }
    (1..=count).collect()
}

fn close(want: f64, got: f64) -> bool {
    (want - got).abs() <= 1e-9 * want.abs().max(1.0)
}

fn recorded_lines(lines: &[mixdog_office_pdf::ocr::tsv::OcrLine]) -> Value {
    Value::Array(
        lines
            .iter()
            .map(|line| {
                serde_json::json!({
                    "text": line.text,
                    "fromEngine": line.from_engine,
                    "left": mixdog_js::json_number(line.left),
                    "top": mixdog_js::json_number(line.top),
                    "width": mixdog_js::json_number(line.width),
                    "height": mixdog_js::json_number(line.height),
                    "columnGap": mixdog_js::json_number(line.column_gap),
                    "words": line.words.iter().map(|word| serde_json::json!({
                        "text": word.text,
                        "confidence": mixdog_js::json_number(word.confidence),
                        "left": mixdog_js::json_number(word.left),
                        "top": mixdog_js::json_number(word.top),
                        "width": mixdog_js::json_number(word.width),
                        "height": mixdog_js::json_number(word.height),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

fn replay(golden: &Value) {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("twin-ocr");
    let font = Font::standard(StandardFontName::Helvetica);
    let mut checked = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let recognitions = case["recognitions"].as_array().expect("recognitions");
        let operation = &case["operation"];
        // The lines of each recognition.
        for (index, recognition) in recognitions.iter().enumerate() {
            let lines = ocr_text_lines(recognition["tsv"].as_str().expect("tsv"), recognition["text"].as_str().expect("text"));
            assert_eq!(recorded_lines(&lines), case["lines"][index], "{name}: the lines of recognition {index}");
        }
        // The call, with the engine standing in.
        let dir = root.join(name);
        if mixdog_testkit::exists(&dir) {
            mixdog_testkit::remove_dir_all(&dir);
        }
        mixdog_testkit::create_dir_all(&dir);
        let pdf_path = dir.join("doc.pdf");
        let pdf = unhex(case["pdf"].as_str().expect("pdf"));
        mixdog_testkit::write(&pdf_path, &pdf);
        let engine = Arc::new(Replay {
            answers: Mutex::new(recognitions.iter().map(|r| Recognition { text: r["text"].as_str().expect("text").to_owned(), tsv: r["tsv"].as_str().expect("tsv").to_owned() }).collect()),
            sizes: Mutex::new(Vec::new()),
        });
        let context = OcrContext {
            lanes: mixdog_rt::testing::tokens(),
            registry: Arc::new(Registry::new()),
            note: Arc::new(NoNote),
            engines: Arc::new(OcrEngines::new(Arc::new(ReplayStarter(Arc::clone(&engine))))),
            data_dir: dir.join("data"),
        };
        let outcome = run(ocr_pdf(&context, &pdf_path, operation, None));
        match (outcome, case.get("error")) {
            (Err(error), Some(want)) => {
                assert_eq!(Value::String(error.message), *want, "{name}: the error");
                continue;
            }
            (Err(error), None) => panic!("{name}: {error}"),
            (Ok(_), Some(want)) => panic!("{name}: Node threw {want}, this ocr'd"),
            (Ok(result), None) => assert_eq!(result, case["result"], "{name}: the result"),
        }
        let sizes: Vec<(u32, u32)> = engine.sizes.lock().expect("sizes").clone();
        let want_sizes: Vec<(u32, u32)> = case["imageSizes"].as_array().expect("sizes").iter().map(|s| (s["width"].as_u64().expect("w") as u32, s["height"].as_u64().expect("h") as u32)).collect();
        assert_eq!(sizes, want_sizes, "{name}: the images the engine was handed");
        let after = mixdog_testkit::read(&pdf_path);
        assert_eq!(after != pdf, case["written"].as_bool().expect("written"), "{name}: whether the PDF was written");
        let mut beside: Vec<String> = mixdog_testkit::entry_names(&dir).into_iter().map(|n| n.to_string_lossy().into_owned()).filter(|n| n != "doc.pdf" && n != "data").collect();
        beside.sort();
        assert_eq!(Value::from(beside), case["leftBeside"], "{name}: what the call left beside the PDF");
        // The placed runs: planned from the recording the way the call plans them.
        let sheets = case["pages"].as_array().expect("pages");
        let minimum = match operation.get("minConfidence") {
            None | Some(Value::Null) => 40.0,
            Some(value) => to_number(value),
        };
        let mut expected: Vec<(usize, mixdog_office_pdf::ocr::layer::Placement)> = Vec::new();
        for (index, page_number) in pages_of(operation, sheets.len()).into_iter().enumerate() {
            let recognition = &recognitions[index];
            let lines = ocr_text_lines(recognition["tsv"].as_str().expect("tsv"), recognition["text"].as_str().expect("text"));
            let (image_width, image_height) = want_sizes[index];
            let page = RecognizedPage { page_number, image_width: f64::from(image_width), image_height: f64::from(image_height), lines, text: String::new() };
            let sheet = &sheets[page_number - 1];
            let mut tally = Tally::default();
            let placed = plan_page(&page, sheet["width"].as_f64().expect("width"), sheet["height"].as_f64().expect("height"), &font, minimum, &mut tally).expect("planned");
            expected.extend(placed.into_iter().map(|placement| (page_number, placement)));
        }
        expected.sort_by_key(|(page, _)| *page);
        let runs = case["runs"].as_array().expect("runs");
        assert_eq!(expected.len(), runs.len(), "{name}: the number of runs");
        for (position, ((page, placement), run)) in expected.iter().zip(runs).enumerate() {
            let what = format!("{name}: run {position}");
            assert_eq!(Value::from(*page), run["page"], "{what}: page");
            assert_eq!(Value::from(placement.text.as_str()), run["text"], "{what}: text");
            for (field, got) in [("x", placement.x), ("y", placement.y), ("size", placement.size)] {
                let want = run[field].as_f64().expect("number");
                assert!(close(want, got), "{what}: {field} {got} is not {want}");
            }
        }
        // And the saved PDF carries exactly those texts.
        if case["written"].as_bool().expect("written") {
            let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Bytes(&after), &LayoutOptions { shapes: false, ..LayoutOptions::default() }).expect("layout");
            for sheet in &layout.pages {
                // pdf.js reads a run of text as one item per stretch the font spaces out ("Second", " ", "row here" for a run
                // of three words set with wide gaps, as it does in Node), so the words are compared, not the items.
                let words = |texts: &mut dyn Iterator<Item = String>| {
                    let mut words: Vec<String> = texts.flat_map(|text| text.split_whitespace().map(str::to_owned).collect::<Vec<_>>()).collect();
                    words.sort();
                    words
                };
                let carried = words(&mut sheet.items.iter().map(|item| item.text.clone()));
                let placed = words(&mut runs.iter().filter(|run| run["page"].as_u64() == Some(sheet.page as u64)).map(|run| run["text"].as_str().expect("text").to_owned()));
                assert_eq!(carried, placed, "{name}: the text layer of page {}", sheet.page);
            }
        }
        checked += 1;
    }
    assert!(checked > 0, "the recording holds no case");
}

#[test]
fn twin_ocr() {
    replay(&twin::load_golden(SET));
}

/// Records again with Node (`MIXDOG_BENCH_TREE=<product tree with node_modules>`) and replays the new recording.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_ocr() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
    replay(&twin::load_golden(SET));
}
