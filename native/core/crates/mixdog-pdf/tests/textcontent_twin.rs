//! `getTextContent` against what pdf.js answered to the same files (`fixtures/pdf-reader`, recorded by
//! `benchmarks/rust-core/recorders/record-pdf-reader.mjs` from the Node product's own pdf.js 6.4.299 through
//! `page.getTextContent()`).
//!
//! Every page of every recorded document is read by `Page::text_content` and must give the same items in the same
//! order: `str` exactly, `dir` and `hasEOL` equal, `transform` within 1e-6, `width` and `height` within 1e-4, and the
//! same font where pdf.js's generated font names are mapped by first occurrence (they are made per document and
//! the recording masks the document part). The styles of the fonts that showed text (`fontFamily`, `ascent`,
//! `descent`, `vertical`) are compared the same way. The reader goldens record two behaviours; the one followed is
//! the one of `withReadableDataUrls`, where the predefined CMaps and the standard font data load, because the
//! reference configuration's `file:` urls do not load in Node and nothing in use may be narrowed.
//!
//! A page that differs fails the test, except the entries of [`ALLOWED`], each with the exact item and the reason.
//! The list is empty: no file the read tool and the intake goldens use may be in it. The test prints one line per
//! file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::text::{TextContent, TextItem, font_loader};
use serde_json::Value;

/// Items allowed to differ: `(file, page number, item index, reason)`.
const ALLOWED: &[(&str, usize, usize, &str)] = &[];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pdf-reader")
}

/// The golden number as pdf.js's JSON has it: `null` is a number that is not finite.
fn near(ours: f64, theirs: &Value, tolerance: f64) -> bool {
    match theirs.as_f64() {
        Some(theirs) => (ours - theirs).abs() <= tolerance || ours == theirs,
        None => !ours.is_finite(),
    }
}

/// The font names of one document: ours (`g_d0_f1`) against the recording's (`g_d#_f1`), by first occurrence.
#[derive(Default)]
struct FontNames {
    to_theirs: HashMap<String, String>,
    to_ours: HashMap<String, String>,
}

impl FontNames {
    fn matches(&mut self, ours: &str, theirs: &str) -> bool {
        let first = self.to_theirs.entry(ours.to_owned()).or_insert_with(|| theirs.to_owned());
        let second = self.to_ours.entry(theirs.to_owned()).or_insert_with(|| ours.to_owned());
        first.as_str() == theirs && second.as_str() == ours
    }
}

fn allowed(file: &str, page: usize, index: usize) -> Option<&'static str> {
    ALLOWED
        .iter()
        .find(|(name, number, item, _)| *name == file && *number == page && *item == index)
        .map(|entry| entry.3)
}

fn show(units: &[u16]) -> String {
    String::from_utf16_lossy(units).chars().take(60).collect()
}

/// What differs on one page, as lines.
fn compare_page(
    file: &str,
    number: usize,
    ours: &TextContent,
    recorded: &Value,
    names: &mut FontNames,
) -> Vec<String> {
    let mut differences = Vec::new();
    let theirs = recorded["items"].as_array().map_or(&[][..], Vec::as_slice);
    if ours.items.len() != theirs.len() {
        differences.push(format!(
            "{file} page {number}: {} items, pdf.js {}",
            ours.items.len(),
            theirs.len()
        ));
    }
    for (index, (item, golden)) in ours.items.iter().zip(theirs).enumerate() {
        let mut item_differences = compare_item(item, golden, names);
        if item_differences.is_empty() {
            continue;
        }
        if let Some(reason) = allowed(file, number, index) {
            println!("{file} page {number} item {index}: allowed ({reason})");
            continue;
        }
        for line in &mut item_differences {
            *line = format!("{file} page {number} item {index}: {line}");
        }
        differences.append(&mut item_differences);
        if differences.len() > 20 {
            break;
        }
    }
    let styles = recorded["styles"].as_object();
    if ours.styles.len() != styles.map_or(0, serde_json::Map::len) {
        differences.push(format!(
            "{file} page {number}: {} font styles, pdf.js {}",
            ours.styles.len(),
            styles.map_or(0, serde_json::Map::len)
        ));
    }
    for (name, style) in &ours.styles {
        let Some(theirs) = names.to_theirs.get(name).and_then(|t| styles?.get(t)) else {
            differences.push(format!("{file} page {number}: no recorded style for {name}"));
            continue;
        };
        let same = theirs["fontFamily"].as_str() == Some(style.font_family.as_str())
            && near(style.ascent, &theirs["ascent"], 1e-9)
            && near(style.descent, &theirs["descent"], 1e-9)
            && (theirs["vertical"] == Value::Bool(true)) == style.vertical;
        if !same {
            differences.push(format!(
                "{file} page {number}: style of {name} is {style:?}, pdf.js {theirs}"
            ));
        }
    }
    differences
}

fn compare_item(item: &TextItem, golden: &Value, names: &mut FontNames) -> Vec<String> {
    let mut differences = Vec::new();
    let text: Vec<u16> = golden["str"].as_str().unwrap_or("").encode_utf16().collect();
    if item.units != text {
        differences.push(format!(
            "str {:?}, pdf.js {:?}",
            show(&item.units),
            show(&text)
        ));
    }
    if golden["dir"].as_str() != Some(item.dir.as_str()) {
        differences.push(format!("dir {}, pdf.js {}", item.dir.as_str(), golden["dir"]));
    }
    if golden["hasEOL"] != Value::Bool(item.has_eol) {
        differences.push(format!("hasEOL {}, pdf.js {}", item.has_eol, golden["hasEOL"]));
    }
    let transform = golden["transform"].as_array();
    for (at, ours) in item.transform.iter().enumerate() {
        let theirs = transform.and_then(|t| t.get(at)).unwrap_or(&Value::Null);
        if !near(*ours, theirs, 1e-6) {
            differences.push(format!(
                "transform[{at}] {ours}, pdf.js {theirs} (all {:?})",
                item.transform
            ));
        }
    }
    if !near(item.width, &golden["width"], 1e-4) {
        differences.push(format!("width {}, pdf.js {}", item.width, golden["width"]));
    }
    if !near(item.height, &golden["height"], 1e-4) {
        differences.push(format!("height {}, pdf.js {}", item.height, golden["height"]));
    }
    match (item.font_name.as_deref(), golden["fontName"].as_str()) {
        (Some(ours), Some(theirs)) => {
            if !names.matches(ours, theirs) {
                differences.push(format!("font {ours} is not {theirs} of pdf.js"));
            }
        }
        (None, None) => {}
        (ours, theirs) => differences.push(format!("font {ours:?}, pdf.js {theirs:?}")),
    }
    differences
}

#[test]
fn the_text_of_every_page_is_what_pdfjs_returns() {
    let manifest: Value = serde_json::from_str(&mixdog_testkit::read_string(
        fixtures().join("MANIFEST.json"),
    ))
    .expect("the manifest parses");
    let mut differences: Vec<String> = Vec::new();
    let (mut files, mut pages, mut items) = (0usize, 0usize, 0usize);
    for case in manifest["cases"].as_array().expect("the cases") {
        let path = fixtures()
            .join("goldens")
            .join(format!("{}.json", case.as_str().expect("a case name")));
        let golden: Value =
            serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("a recording parses");
        let outcome = match golden["withReadableDataUrls"].get("outcome") {
            Some(readable)
                if golden["withReadableDataUrls"]["sameAsReference"] == Value::Bool(false) =>
            {
                readable
            }
            _ => &golden["outcome"],
        };
        if outcome["ok"] != Value::Bool(true) {
            continue;
        }
        let file = golden["file"].as_str().expect("a file");
        let bytes = mixdog_testkit::read(fixtures().join(file));
        let Ok(document) = Document::open(bytes, &OpenOptions::default()) else {
            differences.push(format!("{file}: does not open"));
            continue;
        };
        let fonts = font_loader(&document);
        let mut names = FontNames::default();
        let before = differences.len();
        let (mut file_pages, mut file_items) = (0usize, 0usize);
        for page in outcome["pages"].as_array().expect("pages") {
            let number = page["number"].as_u64().expect("a page number") as usize;
            if page.get("error").is_some() {
                continue;
            }
            let ours = document
                .page(number - 1)
                .and_then(|p| p.text_content(&document, &fonts));
            if page.get("textError").is_some() {
                if ours.is_ok() {
                    differences.push(format!("{file} page {number}: pdf.js fails, this reads"));
                }
                continue;
            }
            let ours = match ours {
                Ok(ours) => ours,
                Err(error) => {
                    differences.push(format!("{file} page {number}: {error}"));
                    continue;
                }
            };
            file_pages += 1;
            file_items += ours.items.len();
            differences.extend(compare_page(file, number, &ours, &page["text"], &mut names));
        }
        println!(
            "{file}: {file_pages} pages, {file_items} items, {}",
            if differences.len() == before { "same" } else { "DIFFERENT" }
        );
        files += 1;
        pages += file_pages;
        items += file_items;
    }
    println!("compared {files} files, {pages} pages, {items} items");
    assert!(pages >= 150, "the pdf-reader recording has {pages} pages with text");
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}
