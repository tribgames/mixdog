//! The page cursor of the writer and the text-family blocks (`createFlow`, `keepTogether`, `drawLines`, the prose, list,
//! cover, callout, quote, caption, rule, stats and image blocks and `flowBlocks` of `pdf-writer.mjs`).
//!
//! A unit that does not fit moves whole to the next page unless it already sits at the top, where it flows on the
//! per-line guard instead. A heading travels with the first unit of what it opens; a paragraph that meets the foot of a
//! page leaves at least two lines there and carries at least two over; a list never leaves one item alone at a page
//! edge; a caption travels with the table, picture or chart it names.

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_fsio::ReadProof;
use mixdog_js::math::{floor, max, min, round};
use mixdog_js::{is_js_space, js_to_lowercase, js_trim, json_stringify, nodepath, value_to_string};
use mixdog_pdf::author::draw::{EmbeddedImage, embed_image, parse_color};
use mixdog_pdf::author::wrap::wrap_text;
use mixdog_pdf::write::PdfDocument;
use mixdog_raster::svg::SvgFonts;
use serde_json::{Map, Value};

use super::blocks::{block_type, is_truthy, items_of, num, num_nn, num_or, text_of, text_or, truthy};
use super::{Canvas, Face, RectStyle, WriterError, WriterResult, charts, fields, new_canvas, tables};

/// Word's own heading sizes over the 11 pt body (the ladder the Word writer's anatomy sets).
pub const HEADING_SIZES: [f64; 3] = [16.0, 13.0, 12.0];

/// The document's own neutrals and accent: the fallback when `properties.palette` names none.
const INK: [(&str, &str); 4] = [("muted", "6B7280"), ("accent", "1F6F8B"), ("field", "EEF2F7"), ("line", "C9CED6")];

/// The roles of a palette: a callout field, a quote rule and a caption read as one system without naming a hex.
#[derive(Debug, Clone)]
pub struct Ink {
    pub muted: String,
    pub accent: String,
    pub field: String,
    pub line: String,
}

fn default_ink() -> Ink {
    let role = |name: &str| INK.iter().find(|(key, _)| *key == name).map(|(_, hex)| (*hex).to_owned()).unwrap_or_default();
    Ink { muted: role("muted"), accent: role("accent"), field: role("field"), line: role("line") }
}

fn palette_keys() -> String {
    INK.iter().map(|(key, _)| *key).collect::<Vec<_>>().join(", ")
}

fn six_hex(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `resolvePalette(palette)`: the palette with the roles it overrides, and whether it was given at all.
pub fn resolve_palette(palette: Option<&Value>) -> WriterResult<(Ink, bool)> {
    let map = match palette {
        None | Some(Value::Null) => return Ok((default_ink(), false)),
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(WriterError::new(format!(
                "PDF properties.palette must be an object {{ {} }} of 6-digit hex colours.",
                palette_keys()
            )));
        }
    };
    let mut faults = Vec::new();
    for key in mixdog_js::js_object_keys(map) {
        let value = map.get(key).unwrap_or(&Value::Null);
        match INK.iter().find(|(role, _)| *role == key.as_str()) {
            None => faults.push(format!("properties.palette.{key} is not a palette role (use {}).", palette_keys())),
            Some((_, example)) => {
                if !six_hex(&value_to_string(value)) {
                    faults.push(format!(
                        "properties.palette.{key} must be a 6-digit hex colour without '#' (for example \"{example}\"), got {}.",
                        json_stringify(value)
                    ));
                }
            }
        }
    }
    if !faults.is_empty() {
        return Err(WriterError::new(format!("PDF palette is invalid: {}", faults.join(" "))));
    }
    let mut ink = default_ink();
    for key in map.keys() {
        let value = value_to_string(&map[key]);
        match key.as_str() {
            "muted" => ink.muted = value,
            "accent" => ink.accent = value,
            "field" => ink.field = value,
            _ => ink.line = value,
        }
    }
    Ok((ink, true))
}

/// The horizontal box a text-family block writes into: its own x/width, else the page body between the margins.
#[derive(Debug, Clone, Copy)]
pub struct TextBox {
    pub left: f64,
    pub width: f64,
}

/// The pictures a block list places: where they are read from and the embeddings already made.
pub struct Pictures<'a, P: ReadProof> {
    pub proof: &'a P,
    pub fonts: &'a SvgFonts,
    pub base_dir: &'a str,
}

/// The page cursor the block renderers share: the pages so far, the baseline `y` still free on the last one, and the
/// document they are written into.
pub struct Flow {
    pub document: PdfDocument,
    pub pages: Vec<Canvas>,
    pub margin: f64,
    pub font: Arc<Face>,
    pub bold: Arc<Face>,
    pub y: f64,
    pub resolved_fields: Vec<Value>,
    pub ink: Ink,
    pub custom_palette: bool,
    size: [f64; 2],
    background: Option<String>,
    images: HashMap<usize, EmbeddedImage>,
}

impl Flow {
    /// `createFlow(document, { size, margin, font, bold, background, palette })`: the first page is open.
    pub fn new(
        document: PdfDocument,
        size: [f64; 2],
        margin: f64,
        font: Face,
        bold: Face,
        background: Option<&Value>,
        palette: Option<&Value>,
    ) -> WriterResult<Flow> {
        let (ink, custom_palette) = resolve_palette(palette)?;
        let mut flow = Flow {
            document,
            pages: Vec::new(),
            margin,
            font: Arc::new(font),
            bold: Arc::new(bold),
            y: 0.0,
            resolved_fields: Vec::new(),
            ink,
            custom_palette,
            size,
            background: background.filter(|value| truthy(value)).map(value_to_string),
            images: HashMap::new(),
        };
        flow.new_page()?;
        Ok(flow)
    }

    /// `flow.newPage()`: the next page with the document background, the cursor under the top margin.
    pub fn new_page(&mut self) -> WriterResult<()> {
        let canvas = new_canvas(&mut self.document, self.size[0], self.size[1])?;
        self.pages.push(canvas);
        if let Some(background) = &self.background {
            let color = parse_color(background)?;
            let (width, height) = (self.page_width(), self.page_height());
            self.page().draw_rectangle(&RectStyle { x: 0.0, y: 0.0, width, height, color: Some(color), ..RectStyle::default() });
        }
        self.y = self.page_height() - self.margin;
        Ok(())
    }

    /// The page being drawn (a flow always has one).
    pub fn page(&mut self) -> &mut Canvas {
        let last = self.pages.len() - 1;
        &mut self.pages[last]
    }

    pub fn page_width(&self) -> f64 {
        self.size[0]
    }

    pub fn page_height(&self) -> f64 {
        self.size[1]
    }

    /// `atTop(flow)`.
    pub fn at_top(&self) -> bool {
        self.y >= self.page_height() - self.margin
    }

    /// `keepTogether(flow, height)`: a unit that does not fit moves whole to the next page, unless it already sits at the
    /// top.
    pub fn keep_together(&mut self, height: f64) -> WriterResult<()> {
        if self.y - height < self.margin && !self.at_top() {
            self.new_page()?;
        }
        Ok(())
    }

    /// `textBox(flow, block)`.
    pub fn text_box(&self, block: &Value) -> TextBox {
        TextBox { left: num_nn(block.get("x"), self.margin), width: num_or(block.get("width"), self.page_width() - self.margin * 2.0) }
    }
}

// ---- measuring --------------------------------------------------------------------------------------------------------

/// `wrapText(text, font, size, width)`.
pub fn wrap(face: &Face, text: &str, size: f64, width: f64) -> WriterResult<Vec<String>> {
    Ok(wrap_text(text, width, |piece| face.width(piece, size))?)
}

/// `linesHeight(font, text, size, width, lh)`: the room the wrapped text takes.
pub fn lines_height(face: &Face, text: &str, size: f64, width: f64, line_height: f64) -> WriterResult<f64> {
    Ok(wrap(face, text, size, max(8.0, width))?.len() as f64 * line_height)
}

/// `captionHeight(following, font, width)`: a caption names what the table, picture or chart before it shows, so it is
/// measured with the last row: on its own it landed at the top of the next page, citing what the reader had turned
/// away from.
pub fn caption_height(following: Option<&Value>, face: &Face, width: f64) -> WriterResult<f64> {
    let Some(following) = following else { return Ok(0.0) };
    if js_to_lowercase(&text_or(following.get("type"), "")) != "caption" {
        return Ok(0.0);
    }
    let size = num_or(following.get("size"), 8.5);
    let lines = wrap(face, &text_of(following.get("text")), size, max(8.0, width))?;
    Ok(lines.len() as f64 * size * 1.35 + num_nn(following.get("after"), 10.0))
}

/// `spaceBefore(block, type)`: space above a block is flow, not decoration. The gap is dropped at the top of a page,
/// where there is nothing to separate from.
fn space_before(block: &Value, kind: &str) -> f64 {
    let asked = num(block.get("before"));
    if asked.is_finite() {
        return max(0.0, asked);
    }
    // A quote is set apart from what it follows as from what follows it, and a chart under a paragraph sat on its last
    // line.
    if kind == "quote" || kind == "chart" {
        return 6.0;
    }
    if kind != "heading" {
        return 0.0;
    }
    round(num_or(block.get("size"), heading_size(block)) * 0.8)
}

/// `HEADING_SIZES[level]` for the level a block declares (1 to 3).
pub fn heading_size(block: &Value) -> f64 {
    let level = heading_level(block);
    if level.fract() == 0.0 { HEADING_SIZES[level as usize - 1] } else { f64::NAN }
}

fn heading_level(block: &Value) -> f64 {
    let declared = num(block.get("level"));
    let declared = if declared.is_nan() || declared == 0.0 { 1.0 } else { declared };
    min(3.0, max(1.0, declared))
}

// ---- lines ------------------------------------------------------------------------------------------------------------

/// What `drawLines` is asked for beside the text and its size.
pub struct LineOpts {
    pub line_height: f64,
    pub x: Option<f64>,
    pub width: Option<f64>,
    pub tint: String,
    pub face: Option<Arc<Face>>,
    pub widows: bool,
}

impl LineOpts {
    pub fn new(line_height: f64, tint: impl Into<String>) -> Self {
        Self { line_height, x: None, width: None, tint: tint.into(), face: None, widows: false }
    }
}

/// `drawLines(flow, box, text, size, opts)`: lines of one role at one x, the shared way a cover's title, a quote and a
/// caption put words down. With `widows`, a paragraph that meets the foot of a page leaves at least two lines there and
/// carries at least two over; one of three lines or fewer moves whole.
pub fn draw_lines(flow: &mut Flow, text_box: TextBox, text: &str, size: f64, opts: &LineOpts) -> WriterResult<()> {
    let face = opts.face.clone().unwrap_or_else(|| flow.font.clone());
    let x = opts.x.unwrap_or(text_box.left);
    let width = opts.width.unwrap_or(text_box.width);
    let tint = parse_color(&opts.tint)?;
    let lh = opts.line_height;
    let lines = wrap(&face, text, size, max(8.0, width))?;
    let mut split_at: i64 = -1;
    let room = floor((flow.y - flow.margin) / lh + 1e-6);
    if opts.widows && !flow.at_top() && room < lines.len() as f64 {
        if room < 2.0 || lines.len() <= 3 {
            flow.new_page()?;
        } else if (lines.len() as f64) - room < 2.0 {
            split_at = room as i64 - 1;
        }
    }
    for (index, line) in lines.iter().enumerate() {
        if index as i64 == split_at || flow.y - lh < flow.margin {
            flow.new_page()?;
        }
        let y = flow.y - size;
        flow.page().draw_text(line, x, y, size, &face, tint)?;
        flow.y -= lh;
    }
    Ok(())
}

/// `drawRule(flow, box, thickness, tint)`.
fn draw_rule(flow: &mut Flow, text_box: TextBox, thickness: f64, tint: &str) -> WriterResult<()> {
    let color = parse_color(tint)?;
    let y = flow.y;
    flow.page().draw_line([text_box.left, y], [text_box.left + text_box.width, y], thickness, color);
    Ok(())
}

fn draw_rule_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    if flow.y - 2.0 < flow.margin {
        flow.new_page()?;
    }
    let tint = text_or(block.get("color"), &flow.ink.line);
    draw_rule(flow, text_box, num_or(block.get("thickness"), 0.6), &tint)?;
    flow.y -= num_nn(block.get("after"), 12.0);
    Ok(())
}

/// Eyebrow, title, subtitle and meta lines, one rule under the group: the title block of a report's first page, not a
/// page of its own.
fn draw_cover_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    let size = num_or(block.get("size"), 26.0);
    let accent = text_or(block.get("accent"), &flow.ink.accent);
    let ink = text_or(block.get("color"), "");
    if is_truthy(block.get("eyebrow")) {
        draw_lines(flow, text_box, &text_of(block.get("eyebrow")), 9.5, &LineOpts::new(14.0, accent.clone()))?;
        flow.y -= 4.0;
    }
    let mut title = LineOpts::new(size * 1.2, ink.clone());
    title.face = Some(flow.bold.clone());
    draw_lines(flow, text_box, &text_of(block.get("title")), size, &title)?;
    if is_truthy(block.get("subtitle")) {
        flow.y -= 6.0;
        let subtitle_size = num_or(block.get("subtitleSize"), 13.0);
        let tint = text_or(block.get("color"), "374151");
        draw_lines(flow, text_box, &text_of(block.get("subtitle")), subtitle_size, &LineOpts::new(subtitle_size * 1.4, tint))?;
    }
    let meta = items_of(block.get("meta"));
    if !meta.is_empty() {
        flow.y -= 8.0;
        for line in meta {
            let muted = flow.ink.muted.clone();
            draw_lines(flow, text_box, &text_of(Some(line)), 9.5, &LineOpts::new(14.0, muted))?;
        }
    }
    if block.get("rule") != Some(&Value::Bool(false)) {
        flow.y -= 12.0;
        draw_rule(flow, text_box, 0.8, &accent)?;
    }
    flow.y -= num_nn(block.get("after"), 26.0);
    Ok(())
}

/// A tinted field the text sits in, its label above the text in the accent: one unit, never split across pages.
fn draw_callout_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    let size = num_or(block.get("size"), 10.5);
    let lh = num_or(block.get("lineHeight"), size * 1.45);
    let pad = num_nn(block.get("padding"), 12.0);
    let label = js_trim(&text_of(block.get("label"))).to_owned();
    let label_size = 8.5;
    let inner = text_box.width - pad * 2.0;
    let text = text_of(block.get("text"));
    let height = pad * 2.0 + if label.is_empty() { 0.0 } else { label_size * 1.4 + 4.0 } + lines_height(&flow.font, &text, size, inner, lh)?;
    flow.keep_together(height)?;
    let fill = parse_color(&text_or(block.get("fill"), &flow.ink.field))?;
    let y = flow.y - height;
    flow.page().draw_rectangle(&RectStyle { x: text_box.left, y, width: text_box.width, height, color: Some(fill), ..RectStyle::default() });
    flow.y -= pad;
    if !label.is_empty() {
        let mut opts = LineOpts::new(label_size * 1.4, text_or(block.get("labelColor"), &flow.ink.accent));
        opts.x = Some(text_box.left + pad);
        opts.width = Some(inner);
        opts.face = Some(flow.bold.clone());
        draw_lines(flow, text_box, &label, label_size, &opts)?;
        flow.y -= 4.0;
    }
    let mut opts = LineOpts::new(lh, text_or(block.get("color"), "1F2937"));
    opts.x = Some(text_box.left + pad);
    opts.width = Some(inner);
    draw_lines(flow, text_box, &text, size, &opts)?;
    flow.y -= pad + num_nn(block.get("after"), 14.0);
    Ok(())
}

/// Someone else's words: a rule in the accent at the left, the quote a step larger than the body, the attribution a
/// caption under it.
fn draw_quote_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    let size = num_or(block.get("size"), 13.0);
    let lh = num_or(block.get("lineHeight"), size * 1.45);
    let inset = 16.0;
    let inner = text_box.width - inset;
    // The dash is drawn here, so one the author already typed is not doubled.
    let attributed = text_of(block.get("attribution"));
    let speaker = js_trim(attributed.trim_start_matches(|c: char| is_js_space(c) || matches!(c, '\u{2014}' | '\u{2013}' | '-'))).to_owned();
    let attribution = if speaker.is_empty() { String::new() } else { format!("\u{2014} {speaker}") };
    let text = text_of(block.get("text"));
    // The attribution is part of the quote, so the break is decided on both: measured on the words alone, a quote that
    // ended a page left its attribution stranded at the top of the next one, under nothing.
    let mut height = lines_height(&flow.font, &text, size, inner, lh)?;
    if !attribution.is_empty() {
        height += 4.0 + lines_height(&flow.font, &attribution, 9.0, inner, 13.0)?;
    }
    flow.keep_together(height)?;
    let top = flow.y;
    let mut opts = LineOpts::new(lh, text_or(block.get("color"), "1F2937"));
    opts.x = Some(text_box.left + inset);
    opts.width = Some(inner);
    draw_lines(flow, text_box, &text, size, &opts)?;
    // The rule spans the quote's lines from the first cap height to the last descender, not one line's ink.
    let accent = parse_color(&text_or(block.get("accent"), &flow.ink.accent))?;
    let bottom = flow.y + (lh - size) / 2.0;
    flow.page().draw_line([text_box.left + 1.0, top], [text_box.left + 1.0, bottom], 2.0, accent);
    if !attribution.is_empty() {
        flow.y -= 4.0;
        let mut opts = LineOpts::new(13.0, flow.ink.muted.clone());
        opts.x = Some(text_box.left + inset);
        opts.width = Some(inner);
        draw_lines(flow, text_box, &attribution, 9.0, &opts)?;
    }
    flow.y -= num_nn(block.get("after"), 14.0);
    Ok(())
}

fn draw_caption_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    let size = num_or(block.get("size"), 8.5);
    let tint = text_or(block.get("color"), &flow.ink.muted);
    draw_lines(flow, text_box, &text_of(block.get("text")), size, &LineOpts::new(size * 1.35, tint))?;
    flow.y -= num_nn(block.get("after"), 10.0);
    Ok(())
}

/// Several figures with one cause on one baseline: value over label per peer, equal columns, one rule under.
fn draw_stats_block(flow: &mut Flow, block: &Value, text_box: TextBox) -> WriterResult<()> {
    let items: Vec<(String, String)> =
        items_of(block.get("items")).iter().map(|item| (text_of(item.get("value")), text_of(item.get("label")))).collect();
    let size = num_or(block.get("size"), 22.0);
    let label_size = num_or(block.get("labelSize"), 9.0);
    let gap = 12.0;
    let column = (text_box.width - gap * (items.len() as f64 - 1.0)) / max(1.0, items.len() as f64);
    let font = flow.font.clone();
    let mut label_height = 0.0;
    for (_, label) in &items {
        label_height = max(label_height, lines_height(&font, label, label_size, column, label_size * 1.3)?);
    }
    let height = size * 1.15 + 4.0 + label_height + 10.0;
    flow.keep_together(height)?;
    let top = flow.y;
    let accent = parse_color(&text_or(block.get("accent"), &flow.ink.accent))?;
    let muted = parse_color(&flow.ink.muted)?;
    let bold = flow.bold.clone();
    for (index, (value, label)) in items.iter().enumerate() {
        let x = text_box.left + index as f64 * (column + gap);
        flow.page().draw_text(value, x, top - size, size, &bold, accent)?;
        let mut ly = top - size * 1.15 - 4.0;
        for line in wrap(&font, label, label_size, column)? {
            flow.page().draw_text(&line, x, ly - label_size, label_size, &font, muted)?;
            ly -= label_size * 1.3;
        }
    }
    flow.y = top - height;
    if block.get("rule") != Some(&Value::Bool(false)) {
        let line = flow.ink.line.clone();
        draw_rule(flow, text_box, 0.6, &line)?;
    }
    flow.y -= num_nn(block.get("after"), 16.0);
    Ok(())
}

/// A heading or a paragraph. Body copy leads at 1.5x (Hangul needs the air); a heading keeps 1.2x and never ends a page:
/// it moves with the first lines of what it opens.
fn draw_prose_block(flow: &mut Flow, block: &Value, text_box: TextBox, kind: &str) -> WriterResult<()> {
    let heading = kind == "heading";
    let font_size = num_or(block.get("size"), if heading { heading_size(block) } else { 11.0 });
    let line_height = num_or(block.get("lineHeight"), font_size * if heading { 1.2 } else { 1.5 });
    if heading && flow.y - line_height * 3.0 < flow.margin {
        flow.new_page()?;
    }
    let mut opts = LineOpts::new(line_height, text_or(block.get("color"), ""));
    opts.face = Some(if heading { flow.bold.clone() } else { flow.font.clone() });
    opts.widows = !heading;
    draw_lines(flow, text_box, &text_of(block.get("text")), font_size, &opts)?;
    flow.y -= num_nn(block.get("after"), if heading { 8.0 } else { 6.0 });
    Ok(())
}

/// The first lines of a paragraph a page may not leave behind (`drawLines` widows): the whole of a short one, else two.
fn paragraph_lead_height(flow: &Flow, block: &Value) -> WriterResult<f64> {
    if block_type(block) != "paragraph" {
        return Ok(0.0);
    }
    let size = num_or(block.get("size"), 11.0);
    let lh = num_or(block.get("lineHeight"), size * 1.5);
    let count = wrap(&flow.font, &text_of(block.get("text")), size, max(8.0, flow.text_box(block).width))?.len();
    Ok((if count <= 3 { count } else { 2 }) as f64 * lh)
}

// ---- lists ------------------------------------------------------------------------------------------------------------

/// A list is the marker plus a hanging indent, so a wrapped item lines up under its own text rather than under the
/// bullet. The measured lines serve the drawing and the room a heading keeps for the list it opens.
struct ListLayout {
    font_size: f64,
    line_height: f64,
    ordered: bool,
    markers: Vec<String>,
    widest_marker: f64,
    indent: f64,
    left: f64,
    lines: Vec<Vec<String>>,
}

impl ListLayout {
    /// The room items `from` through `through` take.
    fn height(&self, from: usize, through: usize) -> f64 {
        let end = (through + 1).min(self.lines.len());
        let start = from.min(end);
        self.lines[start..end].iter().fold(0.0, |sum, item| sum + item.len() as f64 * self.line_height)
    }
}

fn list_layout(flow: &Flow, block: &Value) -> WriterResult<ListLayout> {
    let items: Vec<String> = items_of(block.get("items")).iter().map(|item| text_of(Some(item))).collect();
    let font_size = num_or(block.get("size"), 11.0);
    // The same 1.5x lead as body copy: at 1.35 Hangul items set tighter than the paragraph above them.
    let line_height = num_or(block.get("lineHeight"), font_size * 1.5);
    let ordered = block.get("ordered") == Some(&Value::Bool(true));
    let markers: Vec<String> = (0..items.len())
        .map(|index| if ordered { format!("{}.", index + 1) } else { match block.get("marker") { None | Some(Value::Null) => "\u{2022}".to_owned(), Some(marker) => value_to_string(marker) } })
        .collect();
    let mut widest_marker = 0.0;
    for marker in &markers {
        widest_marker = max(widest_marker, flow.font.width(marker, font_size)?);
    }
    // The text starts past the widest marker with half an em to spare, and the numbers end together on their periods.
    let indent = num_nn(block.get("indent"), max(font_size * 1.4, widest_marker + font_size * 0.5));
    let left = num_nn(block.get("x"), flow.margin);
    let text_width = num_or(block.get("width"), flow.page_width() - flow.margin - left) - indent;
    let mut lines = Vec::with_capacity(items.len());
    for item in &items {
        lines.push(wrap(&flow.font, item, font_size, max(8.0, text_width))?);
    }
    Ok(ListLayout { font_size, line_height, ordered, markers, widest_marker, indent, left, lines })
}

/// The last item a page break may not separate from the one at `index`: the first two open a page together and the last
/// two close one, so a list of three or fewer moves as one.
fn list_keep_through(count: usize, index: usize) -> usize {
    if count <= 3 {
        return if index == 0 { count - 1 } else { index };
    }
    if index == 0 {
        return 1;
    }
    if index == count - 2 { count - 1 } else { index }
}

/// The room the first unit of a list takes, which the heading that opens it keeps beside itself.
fn list_lead_height(flow: &Flow, block: &Value) -> WriterResult<f64> {
    if block_type(block) != "list" {
        return Ok(0.0);
    }
    let layout = list_layout(flow, block)?;
    Ok(if layout.lines.is_empty() { 0.0 } else { layout.height(0, list_keep_through(layout.lines.len(), 0)) })
}

fn draw_list_block(flow: &mut Flow, block: &Value) -> WriterResult<()> {
    let layout = list_layout(flow, block)?;
    let tint = parse_color(&text_or(block.get("color"), ""))?;
    let font = flow.font.clone();
    let count = layout.lines.len();
    for (index, lines) in layout.lines.iter().enumerate() {
        let marker = &layout.markers[index];
        let marker_x = if layout.ordered { layout.left + layout.widest_marker - font.width(marker, layout.font_size)? } else { layout.left };
        // One item is one unit: broken line by line, an item that met the foot of a page left its marker and first line
        // there with the rest overleaf, where no bullet introduces them.
        flow.keep_together(layout.height(index, list_keep_through(count, index)))?;
        for (line_index, line) in lines.iter().enumerate() {
            if flow.y - layout.line_height < flow.margin {
                flow.new_page()?;
            }
            flow.y -= layout.line_height;
            let y = flow.y;
            if line_index == 0 {
                flow.page().draw_text(marker, marker_x, y, layout.font_size, &font, tint)?;
            }
            flow.page().draw_text(line, layout.left + layout.indent, y, layout.font_size, &font, tint)?;
        }
    }
    // A list closes with the same step a table or picture leaves, so what follows it is not set tight against its last item.
    flow.y -= num_nn(block.get("after"), 12.0);
    Ok(())
}

struct ImageUnit {
    placed: EmbeddedImage,
    width: f64,
    height: f64,
    needed: f64,
}

// ---- the flow ---------------------------------------------------------------------------------------------------------

fn present(amount: f64) -> bool {
    amount != 0.0 && !amount.is_nan()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_palette_overrides_roles_and_names_its_faults() {
        let (ink, custom) = resolve_palette(Some(&json!({ "accent": "112233" }))).unwrap();
        assert!(custom);
        assert_eq!((ink.accent.as_str(), ink.muted.as_str()), ("112233", "6B7280"));
        let (ink, custom) = resolve_palette(None).unwrap();
        assert!(!custom);
        assert_eq!(ink.line, "C9CED6");
        assert_eq!(
            resolve_palette(Some(&json!("x"))).unwrap_err().message(),
            "PDF properties.palette must be an object { muted, accent, field, line } of 6-digit hex colours."
        );
        assert_eq!(
            resolve_palette(Some(&json!({ "tint": "112233", "line": "#fff" }))).unwrap_err().message(),
            "PDF palette is invalid: properties.palette.tint is not a palette role (use muted, accent, field, line). properties.palette.line must be a 6-digit hex colour without '#' (for example \"C9CED6\"), got \"#fff\"."
        );
    }

    #[test]
    fn a_list_keeps_its_first_two_and_last_two_items_together() {
        assert_eq!(list_keep_through(3, 0), 2);
        assert_eq!(list_keep_through(3, 1), 1);
        assert_eq!(list_keep_through(6, 0), 1);
        assert_eq!(list_keep_through(6, 4), 5);
        assert_eq!(list_keep_through(6, 2), 2);
        assert_eq!(list_keep_through(1, 0), 0);
    }

    #[test]
    fn the_space_above_a_heading_follows_its_size() {
        assert_eq!(space_before(&json!({ "type": "heading", "text": "h" }), "heading"), 13.0);
        assert_eq!(space_before(&json!({ "type": "heading", "level": 3 }), "heading"), 10.0);
        assert_eq!(space_before(&json!({ "type": "heading", "size": 20 }), "heading"), 16.0);
        assert_eq!(space_before(&json!({ "type": "quote" }), "quote"), 6.0);
        assert_eq!(space_before(&json!({ "type": "paragraph", "before": -3 }), "paragraph"), 0.0);
        assert_eq!(space_before(&json!({ "type": "paragraph", "before": 9 }), "paragraph"), 9.0);
        assert_eq!(space_before(&json!({ "type": "paragraph" }), "paragraph"), 0.0);
    }
}


// ---- pictures ---------------------------------------------------------------------------------------------------------

/// The picture a block places, embedded once per document: the heading before it measures it, and the block draws the
/// same embedding rather than a second copy of the image.
fn block_image<P: ReadProof>(flow: &mut Flow, pictures: &Pictures<'_, P>, index: usize, block: &Value) -> WriterResult<EmbeddedImage> {
    if let Some(placed) = flow.images.get(&index) {
        return Ok(*placed);
    }
    let resolved = nodepath::resolve_host(&[pictures.base_dir, &text_or(block.get("path"), "")]);
    let placed = embed_image(pictures.proof, flow.document.store_mut(), pictures.fonts, &resolved)?;
    flow.images.insert(index, placed);
    Ok(placed)
}
/// The picture's placed size and the room it takes with the caption that names it.
fn image_unit<P: ReadProof>(
    flow: &mut Flow,
    pictures: &Pictures<'_, P>,
    index: usize,
    block: &Value,
    following: Option<&Value>,
) -> WriterResult<ImageUnit> {
    let placed = block_image(flow, pictures, index, block)?;
    let (pixels_wide, pixels_high) = (f64::from(placed.width), f64::from(placed.height));
    let width = num_or(block.get("width"), min(pixels_wide, flow.page_width() - flow.margin * 2.0));
    let height = num_or(block.get("height"), (pixels_high * width) / pixels_wide);
    let trailing = caption_height(following, &flow.font, flow.page_width() - flow.margin * 2.0)?;
    let needed = height + if trailing != 0.0 { num_nn(block.get("after"), 12.0) + trailing } else { 0.0 };
    Ok(ImageUnit { placed, width, height, needed })
}
fn draw_image_block<P: ReadProof>(
    flow: &mut Flow,
    pictures: &Pictures<'_, P>,
    index: usize,
    block: &Value,
    following: Option<&Value>,
) -> WriterResult<()> {
    let unit = image_unit(flow, pictures, index, block, following)?;
    flow.keep_together(unit.needed)?;
    let align = js_to_lowercase(&text_or(block.get("align"), "left"));
    let default_x = match align.as_str() {
        "center" => (flow.page_width() - unit.width) / 2.0,
        "right" => flow.page_width() - flow.margin - unit.width,
        _ => flow.margin,
    };
    let x = num_nn(block.get("x"), default_x);
    let y = num_nn(block.get("y"), flow.y - unit.height);
    flow.page().draw_image(unit.placed.reference, x, y, unit.width, unit.height);
    flow.y -= unit.height + num_nn(block.get("after"), 12.0);
    Ok(())
}
/// `flowBlocks(flow, blocks, baseDir)`: every block onto the pages in order.
pub fn flow_blocks<P: ReadProof>(
    flow: &mut Flow,
    proof: &P,
    svg_fonts: &SvgFonts,
    blocks: &[Value],
    base_dir: &str,
) -> WriterResult<()> {
    let pictures = Pictures { proof, fonts: svg_fonts, base_dir };
    let empty = Value::Object(Map::new());
    for (index, block) in blocks.iter().enumerate() {
        let kind = block_type(block);
        if kind == "pagebreak" {
            flow.new_page()?;
            continue;
        }
        let before = space_before(block, &kind);
        if present(before) && !flow.at_top() {
            flow.y -= before;
        }
        // A heading that introduces a form travels with it: the boxes it names must not start on the next page while the
        // words stay behind on this one. The reservation is what the heading itself will consume, plus the form, or the
        // first unit of the list, table or paragraph it opens, or the picture it introduces with that picture's caption,
        // each of which keeps together itself.
        let next = blocks.get(index + 1).unwrap_or(&empty);
        let after_next = blocks.get(index + 2);
        let mut companion = 0.0;
        if kind == "heading" {
            companion = fields::field_block_height(next);
            if !present(companion) {
                companion = list_lead_height(flow, next)?;
            }
            if !present(companion) {
                companion = tables::table_lead_height(flow, next)?;
            }
            if !present(companion) {
                companion = paragraph_lead_height(flow, next)?;
            }
            if !present(companion) {
                companion = charts::chart_unit_height(flow, next, after_next)?;
            }
            if !present(companion) && block_type(next) == "image" {
                companion = image_unit(flow, &pictures, index + 1, next, after_next)?.needed;
            }
        }
        if present(companion) {
            let size = num_or(block.get("size"), heading_size(block));
            let line_height = num_or(block.get("lineHeight"), size * 1.2);
            let heading_height = lines_height(&flow.font, &text_of(block.get("text")), size, flow.text_box(block).width, line_height)?;
            flow.keep_together(heading_height + num_nn(block.get("after"), 8.0) + companion)?;
        }
        let text_box = flow.text_box(block);
        match kind.as_str() {
            "field" | "fieldRow" => fields::place_field_block(flow, block, text_box, &kind, blocks.get(index + 1))?,
            "image" => draw_image_block(flow, &pictures, index, block, blocks.get(index + 1))?,
            "list" => draw_list_block(flow, block)?,
            "table" => tables::draw_table_block(flow, block, blocks.get(index + 1))?,
            "chart" => charts::draw_chart_block(flow, block, blocks.get(index + 1))?,
            "rule" => draw_rule_block(flow, block, text_box)?,
            "cover" => draw_cover_block(flow, block, text_box)?,
            "callout" => draw_callout_block(flow, block, text_box)?,
            "quote" => draw_quote_block(flow, block, text_box)?,
            "caption" => draw_caption_block(flow, block, text_box)?,
            "stats" => draw_stats_block(flow, block, text_box)?,
            _ => draw_prose_block(flow, block, text_box, &kind)?,
        }
    }
    Ok(())
}
