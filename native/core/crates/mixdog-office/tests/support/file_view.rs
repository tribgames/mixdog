//! How the Office twins describe a file whose bytes two correct writers never share; the recorders' rule
//! (`benchmarks/rust-core/recorders/lib/office-files.mjs`), included by `twin_dispatch.rs` and `twin_e2e.rs`:
//! - a PDF by what a reader finds in it: per page its size and the text items (positions to the thousandth of a point) and the fields
//!   of a form; with `properties` also the document properties without the dates (title, author, subject, keywords, creator, producer;
//!   where the writer names itself, as the recorder's pdf-lib does, the mark is `<writer>`: this writer names itself otherwise, and what a
//!   caller set is still compared);
//! - a PNG by its width, height and the sha256 of its decoded 8-bit RGBA pixels; `twin_e2e.rs` also keeps the PNG itself (`data`, base64) so
//!   two renders of a page are compared as a picture by the shared rule of `twin::pixels` (the rasterisers anti-alias an edge differently).

use std::sync::Arc;

use mixdog_office_pdf::forms::PdfForm;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::{LoadOptions, PdfDocument};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// `Math.floor(value * 1000 + 0.5) / 1000`, as the JSON number JavaScript writes it (a whole number has no fraction).
pub fn milli(value: f64) -> Value {
    let rounded = (value * 1000.0 + 0.5).floor() / 1000.0;
    if rounded.fract() == 0.0 && rounded.abs() < 9e15 { Value::from(rounded as i64) } else { Value::from(rounded) }
}

pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-") && bytes.len() > 4
}

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) && bytes.len() > 8
}

/// The writer's own name in `Creator`/`Producer` is `<writer>`; anything else is what a caller set.
fn writer_named(value: Option<String>) -> Value {
    match value {
        None => Value::Null,
        Some(name) if name == mixdog_pdf::write::info::PRODUCER => Value::from("<writer>"),
        Some(name) => Value::from(name),
    }
}

/// A PDF as the golden holds it (see the module's header). This engine's PDF writer does not write Node's bytes.
pub fn pdf_fingerprint(bytes: &[u8], properties: bool) -> Value {
    let file = tempfile::Builder::new().suffix(".pdf").tempfile().expect("a temporary file");
    mixdog_fsio::write(&mixdog_fsio::Unlaned, file.path(), bytes).expect("the PDF is written");
    let options = LayoutOptions { shapes: false, ..LayoutOptions::default() };
    let layout = match extract_pdf_text_layout(&mixdog_fsio::Unlaned, PdfSource::Path(file.path()), &options) {
        Ok(layout) => layout,
        Err(error) => return json!({ "pdf": { "unreadable": error.message } }),
    };
    let pages: Vec<Value> = layout
        .pages
        .iter()
        .map(|page| {
            json!({
                "width": milli(page.width),
                "height": milli(page.height),
                "items": page.items.iter().map(|item| json!({ "text": item.text, "x": milli(item.x), "top": milli(item.top), "width": milli(item.width), "height": milli(item.height) })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let load = LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() };
    let mut document = PdfDocument::load(bytes.to_vec(), &load).ok();
    let fields = document.as_mut().and_then(|document| PdfForm::new().describe_fields(document).ok()).filter(|fields| !fields.is_empty());
    let mut pdf = json!({ "pages": pages });
    if let Some(fields) = fields {
        pdf["fields"] = Value::Array(fields);
    }
    if properties && let Some(document) = &document {
        pdf["properties"] = json!({
            "title": document.title(),
            "author": document.author(),
            "subject": document.subject(),
            "keywords": document.keywords(),
            "creator": writer_named(document.creator()),
            "producer": writer_named(document.producer()),
        });
    }
    json!({ "pdf": pdf })
}

/// A PNG by its size and the sha256 of its decoded RGBA pixels.
pub fn png_fingerprint(bytes: &[u8]) -> Value {
    match mixdog_raster::image::Image::decode(bytes) {
        Ok(image) => {
            let digest: String = Sha256::digest(image.rgba()).iter().map(|byte| format!("{byte:02x}")).collect();
            json!({ "png": { "width": image.width(), "height": image.height(), "sha256": digest } })
        }
        Err(_) => json!({ "png": { "unreadable": true } }),
    }
}

/// A PNG as `twin_e2e.rs` compares it: its description and the PNG itself (`data`, base64), which the recorder keeps beside the
/// description (`record-office-e2e.mjs`). A PNG that does not decode has no `data`.
pub fn png_fingerprint_with_pixels(bytes: &[u8]) -> Value {
    let mut described = png_fingerprint(bytes);
    if let Some(png) = described["png"].as_object_mut()
        && !png.contains_key("unreadable")
    {
        png.insert("data".to_owned(), Value::from(mixdog_office_base::twin::base64_encode(bytes)));
    }
    described
}
