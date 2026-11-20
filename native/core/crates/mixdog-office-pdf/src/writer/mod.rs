//! The PDF writer of the office backend, ported from `src/runtime/office/pdf/pdf-writer.mjs`: [`create_pdf`] flows a list
//! of blocks (heading, paragraph, list, table, image, cover, callout, quote, caption, rule, stats, chart, field rows)
//! onto pages, adds the form fields, numbers the pages, writes the properties and the file; [`create_chart_pdf`] is the
//! small chart-only PDF the other writers rasterise.
//!
//! * [`blocks`]: the block contracts, the faults a list is refused with and the JavaScript value rules blocks are read with;
//! * [`layout`]: the page cursor (a block that does not fit moves whole to the next page, a heading travels with what it
//!   opens, a paragraph keeps two lines at either edge) and the text-family blocks;
//! * [`tables`]: tables (natural widths, right-aligned figure columns, wrapped rows, repeated header, no orphan row);
//! * [`charts`]: the bar chart block and the chart-only PDF;
//! * [`fields`]: field blocks flowed into pages, the lint of the form and the drawing of the captions and the fields.
//!
//! Every pagination rule is deterministic arithmetic on font metrics, so with equal metrics the layout equals Node's.
//! The page surface the blocks draw on is [`Canvas`]: a page's content stream and the fonts, images and graphics states
//! it uses, written into the page when the document is saved.

pub mod blocks;
pub mod charts;
pub mod fields;
pub mod layout;
pub mod tables;

pub use charts::create_chart_pdf;

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{js_trim, value_to_string};
use mixdog_pdf::author::draw::{page_size, parse_color};
use mixdog_pdf::embed::{EmbedError, Font, FontEnv, FontRequest, StandardFontName, SuffixRng, embed_bold_font, embed_document_font};
use mixdog_pdf::write::{DocumentProperties, PdfDocument, SaveOptions, WriteError, flate_stream};
use mixdog_pdf::{Dict, Obj, Ref};
use mixdog_raster::svg::SvgFonts;
use serde_json::{Map, Value, json};

use crate::forms::{FormError, pdf_number};

use blocks::{assert_pdf_blocks, block_text, items_of, num_nn, text_of, text_or};
use layout::Flow;

/// A refusal of the writer, with the text `pdf-writer.mjs`, pdf-lib or a helper gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriterError(String);

impl WriterError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for WriterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<EmbedError> for WriterError {
    fn from(error: EmbedError) -> Self {
        Self(error.to_string())
    }
}

impl From<FormError> for WriterError {
    fn from(error: FormError) -> Self {
        Self(error.message().to_owned())
    }
}

impl From<WriteError> for WriterError {
    fn from(error: WriteError) -> Self {
        Self(error.to_string())
    }
}

impl From<String> for WriterError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

pub type WriterResult<T> = Result<T, WriterError>;

/// `color(value)` of a block field: nothing (or anything JavaScript reads as false) is black.
pub fn color_of(value: Option<&Value>) -> WriterResult<[f64; 3]> {
    Ok(parse_color(&text_or(value, ""))?)
}

/// A font of the document as the pages name it: the face and the reference its font object is written to.
#[derive(Debug, Clone)]
pub struct Face {
    pub font: Font,
    pub key: String,
    pub reference: Ref,
}

impl Face {
    /// `font.widthOfTextAtSize(text, size)`.
    pub fn width(&self, text: &str, size: f64) -> Result<f64, EmbedError> {
        self.font.width_of_text_at_size(text, size)
    }
}

/// How `page.drawRectangle` is asked for a rectangle: a fill, an outline, an opacity for the fill, a dash for the outline.
#[derive(Debug, Clone, Copy, Default)]
pub struct RectStyle {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Option<[f64; 3]>,
    pub border_color: Option<[f64; 3]>,
    pub border_width: f64,
    pub opacity: Option<f64>,
    pub dash: Option<[f64; 2]>,
}

fn rgb_operands(color: [f64; 3]) -> String {
    format!("{} {} {}", pdf_number(color[0]), pdf_number(color[1]), pdf_number(color[2]))
}

/// One page being drawn: its size, its content stream and what the stream uses.
#[derive(Debug)]
pub struct Canvas {
    reference: Ref,
    width: f64,
    height: f64,
    content: String,
    fonts: Vec<(String, Ref)>,
    images: Vec<(String, Ref)>,
    states: Vec<(String, f64)>,
}

impl Canvas {
    fn new(reference: Ref, width: f64, height: f64) -> Self {
        Self { reference, width, height, content: String::new(), fonts: Vec::new(), images: Vec::new(), states: Vec::new() }
    }

    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }

    /// `page.drawText(text, { x, y, size, font, color })`.
    pub fn draw_text(&mut self, text: &str, x: f64, y: f64, size: f64, face: &Face, color: [f64; 3]) -> Result<(), EmbedError> {
        let encoded = face.font.encode_text(text)?;
        if !self.fonts.iter().any(|(key, _)| *key == face.key) {
            self.fonts.push((face.key.clone(), face.reference));
        }
        let hex: String = encoded.iter().map(|byte| format!("{byte:02X}")).collect();
        self.content.push_str(&format!(
            "BT\n{} rg\n/{} {} Tf\n{} {} Td\n<{hex}> Tj\nET\n",
            rgb_operands(color),
            face.key,
            pdf_number(size),
            pdf_number(x),
            pdf_number(y)
        ));
        Ok(())
    }

    /// `page.drawRectangle(options)`: filled when it has a colour, outlined when it has a border colour.
    pub fn draw_rectangle(&mut self, style: &RectStyle) {
        let mut ops = String::from("q\n");
        if let Some(opacity) = style.opacity {
            let key = match self.states.iter().find(|(_, held)| *held == opacity) {
                Some((key, _)) => key.clone(),
                None => {
                    let key = format!("GS{}", self.states.len() + 1);
                    self.states.push((key.clone(), opacity));
                    key
                }
            };
            ops.push_str(&format!("/{key} gs\n"));
        }
        if let Some(color) = style.color {
            ops.push_str(&format!("{} rg\n", rgb_operands(color)));
        }
        if let Some(color) = style.border_color {
            ops.push_str(&format!("{} RG\n", rgb_operands(color)));
        }
        ops.push_str(&format!("{} w\n", pdf_number(style.border_width)));
        if let Some([on, off]) = style.dash {
            ops.push_str(&format!("[{} {}] 0 d\n", pdf_number(on), pdf_number(off)));
        }
        ops.push_str(&format!("{} {} {} {} re\n", pdf_number(style.x), pdf_number(style.y), pdf_number(style.width), pdf_number(style.height)));
        let paint = if style.color.is_some() && style.border_width != 0.0 {
            "B"
        } else if style.color.is_some() {
            "f"
        } else if style.border_color.is_some() {
            "S"
        } else {
            "n"
        };
        ops.push_str(paint);
        ops.push_str("\nQ\n");
        self.content.push_str(&ops);
    }

    /// `page.drawLine({ start, end, thickness, color })`.
    pub fn draw_line(&mut self, start: [f64; 2], end: [f64; 2], thickness: f64, color: [f64; 3]) {
        self.content.push_str(&format!(
            "q\n{} RG\n{} w\n{} {} m\n{} {} l\nS\nQ\n",
            rgb_operands(color),
            pdf_number(thickness),
            pdf_number(start[0]),
            pdf_number(start[1]),
            pdf_number(end[0]),
            pdf_number(end[1])
        ));
    }

    /// `page.drawImage(image, { x, y, width, height })`.
    pub fn draw_image(&mut self, image: Ref, x: f64, y: f64, width: f64, height: f64) {
        let key = match self.images.iter().find(|(_, held)| *held == image) {
            Some((key, _)) => key.clone(),
            None => {
                let key = format!("Im{}", self.images.len() + 1);
                self.images.push((key.clone(), image));
                key
            }
        };
        self.content.push_str(&format!("q\n{} 0 0 {} {} {} cm\n/{key} Do\nQ\n", pdf_number(width), pdf_number(height), pdf_number(x), pdf_number(y)));
    }

    /// The resource dictionary of the page's content.
    fn resources(&self) -> Dict {
        let mut resources = Dict::new();
        let mut group = |name: &str, entries: Vec<(String, Obj)>| {
            if entries.is_empty() {
                return;
            }
            let mut dict = Dict::new();
            for (key, value) in entries {
                dict.set(&key, value);
            }
            resources.set(name, Obj::Dict(Arc::new(dict)));
        };
        group("Font", self.fonts.iter().map(|(key, reference)| (key.clone(), Obj::Ref(*reference))).collect());
        group("XObject", self.images.iter().map(|(key, reference)| (key.clone(), Obj::Ref(*reference))).collect());
        group(
            "ExtGState",
            self.states
                .iter()
                .map(|(key, opacity)| {
                    let mut state = Dict::new();
                    state.set("Type", Obj::name("ExtGState"));
                    state.set("ca", Obj::Num(*opacity));
                    (key.clone(), Obj::Dict(Arc::new(state)))
                })
                .collect(),
        );
        resources
    }
}

/// A page added to `document` as a drawing surface.
pub(crate) fn new_canvas(document: &mut PdfDocument, width: f64, height: f64) -> WriterResult<Canvas> {
    let reference = document.add_page(width, height)?;
    Ok(Canvas::new(reference, width, height))
}

/// The document's fonts written to their references, the pages' content and resources written into the pages, and the
/// whole file saved. The subsets of the embedded faces hold the glyphs every text was encoded with, so this is the
/// last step.
pub(crate) fn save_document(document: &mut PdfDocument, pages: &[Canvas], faces: &[&Face]) -> WriterResult<Vec<u8>> {
    let mut rng = SuffixRng::default();
    let mut written: Vec<&Face> = Vec::new();
    for face in faces {
        if written.iter().any(|done| done.key == face.key) {
            continue;
        }
        face.font.embed_into(document.store_mut(), Some(face.reference), &mut rng)?;
        written.push(face);
    }
    for page in pages {
        let contents = document.store_mut().register(flate_stream(Dict::new(), page.content.as_bytes()));
        let resources = page.resources();
        document.store_mut().modify_dict(page.reference, |dict| {
            dict.set("Contents", Obj::Ref(contents));
            dict.set("Resources", Obj::Dict(Arc::new(resources)));
        });
    }
    Ok(document.save(SaveOptions::default()))
}

/// The regular face and the bold one of a document: the same face (and object) when the font has no bold companion.
pub(crate) fn faces_of(document: &mut PdfDocument, font: Font, bold: Font) -> (Face, Face) {
    let regular = Face { font, key: "F1".to_owned(), reference: document.store_mut().next_ref() };
    if bold.same_font(&regular.font) {
        return (regular.clone(), regular);
    }
    let strong = Face { font: bold, key: "F2".to_owned(), reference: document.store_mut().next_ref() };
    (regular, strong)
}

/// `pageNumbering(properties, pageCount)`.
fn page_numbering(properties: &Value, page_count: usize) -> bool {
    let setting = properties.get("pageNumbers");
    setting == Some(&Value::Bool(true)) || (setting != Some(&Value::Bool(false)) && text_nn_or(setting, "auto") == "auto" && page_count > 1)
}

/// `String(value ?? fallback)`.
fn text_nn_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(value) => value_to_string(value),
    }
}

/// `drawPageFooters`: the footer text at the left and `n / count` at the right of every page, under the margin.
fn draw_page_footers(flow: &mut Flow, properties: &Value, numbering: bool) -> WriterResult<()> {
    let footer = text_of(properties.get("footer"));
    if !numbering && footer.is_empty() {
        return Ok(());
    }
    let count = flow.pages.len();
    let size = blocks::num_or(properties.get("footerSize"), 9.0);
    let shade = parse_color(&text_or(properties.get("footerColor"), "666666"))?;
    let baseline = mixdog_js::math::max(12.0, flow.margin * 0.5);
    let margin = flow.margin;
    let font = flow.font.clone();
    for (index, page) in flow.pages.iter_mut().enumerate() {
        if !footer.is_empty() {
            page.draw_text(&footer, margin, baseline, size, &font, shade)?;
        }
        if numbering {
            let label = format!("{} / {count}", index + 1);
            let x = page.width() - margin - font.width(&label, size)?;
            page.draw_text(&label, x, baseline, size, &font, shade)?;
        }
    }
    Ok(())
}

/// `applyDocumentProperties(document, properties)`: title, author, subject and keywords, when present (`!= null`), read
/// from the caller's JSON as `String(value)` and applied by [`PdfDocument::apply_document_properties`].
pub fn apply_document_properties(document: &mut PdfDocument, properties: &Value) {
    let present = |key: &str| properties.get(key).filter(|value| !value.is_null());
    let text = |key: &str| present(key).map(value_to_string);
    document.apply_document_properties(&DocumentProperties {
        title: text("title"),
        author: text("author"),
        subject: text("subject"),
        keywords: present("keywords").map(|keywords| match keywords {
            Value::Array(items) => items.iter().map(value_to_string).collect(),
            other => vec![value_to_string(other)],
        }),
    });
}

pub(crate) fn file_error(error: std::io::Error) -> WriterError {
    WriterError::new(error.to_string())
}

/// `createPdf(path, { blocks, fields, properties })`: the blocks flowed onto pages, the form fields added, the pages
/// numbered and the file written. The font is chosen for the whole text up front, so a Korean paragraph and its table
/// share one embedded face. The result is `{ ok, path, pages, pageNumbers, form, flowedFields?, font }`.
pub fn create_pdf<P: WriteProof>(proof: &P, env: &FontEnv, svg_fonts: &SvgFonts, path: &str, spec: &Value) -> WriterResult<Value> {
    let blocks = items_of(spec.get("blocks"));
    assert_pdf_blocks(blocks)?;
    let none = Value::Object(Map::new());
    let properties = match spec.get("properties") {
        Some(found @ Value::Object(_)) => found,
        _ => &none,
    };
    let fields = items_of(spec.get("fields"));
    let margin = num_nn(properties.get("margin"), 54.0);
    let flowed = fields::flowed_field_specs(blocks);
    let mut coverage: Vec<String> = blocks.iter().map(block_text).collect();
    coverage.extend(flowed.iter().map(crate::forms::field_text));
    coverage.push(text_of(properties.get("footer")));
    coverage.extend(fields.iter().map(crate::forms::field_text));
    let coverage = coverage.join(" ");
    let font_path = text_or(properties.get("fontPath"), "");
    let chosen = embed_document_font(proof, env, &FontRequest { font_path: &font_path, text: &coverage, standard: StandardFontName::Helvetica })?;
    let bold = embed_bold_font(proof, &chosen.font, &chosen.font_path, &coverage);
    let mut document = PdfDocument::create();
    let (regular, strong) = faces_of(&mut document, chosen.font.clone(), bold);
    let size = page_size(properties)?;
    let mut flow = Flow::new(document, size, margin, regular, strong, properties.get("background"), properties.get("palette"))?;
    let base_dir = match Path::new(path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().into_owned(),
        _ => ".".to_owned(),
    };
    layout::flow_blocks(&mut flow, proof, svg_fonts, blocks, &base_dir)?;
    let page_count = flow.pages.len();
    let numbering = page_numbering(properties, page_count);
    draw_page_footers(&mut flow, properties, numbering)?;
    apply_document_properties(&mut flow.document, properties);
    // The flowed fields carry the page the reader met them on; the ones the caller placed by hand keep the coordinates
    // they were given.
    let mut form: Vec<Value> = flow.resolved_fields.clone();
    form.extend(fields.iter().cloned());
    let checked = fields::lint_form(&flow, &mut form)?;
    fields::draw_form_fields(&mut flow, &form)?;
    let bytes = save_document(&mut flow.document, &flow.pages, &[&*flow.font, &*flow.bold])?;
    mixdog_fsio::write(proof, path, bytes).map_err(file_error)?;
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(true));
    result.insert("path".into(), Value::String(path.to_owned()));
    result.insert("pages".into(), json!(page_count));
    result.insert("pageNumbers".into(), Value::Bool(numbering));
    result.insert("form".into(), checked);
    if !flow.resolved_fields.is_empty() {
        result.insert("flowedFields".into(), json!(flow.resolved_fields.len()));
    }
    let mut used = Map::new();
    used.insert("embedded".into(), Value::Bool(chosen.embedded));
    if !chosen.font_path.is_empty() {
        used.insert("path".into(), Value::String(chosen.font_path));
    }
    result.insert("font".into(), Value::Object(used));
    Ok(Value::Object(result))
}

/// The faces of a chart-only document: the font for the chart's text and its bold companion.
pub(crate) fn chart_faces<P: ReadProof>(proof: &P, env: &FontEnv, document: &mut PdfDocument, text: &str) -> WriterResult<(Face, Face)> {
    let chosen = embed_document_font(proof, env, &FontRequest { font_path: "", text, standard: StandardFontName::Helvetica })?;
    let bold = embed_bold_font(proof, &chosen.font, &chosen.font_path, text);
    Ok(faces_of(document, chosen.font, bold))
}

/// `String(value).trim()` of a field that may be absent.
pub(crate) fn trimmed(value: Option<&Value>) -> String {
    js_trim(&text_of(value)).to_owned()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use mixdog_fsio::Unlaned;

    use super::*;
    use crate::{LayoutOptions, PdfSource, extract_pdf_text_layout};

    fn write(path: &Path, spec: &Value) -> WriterResult<Value> {
        create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), spec)
    }

    fn pages_text(path: &Path) -> Vec<String> {
        let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Path(path), &LayoutOptions::default()).expect("a layout");
        layout.pages.iter().map(|page| page.items.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join(" ")).collect()
    }

    #[test]
    fn document_properties_are_set_when_given() {
        let mut document = PdfDocument::create();
        apply_document_properties(&mut document, &json!({ "title": "T", "author": null, "keywords": ["a", "b"] }));
        assert_eq!(document.title().as_deref(), Some("T"));
        assert_eq!(document.keywords().as_deref(), Some("a b"));
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("mixdog-office-writer-{}-{name}", std::process::id()));
        mixdog_testkit::create_dir_all(&directory);
        directory
    }
    #[test]
    fn a_report_flows_onto_pages_with_footers_and_reads_back() {
        let directory = scratch("report");
        let path = directory.join("report.pdf");
        let spec = json!({
            "blocks": [
                { "type": "cover", "title": "Quarterly report", "subtitle": "Sales", "meta": ["Draft"] },
                { "type": "heading", "text": "Summary" },
                { "type": "paragraph", "text": "Revenue grew while costs held." },
                { "type": "list", "items": ["one", "two"], "ordered": true },
                { "type": "table", "headers": ["Item", "Cost"], "rows": [["Pens", "1,200"], ["Ink", "300"]] },
                { "type": "caption", "text": "Table 1" },
                { "type": "pagebreak" },
                { "type": "quote", "text": "Plain words.", "attribution": "- Someone" },
                { "type": "stats", "items": [{ "value": "42", "label": "answers" }] },
                { "type": "callout", "label": "Note", "text": "Mind the gap." },
                { "type": "rule" }
            ],
            "properties": { "title": "Report", "footer": "Footer text" }
        });
        let result = write(&path, &spec).expect("written");
        assert_eq!(result["ok"], true);
        assert_eq!(result["pages"], 2);
        assert_eq!(result["pageNumbers"], true);
        assert_eq!(result["font"]["embedded"], false);
        assert!(result.get("flowedFields").is_none());
        let text = pages_text(&path);
        assert_eq!(text.len(), 2);
        assert!(text[0].contains("Quarterly report") && text[0].contains("Summary") && text[0].contains("Pens"));
        assert!(text[0].contains("1 / 2") && text[1].contains("2 / 2") && text[1].contains("Footer text"));
        assert!(text[1].contains("\u{2014} Someone") && text[1].contains("answers") && text[1].contains("Mind the gap."));
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn one_page_is_not_numbered_unless_asked() {
        let directory = scratch("numbering");
        let blocks = json!([{ "type": "paragraph", "text": "alone" }]);
        let plain = write(&directory.join("a.pdf"), &json!({ "blocks": blocks })).expect("written");
        assert_eq!((plain["pages"].clone(), plain["pageNumbers"].clone()), (json!(1), json!(false)));
        let asked = write(&directory.join("b.pdf"), &json!({ "blocks": blocks, "properties": { "pageNumbers": true } })).expect("written");
        assert_eq!(asked["pageNumbers"], true);
        let off = write(&directory.join("c.pdf"), &json!({ "blocks": [{ "type": "pagebreak" }], "properties": { "pageNumbers": false } })).expect("written");
        assert_eq!((off["pages"].clone(), off["pageNumbers"].clone()), (json!(2), json!(false)));
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn a_long_table_repeats_its_header_and_never_strands_a_row() {
        let directory = scratch("table");
        let path = directory.join("table.pdf");
        let rows: Vec<Value> = (1..=80).map(|row| json!([format!("Row {row}"), row * 10])).collect();
        let result = write(&path, &json!({ "blocks": [{ "type": "table", "headers": ["Name", "Value"], "rows": rows }] })).expect("written");
        let pages = result["pages"].as_u64().expect("pages");
        assert!(pages >= 3, "{pages}");
        let text = pages_text(&path);
        assert!(text.iter().all(|page| page.contains("Name") && page.contains("Value")));
        assert!(text.last().is_some_and(|page| page.contains("Row 80")));
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn a_block_list_with_faults_is_refused_before_a_file_is_written() {
        let directory = scratch("refused");
        let path = directory.join("never.pdf");
        let refused = write(&path, &json!({ "blocks": [{ "type": "table" }, { "type": "chart", "categories": ["a"], "values": [1, 2] }] })).unwrap_err();
        assert!(refused.message().starts_with("This PDF breaks 2 block contracts; fix them together."), "{refused}");
        assert!(!mixdog_testkit::exists(&path));
        let palette = write(&path, &json!({ "blocks": [], "properties": { "palette": { "accent": "red" } } })).unwrap_err();
        assert!(palette.message().starts_with("PDF palette is invalid: properties.palette.accent must be a 6-digit hex colour"), "{palette}");
        let colour = write(&path, &json!({ "blocks": [{ "type": "paragraph", "text": "x", "color": "nope" }] })).unwrap_err();
        assert_eq!(colour.message(), "Invalid PDF color: nope");
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn form_fields_flow_with_their_blocks_and_hand_placed_ones_keep_their_coordinates() {
        let directory = scratch("form");
        let path = directory.join("form.pdf");
        let spec = json!({
            "blocks": [
                { "type": "heading", "text": "Approval" },
                { "type": "fieldRow", "items": [
                    { "name": "who", "label": "Name" },
                    { "name": "when", "label": "Date", "fieldType": "dropdown", "options": ["Mon", "Tue"] }
                ] },
                { "type": "fieldRow", "items": [
                    { "name": "ok", "type": "checkbox", "label": "Agreed" },
                    { "name": "pick", "type": "radio", "label": "Choice", "options": [{ "value": "a", "label": "Alpha" }, { "value": "b", "label": "Beta" }] }
                ] }
            ],
            "fields": [{ "name": "stamp", "x": 72, "y": 72, "width": 100, "height": 20 }]
        });
        let result = write(&path, &spec).expect("written");
        assert_eq!(result["flowedFields"], 4);
        assert_eq!(result["form"]["ok"], true);
        assert_eq!(result["form"]["fields"].as_array().map(Vec::len), Some(5));
        let text = pages_text(&path).join(" ");
        assert!(text.contains("Name") && text.contains("Alpha") && text.contains("Beta") && text.contains("Agreed"));
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn a_form_with_an_unnamed_field_is_refused_with_the_lint_errors() {
        let directory = scratch("unnamed");
        let spec = json!({ "blocks": [], "fields": [{ "x": 72, "y": 72, "width": 100, "height": 20 }] });
        let refused = write(&directory.join("unnamed.pdf"), &spec).unwrap_err();
        assert_eq!(refused.message(), "PDF form layout is invalid: Form field name is required.");
        mixdog_testkit::remove_dir_all(&directory);
    }
    #[test]
    fn a_chart_pdf_is_cut_to_the_chart() {
        let directory = scratch("chart");
        let path = directory.join("chart.pdf");
        let block = json!({ "categories": ["North", "East"], "values": [1200, 800], "title": "Sales", "unit": "k", "highlight": "North" });
        let result = create_chart_pdf(&Unlaned, &FontEnv::default(), &path.to_string_lossy(), &block, 420.0, None).expect("written");
        assert_eq!(result["width"], 428);
        assert!(result["height"].as_f64().is_some_and(|height| height > 8.0));
        let text = pages_text(&path);
        assert_eq!(text.len(), 1);
        assert!(text[0].contains("Sales") && text[0].contains("1,200k") && text[0].contains("East"));
        let refused =
            create_chart_pdf(&Unlaned, &FontEnv::default(), &path.to_string_lossy(), &json!({ "categories": ["a"], "values": [] }), 420.0, None).unwrap_err();
        assert_eq!(refused.message(), "PDF block 1 (chart) values must be a non-empty array of numbers, zero or more.");
        mixdog_testkit::remove_dir_all(&directory);
    }
}

impl std::error::Error for WriterError {}
