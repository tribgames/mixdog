//! Twin test `render_pages`: `renderPdfPages` of Node (`native/core/fixtures/office-render-pages/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-render-pages.mjs`) against this crate. Generated PDFs are rendered in a
//! scratch folder with the options Node was given. The result JSON must equal the recording exactly except the pixels:
//! the keys, the file names and the folder they land in, the sizes, the pages of every contact sheet and its geometry,
//! the visual coverage, the error messages and the files left beside the PDF. The pixels of a page image and of each
//! thumbnail a sheet was composed from are within the tolerance of the recording (no channel more than `max` away, a mean
//! difference per channel of at most `mean`); the bottom band of the page with a page number is not compared (the repaint
//! is set in a font the host chooses). The pages draw no text: the font bridge of the rasteriser draws it. Re-recording is
//! `twin_live_render_pages` (ignored: it runs Node).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fonts::registry::Registry;
use mixdog_office_base::twin;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::{RenderPagesOptions, RenderedImage, RenderedPages, render_pdf_pages};
use mixdog_raster::Image;
use serde_json::Value;

const SET: &str = "office-render-pages";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-render-pages.mjs";
/// The case whose bottom band holds a repainted page number.
const PAGE_NUMBER_CASE: &str = "page-number-in-the-bottom-band";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

/// The paths the render reported as writes, in order.
#[derive(Default)]
struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().expect("notes").push(path.to_path_buf());
    }
}

fn options_of(recorded: &Value) -> RenderPagesOptions {
    let mut options = RenderPagesOptions::default();
    if let Some(pages) = recorded["pages"].as_array() {
        options.pages = Some(pages.iter().map(|page| page.as_f64().expect("page")).collect());
    }
    if let Some(width) = recorded["maxWidth"].as_f64() {
        options.max_width = width;
    }
    if let Some(scale) = recorded["maximumScale"].as_f64() {
        options.maximum_scale = scale;
    }
    if let Some(write) = recorded["writeImages"].as_bool() {
        options.write_images = write;
    }
    options
}

fn render(path: &Path, options: RenderPagesOptions, note: Arc<Noted>) -> Result<RenderedPages, mixdog_office_pdf::AnalysisError> {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(render_pdf_pages(lanes, Arc::new(Registry::new()), note, path, options))
}

/// The largest channel difference and the mean over every channel of the rows above `rows`.
fn compare(ours: &Image, theirs: &Image, rows: u32) -> (u8, f64) {
    let used = (rows * ours.width() * 4) as usize;
    let (mut max, mut sum) = (0u8, 0u64);
    for (a, b) in ours.rgba()[..used].iter().zip(&theirs.rgba()[..used]) {
        let d = a.abs_diff(*b);
        max = max.max(d);
        sum += u64::from(d);
    }
    (max, sum as f64 / used.max(1) as f64)
}

fn check_pixels(what: &str, ours: &[u8], recorded_hex: &str, rows_of: impl Fn(u32) -> u32, tolerance: (u8, f64), failures: &mut Vec<String>) {
    let ours = Image::decode(ours).unwrap_or_else(|error| panic!("{what}: our PNG: {error}"));
    let theirs = Image::decode(&unhex(recorded_hex)).unwrap_or_else(|error| panic!("{what}: the recorded PNG: {error}"));
    if (ours.width(), ours.height()) != (theirs.width(), theirs.height()) {
        failures.push(format!("{what}: the PNG is {}x{}, recorded {}x{}", ours.width(), ours.height(), theirs.width(), theirs.height()));
        return;
    }
    let (max, mean) = compare(&ours, &theirs, rows_of(ours.height()));
    eprintln!("{what}: largest {max} mean {mean:.4}");
    if max > tolerance.0 || mean > tolerance.1 {
        failures.push(format!("{what}: largest {max} (allowed {}), mean {mean:.4} (allowed {})", tolerance.0, tolerance.1));
    }
}

fn names(value: &Value) -> Vec<String> {
    let mut out: Vec<String> = value.as_array().expect("names").iter().map(|name| name.as_str().expect("name").to_owned()).collect();
    out.sort();
    out
}

fn replay(golden: &Value) {
    let tolerance = (golden["tolerance"]["max"].as_u64().expect("tolerance.max") as u8, golden["tolerance"]["mean"].as_f64().expect("tolerance.mean"));
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("render-pages");
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let dir = root.join(name);
        mixdog_testkit::remove_dir_all(&dir);
        mixdog_testkit::create_dir_all(&dir);
        let pdf_path = dir.join("doc.pdf");
        mixdog_testkit::write(&pdf_path, unhex(case["pdf"].as_str().expect("pdf")));
        let note = Arc::new(Noted::default());
        let written = options_of(&case["options"]).write_images;
        let outcome = render(&pdf_path, options_of(&case["options"]), Arc::clone(&note));
        let mut files: Vec<String> = mixdog_testkit::entry_names(&dir).into_iter().map(|name| name.to_string_lossy().into_owned()).filter(|name| name != "doc.pdf").collect();
        files.sort();
        assert_eq!(files, names(&case["files"]), "{name}: the files beside the PDF");
        let rendered = match (outcome, case.get("error")) {
            (Err(error), Some(want)) => {
                assert_eq!(Value::String(error.message.clone()), *want, "{name}: the error");
                assert_eq!(error.name, "Error", "{name}: the error's name");
                continue;
            }
            (Err(error), None) => panic!("{name}: {error}"),
            (Ok(_), Some(want)) => panic!("{name}: Node threw {want}, this rendered"),
            (Ok(rendered), None) => rendered,
        };
        let want = &case["result"];
        let json = rendered.to_json();
        let mut keys: Vec<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        let mut want_keys: Vec<&str> = want["keys"].as_array().expect("keys").iter().map(|key| key.as_str().expect("key")).collect();
        keys.sort_unstable();
        want_keys.sort_unstable();
        assert_eq!(keys, want_keys, "{name}: the keys of the result");
        assert_eq!(json["pageCount"], want["pageCount"], "{name}: pageCount");
        assert_eq!(json["visualCoverage"], want["visualCoverage"], "{name}: visualCoverage");
        let recorded = want["images"].as_array().expect("images");
        assert_eq!(rendered.images.len(), recorded.len(), "{name}: the number of images");
        let noted = note.0.lock().expect("notes").clone();
        let expected_notes: Vec<PathBuf> = if written { rendered.images.iter().map(|image| PathBuf::from(image.path())).collect() } else { Vec::new() };
        assert_eq!(noted, expected_notes, "{name}: every image is reported as a write, in order, before it lands");
        for (index, (image, want)) in rendered.images.iter().zip(recorded).enumerate() {
            let what = format!("{name} image {index}");
            let image_json = image.to_json();
            let mut image_keys: Vec<&str> = image_json.as_object().expect("image").keys().map(String::as_str).collect();
            let mut want_image_keys: Vec<&str> = want["keys"].as_array().expect("keys").iter().map(|key| key.as_str().expect("key")).collect();
            image_keys.sort_unstable();
            want_image_keys.sort_unstable();
            assert_eq!(image_keys, want_image_keys, "{what}: the keys");
            let path = PathBuf::from(image.path());
            assert_eq!(path.file_name().and_then(|file| file.to_str()), want["file"].as_str(), "{what}: the file name");
            assert_eq!(path.parent() == Some(dir.as_path()), want["directoryIsThePdfs"].as_bool().expect("flag"), "{what}: the folder");
            for field in ["page", "width", "height", "mimeType"] {
                assert_eq!(image_json[field], want[field], "{what}: {field}");
            }
            let rows_of = |height: u32| if name == PAGE_NUMBER_CASE { (f64::from(height) * 0.85) as u32 } else { height };
            match image {
                RenderedImage::Page(page) => {
                    check_pixels(&what, &page.png, want["png"].as_str().expect("png"), rows_of, tolerance, &mut failures);
                    compared += 1;
                }
                RenderedImage::Sheet(sheet) => {
                    assert_eq!(image_json["pages"], want["pages"], "{what}: the pages of the sheet");
                    let ours = Image::decode(&sheet.png).expect("the sheet PNG");
                    assert_eq!((ours.width(), ours.height()), (sheet.width, sheet.height), "{what}: the sheet's size is its PNG's");
                    let thumbnails = want["pageImages"].as_array().expect("pageImages");
                    assert_eq!(sheet.page_images.len(), thumbnails.len(), "{what}: the thumbnails");
                    for (thumbnail, recorded) in sheet.page_images.iter().zip(thumbnails) {
                        let label = format!("{what} thumbnail of page {}", thumbnail.page);
                        assert_eq!(Value::from(thumbnail.page), recorded["page"], "{label}: page");
                        assert_eq!(Value::from(thumbnail.width), recorded["width"], "{label}: width");
                        assert_eq!(Value::from(thumbnail.height), recorded["height"], "{label}: height");
                        check_pixels(&label, &thumbnail.png, recorded["png"].as_str().expect("png"), |height| height, tolerance, &mut failures);
                        compared += 1;
                    }
                }
            }
        }
    }
    assert!(compared > 0, "the recording holds no image");
    assert!(failures.is_empty(), "images outside the tolerance:\n{}", failures.join("\n"));
}

#[test]
fn twin_render_pages() {
    replay(&twin::load_golden(SET));
}

/// Records again with Node (`MIXDOG_BENCH_TREE=<product tree with node_modules>`) and replays the new recording.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_render_pages() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
    replay(&twin::load_golden(SET));
}
