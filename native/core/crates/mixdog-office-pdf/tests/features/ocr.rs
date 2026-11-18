//! The text layer an OCR pass adds to a scanned page, with the recognizer scripted: the words it reports are placed where the
//! page image says they are, so the saved document can be searched.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::ocr::engine::{BoxFuture, EngineConfig, EngineProcess, EngineStarter, Image, OcrEngines, Recognition};
use mixdog_office_pdf::ocr::tsv::ocr_text_lines;
use mixdog_office_pdf::ocr::{OcrContext, ocr_pdf};
use mixdog_office_pdf::writer::create_pdf;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::CancellationToken;
use serde_json::json;

const HEADER: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n";

fn row(line: u32, word: u32, left: f64, top: f64, width: f64, height: f64, conf: u32, text: &str) -> String {
    format!("5\t1\t1\t1\t{line}\t{word}\t{left}\t{top}\t{width}\t{height}\t{conf}\t{text}\n")
}

#[test]
fn words_of_the_engines_table_become_lines_with_their_box_and_the_widest_gap() {
    let table = format!("{HEADER}{}{}{}", row(1, 1, 10.0, 20.0, 50.0, 12.0, 95, "Hello"), row(1, 2, 70.0, 20.0, 60.0, 12.0, 90, "World"), row(2, 1, 10.0, 50.0, 80.0, 12.0, 88, "Second"));
    let lines = ocr_text_lines(&table, "Hello World\nSecond\n");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].text, "Hello World");
    assert_eq!((lines[0].left, lines[0].top, lines[0].width, lines[0].height), (10.0, 20.0, 120.0, 12.0));
    assert_eq!(lines[0].column_gap, 10.0);
    assert_eq!(lines[0].words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>(), ["Hello", "World"]);
    assert_eq!(lines[0].words[1].confidence, 90.0);
    assert_eq!(lines[1].text, "Second");
    assert_eq!(lines[1].top, 50.0);
}

#[test]
fn a_table_without_its_header_row_reads_the_same_as_one_with_it() {
    let rows = format!("{}{}", row(1, 1, 10.0, 20.0, 50.0, 12.0, 95, "Hello"), row(1, 2, 70.0, 20.0, 60.0, 12.0, 90, "World"));
    let with = ocr_text_lines(&format!("{HEADER}{rows}"), "Hello World\n");
    let without = ocr_text_lines(&rows, "Hello World\n");
    assert_eq!(with, without);
    assert_eq!(without[0].words.len(), 2, "the first data row is not eaten as a header");
}

struct NoNote;

impl WriteNote for NoNote {
    fn note_write(&self, _path: &Path) {}
}

/// An engine that reads every page as three words at fixed shares of the image.
struct Scripted;

impl EngineProcess for Scripted {
    fn recognize<'a>(&'a self, image: Image, _with_words: bool, _cancel: &'a CancellationToken) -> BoxFuture<'a, Result<Recognition, String>> {
        Box::pin(async move {
            let Image::Path(path) = image else { return Err("a file is expected".to_owned()) };
            let decoded = mixdog_raster::Image::decode(&mixdog_testkit::read(&path)).map_err(|error| error.to_string())?;
            let (w, h) = (f64::from(decoded.width()), f64::from(decoded.height()));
            let tsv = format!(
                "{HEADER}{}{}{}",
                row(1, 1, (w * 0.10).round(), (h * 0.10).round(), (w * 0.15).round(), (h * 0.03).round(), 95, "Hello"),
                row(1, 2, (w * 0.40).round(), (h * 0.10).round(), (w * 0.15).round(), (h * 0.03).round(), 93, "World"),
                row(2, 1, (w * 0.10).round(), (h * 0.30).round(), (w * 0.20).round(), (h * 0.03).round(), 91, "Second"),
            );
            Ok(Recognition { text: "Hello World\nSecond\n".to_owned(), tsv })
        })
    }

    fn terminate(&self) {}
}

struct ScriptedStarter;

impl EngineStarter for ScriptedStarter {
    fn start(&self, _config: EngineConfig) -> BoxFuture<'static, Result<Arc<dyn EngineProcess>, String>> {
        Box::pin(async {
            let process: Arc<dyn EngineProcess> = Arc::new(Scripted);
            Ok(process)
        })
    }
}

fn scanned() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-ocr-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let path = directory.join("scan.pdf");
    // The page has no text of its own, as a scan has none.
    create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), &json!({ "blocks": [{ "type": "rule" }] })).expect("written");
    path
}

#[test]
fn recognised_words_are_placed_where_the_image_has_them_and_the_saved_page_can_be_read_as_text() {
    let path = scanned();
    let before = mixdog_testkit::read(&path);
    let context = OcrContext {
        lanes: mixdog_rt::testing::tokens(),
        registry: Arc::new(Registry::new()),
        note: Arc::new(NoNote),
        engines: Arc::new(OcrEngines::new(Arc::new(ScriptedStarter))),
        data_dir: path.with_file_name("data"),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("runtime");
    runtime.block_on(ocr_pdf(&context, &path, &json!({}), None)).expect("recognised");
    let after = mixdog_testkit::read(&path);
    assert_ne!(before, after, "the text layer was written");
    let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Bytes(&after), &LayoutOptions { shapes: false, ..LayoutOptions::default() }).expect("layout");
    let page = &layout.pages[0];
    let find = |word: &str| page.items.iter().find(|item| item.text.contains(word)).unwrap_or_else(|| panic!("no {word} in {:?}", page.items.iter().map(|i| &i.text).collect::<Vec<_>>()));
    let (hello, world, second) = (find("Hello"), find("World"), find("Second"));
    assert!(hello.x < world.x, "Hello is left of World");
    assert!(hello.top < second.top, "the second line is lower");
    assert!((hello.x / page.width - 0.10).abs() < 0.03, "x {} of {}", hello.x, page.width);
    assert!((world.x / page.width - 0.40).abs() < 0.03, "x {} of {}", world.x, page.width);
    assert!((second.top / page.height - 0.30).abs() < 0.05, "top {} of {}", second.top, page.height);
}
