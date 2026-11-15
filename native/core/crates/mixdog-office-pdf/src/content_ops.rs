//! `pdf/pdf-batch-content.mjs`: the batch operations that draw on or fill the document: text stamps and watermarks,
//! marks (`highlight`, `add_link`), images, OCR, and the form operations (`fill_form`, `add_form_field`,
//! `flatten_form`, `preview_fields`). The set implements [`OperationSet`] for the batch of [`crate::adapter`]; a mark
//! keeps the measurement of the text it was placed on for the next one (see [`crate::marks`]).
//!
//! Drawing on an existing page is what pdf-lib's `page.drawText`, `drawRectangle` and `drawImage` do: the page's own
//! content is wrapped in `q` ... `Q` the first time the batch draws on it (so an unbalanced stream cannot leak its
//! state into the stamp), the stamp is a content stream of its own appended after it, and the fonts, images and
//! graphics states it uses are named in the page's resources. A rotated page is stamped as the reader sees it: x and y
//! are points on the displayed page, mapped back into user space, and the run is turned by the page's own rotation so
//! the stamp reads with the page instead of lying sideways along an edge.

use std::any::Any;
use std::collections::HashSet;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex};

use mixdog_fsio::WriteProof;
use mixdog_js::math::{cos, sin, tan};
use mixdog_js::{js_to_lowercase, js_trim, json_number, number_to_string, to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_pdf::author::draw::{embed_image, parse_color};
use mixdog_pdf::embed::{
    EmbedError, Font, FontEnv, FontRequest, StandardFontName, SuffixRng, embed_document_font,
};
use mixdog_pdf::write::{PdfDocument, SaveOptions, flate_stream};
use mixdog_pdf::{Dict, Obj, Ref};
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use crate::adapter::{BatchState, OperationSet};
use crate::document::AnalysisError;
use crate::edit_document::{edit_error, js_string, load_pdf, page_spin, read_file, resolve_beside, selected_edit_pages, write_sibling};
use crate::flatten::flatten_form;
use crate::forms::{
    FormError, FormFont, PdfForm, add_form_field, clipped_form_values, field_text, field_widgets, fill_form_values,
    lint_pdf_form_fields, pdf_number,
};
use crate::marks::{MarkBox, Measure, display_point_to_user, report_boxes, target_boxes};
use crate::ocr::{OcrContext, ocr_pdf};

/// The operations this module runs.
const OPERATIONS: [&str; 10] = [
    "add_text",
    "watermark",
    "highlight",
    "add_link",
    "stamp_image",
    "ocr_pages",
    "fill_form",
    "add_form_field",
    "flatten_form",
    "preview_fields",
];

/// pdf-lib's default `lineHeight` of a page (`TL`), used between the lines of a stamp.
const LINE_HEIGHT: f64 = 24.0;

/// A page's size when `size` is not a usable number (`options.size || this.fontSize`).
const DEFAULT_FONT_SIZE: f64 = 24.0;

pub(crate) fn plain(message: impl Into<String>) -> AnalysisError {
    AnalysisError::plain(message)
}

pub(crate) fn form_error(error: FormError) -> AnalysisError {
    AnalysisError::plain(error.message())
}

pub(crate) fn embed_error(error: EmbedError) -> AnalysisError {
    AnalysisError::plain(error.to_string())
}

/// `Number(operation[key] ?? fallback)`.
fn number_or(operation: &Value, key: &str, fallback: f64) -> f64 {
    match operation.get(key) {
        Some(value) if !value.is_null() => to_number(value),
        _ => fallback,
    }
}

/// `operation[key] === undefined || null ? null : Number(operation[key])`.
fn optional_number(operation: &Value, key: &str) -> Option<f64> {
    operation.get(key).filter(|value| !value.is_null()).map(to_number)
}

/// `Number(operation[key] || fallback)`: a value JavaScript reads as false takes the fallback.
fn number_truthy_or(operation: &Value, key: &str, fallback: f64) -> f64 {
    match operation.get(key) {
        Some(value) if truthy(value) => to_number(value),
        _ => fallback,
    }
}

/// `String(operation[key] || '')`.
fn text_of(operation: &Value, key: &str) -> String {
    match operation.get(key) {
        Some(value) if truthy(value) => value_to_string(value),
        _ => String::new(),
    }
}

/// `color(value)` of pdf-draw: nothing (or anything JavaScript reads as false) is the fallback, black when that is empty.
fn colour_of(value: Option<&Value>, fallback: &str) -> Result<[f64; 3], AnalysisError> {
    let text = match value {
        Some(value) if truthy(value) => value_to_string(value),
        _ => fallback.to_owned(),
    };
    parse_color(&text).map_err(plain)
}

/// pdf-lib's `assertRangeOrUndefined(opacity, 'opacity.opacity', 0, 1)`.
fn assert_opacity(opacity: f64) -> Result<(), AnalysisError> {
    if opacity < 0.0 || opacity > 1.0 {
        return Err(plain(format!(
            "`opacity.opacity` must be at least 0 and at most 1, but was actually {}",
            number_to_string(opacity)
        )));
    }
    Ok(())
}

/// `cleanText` then `lineSplit` of pdf-lib: a tab and the Unicode line and paragraph separators become four spaces,
/// backspace and vertical tab go, and a line break of any kind starts a line.
fn text_lines(text: &str) -> Vec<String> {
    let mut cleaned = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\t' | '\u{85}' | '\u{2028}' | '\u{2029}' => cleaned.push_str("    "),
            '\u{8}' | '\u{b}' => {}
            other => cleaned.push(other),
        }
    }
    cleaned.split(['\n', '\u{c}', '\r']).map(str::to_owned).collect()
}

fn hex_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push('<');
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out.push('>');
    out
}

fn rgb_operands(color: [f64; 3]) -> String {
    format!("{} {} {}", pdf_number(color[0]), pdf_number(color[1]), pdf_number(color[2]))
}

/// The pages this call has already wrapped in `q` ... `Q`: pdf-lib does it once for a page's life.
#[derive(Debug, Default)]
pub struct Wrapped(Mutex<HashSet<i64>>);

impl Wrapped {
    /// Whether this is the first time the page is asked for.
    fn first_time(&self, page: Ref) -> bool {
        self.0.lock().map_or(true, |mut pages| pages.insert(page.num))
    }
}

/// The page's resources as they stand, inherited ones included (`Resources` is an inheritable attribute).
fn page_resources(document: &PdfDocument, page: Ref) -> Dict {
    let store = document.store();
    let mut current = page;
    for _ in 0..64 {
        let Some(dict) = store.dict(current) else { break };
        if let Some(found) = dict.get_raw("Resources").and_then(|raw| store.resolve(raw)).and_then(Obj::as_dict) {
            return (**found).clone();
        }
        match dict.get_raw("Parent").and_then(Obj::as_ref_value) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    Dict::new()
}

/// A copy of the dictionary under `key` of `resources` (a reference followed), empty when there is none.
fn sub_dictionary(document: &PdfDocument, resources: &Dict, key: &str) -> Dict {
    resources
        .get_raw(key)
        .and_then(|raw| document.store().resolve(raw))
        .and_then(Obj::as_dict)
        .map_or_else(Dict::new, |found| (**found).clone())
}

/// The page's `Contents` as a list of references, whatever form it was written in.
fn content_refs(document: &PdfDocument, page: Ref) -> Vec<Obj> {
    let store = document.store();
    let Some(raw) = store.dict(page).and_then(|dict| dict.get_raw("Contents")) else {
        return Vec::new();
    };
    match store.resolve(raw) {
        Some(Obj::Array(items)) => items.iter().cloned().collect(),
        Some(Obj::Stream(_)) => vec![raw.clone()],
        _ => Vec::new(),
    }
}

/// What is drawn on one page by one operation: the operators of a content stream and the resources they name.
pub(crate) struct PageInk {
    page: Ref,
    taken: HashSet<String>,
    content: String,
    fonts: Vec<(String, Ref)>,
    xobjects: Vec<(String, Ref)>,
    states: Vec<(String, Dict)>,
}

impl PageInk {
    pub(crate) fn new(document: &PdfDocument, page: Ref) -> Self {
        let resources = page_resources(document, page);
        let mut taken = HashSet::new();
        for group in ["Font", "XObject", "ExtGState"] {
            taken.extend(sub_dictionary(document, &resources, group).keys().map(str::to_owned));
        }
        PageInk { page, taken, content: String::new(), fonts: Vec::new(), xobjects: Vec::new(), states: Vec::new() }
    }

    fn fresh_name(&mut self, rng: &mut SuffixRng, prefix: &str) -> String {
        loop {
            let name = rng.name(prefix, 10);
            if self.taken.insert(name.clone()) {
                return name;
            }
        }
    }

    pub(crate) fn font(&mut self, rng: &mut SuffixRng, reference: Ref) -> String {
        if let Some((name, _)) = self.fonts.iter().find(|(_, held)| *held == reference) {
            return name.clone();
        }
        let name = self.fresh_name(rng, "Font");
        self.fonts.push((name.clone(), reference));
        name
    }

    pub(crate) fn xobject(&mut self, rng: &mut SuffixRng, prefix: &str, reference: Ref) -> String {
        let name = self.fresh_name(rng, prefix);
        self.xobjects.push((name.clone(), reference));
        name
    }

    /// An `ExtGState` of `maybeEmbedGraphicsState`: the fill opacity, and a blend mode when asked.
    fn state(&mut self, rng: &mut SuffixRng, opacity: f64, blend: Option<&str>) -> String {
        let name = self.fresh_name(rng, "GS");
        let mut state = Dict::new();
        state.set("Type", Obj::name("ExtGState"));
        state.set("ca", Obj::Num(opacity));
        if let Some(blend) = blend {
            state.set("BM", Obj::name(blend));
        }
        self.states.push((name.clone(), state));
        name
    }

    pub(crate) fn push(&mut self, operators: &str) {
        self.content.push_str(operators);
    }

    /// `drawLinesOfText`: the lines in one text object, turned by `rotate` (radians) about their start.
    fn draw_text(&mut self, lines: &[Vec<u8>], font: &str, size: f64, color: [f64; 3], rotate: f64, x: f64, y: f64, state: Option<&str>) {
        let mut ops = String::from("q\n");
        if let Some(state) = state {
            ops.push_str(&format!("/{state} gs\n"));
        }
        let (c, s) = (cos(rotate), sin(rotate));
        ops.push_str(&format!(
            "BT\n{} rg\n/{font} {} Tf\n{} TL\n{} {} {} {} {} {} Tm\n",
            rgb_operands(color),
            pdf_number(size),
            pdf_number(LINE_HEIGHT),
            pdf_number(c),
            pdf_number(s + tan(0.0)),
            pdf_number(-s + tan(0.0)),
            pdf_number(c),
            pdf_number(x),
            pdf_number(y),
        ));
        for line in lines {
            ops.push_str(&format!("{} Tj\nT*\n", hex_string(line)));
        }
        ops.push_str("ET\nQ\n");
        self.content.push_str(&ops);
    }

    /// `drawRectangle`: filled when it has a colour and a border, outlined when it has a border colour only.
    pub(crate) fn draw_rectangle(&mut self, x: f64, y: f64, width: f64, height: f64, fill: Option<[f64; 3]>, stroke: Option<[f64; 3]>, border_width: f64, state: Option<&str>) {
        let mut ops = String::from("q\n");
        if let Some(state) = state {
            ops.push_str(&format!("/{state} gs\n"));
        }
        if let Some(color) = fill {
            ops.push_str(&format!("{} rg\n", rgb_operands(color)));
        }
        if let Some(color) = stroke {
            ops.push_str(&format!("{} RG\n", rgb_operands(color)));
        }
        ops.push_str(&format!("{} w\n[] 0 d\n", pdf_number(border_width)));
        ops.push_str(&format!("1 0 0 1 {} {} cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n", pdf_number(x), pdf_number(y)));
        ops.push_str(&format!(
            "0 0 m\n0 {h} l\n{w} {h} l\n{w} 0 l\nh\n",
            w = pdf_number(width),
            h = pdf_number(height)
        ));
        let paint = if fill.is_some() && border_width != 0.0 {
            "B"
        } else if fill.is_some() {
            "f"
        } else if stroke.is_some() {
            "S"
        } else {
            "h"
        };
        ops.push_str(paint);
        ops.push_str("\nQ\n");
        self.content.push_str(&ops);
    }

    /// `drawImage`.
    fn draw_image(&mut self, name: &str, x: f64, y: f64, width: f64, height: f64, state: Option<&str>) {
        let mut ops = String::from("q\n");
        if let Some(state) = state {
            ops.push_str(&format!("/{state} gs\n"));
        }
        ops.push_str(&format!(
            "1 0 0 1 {} {} cm\n1 0 0 1 0 0 cm\n{} 0 0 {} 0 0 cm\n1 0 0 1 0 0 cm\n/{name} Do\nQ\n",
            pdf_number(x),
            pdf_number(y),
            pdf_number(width),
            pdf_number(height)
        ));
        self.content.push_str(&ops);
    }

    /// Writes the content and the resources into the page.
    pub(crate) fn commit(self, document: &mut PdfDocument, wrapped: &Wrapped) {
        if self.content.is_empty() {
            return;
        }
        let mut resources = page_resources(document, self.page);
        for (group, entries) in [
            ("Font", self.fonts.iter().map(|(name, reference)| (name.clone(), Obj::Ref(*reference))).collect::<Vec<_>>()),
            ("XObject", self.xobjects.iter().map(|(name, reference)| (name.clone(), Obj::Ref(*reference))).collect()),
            ("ExtGState", self.states.iter().map(|(name, state)| (name.clone(), Obj::Dict(Arc::new(state.clone())))).collect()),
        ] {
            let mut dict = sub_dictionary(document, &resources, group);
            for (name, value) in entries {
                dict.set(&name, value);
            }
            resources.set(group, Obj::Dict(Arc::new(dict)));
        }
        let existing = content_refs(document, self.page);
        let first = wrapped.first_time(self.page);
        let mut contents: Vec<Obj> = Vec::with_capacity(existing.len() + 3);
        if !existing.is_empty() && first {
            contents.push(Obj::Ref(stream_of(document, b"q\n")));
            contents.extend(existing);
            contents.push(Obj::Ref(stream_of(document, b"Q\n")));
        } else {
            contents.extend(existing);
        }
        contents.push(Obj::Ref(stream_of(document, self.content.as_bytes())));
        document.store_mut().modify_dict(self.page, |dict| {
            dict.set("Resources", Obj::Dict(Arc::new(resources)));
            dict.set("Contents", Obj::Array(Arc::new(contents)));
        });
    }
}

fn stream_of(document: &mut PdfDocument, bytes: &[u8]) -> Ref {
    document.store_mut().register(flate_stream(Dict::new(), bytes))
}

/// How a run of text is placed (`stamp` of `addText`).
struct Stamp<'a> {
    font: &'a Font,
    watermark: bool,
    align: &'a str,
    size: f64,
    opacity: f64,
    angle: f64,
    /// `stamp.color`, read as a colour where `drawText` reads it (after the run is measured, before its opacity).
    color: Option<&'a Value>,
    x: Option<f64>,
    y: Option<f64>,
}

/// The set of content operations of a batch. `ocr` and `cancel` are what `ocr_pages` reads from the call (`context`
/// of `applyPdfBatch`: the data folder and the signal); the fonts are what a document's font is chosen from.
pub struct ContentOperations {
    fonts: FontEnv,
    svg_fonts: SvgFonts,
    ocr: Option<OcrContext>,
    cancel: Option<CancellationToken>,
    wrapped: Wrapped,
}

impl ContentOperations {
    /// The set of one call. A set holds what the call has drawn on a page, so it is made for one batch.
    pub fn new(fonts: FontEnv, svg_fonts: SvgFonts, ocr: Option<OcrContext>, cancel: Option<CancellationToken>) -> Self {
        ContentOperations { fonts, svg_fonts, ocr, cancel, wrapped: Wrapped::default() }
    }
}

impl<P: WriteProof> OperationSet<P> for ContentOperations {
    fn supports(&self, op: &str) -> bool {
        OPERATIONS.contains(&op)
    }

    /// The mark operations: text positions measured for one stay valid across the next.
    fn keeps_measurement(&self, op: &str) -> bool {
        matches!(op, "highlight" | "add_link")
    }

    fn run(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        match js_string(operation.get("op")).as_str() {
            "add_text" | "watermark" => self.add_text(state, operation),
            "highlight" => self.highlight(state, operation),
            "add_link" => self.add_link(state, operation),
            "stamp_image" => self.stamp_image(state, operation),
            "ocr_pages" => self.ocr_pages(state, operation),
            "fill_form" => self.fill_form(state, operation),
            "add_form_field" => self.add_form_field(state, operation),
            "flatten_form" => self.flatten_form(state, operation),
            "preview_fields" => self.preview_fields(state, operation),
            other => Err(plain(format!("PDF backend does not support operation: {other}"))),
        }
    }
}

fn take_measure<P: WriteProof>(state: &mut BatchState<'_, P>) -> Option<Measure> {
    state.measure.take().and_then(|held| held.downcast::<Measure>().ok()).map(|held| *held)
}

/// `measureTargets`: the boxes of a mark, and the measurement kept for the next one.
fn measure_targets<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Vec<MarkBox>, AnalysisError> {
    let held = take_measure(state);
    let (boxes, measure) = target_boxes(state.proof, &state.document, operation, held)?;
    state.measure = measure.map(|measure| Box::new(measure) as Box<dyn Any + Send>);
    Ok(boxes)
}

/// The pages of the boxes, 1-based, each once, in the order they were first met.
fn pages_of(boxes: &[MarkBox]) -> Vec<Value> {
    let mut seen: Vec<usize> = Vec::new();
    for mark in boxes {
        if !seen.contains(&mark.index) {
            seen.push(mark.index);
        }
    }
    seen.into_iter().map(|index| json!(index + 1)).collect()
}

impl ContentOperations {
    /// `stampText`: one page's run of text, placed as the reader sees the page.
    fn stamp_text(&self, document: &PdfDocument, ink: &mut PageInk, rng: &mut SuffixRng, font_name: &str, page: Ref, text: &str, stamp: &Stamp<'_>) -> Result<(), AnalysisError> {
        let text_width = stamp.font.width_of_text_at_size(text, stamp.size).map_err(embed_error)?;
        let spin = page_spin(document, page);
        let media = document.media_box(page).map_err(edit_error)?;
        let (width, height) = (media.width, media.height);
        let upright = spin % 180 == 0;
        let display_width = if upright { width } else { height };
        let display_height = if upright { height } else { width };
        let angle = stamp.angle * PI / 180.0;
        let span_x = text_width * cos(angle);
        let span_y = text_width * sin(angle);
        let default_x = match stamp.align {
            "center" => (display_width - span_x) / 2.0,
            "right" => display_width - 36.0 - span_x,
            _ => 36.0,
        };
        let mut display_x = stamp.x.unwrap_or(default_x);
        let mut display_y = stamp.y.unwrap_or(if stamp.watermark { (display_height - span_y) / 2.0 } else { 36.0 });
        if stamp.x.is_some() {
            // With x, align puts the run's centre or right end there: the start at x ignored the align asked for, and
            // a footer centred at the page's middle ran off to the right by half its width.
            let share = match stamp.align {
                "center" => 0.5,
                "right" => 1.0,
                _ => 0.0,
            };
            display_x -= share * span_x;
            if stamp.y.is_some() {
                display_y -= share * span_y;
            }
        } else if stamp.watermark && stamp.y.is_none() {
            // The glyphs' middle on the page's centre, not their baseline: a 45 degree mark sat a third of its size up
            // and to the left. Latin capitals and Hangul stand about 0.7 em.
            let lift = 0.35 * stamp.size;
            display_x += lift * sin(angle);
            display_y -= lift * cos(angle);
        }
        let (x, y) = display_point_to_user(spin, width, height, display_x, display_y);
        let color = colour_of(stamp.color, "")?;
        assert_opacity(stamp.opacity)?;
        let state = ink.state(rng, stamp.opacity, None);
        let lines = text_lines(text)
            .iter()
            .map(|line| stamp.font.encode_text(line).map_err(embed_error))
            .collect::<Result<Vec<_>, _>>()?;
        let size = if stamp.size.is_nan() || stamp.size == 0.0 { DEFAULT_FONT_SIZE } else { stamp.size };
        ink.draw_text(&lines, font_name, size, color, (stamp.angle + spin as f64) * PI / 180.0, x, y, Some(&state));
        Ok(())
    }

    fn add_text<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let op = js_string(operation.get("op"));
        let watermark = op == "watermark";
        let template = match operation.get("text") {
            Some(text) if !text.is_null() => value_to_string(text),
            _ => String::new(),
        };
        if js_trim(&template).is_empty() {
            return Err(plain(format!("{op} needs text")));
        }
        let font_path = text_of(operation, "fontPath");
        let chosen = embed_document_font(
            state.proof,
            &self.fonts,
            &FontRequest { font_path: &font_path, text: &template, standard: StandardFontName::Helvetica },
        )
        .map_err(embed_error)?;
        let align = match operation.get("align") {
            Some(value) if truthy(value) => js_to_lowercase(&value_to_string(value)),
            _ => (if watermark { "center" } else { "left" }).to_owned(),
        };
        if !["left", "center", "right"].contains(&align.as_str()) {
            return Err(plain(format!("{op} align must be left, center, or right")));
        }
        let stamp = Stamp {
            font: &chosen.font,
            watermark,
            align: &align,
            size: number_or(operation, "size", if watermark { 48.0 } else { 12.0 }),
            opacity: number_or(operation, "opacity", if watermark { 0.25 } else { 1.0 }),
            angle: number_or(operation, "rotation", if watermark { 45.0 } else { 0.0 }),
            color: operation.get("color"),
            x: optional_number(operation, "x"),
            y: optional_number(operation, "y"),
        };
        let page_count = state.document.page_count();
        let mut rng = SuffixRng::default();
        let font_ref = state.document.store_mut().next_ref();
        let mut pages: Vec<Value> = Vec::new();
        for selected in selected_edit_pages(&state.document, operation)? {
            // {page} and {pages} number an existing file the way create's pageNumbers does.
            let text = template.replace("{page}", &(selected.index + 1).to_string()).replace("{pages}", &page_count.to_string());
            let mut ink = PageInk::new(&state.document, selected.page);
            let font_name = ink.font(&mut rng, font_ref);
            self.stamp_text(&state.document, &mut ink, &mut rng, &font_name, selected.page, &text, &stamp)?;
            ink.commit(&mut state.document, &self.wrapped);
            pages.push(json!(selected.index + 1));
        }
        // The text is encoded before the font is written: an embedded face keeps only the glyphs that were encoded.
        chosen.font.embed_into(state.document.store_mut(), Some(font_ref), &mut rng).map_err(embed_error)?;
        let mut row = Map::new();
        row.insert("op".to_owned(), json!(op));
        row.insert("changed".to_owned(), json!(!pages.is_empty()));
        row.insert("pages".to_owned(), Value::Array(pages));
        row.insert("fontEmbedded".to_owned(), json!(chosen.embedded));
        if !chosen.font_path.is_empty() {
            row.insert("fontPath".to_owned(), json!(chosen.font_path));
        }
        Ok(Value::Object(row))
    }

    fn highlight<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let boxes = measure_targets(state, operation)?;
        let fill = colour_of(
            operation.get("color"),
            "ffeb3b",
        )?;
        let opacity = number_or(operation, "opacity", 0.45);
        assert_opacity(opacity)?;
        let refs = state.document.pages();
        let mut rng = SuffixRng::default();
        let mut inks: Vec<(usize, PageInk)> = Vec::new();
        for mark in &boxes {
            let at = match inks.iter().position(|(index, _)| *index == mark.index) {
                Some(at) => at,
                None => {
                    let page = *refs.get(mark.index).ok_or_else(|| plain(format!("PDF page out of range: {}", mark.index + 1)))?;
                    inks.push((mark.index, PageInk::new(&state.document, page)));
                    inks.len() - 1
                }
            };
            let ink = &mut inks[at].1;
            // Multiply keeps the glyphs under the mark legible, the way a marker pen does.
            let gs = ink.state(&mut rng, opacity, Some("Multiply"));
            ink.draw_rectangle(mark.x - 1.0, mark.y - 1.0, mark.width + 2.0, mark.height + 2.0, Some(fill), None, 0.0, Some(&gs));
        }
        for (_, ink) in inks {
            ink.commit(&mut state.document, &self.wrapped);
        }
        let mut row = Map::new();
        row.insert("op".to_owned(), json!(js_string(operation.get("op"))));
        row.insert("changed".to_owned(), json!(true));
        row.insert("marks".to_owned(), json!(boxes.len()));
        row.insert("pages".to_owned(), Value::Array(pages_of(&boxes)));
        if operation.get("find").is_some_and(truthy) {
            row.insert("find".to_owned(), json!(text_of(operation, "find")));
        }
        row.insert("boxes".to_owned(), report_boxes(&boxes));
        Ok(Value::Object(row))
    }

    fn add_link<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let auto_urls = operation.get("urls") == Some(&Value::Bool(true));
        let url = match operation.get("url") {
            Some(value) if !value.is_null() => js_trim(&value_to_string(value)).to_owned(),
            _ => String::new(),
        };
        let to_page = optional_number(operation, "toPage");
        if url.is_empty() && to_page.is_none() && !auto_urls {
            return Err(plain("add_link needs url, toPage, or urls:true"));
        }
        if !url.is_empty() && !has_link_scheme(&url) {
            return Err(plain(format!("add_link url must start with http://, https://, or mailto: ({url})")));
        }
        if let Some(page) = to_page {
            selected_edit_pages(&state.document, &json!({ "page": json_number(page) }))?;
        }
        // urls:true finds every http(s) address in the text and points each at itself.
        let request = if auto_urls {
            let mut changed = operation.clone();
            if let Some(map) = changed.as_object_mut() {
                map.insert("find".to_owned(), json!("https?://[^\\s<>()\"']+"));
                map.insert("regex".to_owned(), json!(true));
                map.insert("wholeWord".to_owned(), json!(false));
            }
            changed
        } else {
            operation.clone()
        };
        let boxes = match measure_targets(state, &request) {
            Ok(boxes) => boxes,
            Err(error) if auto_urls && error.message.contains("found no text matching") => {
                return Err(plain("add_link urls:true found no http(s) address in the selected pages; pass find or a box instead"));
            }
            Err(error) => return Err(error),
        };
        let refs = state.document.pages();
        // The destination page is looked up after measuring, on the document the links go into.
        let destination = match to_page {
            None => None,
            Some(page) => Some(destination_of(&refs, page)?),
        };
        let link_url = |mark: &MarkBox| -> String {
            if auto_urls {
                mark.text.as_deref().unwrap_or_default().trim_end_matches(['.', ',', ';', ':', '!', '?']).to_owned()
            } else {
                url.clone()
            }
        };
        for mark in &boxes {
            let page = *refs.get(mark.index).ok_or_else(|| plain(format!("PDF page out of range: {}", mark.index + 1)))?;
            let href = link_url(mark);
            let mut annotation = Dict::new();
            annotation.set("Type", Obj::name("Annot"));
            annotation.set("Subtype", Obj::name("Link"));
            annotation.set(
                "Rect",
                Obj::Array(Arc::new(vec![
                    Obj::Num(mark.x),
                    Obj::Num(mark.y),
                    Obj::Num(mark.x + mark.width),
                    Obj::Num(mark.y + mark.height),
                ])),
            );
            annotation.set("Border", Obj::Array(Arc::new(vec![Obj::Num(0.0), Obj::Num(0.0), Obj::Num(0.0)])));
            if href.is_empty() {
                annotation.set("Dest", destination.clone().unwrap_or(Obj::Null));
            } else {
                let mut action = Dict::new();
                action.set("Type", Obj::name("Action"));
                action.set("S", Obj::name("URI"));
                action.set("URI", crate::forms::latin1_object(&href));
                annotation.set("A", Obj::Dict(Arc::new(action)));
            }
            let store = state.document.store_mut();
            let reference = store.register(Obj::Dict(Arc::new(annotation)));
            crate::forms::push_array(store, page, "Annots", Obj::Ref(reference));
        }
        let mut row = Map::new();
        row.insert("op".to_owned(), json!(js_string(operation.get("op"))));
        row.insert("changed".to_owned(), json!(true));
        row.insert("links".to_owned(), json!(boxes.len()));
        row.insert("pages".to_owned(), Value::Array(pages_of(&boxes)));
        if auto_urls {
            row.insert("urls".to_owned(), Value::Array(boxes.iter().map(|mark| json!(link_url(mark))).collect()));
        } else if !url.is_empty() {
            row.insert("url".to_owned(), json!(url));
        } else {
            row.insert("toPage".to_owned(), to_page.map_or(Value::Null, json_number));
        }
        row.insert("boxes".to_owned(), report_boxes(&boxes));
        Ok(Value::Object(row))
    }

    fn stamp_image<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let image_path = resolve_beside(state.path, &text_of(operation, "path")).to_string_lossy().into_owned();
        let placed = embed_image(state.proof, state.document.store_mut(), &self.svg_fonts, &image_path).map_err(embed_error)?;
        let (natural_width, natural_height) = (f64::from(placed.width), f64::from(placed.height));
        let mut rng = SuffixRng::default();
        let mut pages: Vec<Value> = Vec::new();
        for selected in selected_edit_pages(&state.document, operation)? {
            let media = state.document.media_box(selected.page).map_err(edit_error)?;
            // Pixels become points one-to-one, so a photo would run off the page; keep it inside the margins unless sized.
            let width = number_truthy_or(operation, "width", natural_width.min(media.width - 72.0));
            let height = number_truthy_or(operation, "height", natural_height * width / natural_width);
            let opacity = number_or(operation, "opacity", 1.0);
            assert_opacity(opacity)?;
            let mut ink = PageInk::new(&state.document, selected.page);
            let name = ink.xobject(&mut rng, "Image", placed.reference);
            let gs = ink.state(&mut rng, opacity, None);
            ink.draw_image(
                &name,
                number_truthy_or(operation, "x", 0.0),
                number_truthy_or(operation, "y", 0.0),
                width,
                height,
                Some(&gs),
            );
            ink.commit(&mut state.document, &self.wrapped);
            pages.push(json!(selected.index + 1));
        }
        Ok(json!({
            "op": js_string(operation.get("op")),
            "changed": !pages.is_empty(),
            "pages": pages,
            "image": image_path,
        }))
    }

    /// `ocrPages`: the document is saved, the pages are read, and the batch continues on a reload of the file.
    fn ocr_pages<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let Some(context) = self.ocr.as_ref() else {
            return Err(plain("PDF OCR is not available in this call: no OCR context was given"));
        };
        let bytes = state.document.save(SaveOptions::default());
        state.note.note_write(state.path);
        mixdog_fsio::write(state.proof, state.path, &bytes).map_err(|error| plain(error.to_string()))?;
        // The batch runs as a blocking job; the recognition is async work, so it runs on a runtime of its own.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| plain(error.to_string()))?;
        let result = runtime.block_on(ocr_pdf(context, state.path, operation, self.cancel.clone()))?;
        state.document = load_pdf(&read_file(state.proof, state.path)?, false)?;
        Ok(result)
    }

    fn fill_form<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let mut form = PdfForm::new();
        let values = operation.get("values").unwrap_or(&Value::Null);
        let filled = fill_form_values(&mut form, &mut state.document, values).map_err(form_error)?;
        let coverage = coverage_of(values);
        let font_path = text_of(operation, "fontPath");
        let chosen = embed_document_font(
            state.proof,
            &self.fonts,
            &FontRequest { font_path: &font_path, text: &coverage, standard: StandardFontName::Helvetica },
        )
        .map_err(embed_error)?;
        let reference = state.document.store_mut().next_ref();
        let face = FormFont { font: chosen.font.clone(), reference };
        form.update_field_appearances(&mut state.document, Some(&face)).map_err(form_error)?;
        // The appearances exist now, so the values can be measured against the boxes that will show them before the
        // document is handed on.
        let clipped = clipped_form_values(&form, &mut state.document, values, Some(&face.font)).map_err(form_error)?;
        let flatten = operation.get("flatten").is_some_and(truthy);
        if flatten {
            flatten_form(&mut form, &mut state.document, &self.wrapped)?;
        }
        chosen.font.embed_into(state.document.store_mut(), Some(reference), &mut SuffixRng::default()).map_err(embed_error)?;
        let mut row = Map::new();
        row.insert("op".to_owned(), json!(js_string(operation.get("op"))));
        row.insert("changed".to_owned(), json!(!filled.is_empty()));
        row.insert("filled".to_owned(), json!(filled));
        row.insert("flattened".to_owned(), json!(flatten));
        row.insert("fontEmbedded".to_owned(), json!(chosen.embedded));
        if !chosen.font_path.is_empty() {
            row.insert("fontPath".to_owned(), json!(chosen.font_path));
        }
        if !clipped.is_empty() {
            let messages: Vec<String> = clipped.iter().map(|entry| value_to_string(&entry["message"])).collect();
            let warning = format!("{} value(s) do not fit their field box: {}", clipped.len(), messages.join(" "));
            row.insert("clipped".to_owned(), Value::Array(clipped));
            row.insert("warning".to_owned(), json!(warning));
        }
        Ok(Value::Object(row))
    }

    fn add_form_field<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let sizes: Vec<[f64; 2]> = state
            .document
            .pages()
            .into_iter()
            .map(|page| state.document.media_box(page).map(|media| [media.width, media.height]).map_err(edit_error))
            .collect::<Result<_, _>>()?;
        // The lint adopts the field into the shape the writer draws, in place, as the source does.
        let mut field = [operation.clone()];
        let check = lint_pdf_form_fields(&mut field, &sizes);
        if check["ok"] != Value::Bool(true) {
            let messages: Vec<String> =
                check["issues"].as_array().into_iter().flatten().map(|issue| value_to_string(&issue["message"])).collect();
            return Err(plain(messages.join(" ")));
        }
        let [field] = field;
        let font_path = text_of(&field, "fontPath");
        let chosen = embed_document_font(
            state.proof,
            &self.fonts,
            &FontRequest { font_path: &font_path, text: &field_text(&field), standard: StandardFontName::Helvetica },
        )
        .map_err(embed_error)?;
        let reference = state.document.store_mut().next_ref();
        let face = FormFont { font: chosen.font.clone(), reference };
        let mut form = PdfForm::new();
        add_form_field(&mut form, &mut state.document, &field, Some(&face)).map_err(form_error)?;
        form.update_field_appearances(&mut state.document, Some(&face)).map_err(form_error)?;
        chosen.font.embed_into(state.document.store_mut(), Some(reference), &mut SuffixRng::default()).map_err(embed_error)?;
        let kind = if truthy_field(&field, "type") { js_to_lowercase(&js_string(field.get("type"))) } else { "text".to_owned() };
        Ok(json!({
            "op": js_string(operation.get("op")),
            "changed": true,
            "name": field.get("name").cloned().unwrap_or(Value::Null),
            "type": kind,
        }))
    }

    fn flatten_form<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let mut form = PdfForm::new();
        let count = form.fields(&mut state.document).map_err(form_error)?.len();
        let font_path = text_of(operation, "fontPath");
        let mut embedded: Option<(Font, Ref)> = None;
        if !font_path.is_empty() {
            let chosen = embed_document_font(
                state.proof,
                &self.fonts,
                &FontRequest { font_path: &font_path, text: "", standard: StandardFontName::Helvetica },
            )
            .map_err(embed_error)?;
            let reference = state.document.store_mut().next_ref();
            let face = FormFont { font: chosen.font.clone(), reference };
            form.update_field_appearances(&mut state.document, Some(&face)).map_err(form_error)?;
            embedded = Some((chosen.font, reference));
        }
        flatten_form(&mut form, &mut state.document, &self.wrapped)?;
        if let Some((font, reference)) = embedded {
            font.embed_into(state.document.store_mut(), Some(reference), &mut SuffixRng::default()).map_err(embed_error)?;
        }
        Ok(json!({ "op": js_string(operation.get("op")), "changed": count > 0, "fields": count }))
    }

    /// A copy with every field's box outlined and named, and any box the caller proposes, so a render shows placement
    /// before a fill. The session document is left as it is.
    fn preview_fields<P: WriteProof>(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        let output = js_trim(&text_of(operation, "output")).to_owned();
        if output.is_empty() {
            return Err(plain("preview_fields needs output (a file name beside the document)"));
        }
        let bytes = state.document.save(SaveOptions::default());
        let mut copy = load_pdf(&bytes, false)?;
        let mut form = PdfForm::new();
        let fields = form.fields(&mut copy).map_err(form_error)?;
        let proposed: Vec<Value> = match operation.get("boxes") {
            Some(Value::Array(boxes)) => boxes.clone(),
            _ => Vec::new(),
        };
        let mut names: Vec<String> = fields.iter().map(|field| crate::forms::field_name(copy.store(), field.reference)).collect();
        names.extend(proposed.iter().map(|entry| label_of(entry, String::new())));
        let labels = names.join(" ");
        let text = format!("{labels} box 0123456789");
        let chosen = embed_document_font(
            state.proof,
            &self.fonts,
            &FontRequest { font_path: "", text: &text, standard: StandardFontName::Helvetica },
        )
        .map_err(embed_error)?;
        let reference = copy.store_mut().next_ref();
        let ink_color = colour_of(None, "d32f2f")?;
        let wrapped = Wrapped::default();
        let mut rng = SuffixRng::default();
        let pages = copy.pages();
        let mut widgets = 0usize;
        let mut outline = |copy: &mut PdfDocument, page: Ref, rect: [f64; 4], label: &str| -> Result<(), AnalysisError> {
            let mut ink = PageInk::new(copy, page);
            let font_name = ink.font(&mut rng, reference);
            ink.draw_rectangle(rect[0], rect[1], rect[2], rect[3], None, Some(ink_color), 1.0, None);
            let lines = text_lines(label).iter().map(|line| chosen.font.encode_text(line).map_err(embed_error)).collect::<Result<Vec<_>, _>>()?;
            ink.draw_text(&lines, &font_name, 7.0, ink_color, 0.0, rect[0], rect[1] + rect[3] + 2.0, None);
            ink.commit(copy, &wrapped);
            Ok(())
        };
        for (index, field) in fields.iter().enumerate() {
            for widget in field_widgets(&copy, field) {
                if widget.page == 0 {
                    continue;
                }
                let name = crate::forms::field_name(copy.store(), field.reference);
                let page = *pages.get(widget.page - 1).ok_or_else(|| plain(format!("PDF page out of range: {}", widget.page)))?;
                outline(&mut copy, page, [widget.x, widget.y, widget.width, widget.height], &format!("{} {name}", index + 1))?;
                widgets += 1;
            }
        }
        for (index, entry) in proposed.iter().enumerate() {
            let rect = ["x", "y", "width", "height"].map(|key| to_number_of(entry.get(key)));
            if !entry.get("page").is_some_and(truthy) || rect.iter().any(|value| !value.is_finite()) {
                return Err(plain(format!("preview_fields boxes[{index}] needs page, x, y, width, height")));
            }
            let selected = selected_edit_pages(&copy, &json!({ "page": entry["page"] }))?;
            outline(&mut copy, selected[0].page, rect, &label_of(entry, format!("box {}", index + 1)))?;
        }
        // The appearances a form has not drawn yet are drawn when it is saved.
        form.update_field_appearances(&mut copy, None).map_err(form_error)?;
        chosen.font.embed_into(copy.store_mut(), Some(reference), &mut SuffixRng::default()).map_err(embed_error)?;
        let written = write_sibling(state.proof, state.note, state.path, &output, &copy.save(SaveOptions::default()))?;
        Ok(json!({
            "op": js_string(operation.get("op")),
            "changed": true,
            "documentChanged": false,
            "output": written.to_string_lossy(),
            "fields": fields.len(),
            "widgets": widgets,
            "boxes": proposed.len(),
        }))
    }
}

/// `/^(https?:\/\/|mailto:)/i`.
fn has_link_scheme(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
}

/// `[document.getPage(toPage - 1).ref, 'XYZ', null, null, null]`.
fn destination_of(pages: &[Ref], to_page: f64) -> Result<Obj, AnalysisError> {
    let index = to_page - 1.0;
    let last = pages.len() as f64 - 1.0;
    if index < 0.0 || index > last {
        return Err(plain(format!(
            "`index` must be at least 0 and at most {}, but was actually {}",
            number_to_string(last),
            number_to_string(index)
        )));
    }
    let Some(page) = (index.fract() == 0.0).then(|| pages[index as usize]) else {
        return Err(plain("Cannot read properties of undefined (reading 'ref')"));
    };
    Ok(Obj::Array(Arc::new(vec![Obj::Ref(page), Obj::name("XYZ"), Obj::Null, Obj::Null, Obj::Null])))
}

/// `String(box.label ?? fallback)`.
fn label_of(entry: &Value, fallback: String) -> String {
    match entry.get("label") {
        Some(label) if !label.is_null() => value_to_string(label),
        _ => fallback,
    }
}

fn truthy_field(field: &Value, key: &str) -> bool {
    field.get(key).is_some_and(truthy)
}

/// `Object.values(values || {}).flat().map((value) => String(value ?? '')).join(' ')`: every string a fill writes, so
/// the font chosen covers it.
fn coverage_of(values: &Value) -> String {
    let items: Vec<&Value> = match values {
        Value::Object(map) => map.values().collect(),
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    };
    let mut parts: Vec<String> = Vec::new();
    for item in items {
        let flat: Vec<&Value> = match item {
            Value::Array(inner) => inner.iter().collect(),
            other => vec![other],
        };
        parts.extend(flat.into_iter().map(|value| if value.is_null() { String::new() } else { value_to_string(value) }));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_office_base::write_note::NoWriteNote;

    #[test]
    fn text_is_cleaned_and_split_as_pdf_lib_does() {
        assert_eq!(text_lines("a\tb"), ["a    b"]);
        assert_eq!(text_lines("a\r\nb\nc\u{c}d"), ["a", "", "b", "c", "d"]);
        assert_eq!(text_lines("x\u{8}y\u{b}z"), ["xyz"]);
    }

    #[test]
    fn an_opacity_outside_zero_to_one_is_refused_in_pdf_libs_words() {
        assert!(assert_opacity(0.0).is_ok() && assert_opacity(1.0).is_ok());
        assert_eq!(
            assert_opacity(1.5).expect_err("range").message,
            "`opacity.opacity` must be at least 0 and at most 1, but was actually 1.5"
        );
        assert!(assert_opacity(-0.1).is_err());
    }

    #[test]
    fn a_link_needs_one_of_the_three_schemes() {
        assert!(has_link_scheme("https://a.test") && has_link_scheme("HTTP://a.test") && has_link_scheme("mailto:a@b.test"));
        assert!(!has_link_scheme("ftp://a.test") && !has_link_scheme("file:///etc/passwd") && !has_link_scheme(" https://a"));
    }

    #[test]
    fn a_destination_is_the_page_by_its_number() {
        let pages = [Ref::new(4, 0), Ref::new(9, 0)];
        let Obj::Array(items) = destination_of(&pages, 2.0).expect("destination") else { panic!("an array") };
        assert_eq!(items[0].as_ref_value(), Some(Ref::new(9, 0)));
        assert!(items[1].is_name("XYZ") && matches!(items[2], Obj::Null));
        assert_eq!(
            destination_of(&pages, 0.0).expect_err("range").message,
            "`index` must be at least 0 and at most 1, but was actually -1"
        );
        assert!(destination_of(&pages, 3.0).is_err());
    }

    #[test]
    fn the_fill_coverage_flattens_one_level_and_blanks_the_missing() {
        assert_eq!(coverage_of(&json!({ "a": "x", "b": ["y", null, 3], "c": null })), "x y  3 ");
        assert_eq!(coverage_of(&Value::Null), "");
    }

    fn batch_document() -> PdfDocument {
        let mut document = PdfDocument::create_at(0);
        document.add_page(200.0, 100.0).expect("page");
        document.add_page(100.0, 200.0).expect("page");
        document
    }

    fn set() -> ContentOperations {
        ContentOperations::new(FontEnv::default(), SvgFonts::none(), None, None)
    }

    fn run(document: PdfDocument, operation: Value) -> (PdfDocument, Result<Value, AnalysisError>) {
        let set = set();
        let mut state = BatchState {
            proof: &mixdog_fsio::Unlaned,
            note: &NoWriteNote,
            path: std::path::Path::new("doc.pdf"),
            source: &[],
            document,
            replaced: false,
            measure: None,
        };
        let result = <ContentOperations as OperationSet<mixdog_fsio::Unlaned>>::run(&set, &mut state, &operation);
        (state.document, result)
    }

    fn page_content(document: &PdfDocument, page: Ref) -> String {
        let store = document.store();
        let Some(Obj::Array(contents)) = store.dict(page).and_then(|dict| store.lookup(dict, "Contents")) else {
            return String::new();
        };
        contents
            .iter()
            .filter_map(|entry| document.decode_stream(entry.as_ref_value()?, &mixdog_pdf::codec_glue::CodecFilters, &mixdog_pdf::Guard::unbounded()).ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<Vec<_>>()
            .join("")
    }

    #[test]
    fn a_stamp_on_every_page_numbers_it_and_turns_with_a_rotated_page() {
        let mut document = batch_document();
        let pages = document.pages();
        document.set_rotation(pages[1], 90.0).expect("rotate");
        let (document, result) = run(document, json!({ "op": "add_text", "text": "p{page}/{pages}", "x": 10, "y": 20 }));
        let row = result.expect("a stamp");
        assert_eq!(row["pages"], json!([1, 2]));
        assert_eq!(row["changed"], json!(true));
        assert_eq!(row["fontEmbedded"], json!(false));
        let first = page_content(&document, pages[0]);
        assert!(first.contains("1 0 0 1 10 20 Tm"), "{first}");
        // On the page turned 90 degrees the displayed point (10, 20) is user point (width - y, x) = (80, 10) and the
        // run is turned by the page's own rotation.
        let second = page_content(&document, pages[1]);
        assert!(second.contains(" 80 10 Tm"), "{second}");
    }

    #[test]
    fn a_watermark_is_centred_and_a_missing_text_is_refused() {
        let (document, result) = run(batch_document(), json!({ "op": "watermark", "text": "DRAFT", "page": 1 }));
        assert_eq!(result.expect("a watermark")["pages"], json!([1]));
        assert!(page_content(&document, document.pages()[0]).contains("Tm"));
        let (_, refused) = run(batch_document(), json!({ "op": "add_text", "text": "  " }));
        assert_eq!(refused.expect_err("no text").message, "add_text needs text");
        let (_, refused) = run(batch_document(), json!({ "op": "add_text", "text": "x", "align": "middle" }));
        assert_eq!(refused.expect_err("bad align").message, "add_text align must be left, center, or right");
        let (_, refused) = run(batch_document(), json!({ "op": "watermark", "text": "x", "opacity": 2 }));
        assert!(refused.expect_err("opacity").message.contains("opacity.opacity"));
    }

    #[test]
    fn a_highlight_by_box_is_multiplied_and_a_link_by_box_is_an_annotation() {
        let (document, result) = run(
            batch_document(),
            json!({ "op": "highlight", "page": 1, "x": 10, "y": 20, "width": 30, "height": 8, "color": "#ff0000" }),
        );
        let row = result.expect("a highlight");
        assert_eq!(row["marks"], json!(1));
        assert_eq!(row["pages"], json!([1]));
        assert_eq!(row["boxes"][0]["page"], json!(1));
        let content = page_content(&document, document.pages()[0]);
        assert!(content.contains("1 0 0 rg") && content.contains("9 19") && content.contains("32 10"), "{content}");
        let (document, result) = run(
            document,
            json!({ "op": "add_link", "url": "https://example.test/x", "page": 1, "x": 1, "y": 2, "width": 3, "height": 4 }),
        );
        let row = result.expect("a link");
        assert_eq!(row["links"], json!(1));
        assert_eq!(row["url"], json!("https://example.test/x"));
        assert_eq!(document.page_annotations(document.pages()[0]).len(), 1);
    }

    #[test]
    fn a_link_names_what_it_needs_and_refuses_a_scheme_it_does_not_open() {
        let (_, refused) = run(batch_document(), json!({ "op": "add_link", "page": 1, "x": 1, "y": 2, "width": 3, "height": 4 }));
        assert_eq!(refused.expect_err("needs a target").message, "add_link needs url, toPage, or urls:true");
        let (_, refused) = run(batch_document(), json!({ "op": "add_link", "url": "ftp://x", "page": 1, "x": 1, "y": 2, "width": 3, "height": 4 }));
        assert_eq!(refused.expect_err("scheme").message, "add_link url must start with http://, https://, or mailto: (ftp://x)");
        let (document, result) =
            run(batch_document(), json!({ "op": "add_link", "toPage": 2, "page": 1, "x": 1, "y": 2, "width": 3, "height": 4 }));
        assert_eq!(result.expect("an internal link")["toPage"], json!(2));
        assert_eq!(document.page_annotations(document.pages()[0]).len(), 1);
    }

    #[test]
    fn the_preview_needs_an_output_and_a_proposed_box_needs_its_numbers() {
        let (_, refused) = run(batch_document(), json!({ "op": "preview_fields" }));
        assert_eq!(refused.expect_err("output").message, "preview_fields needs output (a file name beside the document)");
        let (_, refused) = run(
            batch_document(),
            json!({ "op": "preview_fields", "output": "never-written-preview.pdf", "boxes": [{ "page": 1, "x": 1 }] }),
        );
        assert_eq!(refused.expect_err("box").message, "preview_fields boxes[0] needs page, x, y, width, height");
    }

    #[test]
    fn an_ocr_without_a_context_says_so_before_it_writes() {
        let (_, refused) = run(batch_document(), json!({ "op": "ocr_pages" }));
        assert!(refused.expect_err("no context").message.contains("OCR"));
    }

    #[test]
    fn an_operation_of_another_set_is_not_this_ones() {
        let set = set();
        assert!(<ContentOperations as OperationSet<mixdog_fsio::Unlaned>>::supports(&set, "watermark"));
        assert!(!<ContentOperations as OperationSet<mixdog_fsio::Unlaned>>::supports(&set, "rotate_pages"));
        assert!(<ContentOperations as OperationSet<mixdog_fsio::Unlaned>>::keeps_measurement(&set, "highlight"));
        assert!(!<ContentOperations as OperationSet<mixdog_fsio::Unlaned>>::keeps_measurement(&set, "add_text"));
    }
}
