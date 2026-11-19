//! The Word HTML route, second half (`authoring/docx-html-build.mjs`): the flow `measure_docx` read from the browser
//! becomes a native Word document. The page and the running lines go through the portable writer's own operations; the
//! body is WordprocessingML written block by block: paragraphs in their runs and spacing (paragraph properties in the
//! schema's order), tables on the grid the browser drew (data tables, rows of cards, boxes), lists on Word numbering,
//! and pictures. Every number is points; the body follows the page's text width, so a block the browser set 40 pt in
//! sits 40 pt in on the Word page.
//!
//! The flow is the JSON `measure_docx` hands over (`{ blocks, header, footer, body, notes, captures }`); it is read as it
//! is, so a flow recorded by Node builds the same document. The package is built in memory: [`build_docx_from_flow`]
//! answers its bytes and the notes of what was left out.

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use mixdog_fonts::registry::Registry;

use crate::link_target::safe_link;
use mixdog_fsio::ReadProof;
use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::math::round as js_round;
use mixdog_js::slice_utf16;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_office_base::values::truthy;
use mixdog_ooxml::blank::blank_parts;
use mixdog_ooxml::blank::kind_family;
use mixdog_ooxml::blank::package_of;
use mixdog_ooxml::docx::apply_docx;
use mixdog_ooxml::docx_parts::WordDrawing;
use mixdog_ooxml::docx_parts::add_document_image;
use mixdog_ooxml::docx_parts::ensure_numbering;
use mixdog_ooxml::docx_parts::word_drawing_xml;
use mixdog_ooxml::docx_styles::document_style_id;
use mixdog_ooxml::docx_xml::word_run_properties;
use mixdog_ooxml::docx_xml::word_text_content;
use mixdog_ooxml::opc::add_package_relationship;
use mixdog_ooxml::package::package_buffer;
use mixdog_ooxml::snapshot_docx::append_docx_block;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xml::xml_encode;
use mixdog_ooxml::zipio::Package;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const DOCUMENT_PART: &str = "word/document.xml";
const SIDES: [&str; 4] = ["top", "left", "bottom", "right"];

/// The sheet and margins of the Word page, in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DocxPage {
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// A picture a flow names by a `data:` URI, decoded: the runner writes it to a file (`add_document_image` reads files)
/// and hands the path back under `src`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlinePicture {
    pub src: String,
    /// `png`, `jpg` or `gif`.
    pub extension: String,
    pub bytes: Vec<u8>,
}

/// What a build answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltDocx {
    /// The package.
    pub bytes: Vec<u8>,
    /// What the measure and the build left out, one sentence each.
    pub notes: Vec<String>,
}

/// `Number(value || 0)` for a field of the flow; a field that is not a number reads as 0.
fn num(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

fn field(block: &Value, key: &str) -> f64 {
    num(block.get(key))
}

fn is_true(block: &Value, key: &str) -> bool {
    block.get(key).is_some_and(truthy)
}

fn text<'a>(block: &'a Value, key: &str) -> &'a str {
    block.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn array<'a>(block: &'a Value, key: &str) -> &'a [Value] {
    block.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

/// `Math.max(0, Math.round(Number(points || 0) * 20))`: points as twentieths.
fn tw(points: f64) -> i64 {
    js_round(points * 20.0).max(0.0) as i64
}

/// `Math.max(2, Math.min(96, Math.round(Number(points || 0.75) * 8)))`: a border's width in eighths of a point.
fn eighths(points: f64) -> i64 {
    let points = if points == 0.0 { 0.75 } else { points };
    js_round(points * 8.0).clamp(2.0, 96.0) as i64
}

fn border_style(style: &str) -> &'static str {
    match style {
        "dashed" => "dashed",
        "dotted" => "dotted",
        "double" => "double",
        _ => "single",
    }
}

fn border_element(tag: &str, border: &Value, space: f64) -> String {
    format!(
        "<w:{tag} w:val=\"{}\" w:sz=\"{}\" w:space=\"{}\" w:color=\"{}\"/>",
        border_style(text(border, "style")),
        eighths(field(border, "width")),
        js_round(space).clamp(0.0, 31.0) as i64,
        text(border, "color")
    )
}

fn shading(fill: &str) -> String {
    format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>")
}

/// `link` is given a run's `href` and returns the relationship id of its external hyperlink.
fn runs_xml(runs: &[Value], link: &mut dyn FnMut(&str) -> String) -> String {
    runs.iter()
        .map(|run| {
            if is_true(run, "br") {
                return "<w:r><w:br/></w:r>".to_owned();
            }
            let mut face = Map::new();
            let font = text(run, "font");
            if !font.is_empty() {
                face.insert("name".into(), json!(font));
            }
            let east_asia = text(run, "fontEastAsia");
            if !east_asia.is_empty() || !font.is_empty() {
                face.insert("nameEastAsia".into(), json!(if east_asia.is_empty() { font } else { east_asia }));
            }
            for key in ["size", "color"] {
                if let Some(value) = run.get(key).filter(|value| !value.is_null()) {
                    face.insert(key.into(), value.clone());
                }
            }
            for key in ["bold", "italic", "underline"] {
                if is_true(run, key) {
                    face.insert(key.into(), json!(true));
                }
            }
            let properties = [
                word_run_properties(&Value::Object(face)),
                if is_true(run, "strike") { "<w:strike/>".to_owned() } else { String::new() },
                if is_true(run, "shading") { shading(text(run, "shading")) } else { String::new() },
                if is_true(run, "vertAlign") { format!("<w:vertAlign w:val=\"{}\"/>", text(run, "vertAlign")) } else { String::new() },
            ]
            .concat();
            let rpr = if properties.is_empty() { String::new() } else { format!("<w:rPr>{properties}</w:rPr>") };
            let piece = format!("<w:r>{rpr}{}</w:r>", word_text_content(text(run, "text"), true));
            match safe_link(text(run, "href")) {
                None => piece,
                Some(href) => format!("<w:hyperlink r:id=\"{}\" w:history=\"1\">{piece}</w:hyperlink>", link(&href)),
            }
        })
        .collect()
}

/// A list item's Word numbering: the instance and the level.
struct Numbering {
    num_id: u64,
    level: Value,
}

/// Paragraph properties in the schema's order: style, keeps, break, numbering, borders, shading, spacing, indents,
/// justification.
fn paragraph_properties(block: &Value, style_id: &str, numbering: Option<&Numbering>, exact_line: bool) -> String {
    let mut parts = Vec::new();
    if !style_id.is_empty() {
        parts.push(format!("<w:pStyle w:val=\"{}\"/>", xml_encode(style_id)));
    }
    if is_true(block, "keepNext") {
        parts.push("<w:keepNext/>".to_owned());
    }
    if is_true(block, "keepLines") {
        parts.push("<w:keepLines/>".to_owned());
    }
    if is_true(block, "pageBreakBefore") {
        parts.push("<w:pageBreakBefore/>".to_owned());
    }
    if let Some(numbering) = numbering {
        parts.push(format!("<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>", numbering.level, numbering.num_id));
    }
    if let Some(borders) = block.get("borders").filter(|borders| truthy(borders)) {
        let drawn: Vec<String> = SIDES
            .iter()
            .filter(|side| borders.get(**side).is_some_and(truthy))
            .map(|side| {
                let space = block["borderSpace"].get(*side).filter(|space| !space.is_null()).map_or(1.0, |space| num(Some(space)));
                border_element(side, &borders[*side], space)
            })
            .collect();
        if !drawn.is_empty() {
            parts.push(format!("<w:pBdr>{}</w:pBdr>", drawn.concat()));
        }
    }
    if is_true(block, "shading") {
        parts.push(shading(text(block, "shading")));
    }
    let line = if exact_line && field(block, "line") > 0.0 { format!(" w:line=\"{}\" w:lineRule=\"exact\"", tw(field(block, "line"))) } else { String::new() };
    parts.push(format!("<w:spacing w:before=\"{}\" w:after=\"{}\"{line}/>", tw(field(block, "before")), tw(field(block, "after"))));
    let first_line = field(block, "firstLine");
    let first = if numbering.is_some() {
        let hanging = field(block, "indentLeft").max(0.0).min(18.0);
        if hanging != 0.0 { format!(" w:hanging=\"{}\"", tw(hanging)) } else { String::new() }
    } else if first_line > 0.0 {
        format!(" w:firstLine=\"{}\"", tw(first_line))
    } else if first_line < 0.0 {
        format!(" w:hanging=\"{}\"", tw(-first_line))
    } else {
        String::new()
    };
    if field(block, "indentLeft") != 0.0 || field(block, "indentRight") != 0.0 || !first.is_empty() {
        parts.push(format!("<w:ind w:left=\"{}\" w:right=\"{}\"{first}/>", tw(field(block, "indentLeft")), tw(field(block, "indentRight"))));
    }
    let align = text(block, "align");
    if !align.is_empty() && align != "left" {
        parts.push(format!("<w:jc w:val=\"{align}\"/>"));
    }
    format!("<w:pPr>{}</w:pPr>", parts.concat())
}

fn tiny_paragraph(height: f64, page_break_before: bool) -> String {
    format!(
        "<w:p><w:pPr>{}<w:spacing w:before=\"0\" w:after=\"0\" w:line=\"{}\" w:lineRule=\"exact\"/><w:rPr><w:sz w:val=\"2\"/><w:szCs w:val=\"2\"/></w:rPr></w:pPr></w:p>",
        if page_break_before { "<w:pageBreakBefore/>" } else { "" },
        tw(height)
    )
}

fn cell_borders(borders: Option<&Value>) -> String {
    let Some(borders) = borders.filter(|borders| truthy(borders)) else { return String::new() };
    let sides: String = SIDES
        .iter()
        .map(|side| match borders.get(*side).filter(|border| truthy(border)) {
            Some(border) => border_element(side, border, 0.0),
            None => format!("<w:{side} w:val=\"nil\"/>"),
        })
        .collect();
    format!("<w:tcBorders>{sides}</w:tcBorders>")
}

/// Only the side margins are the cell's: Word sets a row's text at its deepest top margin in every cell of the row, so a
/// card's padding pushed the unpadded column beside it down. The top and bottom padding become the space before the
/// cell's first block and after its last (`cell_blocks`).
fn cell_margins(padding: Option<&Value>) -> String {
    let Some(padding) = padding.filter(|padding| truthy(padding)) else { return String::new() };
    format!(
        "<w:tcMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"{}\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"{}\" w:type=\"dxa\"/></w:tcMar>",
        tw(field(padding, "left")),
        tw(field(padding, "right"))
    )
}

fn is_paragraph(block: Option<&Value>) -> bool {
    block.is_some_and(|block| !matches!(text(block, "kind"), "table" | "spacer"))
}

fn cell_blocks(cell: &Value) -> Vec<Value> {
    let mut blocks: Vec<Value> = array(cell, "blocks").to_vec();
    let top = cell["padding"].get("top").map_or(0.0, |top| num(Some(top)));
    let bottom = cell["padding"].get("bottom").map_or(0.0, |bottom| num(Some(bottom)));
    if top > 0.5 {
        if is_paragraph(blocks.first()) {
            let before = field(&blocks[0], "before") + top;
            blocks[0]["before"] = json!(before);
        } else {
            blocks.insert(0, json!({ "kind": "spacer", "height": top }));
        }
    }
    if bottom > 0.5 {
        if is_paragraph(blocks.last()) {
            let at = blocks.len() - 1;
            let after = field(&blocks[at], "after") + bottom;
            blocks[at]["after"] = json!(after);
        } else {
            blocks.push(json!({ "kind": "spacer", "height": bottom }));
        }
    }
    blocks
}

/// `/^data:image\/(png|jpe?g|gif);base64,(.+)$/i`: the extension (`jpeg` as `jpg`) and the payload.
fn inline_parts(src: &str) -> Option<(String, String)> {
    let pattern = JsRegex::new_static(r"^data:image\/(png|jpe?g|gif);base64,(.+)$", "i");
    let found = pattern.captures(src)?;
    let extension = js_to_lowercase(found.get(1)?).replace("jpeg", "jpg");
    Some((extension, found.get(2)?.to_owned()))
}

/// `Buffer.from(text, 'base64')`: the characters of either alphabet, padding and anything else ignored.
fn lenient_base64(encoded: &str) -> Vec<u8> {
    let mut clean: Vec<u8> = encoded
        .bytes()
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true));
    engine.decode(&clean).unwrap_or_default()
}

/// The pictures of the flow that are `data:` URIs and not captured elements, decoded, each source once.
pub fn inline_pictures(flow: &Value) -> Vec<InlinePicture> {
    fn walk(blocks: &[Value], found: &mut Vec<InlinePicture>) {
        for block in blocks {
            match text(block, "kind") {
                "image" if !is_true(block, "capture") => {
                    let src = text(block, "src");
                    if let Some((extension, payload)) = inline_parts(src) {
                        if !found.iter().any(|known| known.src == src) {
                            found.push(InlinePicture { src: src.to_owned(), extension, bytes: lenient_base64(&payload) });
                        }
                    }
                }
                "table" => {
                    for cell in array(block, "rows").iter().flat_map(|row| array(row, "cells")) {
                        walk(array(cell, "blocks"), found);
                    }
                }
                _ => {}
            }
        }
    }
    let mut found = Vec::new();
    walk(array(flow, "blocks"), &mut found);
    found
}

const HYPERLINK_RELATIONSHIP: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/// Writes a flow into the body of the document.
struct BodyWriter<'a, P: ReadProof> {
    proof: &'a P,
    zip: &'a mut Package,
    captures: &'a BTreeMap<usize, PathBuf>,
    inline: &'a BTreeMap<String, PathBuf>,
    notes: &'a mut Vec<String>,
    drawing_id: u64,
    lists: Vec<(String, u64)>,
    bullet: Option<u64>,
    heading_styles: BTreeMap<u64, String>,
}

impl<P: ReadProof> BodyWriter<'_, P> {
    fn numbering(&mut self, list: &Value) -> Numbering {
        let level = list.get("level").cloned().unwrap_or(Value::Null);
        if text(list, "kind") == "bullet" {
            let num_id = match self.bullet {
                Some(num_id) => num_id,
                None => {
                    let num_id = ensure_numbering(self.zip, "bullet", false).num_id;
                    self.bullet = Some(num_id);
                    num_id
                }
            };
            return Numbering { num_id, level };
        }
        let instance = list.get("instance").map(Value::to_string).unwrap_or_default();
        let num_id = match self.lists.iter().find(|(known, _)| *known == instance) {
            Some((_, num_id)) => *num_id,
            None => {
                let restart = !self.lists.is_empty();
                let num_id = ensure_numbering(self.zip, "number", restart).num_id;
                self.lists.push((instance, num_id));
                num_id
            }
        };
        Numbering { num_id, level }
    }

    fn heading_style(&mut self, level: u64) -> String {
        if !self.heading_styles.contains_key(&level) {
            let id = document_style_id(self.zip, &format!("Heading {level}"), "paragraph").id;
            self.heading_styles.insert(level, id);
        }
        self.heading_styles[&level].clone()
    }

    /// The file a picture is read from, or `None` for one that is left out.
    fn picture_path(&mut self, block: &Value) -> Result<Option<String>, String> {
        if is_true(block, "capture") {
            let capture = block["capture"].as_u64().unwrap_or(0) as usize;
            return Ok(self.captures.get(&capture).map(|path| path.display().to_string()));
        }
        let src = text(block, "src");
        if src.starts_with("file:") {
            let path = url::Url::parse(src).ok().and_then(|url| url.to_file_path().ok()).ok_or_else(|| format!("{src} is not a file URL"))?;
            return Ok(Some(path.display().to_string()));
        }
        if inline_parts(src).is_some() {
            return Ok(self.inline.get(src).map(|path| path.display().to_string()));
        }
        self.notes.push(format!("picture {} is not a local file or data: URI; it was left out", slice_utf16(src, 60)));
        Ok(None)
    }

    fn block(&mut self, block: &Value) -> Result<String, String> {
        match text(block, "kind") {
            "spacer" => Ok(tiny_paragraph(block.get("height").map_or(1.0, |height| num(Some(height))), false)),
            "table" => {
                // Word puts page breaks on paragraphs, not on tables.
                let before = if is_true(block, "pageBreakBefore") { tiny_paragraph(1.0, true) } else { String::new() };
                Ok(before + &self.table(block)?)
            }
            "image" => self.picture(block),
            _ => {
                let numbering = block.get("list").filter(|list| truthy(list)).map(|list| self.numbering(list));
                let heading = field(block, "heading");
                let style_id = if is_true(block, "heading") && heading <= 3.0 { self.heading_style(heading as u64) } else { String::new() };
                let zip = &mut *self.zip;
                let runs = runs_xml(array(block, "runs"), &mut |href| add_package_relationship(zip, "word/_rels/document.xml.rels", HYPERLINK_RELATIONSHIP, href, "External"));
                Ok(format!("<w:p>{}{}</w:p>", paragraph_properties(block, &style_id, numbering.as_ref(), true), runs))
            }
        }
    }

    fn picture(&mut self, block: &Value) -> Result<String, String> {
        let Some(path) = self.picture_path(block)? else { return Ok(String::new()) };
        let image = add_document_image(self.proof, self.zip, &path)?;
        self.drawing_id += 1;
        let drawing = word_drawing_xml(&WordDrawing {
            id: self.drawing_id,
            embed_id: &image.relationship_id,
            name: &image.name,
            width: field(block, "width"),
            height: field(block, "height"),
            alt_text: text(block, "alt"),
        });
        let mut own = block.clone();
        own["indentLeft"] = block.get("indent").cloned().unwrap_or(Value::Null);
        own["indentRight"] = json!(0);
        own["firstLine"] = json!(0);
        own["align"] = json!(if is_true(block, "align") { text(block, "align") } else { "left" });
        Ok(format!("<w:p>{}<w:r>{drawing}</w:r></w:p>", paragraph_properties(&own, "", None, false)))
    }

    fn blocks(&mut self, blocks: &[Value], keep_all: bool) -> Result<String, String> {
        let mut xml = String::new();
        for (index, block) in blocks.iter().enumerate() {
            let next = blocks.get(index + 1);
            // A short paragraph right before a table or picture is its title (그림 1. …, 표 1. …): it goes with it to the
            // next page, as Word keeps a caption with its table. keep_all holds a row's content to the row after it.
            let caption = text(block, "kind") == "p"
                && next.is_some_and(|next| matches!(text(next, "kind"), "table" | "image"))
                && array(block, "runs").iter().map(|run| run.get("text").and_then(Value::as_str).map_or(0, utf16_len)).sum::<usize>() <= 80;
            if keep_all || caption {
                let mut kept = block.clone();
                kept["keepNext"] = json!(true);
                xml.push_str(&self.block(&kept)?);
            } else {
                xml.push_str(&self.block(block)?);
            }
        }
        Ok(xml)
    }

    fn table(&mut self, table: &Value) -> Result<String, String> {
        let columns: Vec<f64> = array(table, "columns").iter().map(|width| num(Some(width))).collect();
        let total: f64 = columns.iter().sum();
        let mut properties = format!("<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", tw(total));
        if is_true(table, "indent") {
            properties.push_str(&format!("<w:tblInd w:w=\"{}\" w:type=\"dxa\"/>", tw(field(table, "indent"))));
        }
        let nil: String = SIDES.iter().chain(["insideH", "insideV"].iter()).map(|side| format!("<w:{side} w:val=\"nil\"/>")).collect();
        properties.push_str(&format!("<w:tblBorders>{nil}</w:tblBorders><w:tblLayout w:type=\"fixed\"/>"));
        let margins: String = SIDES.iter().map(|side| format!("<w:{side} w:w=\"0\" w:type=\"dxa\"/>")).collect();
        properties.push_str(&format!("<w:tblCellMar>{margins}</w:tblCellMar>"));
        let grid: String = columns.iter().map(|width| format!("<w:gridCol w:w=\"{}\"/>", tw(*width))).collect();
        // A short table (six rows or fewer), one asked to stay whole, or a layout grid moves to the next page whole: each
        // row's text keeps with the row after it. A long data table breaks between rows, its header repeated.
        let rows = array(table, "rows");
        let content_rows: Vec<usize> = (0..rows.len()).filter(|at| !is_true(&rows[*at], "spacer")).collect();
        let data = is_true(table, "data");
        let keep_together = is_true(table, "keepTogether");
        let keep_whole = !data || keep_together || content_rows.len() <= 6;
        let last_row = content_rows.last().copied();
        let mut written = Vec::new();
        for (at, row) in rows.iter().enumerate() {
            if is_true(row, "spacer") {
                let span = if columns.len() > 1 { format!("<w:gridSpan w:val=\"{}\"/>", columns.len()) } else { String::new() };
                written.push(format!(
                    "<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val=\"{}\" w:hRule=\"exact\"/></w:trPr><w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/>{span}</w:tcPr>{}</w:tc></w:tr>",
                    tw(field(row, "height")),
                    tw(total),
                    tiny_paragraph(1.0, false)
                ));
                continue;
            }
            // A layout row (cards) stays whole; a data table breaks between rows as Word breaks it, its header repeated.
            let height = to_number_of(row.get("height")) - 0.5;
            let mut row_properties = String::new();
            if !(data && !keep_together) {
                row_properties.push_str("<w:cantSplit/>");
            }
            if height > 1.0 {
                row_properties.push_str(&format!("<w:trHeight w:val=\"{}\" w:hRule=\"atLeast\"/>", tw(height)));
            }
            if is_true(row, "header") {
                row_properties.push_str("<w:tblHeader/>");
            }
            let mut cells = Vec::new();
            let mut column = 0_usize;
            for cell in array(row, "cells") {
                let span = cell.get("span").map_or(1.0, |span| num(Some(span))).max(0.0) as usize;
                let width: f64 = columns.iter().skip(column).take(span).sum();
                column += span;
                let mut cell_properties = format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", tw(width));
                if span > 1 {
                    cell_properties.push_str(&format!("<w:gridSpan w:val=\"{span}\"/>"));
                }
                cell_properties.push_str(&cell_borders(cell.get("borders")));
                if is_true(cell, "fill") {
                    cell_properties.push_str(&shading(text(cell, "fill")));
                }
                cell_properties.push_str(&cell_margins(cell.get("padding")));
                cell_properties.push_str(&format!("<w:vAlign w:val=\"{}\"/>", if is_true(cell, "vAlign") { text(cell, "vAlign") } else { "top" }));
                let mut content = if is_true(cell, "empty") || array(cell, "blocks").is_empty() {
                    tiny_paragraph(1.0, false)
                } else {
                    let blocks = cell_blocks(cell);
                    self.blocks(&blocks, keep_whole && Some(at) != last_row)?
                };
                if !content.ends_with("</w:p>") {
                    content.push_str(&tiny_paragraph(1.0, false));
                }
                cells.push(format!("<w:tc><w:tcPr>{cell_properties}</w:tcPr>{content}</w:tc>"));
            }
            let row_properties = if row_properties.is_empty() { String::new() } else { format!("<w:trPr>{row_properties}</w:trPr>") };
            written.push(format!("<w:tr>{row_properties}{}</w:tr>", cells.concat()));
        }
        Ok(format!("<w:tbl><w:tblPr>{properties}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{}</w:tbl>", written.concat()))
    }
}

/// The face a measured run or body names, as the writer's style and font operations take it.
fn face_of(source: &Value) -> Map<String, Value> {
    let mut face = Map::new();
    let font = text(source, "font");
    if !font.is_empty() {
        face.insert("name".into(), json!(font));
        let east_asia = text(source, "fontEastAsia");
        face.insert("nameEastAsia".into(), json!(if east_asia.is_empty() { font } else { east_asia }));
    }
    face
}

/// The running line and page numbers as the portable writer's own operations: a footer reading "{page} / {pages}" is the
/// page field and the total, "Page {page}" a prefix; `data-first-page="none"` leaves the cover without it.
fn running_operations(kind: &str, running: &Value) -> Vec<Value> {
    let words = text(running, "text");
    if words.is_empty() {
        return Vec::new();
    }
    let mut properties = face_of(running);
    for key in ["size", "color"] {
        if let Some(value) = running.get(key).filter(|value| !value.is_null()) {
            properties.insert(key.into(), value.clone());
        }
    }
    if is_true(running, "bold") {
        properties.insert("bold".into(), json!(true));
    }
    let alignment = running.get("align").filter(|align| !align.is_null()).cloned();
    if let Some(alignment) = &alignment {
        properties.insert("alignment".into(), alignment.clone());
    }
    let numbered = JsRegex::new_static(r"^(.*?)\{page\}(?:(.*?)\{pages\})?(.*)$", "");
    let mut operations = Vec::new();
    match numbered.captures(words) {
        Some(found) => {
            let mut op = Map::new();
            op.insert("op".into(), json!("add_page_numbers"));
            op.insert("kind".into(), json!(kind));
            op.insert("prefix".into(), json!(js_trim(found.get(1).unwrap_or_default())));
            match found.get(2) {
                Some(separator) => {
                    let separator = js_trim(separator);
                    op.insert("separator".into(), json!(if separator.is_empty() { "/" } else { separator }));
                    op.insert("includeTotal".into(), json!(true));
                }
                None => {
                    op.insert("includeTotal".into(), json!(false));
                }
            }
            if let Some(alignment) = alignment {
                op.insert("alignment".into(), alignment);
            }
            operations.push(Value::Object(op));
        }
        None => operations.push(json!({ "op": "set_header_footer", "kind": kind, "text": words, "properties": properties })),
    }
    if matches!(js_to_lowercase(text(running, "firstPage")).as_str(), "none" | "blank" | "hidden") {
        operations.push(json!({ "op": "set_header_footer", "kind": kind, "variant": "first", "text": "" }));
    }
    operations
}

/// The page, document font, styles and running lines of the flow as the operations that write them.
fn setup_operations(flow: &Value, page: &DocxPage) -> Vec<Value> {
    let first_heading = |level: u64| array(flow, "blocks").iter().find(|block| block.get("heading").is_some_and(|heading| heading.as_u64() == Some(level)) && !array(block, "runs").is_empty());
    let mut heading_styles = Map::new();
    for level in 1..=3_u64 {
        let Some(run) = first_heading(level).and_then(|block| array(block, "runs").iter().find(|run| is_true(run, "text"))) else { continue };
        let mut style = face_of(run);
        for key in ["size", "bold", "color"] {
            if let Some(value) = run.get(key).filter(|value| !value.is_null()) {
                style.insert(key.into(), value.clone());
            }
        }
        style.insert("keepWithNext".into(), json!(true));
        heading_styles.insert(format!("Heading {level}"), Value::Object(style));
    }
    let body = flow.get("body").filter(|body| truthy(body)).cloned().unwrap_or_else(|| json!({}));
    let face = face_of(&body);
    let mut font = face.clone();
    let mut normal = face;
    if is_true(&body, "size") {
        font.insert("size".into(), body["size"].clone());
        normal.insert("size".into(), body["size"].clone());
    }
    if is_true(&body, "color") {
        font.insert("color".into(), body["color"].clone());
    }
    normal.insert("spacingBefore".into(), json!(0));
    normal.insert("spacingAfter".into(), json!(0));
    normal.insert("alignment".into(), json!("left"));
    let mut styles = Map::new();
    styles.insert("Normal".into(), Value::Object(normal));
    styles.extend(heading_styles);
    let mut operations = vec![
        json!({
            "op": "set_page",
            "properties": {
                "pageWidth": page.width,
                "pageHeight": page.height,
                "topMargin": page.top,
                "rightMargin": page.right,
                "bottomMargin": page.bottom,
                "leftMargin": page.left,
            },
        }),
        json!({ "op": "set_document_font", "properties": font }),
        json!({ "op": "define_styles", "styles": styles }),
    ];
    operations.extend(running_operations("header", &flow["header"]));
    operations.extend(running_operations("footer", &flow["footer"]));
    operations
}

/// Writes the measured flow as a .docx. `captures` are the picture files of the captured elements (an SVG, a chart, a
/// canvas) by capture number; `inline` the files of the flow's `data:` pictures by source ([`inline_pictures`]). The
/// pictures are read through `proof`; `registry` holds the faces the Word batch measures in.
pub fn build_docx_from_flow<P: ReadProof>(
    proof: &P,
    registry: &Registry,
    flow: &Value,
    page: &DocxPage,
    captures: &BTreeMap<usize, PathBuf>,
    inline: &BTreeMap<String, PathBuf>,
    title: &str,
) -> Result<BuiltDocx, String> {
    let mut notes: Vec<String> = array(flow, "notes").iter().map(|note| note.as_str().map_or_else(|| note.to_string(), str::to_owned)).collect();
    let family = kind_family("docx").ok_or_else(|| "Portable Office creation does not support docx".to_owned())?;
    let parts = blank_parts(family, if title.is_empty() { "Untitled" } else { title }, "docx", "").unwrap_or_default();
    let mut zip = package_of(&parts);
    let measurer = TextMeasurer::new(proof, registry);
    apply_docx(proof, &measurer, &mut zip, &setup_operations(flow, page))?;
    let xml = {
        let mut writer = BodyWriter { proof, zip: &mut zip, captures, inline, notes: &mut notes, drawing_id: 1000, lists: Vec::new(), bullet: None, heading_styles: BTreeMap::new() };
        let blocks = array(flow, "blocks");
        let mut xml = writer.blocks(blocks, false)?;
        if xml.is_empty() {
            xml = tiny_paragraph(1.0, false);
        }
        // The body ends on a paragraph: a document that ends in a table gives Word nowhere to put the cursor.
        if xml.ends_with("</w:tbl>") {
            xml.push_str(&tiny_paragraph(1.0, false));
        }
        xml
    };
    let document = append_docx_block(&zip.text(DOCUMENT_PART), &xml)?;
    zip.set(DOCUMENT_PART, document);
    Ok(BuiltDocx { bytes: package_buffer(&zip)?, notes })
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    const PAGE: DocxPage = DocxPage { width: 595.3, height: 841.9, top: 56.7, right: 56.7, bottom: 56.7, left: 56.7 };

    fn paragraph(text: &str) -> Value {
        json!({ "kind": "p", "runs": [{ "text": text, "size": 11 }], "before": 0, "after": 8, "line": 17.6, "align": "left" })
    }

    /// The flow built; one without a body takes the 11 pt size the writer asks for (a body with no face, size or colour is
    /// refused, as Node refuses it).
    fn built(flow: &Value) -> (Package, Vec<String>) {
        let mut flow = flow.clone();
        if flow.get("body").is_none() {
            flow["body"] = json!({ "size": 11 });
        }
        let flow = &flow;
        let built = build_docx_from_flow(&Unlaned, &Registry::new(), flow, &PAGE, &BTreeMap::new(), &BTreeMap::new(), "Report").expect("a document");
        (Package::load(&built.bytes).expect("a package"), built.notes)
    }

    #[test]
    fn points_are_twentieths_and_borders_eighths() {
        assert_eq!(tw(10.0), 200);
        assert_eq!(tw(0.025), 1);
        assert_eq!(tw(-4.0), 0);
        assert_eq!(eighths(0.0), 6);
        assert_eq!(eighths(0.1), 2);
        assert_eq!(eighths(100.0), 96);
    }

    #[test]
    fn paragraph_properties_follow_the_schema_order() {
        let block = json!({
            "keepNext": true, "pageBreakBefore": true, "borders": { "left": { "style": "dashed", "width": 3, "color": "C2461A" } },
            "shading": "FDF1EC", "before": 2, "after": 4, "line": 16, "indentLeft": 8, "firstLine": -4, "align": "center",
        });
        let xml = paragraph_properties(&block, "Heading1", Some(&Numbering { num_id: 3, level: json!(1) }), true);
        let order: Vec<usize> = ["<w:pStyle", "<w:keepNext", "<w:pageBreakBefore", "<w:numPr>", "<w:pBdr>", "<w:shd", "<w:spacing", "<w:ind", "<w:jc"].iter().map(|tag| xml.find(tag).unwrap_or_else(|| panic!("{tag} in {xml}"))).collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{xml}");
        assert!(xml.contains("w:hanging=\"160\""), "a list item hangs by its indent: {xml}");
        assert!(xml.contains("w:w=\"nil\"") || xml.contains("w:val=\"dashed\" w:sz=\"24\" w:space=\"1\""), "{xml}");
    }

    #[test]
    fn a_picture_paragraph_keeps_its_line_and_takes_the_indent() {
        let block = json!({ "kind": "image", "indent": 12, "before": 3, "after": 3, "line": 20 });
        let mut own = block.clone();
        own["indentLeft"] = json!(12);
        let xml = paragraph_properties(&own, "", None, false);
        assert!(!xml.contains("w:line="));
        assert!(xml.contains("<w:ind w:left=\"240\" w:right=\"0\"/>"));
    }

    #[test]
    fn runs_carry_their_marks_and_a_break_is_a_run_of_its_own() {
        let xml = runs_xml(&[
            json!({ "text": "a", "font": "Georgia", "size": 11, "bold": true, "strike": true, "shading": "FFF2A8", "vertAlign": "superscript" }),
            json!({ "br": true }),
        ], &mut |_| unreachable!());
        assert!(xml.contains("<w:rFonts w:ascii=\"Georgia\" w:hAnsi=\"Georgia\" w:eastAsia=\"Georgia\"/>"), "{xml}");
        assert!(xml.contains("<w:strike/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"FFF2A8\"/><w:vertAlign w:val=\"superscript\"/>"), "{xml}");
        assert!(xml.ends_with("<w:r><w:br/></w:r>"));
    }

    #[test]
    fn a_linked_run_is_a_hyperlink_whose_relationship_targets_the_url() {
        let run = |label: &str, href: &str| json!({ "text": label, "size": 11, "href": href });
        let runs = json!([run("Alpha", "https://a.test/?x=1&y=2"), run("Beta", "mailto:b@b.test"), run("Evil", "javascript:alert(1)"), run("Plain", ""), run("Ctl", "https://ctl.test/a\u{1}")]);
        let cell_runs = json!([run("CellOne", "https://c.test/one"), run("CellTwo", "https://c.test/two"), run("CellEvil", "file:///c:/secret")]);
        let flow = json!({ "blocks": [
            { "kind": "p", "runs": runs, "before": 0, "after": 8, "line": 17.6, "align": "left" },
            { "kind": "table", "rows": [{ "cells": [{ "blocks": [{ "kind": "p", "runs": cell_runs, "before": 0, "after": 0, "line": 17.6, "align": "left" }] }] }] },
        ] });
        let (zip, _) = built(&flow);
        let rels = zip.text("word/_rels/document.xml.rels");
        let document = zip.text(DOCUMENT_PART);
        // The relationship a labelled run sits in a hyperlink of, resolved through the document's relationships.
        let target_of = |label: &str| -> Option<String> {
            let at = document.find(&format!(">{label}</w:t>")).unwrap_or_else(|| panic!("{label} in {document}"));
            let before = &document[..at];
            let open = before.rfind("<w:r>").expect("a run");
            if !before[..open].ends_with("w:history=\"1\">") {
                return None;
            }
            let id = before[..open].rsplit("<w:hyperlink r:id=\"").next()?.split('"').next()?;
            let rel = rels.split("<Relationship ").find(|rel| rel.contains(&format!("Id=\"{id}\""))).unwrap_or_else(|| panic!("{id} in {rels}"));
            assert!(rel.contains("relationships/hyperlink") && rel.contains("TargetMode=\"External\""), "{rel}");
            Some(rel.split("Target=\"").nth(1)?.split('"').next()?.to_owned())
        };
        assert_eq!(target_of("Alpha").as_deref(), Some("https://a.test/?x=1&amp;y=2"));
        assert_eq!(target_of("Beta").as_deref(), Some("mailto:b@b.test"));
        assert_eq!(target_of("CellOne").as_deref(), Some("https://c.test/one"));
        assert_eq!(target_of("CellTwo").as_deref(), Some("https://c.test/two"));
        for plain in ["Evil", "Plain", "CellEvil"] {
            assert_eq!(target_of(plain), None, "{plain}");
        }
        assert_eq!(target_of("Ctl").as_deref(), Some("https://ctl.test/a"));
        assert!(!rels.contains('\u{1}'), "the relationships stay valid XML");
        assert!(!rels.contains("javascript") && !rels.contains("secret"), "{rels}");
    }

    #[test]
    fn a_footer_of_page_and_pages_is_the_page_field_with_the_total() {
        let operations = running_operations("footer", &json!({ "text": "{page} / {pages}", "align": "center", "size": 9 }));
        assert_eq!(operations, vec![json!({ "op": "add_page_numbers", "kind": "footer", "prefix": "", "separator": "/", "includeTotal": true, "alignment": "center" })]);
        let prefixed = running_operations("footer", &json!({ "text": "Page {page}" }));
        assert_eq!(prefixed, vec![json!({ "op": "add_page_numbers", "kind": "footer", "prefix": "Page", "includeTotal": false })]);
    }

    #[test]
    fn a_header_is_text_and_none_leaves_the_cover_without_it() {
        let operations = running_operations("header", &json!({ "text": "운영 보고", "firstPage": "none", "font": "Malgun Gothic", "bold": true }));
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0]["properties"], json!({ "name": "Malgun Gothic", "nameEastAsia": "Malgun Gothic", "bold": true }));
        assert_eq!(operations[1], json!({ "op": "set_header_footer", "kind": "header", "variant": "first", "text": "" }));
        assert!(running_operations("header", &json!(null)).is_empty());
    }

    #[test]
    fn a_data_picture_is_decoded_once_and_other_sources_are_not_pictures() {
        let src = "data:image/jpeg;base64,AAEC\n";
        assert!(inline_parts(src).is_none(), "a payload with a line break does not match");
        let flow = json!({ "blocks": [
            { "kind": "image", "src": "data:image/jpeg;base64,AAEC" },
            { "kind": "table", "rows": [{ "cells": [{ "blocks": [{ "kind": "image", "src": "data:image/jpeg;base64,AAEC" }, { "kind": "image", "src": "data:image/PNG;base64,AAEC", "capture": 1 }] }] }] },
            { "kind": "image", "src": "https://example.org/a.png" },
        ] });
        let found = inline_pictures(&flow);
        assert_eq!(found, vec![InlinePicture { src: "data:image/jpeg;base64,AAEC".into(), extension: "jpg".into(), bytes: vec![0, 1, 2] }]);
    }

    #[test]
    fn a_body_with_no_face_size_or_colour_is_refused() {
        let refused = build_docx_from_flow(&Unlaned, &Registry::new(), &json!({ "blocks": [], "body": {} }), &PAGE, &BTreeMap::new(), &BTreeMap::new(), "");
        assert_eq!(refused.expect_err("refused"), "set_document_font needs properties.name, nameEastAsia, size, or color");
    }

    #[test]
    fn a_document_of_paragraphs_ends_on_one_and_a_table_gets_the_closing_paragraph() {
        let table = json!({ "kind": "table", "columns": [100, 100], "data": true, "rows": [
            { "height": 20, "header": true, "cells": [{ "span": 1, "blocks": [paragraph("a")] }, { "span": 1, "blocks": [paragraph("b")] }] },
        ] });
        let (package, notes) = built(&json!({ "blocks": [paragraph("Hello"), table], "notes": ["kept note"], "body": { "font": "Georgia", "size": 11 } }));
        assert_eq!(notes, vec!["kept note".to_owned()]);
        let document = package.text(DOCUMENT_PART);
        assert!(document.contains("<w:tblHeader/>"));
        assert!(document.contains("<w:pgSz w:w=\"11906\" w:h=\"16838\""), "{document}");
        assert!(document.find("</w:tbl>").expect("a table") < document.rfind("<w:p>").expect("a paragraph"));
    }

    #[test]
    fn an_empty_flow_is_one_tiny_paragraph() {
        let (package, _) = built(&json!({ "blocks": [] }));
        assert!(package.text(DOCUMENT_PART).contains("w:line=\"20\" w:lineRule=\"exact\""));
    }

    #[test]
    fn a_picture_that_is_not_local_is_left_out_with_a_note() {
        let (_, notes) = built(&json!({ "blocks": [{ "kind": "image", "src": "https://example.org/a.png", "width": 10, "height": 10 }] }));
        assert_eq!(notes, vec!["picture https://example.org/a.png is not a local file or data: URI; it was left out".to_owned()]);
    }

    #[test]
    fn a_short_title_before_a_table_keeps_with_it_and_a_short_table_keeps_its_rows_together() {
        let table = json!({ "kind": "table", "columns": [100], "data": true, "rows": [
            { "height": 20, "cells": [{ "span": 1, "blocks": [paragraph("r1")] }] },
            { "height": 20, "cells": [{ "span": 1, "blocks": [paragraph("r2")] }] },
        ] });
        let (package, _) = built(&json!({ "blocks": [paragraph("표 1. 처리량"), table] }));
        let document = package.text(DOCUMENT_PART);
        assert_eq!(document.matches("<w:keepNext/>").count(), 2, "the caption and the first row: {document}");
        assert!(document.contains("<w:trPr><w:trHeight w:val=\"390\" w:hRule=\"atLeast\"/></w:trPr>"), "a data table's row may split and is at least as tall as measured: {document}");
    }

    #[test]
    fn cell_padding_moves_to_the_space_around_the_blocks() {
        let cell = json!({ "padding": { "top": 10, "bottom": 6 }, "blocks": [{ "kind": "p", "before": 1, "after": 2, "runs": [] }] });
        let blocks = cell_blocks(&cell);
        assert_eq!((field(&blocks[0], "before"), field(&blocks[0], "after")), (11.0, 8.0));
        let table_cell = json!({ "padding": { "top": 4, "bottom": 4 }, "blocks": [{ "kind": "table" }] });
        let blocks = cell_blocks(&table_cell);
        assert_eq!(blocks.iter().map(|block| text(block, "kind")).collect::<Vec<_>>(), ["spacer", "table", "spacer"]);
    }
}
