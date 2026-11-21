//! `portable/text-metrics.mjs`: the numbers that decide whether text overflows its box and where a paragraph wraps, and
//! the reviews built on them (text-box fit, contrast, spacing, vertical balance, stat labels, CJK tracking), with the
//! font-size repair that keeps a shrinking box on the type ladder.
//!
//! Widths come from `mixdog-fonts` (the canvas `measureText`), read through a [`TextMeasurer`] that holds the registry
//! of faces the caller registered: Node asked the canvas which families it had, here the registry answers. PowerPoint's
//! single line spacing is 1.2 em for every face, so a line is `size * 1.2 * multiple` high whatever the face's own
//! metrics are; a Latin face hands its CJK runs to PowerPoint's East Asian fallback family; three faces carry a width
//! calibration per script class measured against PowerPoint; wrapping follows the Korean line-break prohibitions
//! (kinsoku), and a run with no break opportunity is cut between characters.
//!
//! The inputs are the typed shapes of what the pptx inspection reads ([`Paragraph`], [`TextBox`], [`Bound`]); a number
//! that Node read with `Number(x) || 0` is an `f64` where `0` stands for absent.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_fonts::face::FontError;
use mixdog_fonts::measure;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, is_js_space, js_to_lowercase, js_trim, js_trim_end, json_number, math, number_to_string, utf16_len};
use serde_json::{Value, json};

use crate::relations::{RelationBox, by_slide, rectangle_gap, review_declared_relations};

/// PowerPoint's single line spacing, in em, for every face.
const LINE_HEIGHT_RATIO: f64 = 1.2;

static WEIGHT_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s+(semilight|light|semibold|medium|black|thin|extrabold)$", "iu"));
/// Families that carry their own Hangul / CJK glyphs; any other face hands CJK runs to the East Asian fallback.
static CJK_FAMILY: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"noto (sans|serif) (kr|sc|tc|jp|cjk)|malgun|batang|gulim|dotum|yahei|jhenghei|yu gothic|meiryo|ms (gothic|mincho)|simsun|simhei|pingfang|hiragino|apple sd|nanum",
        "i",
    )
});
static LETTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\p{L}", "gu"));

/// The localized or weight-suffixed names Office stores, and the registered family each stands for.
const FONT_ALIASES: [(&str, &str); 10] = [
    ("맑은 고딕", "Malgun Gothic"),
    ("바탕", "Batang"),
    ("돋움", "Dotum"),
    ("굴림", "Gulim"),
    ("본고딕", "Noto Sans KR"),
    ("본명조", "Noto Serif KR"),
    ("微软雅黑", "Microsoft YaHei"),
    ("微軟正黑體", "Microsoft JhengHei"),
    ("游ゴシック", "Yu Gothic"),
    ("メイリオ", "Meiryo"),
];

/// A weight suffix and the numeric weight it registers at.
const SUFFIX_WEIGHT: [(&str, u16); 7] =
    [("thin", 100), ("light", 300), ("semilight", 300), ("medium", 500), ("semibold", 600), ("extrabold", 800), ("black", 900)];

/// Open faces with the advance widths of the proprietary family they stand in for.
const METRIC_EQUIVALENTS: [(&str, &[&str]); 7] = [
    ("arial", &["liberation sans", "arimo"]),
    // Windows answers a request for Helvetica with its own Arial (the font substitution the canvas rode on there); the open faces follow.
    ("helvetica", &["arial", "liberation sans", "arimo"]),
    ("times new roman", &["liberation serif", "tinos"]),
    ("courier new", &["liberation mono", "cousine"]),
    ("calibri", &["carlito"]),
    ("cambria", &["caladea"]),
    ("georgia", &["gelasio"]),
];

/// Width calibration per script class, measured against PowerPoint's own bound width: `(family, cjk, latin)`.
const WIDTH_CALIBRATION: [(&str, f64, f64); 3] = [("noto sans kr", 1.027, 1.082), ("noto serif kr", 1.028, 1.042), ("malgun gothic", 1.039, 1.032)];

/// The sizes a shrinking box may land on.
const TYPE_LADDER: [f64; 26] =
    [96.0, 80.0, 72.0, 66.0, 60.0, 54.0, 48.0, 44.0, 40.0, 36.0, 32.0, 28.0, 26.0, 24.0, 22.0, 20.0, 18.0, 16.0, 15.0, 14.0, 13.0, 12.0, 11.0, 10.0, 9.0, 8.0];

/// A short label sits by design next to its neighbour; the block gap applies between blocks of copy.
const LABEL_MAX_CHARS: usize = 16;
/// A band this deep with content above and below it reads as an unfinished page (1.5 in at 72 pt per inch).
const HOLLOW_BAND: f64 = 108.0;
const CJK_TRACKING_RATIO: f64 = 0.05;

fn is_cjk(character: char) -> bool {
    matches!(
        character,
        '\u{1100}'..='\u{115F}'
            | '\u{2E80}'..='\u{A4CF}'
            | '\u{AC00}'..='\u{D7A3}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{FE30}'..='\u{FE6F}'
            | '\u{FF00}'..='\u{FF60}'
            | '\u{FFE0}'..='\u{FFE6}'
    )
}

/// Hangul and CJK text a tracking review reads.
fn is_cjk_text(character: char) -> bool {
    matches!(character, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7AF}' | '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}')
}

/// A closing mark never starts a line.
fn no_line_start(part: &str) -> bool {
    let mut characters = part.chars();
    matches!(
        (characters.next(), characters.next()),
        (
            Some(
                ',' | '.'
                    | '、'
                    | '。'
                    | '，'
                    | '．'
                    | ':'
                    | ';'
                    | '!'
                    | '?'
                    | '%'
                    | ')'
                    | ']'
                    | '}'
                    | '」'
                    | '』'
                    | '〉'
                    | '》'
                    | '】'
                    | '〕'
                    | '’'
                    | '”'
                    | '…'
                    | '·'
            ),
            None
        )
    )
}

/// An opening mark never ends one.
fn no_line_end(part: &str) -> bool {
    let mut characters = part.chars();
    matches!((characters.next(), characters.next()), (Some('(' | '[' | '{' | '「' | '『' | '〈' | '《' | '【' | '〔' | '‘' | '“'), None))
}

/// The font of a run of text: `{ fontName, fontSize, bold, italic }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FontSpec {
    /// The family as Office names it (`Calibri` when absent or empty).
    pub font_name: Option<String>,
    /// The size in points (18 when absent, zero or not a number; at least 1).
    pub font_size: Option<f64>,
    pub bold: bool,
    pub italic: bool,
}

/// One run of a paragraph that sets its own size.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Run {
    pub text: String,
    pub font_size: Option<f64>,
}

/// One paragraph of a text box as the reviews read it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Paragraph {
    pub text: String,
    pub font_name: Option<String>,
    pub font_size: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    /// The PowerPoint multiple read from `lnSpc` (1 = single); absent or not positive defers to the block's.
    pub line_spacing: Option<f64>,
    pub space_before: f64,
    pub space_after: f64,
    /// The runs, when the paragraph's runs are read apart.
    pub runs: Option<Vec<Run>>,
    /// The text colour as hex (`000000` when absent).
    pub color: Option<String>,
    /// Tracking in points.
    pub char_spacing: f64,
}

impl Paragraph {
    fn font(&self) -> FontSpec {
        FontSpec { font_name: self.font_name.clone(), font_size: self.font_size, bold: self.bold, italic: self.italic }
    }

    /// `Math.max(1, Number(fontSize) || 18)`.
    fn size(&self) -> f64 {
        size_or_default(self.font_size)
    }

    /// `Number(fontSize) || 0`.
    fn size_or_zero(&self) -> f64 {
        truthy_number(self.font_size)
    }
}

fn truthy_number(value: Option<f64>) -> f64 {
    value.filter(|number| !number.is_nan()).unwrap_or(0.0)
}

fn size_or_default(value: Option<f64>) -> f64 {
    let number = truthy_number(value);
    math::max(1.0, if number == 0.0 { 18.0 } else { number })
}

/// A shape's text as the reviews read it: where it sits (points), what it declares, and its paragraphs.
#[derive(Debug, Clone, PartialEq)]
pub struct TextBox {
    pub frame: RelationBox,
    pub paragraphs: Vec<Paragraph>,
    /// The fill the text sits on, as hex.
    pub background: Option<String>,
    /// `box.wrap !== false`.
    pub wrap: bool,
    /// `box.autofit === true`.
    pub autofit: bool,
    pub inset_left: f64,
    pub inset_right: f64,
    pub inset_top: f64,
    pub inset_bottom: f64,
}

impl TextBox {
    pub fn new(frame: RelationBox) -> Self {
        Self {
            frame,
            paragraphs: Vec::new(),
            background: None,
            wrap: true,
            autofit: false,
            inset_left: 0.0,
            inset_right: 0.0,
            inset_top: 0.0,
            inset_bottom: 0.0,
        }
    }
}

/// A shape's bounds on a slide, for the vertical balance review.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bound {
    pub slide: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    /// The element the shape is (`p:graphicFrame`, `p:pic`, `p:grpSp`, `p:sp`).
    pub kind: String,
    pub name: String,
}

/// What `measureTextBlock` answers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockMetrics {
    pub height: f64,
    pub lines: usize,
    /// The widest laid-out line.
    pub width: f64,
    /// The widest run that cannot be broken at a space or a syllable.
    pub longest_run: f64,
}

/// The options of `measureTextBlock`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BlockOptions {
    /// The measure in points; zero lays every paragraph out on one line.
    pub width: f64,
    /// The block's line-spacing multiple (a paragraph's own overrides it).
    pub line_spacing: f64,
    /// The pitch per em, for callers that resolved spacing themselves; zero uses 1.2 times the multiple.
    pub line_height_ratio: f64,
}

impl Default for BlockOptions {
    fn default() -> Self {
        Self { width: 0.0, line_spacing: 1.0, line_height_ratio: 0.0 }
    }
}

/// The options of `reviewTextBoxFit`.
pub struct FitOptions<'a> {
    pub slide_width: f64,
    pub slide_height: f64,
    pub tolerance: f64,
    /// Whether a family is installed; absent, the registry answers.
    pub is_font_available: Option<&'a dyn Fn(&str) -> bool>,
}

impl Default for FitOptions<'_> {
    fn default() -> Self {
        Self { slide_width: 0.0, slide_height: 0.0, tolerance: 1.04, is_font_available: None }
    }
}

/// The options of `shrinkFontSizeToFit`.
#[derive(Debug, Clone, PartialEq)]
pub struct ShrinkOptions {
    pub width: f64,
    pub height: f64,
    pub minimum_font_size: f64,
    /// The sizes the repair may land on; the type ladder when absent or empty.
    pub steps: Option<Vec<f64>>,
}

impl Default for ShrinkOptions {
    fn default() -> Self {
        Self { width: 0.0, height: 0.0, minimum_font_size: 8.0, steps: None }
    }
}

/// What `shrinkFontSizeToFit` answers: the factor and the size of each paragraph, or `0` and nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct Shrunk {
    pub scale: f64,
    pub sizes: Vec<f64>,
}

/// Measures text in the faces of a registry.
pub struct TextMeasurer<'a, P: ReadProof> {
    proof: &'a P,
    registry: &'a Registry,
    /// Lower-cased family to the name as registered.
    installed: HashMap<String, String>,
    cjk_fallback: &'static str,
    widths: RefCell<HashMap<(String, String), f64>>,
}

impl<'a, P: ReadProof> TextMeasurer<'a, P> {
    /// A measurer over the faces registered in `registry` (the provisioned Office faces included, registered by the caller).
    pub fn new(proof: &'a P, registry: &'a Registry) -> Self {
        let installed: HashMap<String, String> =
            registry.family_names().map(js_trim).filter(|family| !family.is_empty()).map(|family| (js_to_lowercase(family), family.to_owned())).collect();
        // PowerPoint's East Asian fallback for a Latin face: Malgun Gothic, else the provisioned Noto Sans KR.
        let cjk_fallback = if !installed.contains_key("malgun gothic") && installed.contains_key("noto sans kr") { "Noto Sans KR" } else { "Malgun Gothic" };
        Self { proof, registry, installed, cjk_fallback, widths: RefCell::new(HashMap::new()) }
    }

    /// The registered name of an installed metric-compatible substitute for a family that is not installed.
    fn installed_equivalent(&self, family: &str) -> Option<&str> {
        if self.installed.is_empty() || self.installed.contains_key(family) {
            return None;
        }
        let (_, candidates) = METRIC_EQUIVALENTS.iter().find(|(name, _)| *name == family)?;
        let found = candidates.iter().find(|candidate| self.installed.contains_key(**candidate))?;
        self.installed.get(*found).map(String::as_str)
    }

    /// The registered family and numeric weight a font name stands for (`0` when the name carries no weight).
    fn resolve_font(&self, font_name: Option<&str>) -> (String, u16) {
        let name = font_name.filter(|name| !name.is_empty()).unwrap_or("Calibri");
        let mut family = js_trim(&name.replace('"', "")).to_owned();
        if let Some((_, alias)) = FONT_ALIASES.iter().find(|(from, _)| *from == family) {
            family = (*alias).to_owned();
        }
        let mut weight = 0;
        let suffix = WEIGHT_SUFFIX.captures(&family).map(|found| (js_to_lowercase(found.get(1).unwrap_or("")), found.range()));
        if let Some((suffix, range)) = suffix
            && !self.installed.contains_key(&js_to_lowercase(&family))
        {
            weight = SUFFIX_WEIGHT.iter().find(|(name, _)| *name == suffix).map_or(0, |(_, value)| *value);
            family.replace_range(range, "");
        }
        let family = self.installed_equivalent(&js_to_lowercase(&family)).map_or(family.clone(), str::to_owned);
        (family, weight)
    }

    /// The canvas font string of a font.
    fn font_spec(&self, font: &FontSpec) -> String {
        let (family, weight) = self.resolve_font(font.font_name.as_deref());
        let weight_spec = if font.bold {
            "700 ".to_owned()
        } else if weight != 0 {
            format!("{weight} ")
        } else {
            String::new()
        };
        format!("{}{}{}px \"{}\"", if font.italic { "italic " } else { "" }, weight_spec, number_to_string(size_or_default(font.font_size)), family)
    }

    /// Whether Office's `name` resolves to an installed family. With nothing registered every name is available.
    pub fn font_available(&self, name: &str) -> bool {
        let trimmed = js_trim(name);
        let aliased = FONT_ALIASES.iter().find(|(from, _)| *from == trimmed).map_or(name, |(_, alias)| *alias);
        let family = js_to_lowercase(js_trim(aliased));
        if family.is_empty() || self.installed.is_empty() {
            return true;
        }
        if self.installed.contains_key(&family) || self.installed_equivalent(&family).is_some() {
            return true;
        }
        // Weight-suffixed families often enumerate only under their base family.
        let base = match WEIGHT_SUFFIX.find(&family) {
            Some(range) => family[..range.start].to_owned() + &family[range.end..],
            None => family.clone(),
        };
        base != family && (self.installed.contains_key(&base) || self.installed_equivalent(&base).is_some())
    }

    /// Maximal runs of one script class, in order.
    fn script_runs(text: &str) -> Vec<(String, bool)> {
        let mut runs: Vec<(String, bool)> = Vec::new();
        for character in text.chars() {
            let cjk = is_cjk(character);
            match runs.last_mut() {
                Some((run, run_cjk)) if *run_cjk == cjk => run.push(character),
                _ => runs.push((character.to_string(), cjk)),
            }
        }
        runs
    }

    fn canvas_width(&self, spec: &str, text: &str) -> Result<f64, FontError> {
        let key = (spec.to_owned(), text.to_owned());
        if let Some(width) = self.widths.borrow().get(&key) {
            return Ok(*width);
        }
        let width = measure::measure_text(self.proof, self.registry, spec, text)?.width;
        self.widths.borrow_mut().insert(key, width);
        Ok(width)
    }

    fn raw_width(&self, text: &str, font: &FontSpec) -> Result<f64, FontError> {
        let spec = self.font_spec(font);
        let family = js_to_lowercase(&self.resolve_font(font.font_name.as_deref()).0);
        let Some((_, cjk, latin)) = WIDTH_CALIBRATION.iter().find(|(name, _, _)| *name == family) else {
            return self.canvas_width(&spec, text);
        };
        let mut total = 0.0;
        for (run, run_cjk) in Self::script_runs(text) {
            total += self.canvas_width(&spec, &run)? * if run_cjk { *cjk } else { *latin };
        }
        Ok(total)
    }

    /// `measureTextWidth(text, font)`: the width in px of the text set in the font, CJK runs of a Latin face measured in
    /// the East Asian fallback family.
    pub fn measure_text_width(&self, text: &str, font: &FontSpec) -> Result<f64, FontError> {
        if text.is_empty() {
            return Ok(0.0);
        }
        let family = self.resolve_font(font.font_name.as_deref()).0;
        if !text.chars().any(is_cjk) || CJK_FAMILY.is_match(&family) {
            return self.raw_width(text, font);
        }
        let mut total = 0.0;
        for (run, cjk) in Self::script_runs(text) {
            let run_font = if cjk { FontSpec { font_name: Some(self.cjk_fallback.to_owned()), ..font.clone() } } else { font.clone() };
            total += self.raw_width(&run, &run_font)?;
        }
        Ok(total)
    }

    /// The longest prefix of a run that still fits the measure, never empty.
    fn head_that_fits(&self, text: &str, limit: f64, font: &FontSpec) -> Result<String, FontError> {
        let ends: Vec<usize> = text.char_indices().map(|(at, character)| at + character.len_utf8()).collect();
        let mut head = ends.first().map_or("", |end| &text[..*end]);
        for end in ends.iter().skip(1) {
            let candidate = &text[..*end];
            if self.measure_text_width(candidate, font)? > limit {
                break;
            }
            head = candidate;
        }
        Ok(head.to_owned())
    }

    /// `wrapParagraph(text, width, font)`: the lines of the paragraph at the measure.
    pub fn wrap_paragraph(&self, text: &str, width: f64, font: &FontSpec) -> Result<Vec<String>, FontError> {
        if text.is_empty() {
            return Ok(vec![String::new()]);
        }
        let limit = math::max(1.0, if width.is_nan() || width == 0.0 { 1.0 } else { width });
        let mut lines = Vec::new();
        let mut current = String::new();
        for part in segments(text) {
            let candidate = format!("{current}{part}");
            if !current.is_empty() && self.measure_text_width(js_trim_end(&candidate), font)? > limit {
                lines.push(js_trim_end(&current).to_owned());
                current = if part == " " { String::new() } else { part };
            } else {
                current = candidate;
            }
            // A run with no break opportunity that still does not fit is broken between characters.
            while !current.is_empty() && self.measure_text_width(&current, font)? > limit {
                let head = self.head_that_fits(&current, limit, font)?;
                if head.len() >= current.len() {
                    break;
                }
                current = current[head.len()..].to_owned();
                lines.push(head);
            }
        }
        lines.push(js_trim_end(&current).to_owned());
        Ok(lines)
    }

    /// `measureTextBlock(paragraphs, options)`: height, line count, widest line and widest unbreakable run of the block.
    pub fn measure_text_block(&self, paragraphs: &[Paragraph], options: &BlockOptions) -> Result<BlockMetrics, FontError> {
        let (mut height, mut lines, mut widest, mut longest_run) = (0.0, 0_usize, 0.0, 0.0);
        let width = options.width;
        for paragraph in paragraphs.iter().flat_map(soft_break_lines) {
            let font = paragraph.font();
            let size = paragraph.size();
            let own = truthy_number(paragraph.line_spacing);
            let multiple = if own > 0.0 {
                own
            } else {
                let block = if options.line_spacing.is_nan() || options.line_spacing == 0.0 { 1.0 } else { options.line_spacing };
                math::max(0.5, block)
            };
            let pitch = if options.line_height_ratio > 0.0 { options.line_height_ratio } else { LINE_HEIGHT_RATIO * multiple };
            // Runs of different sizes are measured each at its own size; one line when the whole paragraph fits.
            let runs = paragraph.runs.as_deref().filter(|runs| distinct(runs.iter().map(|run| run.font_size)) > 1);
            if let Some(runs) = runs {
                let mut total = 0.0;
                for run in runs {
                    total += self.measure_text_width(&run.text, &FontSpec { font_size: run.font_size, ..font.clone() })?;
                }
                if !(width > 0.0) || total <= width {
                    widest = math::max(widest, total);
                    longest_run = math::max(longest_run, total);
                    lines += 1;
                    height += size * pitch;
                    height += math::max(0.0, paragraph.space_before) + math::max(0.0, paragraph.space_after);
                    continue;
                }
            }
            let wrapped = if width > 0.0 { self.wrap_paragraph(&paragraph.text, width, &font)? } else { vec![paragraph.text.clone()] };
            for line in &wrapped {
                widest = math::max(widest, self.measure_text_width(line, &font)?);
            }
            for part in segments(&paragraph.text) {
                if part != " " {
                    longest_run = math::max(longest_run, self.measure_text_width(&part, &font)?);
                }
            }
            lines += wrapped.len();
            height += wrapped.len() as f64 * size * pitch;
            height += math::max(0.0, paragraph.space_before);
            height += math::max(0.0, paragraph.space_after);
        }
        Ok(BlockMetrics { height, lines, width: widest, longest_run })
    }

    /// `reviewTextBoxFit(boxes, options)`: overflow, clipping, narrow measure, missing fonts and shapes past the slide.
    pub fn review_text_box_fit(&self, boxes: &[TextBox], options: &FitOptions<'_>) -> Result<Vec<Value>, FontError> {
        let mut issues = Vec::new();
        for text_box in boxes {
            if !text_box.paragraphs.iter().any(|paragraph| !js_trim(&paragraph.text).is_empty()) || text_box.autofit {
                continue;
            }
            issues.extend(self.text_box_fit_issues(text_box, options)?);
        }
        Ok(issues)
    }

    fn text_box_fit_issues(&self, text_box: &TextBox, options: &FitOptions<'_>) -> Result<Vec<Value>, FontError> {
        let path = shape_path(&text_box.frame);
        let usable_width = math::max(1.0, text_box.frame.width - text_box.inset_left - text_box.inset_right);
        let usable_height = math::max(1.0, text_box.frame.height - text_box.inset_top - text_box.inset_bottom);
        let measured =
            self.measure_text_block(&text_box.paragraphs, &BlockOptions { width: if text_box.wrap { usable_width } else { 0.0 }, ..BlockOptions::default() })?;
        let available = |name: &str| options.is_font_available.map_or_else(|| self.font_available(name), |check| check(name));
        let mut fonts: Vec<String> = Vec::new();
        for paragraph in &text_box.paragraphs {
            let name = js_trim(paragraph.font_name.as_deref().unwrap_or(""));
            if !name.is_empty() && !available(name) && !fonts.iter().any(|known| known == name) {
                fonts.push(name.to_owned());
            }
        }
        let mut issues: Vec<Value> = fonts
            .iter()
            .map(|font| {
                json!({
                    "code": "font_unavailable",
                    "path": path,
                    "message": format!("Font \"{font}\" is not installed, so PowerPoint may substitute it and change the layout."),
                    "font": font,
                })
            })
            .collect();
        let substituted = !fonts.is_empty();
        let allowance = if substituted { options.tolerance * 1.12 } else { options.tolerance };
        if measured.height > usable_height * allowance {
            issues.push(text_overflow_issue(&path, &measured, usable_height, substituted));
        }
        if !text_box.wrap && measured.width > usable_width * options.tolerance {
            issues.push(json!({
                "code": "text_clipped",
                "path": path,
                "message": format!(
                    "Unwrapped text is about {}pt wide inside a {}pt shape.",
                    number_to_string(math::round(measured.width)),
                    number_to_string(math::round(usable_width))
                ),
            }));
        }
        issues.extend(narrow_box_issue(text_box, &measured, usable_width, &path));
        issues.extend(out_of_bounds_issue(&text_box.frame, options.slide_width, options.slide_height, &path));
        Ok(issues)
    }

    /// `shrinkFontSizeToFit(paragraphs, options)`: the largest step of the type ladder at which the text fits the box.
    pub fn shrink_font_size_to_fit(&self, paragraphs: &[Paragraph], options: &ShrinkOptions) -> Result<Shrunk, FontError> {
        let sizes: Vec<f64> = paragraphs.iter().map(Paragraph::size).collect();
        let largest = sizes.iter().fold(1.0, |top, size| math::max(top, *size));
        let floor = math::max(1.0, if options.minimum_font_size.is_nan() || options.minimum_font_size == 0.0 { 8.0 } else { options.minimum_font_size });
        let steps: &[f64] = match options.steps.as_deref() {
            Some(steps) if !steps.is_empty() => steps,
            _ => &TYPE_LADDER,
        };
        let mut ladder: Vec<f64> = Vec::new();
        for candidate in std::iter::once(largest).chain(steps.iter().copied()).chain(std::iter::once(floor)) {
            if candidate.is_finite() && candidate <= largest && candidate >= floor && !ladder.contains(&candidate) {
                ladder.push(candidate);
            }
        }
        ladder.sort_by(|left, right| right.total_cmp(left));
        for candidate in ladder {
            let factor = candidate / largest;
            let scaled: Vec<Paragraph> = paragraphs
                .iter()
                .zip(&sizes)
                .map(|(paragraph, size)| Paragraph { font_size: Some(math::max(floor, math::round(size * factor * 2.0) / 2.0)), ..paragraph.clone() })
                .collect();
            let measured = self.measure_text_block(&scaled, &BlockOptions { width: options.width, ..BlockOptions::default() })?;
            if measured.height <= options.height {
                return Ok(Shrunk { scale: factor, sizes: scaled.iter().map(Paragraph::size_or_zero).collect() });
            }
        }
        Ok(Shrunk { scale: 0.0, sizes: Vec::new() })
    }
}

/// The number of distinct values (SameValueZero), an absent size counting as one value of its own.
fn distinct(values: impl Iterator<Item = Option<f64>>) -> usize {
    let mut seen: Vec<Option<f64>> = Vec::new();
    for value in values {
        let known = seen.iter().any(|other| match (other, &value) {
            (Some(a), Some(b)) => a == b || (a.is_nan() && b.is_nan()),
            (None, None) => true,
            _ => false,
        });
        if !known {
            seen.push(value);
        }
    }
    seen.len()
}

/// The parts of a paragraph a line may break between: spaces, single CJK characters and runs of anything else, with a
/// closing mark bound to the part before it and an opening mark to the part after it (kinsoku).
pub fn segments(text: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut buffer = String::new();
    for character in text.chars() {
        if character == ' ' || is_cjk(character) {
            if !buffer.is_empty() {
                parts.push(std::mem::take(&mut buffer));
            }
            parts.push(character.to_string());
        } else {
            buffer.push(character);
        }
    }
    if !buffer.is_empty() {
        parts.push(buffer);
    }
    let mut bound: Vec<String> = Vec::new();
    for part in parts {
        match bound.last_mut() {
            Some(last) if last.as_str() != " " && (no_line_start(&part) || no_line_end(last)) => last.push_str(&part),
            _ => bound.push(part),
        }
    }
    bound
}

/// A paragraph whose text carries soft breaks is laid out as one line group per break, each at the size of its own runs;
/// space before and after stay with the first and last line.
fn soft_break_lines(paragraph: &Paragraph) -> Vec<Paragraph> {
    if !paragraph.text.contains('\n') {
        return vec![paragraph.clone()];
    }
    let runs = paragraph.runs.clone().unwrap_or_else(|| vec![Run { text: paragraph.text.clone(), font_size: paragraph.font_size }]);
    let mut lines: Vec<Vec<Run>> = vec![Vec::new()];
    for run in runs {
        for (index, part) in run.text.split('\n').enumerate() {
            if index > 0 {
                lines.push(Vec::new());
            }
            if !part.is_empty() {
                if let Some(line) = lines.last_mut() {
                    line.push(Run { text: part.to_owned(), font_size: run.font_size });
                }
            }
        }
    }
    let last = lines.len() - 1;
    lines
        .into_iter()
        .enumerate()
        .map(|(index, line_runs)| {
            let sizes: Vec<f64> = line_runs.iter().map(|run| truthy_number(run.font_size)).filter(|size| *size != 0.0).collect();
            let mixed = distinct(sizes.iter().map(|size| Some(*size))) > 1;
            Paragraph {
                text: line_runs.iter().map(|run| run.text.as_str()).collect(),
                font_size: if sizes.is_empty() { paragraph.font_size } else { Some(sizes.iter().fold(f64::NEG_INFINITY, |top, size| math::max(top, *size))) },
                runs: mixed.then_some(line_runs),
                space_before: if index == 0 { paragraph.space_before } else { 0.0 },
                space_after: if index == last { paragraph.space_after } else { 0.0 },
                ..paragraph.clone()
            }
        })
        .collect()
}

fn shape_path(frame: &RelationBox) -> String {
    format!("/slide[{}]/shape[{}]", number_to_string(frame.slide), number_to_string(frame.shape))
}

/// The largest type size a block of paragraphs sets, 0 when none states one.
fn largest_font_size(paragraphs: &[Paragraph]) -> f64 {
    paragraphs.iter().fold(0.0, |top, paragraph| math::max(top, paragraph.size_or_zero()))
}

fn has_text(text_box: &TextBox) -> bool {
    text_box.paragraphs.iter().any(|paragraph| !js_trim(&paragraph.text).is_empty())
}

fn text_overflow_issue(path: &str, measured: &BlockMetrics, usable_height: f64, substituted: bool) -> Value {
    let mut message = format!(
        "Text needs about {}pt but the shape allows {}pt.",
        number_to_string(math::round(measured.height)),
        number_to_string(math::round(usable_height))
    );
    if substituted {
        message.push_str(" The font is not installed here, so the measurement is approximate.");
    }
    let mut issue = json!({
        "code": "text_overflow",
        "path": path,
        "message": message,
        "overflow": json_number(math::round(measured.height - usable_height)),
        "lines": measured.lines,
    });
    if substituted {
        issue["approximate"] = Value::Bool(true);
    }
    issue
}

/// Two readings of the same fault: a box narrower than its longest word breaks mid-word, and a box only a little wider
/// leaves a ragged column of one or two words a line.
fn narrow_box_issue(text_box: &TextBox, measured: &BlockMetrics, usable_width: f64, path: &str) -> Option<Value> {
    if !text_box.wrap {
        return None;
    }
    let body_size = largest_font_size(&text_box.paragraphs);
    let longest_run = if measured.longest_run == 0.0 || measured.longest_run.is_nan() { measured.width } else { measured.longest_run };
    if longest_run > usable_width * 1.02 {
        return Some(json!({
            "code": "text_box_too_narrow",
            "path": path,
            "message": format!(
                "A word needs about {}pt but the shape offers {}pt, so the text breaks mid-word.",
                number_to_string(math::round(longest_run)),
                number_to_string(math::round(usable_width))
            ),
        }));
    }
    if measured.lines >= 3 && body_size > 0.0 && usable_width < body_size * 7.0 {
        return Some(json!({
            "code": "text_box_too_narrow",
            "path": path,
            "message": format!(
                "The box offers {}pt of measure for {}pt text, so its {} lines carry one or two words each.",
                number_to_string(math::round(usable_width)),
                number_to_string(math::round(body_size)),
                measured.lines
            ),
        }));
    }
    None
}

fn out_of_bounds_issue(frame: &RelationBox, slide_width: f64, slide_height: f64, path: &str) -> Option<Value> {
    if !(slide_width > 0.0 && slide_height > 0.0) {
        return None;
    }
    let right = truthy_number(Some(frame.left)) + truthy_number(Some(frame.width));
    let bottom = truthy_number(Some(frame.top)) + truthy_number(Some(frame.height));
    if frame.left < -1.0 || frame.top < -1.0 || right > slide_width + 1.0 || bottom > slide_height + 1.0 {
        return Some(json!({ "code": "shape_out_of_bounds", "path": path, "message": "Shape extends past the slide edge." }));
    }
    None
}

fn channel_luminance(value: f64) -> f64 {
    let srgb = value / 255.0;
    if srgb <= 0.03928 { srgb / 12.92 } else { math::pow((srgb + 0.055) / 1.055, 2.4) }
}

/// `relativeLuminance(hex)`: the WCAG luminance of a six-digit hex colour (a leading `#` and anything before the last six
/// digits are ignored), or `None` when it is not one.
pub fn relative_luminance(hex: &str) -> Option<f64> {
    let stripped = hex.strip_prefix('#').unwrap_or(hex);
    let characters: Vec<char> = stripped.chars().collect();
    let raw: String = characters[characters.len().saturating_sub(6)..].iter().collect();
    if raw.len() != 6 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| channel_luminance(f64::from(u8::from_str_radix(&raw[at..at + 2], 16).unwrap_or(0)));
    Some(0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4))
}

/// `contrastRatio(foreground, background)`: the WCAG contrast ratio, or `None` when either is not a colour.
pub fn contrast_ratio(foreground: &str, background: &str) -> Option<f64> {
    let first = relative_luminance(foreground)?;
    let second = relative_luminance(background)?;
    Some((math::max(first, second) + 0.05) / (math::min(first, second) + 0.05))
}

fn is_label_box(text_box: &TextBox) -> bool {
    let texts: Vec<&str> = text_box.paragraphs.iter().map(|paragraph| js_trim(&paragraph.text)).filter(|text| !text.is_empty()).collect();
    let text = texts.join("\n");
    let length = utf16_len(&text);
    length > 0 && length <= LABEL_MAX_CHARS && !text.contains('\n')
}

/// `reviewShapeSpacing(boxes, { minimumGap })`: neighbours in a row or a column closer than the block gap.
pub fn review_shape_spacing(boxes: &[TextBox], minimum_gap: f64) -> Vec<Value> {
    let mut issues = Vec::new();
    for (slide, shapes) in by_slide(boxes, |text_box| text_box.frame.slide) {
        for first in 0..shapes.len() {
            for second in first + 1..shapes.len() {
                let (left, right) = (shapes[first], shapes[second]);
                let (l, r) = (&left.frame, &right.frame);
                let horizontal = math::max(l.left - (r.left + r.width), r.left - (l.left + l.width));
                let vertical = math::max(l.top - (r.top + r.height), r.top - (l.top + l.height));
                // Clear of each other on exactly one axis: neighbours in a row or a column.
                let apart_horizontally = horizontal >= 0.0;
                let apart_vertically = vertical >= 0.0;
                if apart_horizontally == apart_vertically {
                    continue;
                }
                let gap = if apart_horizontally { horizontal } else { vertical };
                if gap >= minimum_gap || is_label_box(left) || is_label_box(right) {
                    continue;
                }
                if !apart_horizontally {
                    let aligned = math::min(l.left + l.width, r.left + r.width) - math::max(l.left, r.left);
                    if aligned >= math::min(l.width, r.width) * 0.6 {
                        continue;
                    }
                }
                let rounded = math::to_fixed(gap, 1);
                issues.push(json!({
                    "code": "shapes_too_close",
                    "path": format!("/slide[{}]/shape[{}]", number_to_string(slide), number_to_string(r.shape)),
                    "message": format!(
                        "Shapes {} and {} sit {rounded}pt apart; keep at least {}pt between blocks.",
                        number_to_string(l.shape),
                        number_to_string(r.shape),
                        number_to_string(minimum_gap)
                    ),
                    "gap": json_number(rounded.parse().unwrap_or(gap)),
                }));
            }
        }
    }
    issues
}

/// `reviewTextContrast(boxes)`: the worst paragraph of a box under the WCAG minimum for its size.
pub fn review_text_contrast(boxes: &[TextBox]) -> Vec<Value> {
    let mut issues = Vec::new();
    for text_box in boxes {
        let Some(background) = text_box.background.as_deref().filter(|background| !background.is_empty()) else { continue };
        let mut worst: Option<(f64, f64, f64)> = None;
        for paragraph in &text_box.paragraphs {
            if js_trim(&paragraph.text).is_empty() {
                continue;
            }
            let foreground = paragraph.color.as_deref().filter(|color| !color.is_empty()).unwrap_or("000000");
            let Some(ratio) = contrast_ratio(foreground, background) else { continue };
            let size = paragraph.size();
            let large = size >= 18.0 || (size >= 14.0 && paragraph.bold);
            let minimum = if large { 3.0 } else { 4.5 };
            if ratio >= minimum {
                continue;
            }
            if worst.is_none_or(|(known, _, _)| ratio < known) {
                worst = Some((ratio, minimum, size));
            }
        }
        let Some((ratio, minimum, size)) = worst else { continue };
        let shown = math::to_fixed(ratio, 2);
        issues.push(json!({
            "code": "low_contrast",
            "path": shape_path(&text_box.frame),
            "message": format!(
                "Text contrast is {shown}:1 against its background; {}:1 is the readable minimum at {}pt.",
                number_to_string(minimum),
                number_to_string(math::round(size))
            ),
            "ratio": json_number(shown.parse().unwrap_or(ratio)),
            "minimum": json_number(minimum),
        }));
    }
    issues
}

/// `reviewCjkTracking(boxes)`: Hangul and CJK text with tracking over 5 % of its size.
pub fn review_cjk_tracking(boxes: &[TextBox]) -> Vec<Value> {
    let mut issues = Vec::new();
    for text_box in boxes {
        let mut worst: Option<(f64, f64, f64)> = None;
        for paragraph in &text_box.paragraphs {
            if !paragraph.text.chars().any(is_cjk_text) {
                continue;
            }
            let tracking = truthy_number(Some(paragraph.char_spacing));
            if tracking <= 0.0 {
                continue;
            }
            let size = paragraph.size();
            let ratio = tracking / size;
            if ratio <= CJK_TRACKING_RATIO {
                continue;
            }
            if worst.is_none_or(|(known, _, _)| ratio > known) {
                worst = Some((ratio, tracking, size));
            }
        }
        let Some((ratio, tracking, size)) = worst else { continue };
        let shown = math::to_fixed(tracking, 1);
        issues.push(json!({
            "code": "cjk_letter_spacing",
            "path": shape_path(&text_box.frame),
            "message": format!(
                "Hangul or CJK text carries {shown}pt of tracking at {}pt ({}% of the size); the syllables of a word read as separate characters.",
                number_to_string(math::round(size)),
                number_to_string(math::round(ratio * 100.0))
            ),
            "tracking": json_number(shown.parse().unwrap_or(tracking)),
        }));
    }
    issues
}

/// The slides a statement criterion covers: at most five text boxes and one thesis, quote or number in the air.
fn statement_slides(boxes: &[TextBox]) -> Vec<f64> {
    struct Entry {
        slide: f64,
        count: usize,
        sizes: Vec<f64>,
        chars: usize,
    }
    let mut per_slide: Vec<Entry> = Vec::new();
    for text_box in boxes {
        let joined: String = text_box.paragraphs.iter().map(|paragraph| paragraph.text.as_str()).collect();
        let text = js_trim(&joined);
        if text.is_empty() {
            continue;
        }
        let slide = text_box.frame.slide;
        let at = per_slide.iter().position(|entry| entry.slide == slide || (entry.slide.is_nan() && slide.is_nan()));
        let entry = match at {
            Some(at) => &mut per_slide[at],
            None => {
                per_slide.push(Entry { slide, count: 0, sizes: Vec::new(), chars: 0 });
                per_slide.last_mut().expect("an entry was just pushed")
            }
        };
        entry.count += 1;
        entry.sizes.push(largest_font_size(&text_box.paragraphs));
        entry.chars += utf16_len(text);
    }
    per_slide
        .into_iter()
        .filter(|entry| {
            if entry.count > 5 {
                return false;
            }
            let largest = entry.sizes.iter().fold(f64::NEG_INFINITY, |top, size| math::max(top, *size));
            largest >= 42.0 || entry.sizes.iter().filter(|size| **size >= 34.0).count() >= 2 || (largest >= 24.0 && entry.chars <= 280)
        })
        .map(|entry| entry.slide)
        .collect()
}

/// A device the kit drew (the motif, the orb, an icon) is decoration placed as a picture, not the page's carrier.
fn is_device_name(name: &str) -> bool {
    name.starts_with("mixdog-svg:") || name.starts_with("mixdog-device:") || name == "Icon"
}

/// A table, chart, picture or group is the page's carrier.
fn carries_object(content: &[&Bound]) -> bool {
    content.iter().any(|shape| matches!(shape.kind.as_str(), "p:graphicFrame" | "p:pic" | "p:grpSp") && !is_device_name(&shape.name))
}

/// The deepest empty band between the slide's content, measured on merged intervals: `(depth, top)`.
fn hollow_band(content: &[&Bound]) -> (f64, f64) {
    let mut intervals: Vec<(f64, f64)> = content.iter().map(|shape| (shape.top, shape.top + math::max(0.0, shape.height))).collect();
    intervals.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut reach = intervals.first().map_or(0.0, |first| first.1);
    let (mut depth, mut top) = (0.0, 0.0);
    for (start, end) in intervals.iter().skip(1) {
        if start - reach > depth {
            depth = start - reach;
            top = reach;
        }
        reach = math::max(reach, *end);
    }
    (depth, top)
}

/// A page the statement exemption covers that is no statement: a title in the top quarter, nothing at poster size, and a
/// line of 14 pt or more with a hollow band between them: `(depth, top)` of the band.
fn title_line_hollow(slide_boxes: &[&TextBox], content: &[&Bound], slide_height: f64) -> Option<(f64, f64)> {
    let texts: Vec<(&TextBox, f64)> =
        slide_boxes.iter().map(|text_box| (*text_box, largest_font_size(&text_box.paragraphs))).filter(|(text_box, _)| has_text(text_box)).collect();
    if texts.len() < 2 {
        return None;
    }
    let mut title = 0;
    for (at, (_, size)) in texts.iter().enumerate() {
        if *size > texts[title].1 {
            title = at;
        }
    }
    let (title_box, title_size) = texts[title];
    if title_size < 24.0 || title_size >= 34.0 || !(title_box.frame.top < slide_height * 0.25) {
        return None;
    }
    let (depth, top) = hollow_band(content);
    if depth <= HOLLOW_BAND || top < title_box.frame.top + title_box.frame.height - 1.0 {
        return None;
    }
    let below = top + depth - 1.0;
    texts.iter().enumerate().any(|(at, (other, size))| at != title && *size >= 14.0 && other.frame.top >= below).then_some((depth, top))
}

/// `reviewVerticalBalance(bounds, { slideWidth, slideHeight, boxes })`: content bunched at one edge, or an empty band
/// between blocks; a statement page is balanced by its air.
pub fn review_vertical_balance(bounds: &[Bound], slide_width: f64, slide_height: f64, boxes: &[TextBox]) -> Vec<Value> {
    if !(slide_height > 0.0) || !(slide_width > 0.0) {
        return Vec::new();
    }
    let mut issues = Vec::new();
    let statements = statement_slides(boxes);
    for (slide, shapes) in by_slide(bounds, |bound| bound.slide) {
        let content: Vec<&Bound> =
            shapes.into_iter().filter(|shape| math::max(0.0, shape.width) * math::max(0.0, shape.height) < slide_width * slide_height * 0.8).collect();
        if content.is_empty() {
            continue;
        }
        let slide_path = format!("/slide[{}]", number_to_string(slide));
        if statements.iter().any(|known| *known == slide || (known.is_nan() && slide.is_nan())) && !carries_object(&content) {
            let slide_boxes: Vec<&TextBox> = boxes.iter().filter(|text_box| text_box.frame.slide == slide).collect();
            if let Some((depth, top)) = title_line_hollow(&slide_boxes, &content, slide_height) {
                issues.push(json!({
                    "severity": "info",
                    "code": "title_line_hollow",
                    "path": slide_path,
                    "message": format!(
                        "Only a title and a line under it, with an empty band {}pt deep between them. A statement page sets its claim large in the air; a content page brings its evidence into the band, or moves the line up under the title.",
                        number_to_string(math::round(depth))
                    ),
                    "hollowBand": json_number(math::round(depth)),
                    "hollowTop": json_number(math::round(top)),
                }));
            }
            continue;
        }
        issues.extend(vertical_imbalance_issue(&slide_path, &content, slide_height));
    }
    issues
}

fn vertical_imbalance_issue(slide_path: &str, content: &[&Bound], slide_height: f64) -> Option<Value> {
    let top = content.iter().fold(f64::INFINITY, |least, shape| math::min(least, shape.top));
    let bottom = content.iter().fold(f64::NEG_INFINITY, |most, shape| math::max(most, shape.top + shape.height));
    let top_empty = math::max(0.0, top);
    let bottom_empty = math::max(0.0, slide_height - bottom);
    let heavy_bottom = bottom_empty > slide_height * 0.3 && bottom_empty - top_empty > slide_height * 0.24;
    let heavy_top = top_empty > slide_height * 0.3 && top_empty - bottom_empty > slide_height * 0.24;
    if !heavy_bottom && !heavy_top {
        let (depth, band_top) = hollow_band(content);
        return (depth > HOLLOW_BAND).then(|| {
            json!({
                "code": "vertical_imbalance",
                "path": slide_path,
                "message": format!(
                    "An empty band {}pt deep ({}in) runs from {}pt to {}pt with content above and below it; extend a region into the band or move the lower block up.",
                    number_to_string(math::round(depth)),
                    math::to_fixed(depth / 72.0, 2),
                    number_to_string(math::round(band_top)),
                    number_to_string(math::round(band_top + depth))
                ),
                "hollowBand": json_number(math::round(depth)),
                "hollowTop": json_number(math::round(band_top)),
            })
        });
    }
    let message = if heavy_bottom {
        format!(
            "Content ends {}pt above the slide bottom while starting {}pt from the top; rebalance the layout or extend content regions downward.",
            number_to_string(math::round(bottom_empty)),
            number_to_string(math::round(top_empty))
        )
    } else {
        format!(
            "Content starts {}pt from the slide top while ending {}pt above the bottom; rebalance the layout upward.",
            number_to_string(math::round(top_empty)),
            number_to_string(math::round(bottom_empty))
        )
    };
    Some(json!({
        "code": "vertical_imbalance",
        "path": slide_path,
        "message": message,
        "emptyTop": json_number(math::round(top_empty)),
        "emptyBottom": json_number(math::round(bottom_empty)),
    }))
}

/// `reviewStatLabelProximity(boxes, { maximumGap })`: declared value and label pairs, and a large figure far from any
/// small text near it.
pub fn review_stat_label_proximity(boxes: &[TextBox], maximum_gap: f64) -> Vec<Value> {
    let mut issues = Vec::new();
    for (slide, shapes) in by_slide(boxes, |text_box| text_box.frame.slide) {
        let frames: Vec<RelationBox> = shapes.iter().map(|text_box| text_box.frame.clone()).collect();
        issues.extend(review_declared_relations(&frames, maximum_gap));
        for at in 0..shapes.len() {
            issues.extend(detached_stat_issue(slide, &shapes, at, maximum_gap));
        }
    }
    issues
}

fn detached_stat_issue(slide: f64, shapes: &[&TextBox], at: usize, maximum_gap: f64) -> Option<Value> {
    let text_box = shapes[at];
    if text_box.frame.relation.as_ref().is_some_and(|relation| relation.role == "value") {
        return None;
    }
    let texts: Vec<&str> = text_box.paragraphs.iter().map(|paragraph| paragraph.text.as_str()).collect();
    let text = js_trim(&texts.join(" ")).to_owned();
    let size = largest_font_size(&text_box.paragraphs);
    if size < 28.0 || text.is_empty() || utf16_len(&text) > 16 || !text.chars().any(|character| character.is_ascii_digit()) {
        return None;
    }
    let letters = LETTER.find_iter(&text).count();
    let compact = text.chars().filter(|character| !is_js_space(*character)).map(char::len_utf16).sum::<usize>();
    if letters as f64 > compact as f64 * 0.5 {
        return None;
    }
    let mut nearest: Option<f64> = None;
    for (other_at, candidate) in shapes.iter().enumerate() {
        if other_at == at
            || largest_font_size(&candidate.paragraphs) > 20.0
            || !candidate.paragraphs.iter().any(|paragraph| !js_trim(&paragraph.text).is_empty())
        {
            continue;
        }
        let distance = rectangle_gap(&text_box.frame, &candidate.frame);
        if nearest.is_none_or(|known| distance < known) {
            nearest = Some(distance);
        }
    }
    let gap = nearest.filter(|gap| *gap > maximum_gap)?;
    Some(json!({
        "code": "stat_label_detached",
        "severity": "info",
        "confidence": "inferred",
        "path": format!("/slide[{}]/shape[{}]", number_to_string(slide), number_to_string(text_box.frame.shape)),
        "message": format!(
            "The stat \"{text}\" is {}pt from the nearest small text. Its label is unknown; inspect the relationship before moving either element.",
            number_to_string(math::round(gap))
        ),
        "gap": json_number(math::round(gap)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_fsio::Unlaned;
    use std::path::PathBuf;

    fn frame(slide: f64, shape: f64, left: f64, top: f64, width: f64, height: f64) -> RelationBox {
        RelationBox { slide, shape, left, top, width, height, relation: None, relation_error: None }
    }

    fn boxed(slide: f64, shape: f64, left: f64, top: f64, width: f64, height: f64, text: &str, size: f64) -> TextBox {
        let mut text_box = TextBox::new(frame(slide, shape, left, top, width, height));
        text_box.paragraphs = vec![Paragraph { text: text.to_owned(), font_size: Some(size), ..Paragraph::default() }];
        text_box
    }

    fn font(name: &str, size: f64) -> FontSpec {
        FontSpec { font_name: Some(name.to_owned()), font_size: Some(size), ..FontSpec::default() }
    }

    #[test]
    fn segments_bind_closing_marks_back_and_opening_marks_forward() {
        assert_eq!(segments("a b"), ["a", " ", "b"]);
        assert_eq!(segments("한글, 끝."), ["한", "글,", " ", "끝."]);
        assert_eq!(segments("(가) 나"), ["(가)", " ", "나"]);
        assert_eq!(segments("「가」"), ["「가」"]);
        assert_eq!(segments("a ,b"), ["a", " ", ",b"]);
    }

    #[test]
    fn a_closing_mark_after_a_space_stays_apart() {
        assert_eq!(segments(" ."), [" ", "."]);
    }

    #[test]
    fn contrast_follows_wcag() {
        assert!((contrast_ratio("000000", "FFFFFF").expect("a ratio") - 21.0).abs() < 1e-9);
        assert_eq!(contrast_ratio("#ffffff", "ffffff"), Some(1.0));
        assert_eq!(contrast_ratio("zzzzzz", "ffffff"), None);
        assert_eq!(relative_luminance("12345"), None);
        assert_eq!(relative_luminance("xx000000"), Some(0.0));
    }

    #[test]
    fn low_contrast_is_judged_by_the_size_of_the_text() {
        let mut small = boxed(1.0, 2.0, 0.0, 0.0, 100.0, 40.0, "hello", 12.0);
        small.background = Some("FFFFFF".to_owned());
        small.paragraphs[0].color = Some("999999".to_owned());
        let mut large = small.clone();
        large.paragraphs[0].font_size = Some(20.0);
        large.paragraphs[0].color = Some("888888".to_owned());
        let found = review_text_contrast(&[small, large]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["code"], "low_contrast");
        assert_eq!(found[0]["path"], "/slide[1]/shape[2]");
        assert_eq!(found[0]["minimum"], 4.5);
        assert_eq!(found[0]["message"], "Text contrast is 2.85:1 against its background; 4.5:1 is the readable minimum at 12pt.");
    }

    #[test]
    fn neighbours_closer_than_the_gap_are_reported_unless_labels_or_aligned() {
        let a = boxed(1.0, 1.0, 0.0, 0.0, 100.0, 50.0, "A long block of body copy", 14.0);
        let b = boxed(1.0, 2.0, 0.0, 60.0, 100.0, 50.0, "Another long block of body copy", 14.0);
        let c = boxed(1.0, 3.0, 110.0, 0.0, 100.0, 50.0, "A third long block of body copy", 14.0);
        let found = review_shape_spacing(&[a.clone(), b.clone(), c.clone()], 21.6);
        // a-b are aligned columns (skipped), a-c sit 10 pt apart in a row, b-c are diagonal.
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["path"], "/slide[1]/shape[3]");
        assert_eq!(found[0]["gap"], 10.0);
        assert_eq!(found[0]["message"], "Shapes 1 and 3 sit 10.0pt apart; keep at least 21.6pt between blocks.");
        let label = boxed(1.0, 3.0, 110.0, 0.0, 100.0, 50.0, "Step 1", 14.0);
        assert!(review_shape_spacing(&[a, label], 21.6).is_empty());
    }

    #[test]
    fn tracking_over_five_percent_of_hangul_is_reported() {
        let mut spaced = boxed(2.0, 4.0, 0.0, 0.0, 100.0, 40.0, "안녕하세요", 20.0);
        spaced.paragraphs[0].char_spacing = 2.0;
        let mut latin = boxed(2.0, 5.0, 0.0, 0.0, 100.0, 40.0, "KICKER", 20.0);
        latin.paragraphs[0].char_spacing = 4.0;
        let found = review_cjk_tracking(&[spaced, latin]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["tracking"], 2.0);
        assert_eq!(
            found[0]["message"],
            "Hangul or CJK text carries 2.0pt of tracking at 20pt (10% of the size); the syllables of a word read as separate characters."
        );
    }

    #[test]
    fn vertical_balance_reports_bottom_heavy_and_hollow_pages() {
        let bound = |top: f64, height: f64| Bound { slide: 1.0, left: 0.0, top, width: 200.0, height, kind: "p:sp".into(), name: String::new() };
        let heavy = review_vertical_balance(&[bound(10.0, 100.0)], 720.0, 540.0, &[]);
        assert_eq!(heavy.len(), 1);
        assert_eq!(heavy[0]["emptyTop"], 10.0);
        assert_eq!(heavy[0]["emptyBottom"], 430.0);
        let hollow = review_vertical_balance(&[bound(10.0, 100.0), bound(240.0, 290.0)], 720.0, 540.0, &[]);
        assert_eq!(hollow[0]["hollowBand"], 130.0);
        assert_eq!(hollow[0]["hollowTop"], 110.0);
        assert!(review_vertical_balance(&[bound(0.0, 400.0)], 0.0, 540.0, &[]).is_empty());
    }

    #[test]
    fn a_title_over_an_empty_middle_is_information_on_a_statement_page() {
        let bound = |top: f64, height: f64| Bound { slide: 1.0, left: 0.0, top, width: 200.0, height, kind: "p:sp".into(), name: String::new() };
        let title = boxed(1.0, 1.0, 0.0, 20.0, 600.0, 60.0, "A claim", 28.0);
        let takeaway = boxed(1.0, 2.0, 0.0, 400.0, 600.0, 40.0, "The takeaway", 16.0);
        let found = review_vertical_balance(&[bound(20.0, 60.0), bound(400.0, 40.0)], 720.0, 540.0, &[title, takeaway]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["code"], "title_line_hollow");
        assert_eq!(found[0]["severity"], "info");
        assert_eq!(found[0]["hollowBand"], 320.0);
    }

    #[test]
    fn a_declared_label_and_a_figure_far_from_small_text_are_reviewed() {
        let figure = boxed(1.0, 1.0, 0.0, 0.0, 100.0, 60.0, "47,210", 40.0);
        let caption = boxed(1.0, 2.0, 0.0, 300.0, 100.0, 20.0, "Revenue", 12.0);
        let found = review_stat_label_proximity(&[figure, caption], 36.0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["code"], "stat_label_detached");
        assert_eq!(found[0]["confidence"], "inferred");
        assert_eq!(found[0]["gap"], 240.0);
    }

    #[test]
    fn font_names_resolve_to_the_registered_family_and_weight() {
        let empty = Registry::new();
        let measurer = TextMeasurer::new(&Unlaned, &empty);
        assert_eq!(measurer.resolve_font(Some("맑은 고딕")), ("Malgun Gothic".to_owned(), 0));
        assert_eq!(measurer.resolve_font(Some("\"Calibri Light\"")), ("Calibri".to_owned(), 300));
        assert_eq!(measurer.resolve_font(Some("Malgun Gothic Semilight")), ("Malgun Gothic".to_owned(), 300));
        assert_eq!(measurer.resolve_font(None), ("Calibri".to_owned(), 0));
        assert_eq!(measurer.resolve_font(Some("")), ("Calibri".to_owned(), 0));
        assert!(measurer.font_available("Anything"));
        let bold = FontSpec { font_name: Some("Arial".into()), font_size: Some(0.0), bold: true, italic: true };
        assert_eq!(measurer.font_spec(&bold), "italic 700 18px \"Arial\"");
        assert_eq!(measurer.font_spec(&font("Calibri Light", 13.5)), "300 13.5px \"Calibri\"");
    }

    #[test]
    fn soft_breaks_carry_the_spacing_to_the_first_and_last_line() {
        let paragraph = Paragraph {
            text: "big\nsmall".to_owned(),
            font_size: Some(14.0),
            space_before: 4.0,
            space_after: 6.0,
            runs: Some(vec![Run { text: "big\n".into(), font_size: Some(14.0) }, Run { text: "small".into(), font_size: Some(10.0) }]),
            ..Paragraph::default()
        };
        let lines = soft_break_lines(&paragraph);
        assert_eq!(lines.len(), 2);
        assert_eq!((lines[0].text.as_str(), lines[0].font_size, lines[0].space_before, lines[0].space_after), ("big", Some(14.0), 4.0, 0.0));
        assert_eq!((lines[1].text.as_str(), lines[1].font_size, lines[1].space_before, lines[1].space_after), ("small", Some(10.0), 0.0, 6.0));
        assert!(lines.iter().all(|line| line.runs.is_none()));
    }

    fn faces() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts")
    }
    // Every entry is a family name registered over the one face the repository carries; the file named only tells the
    // entries apart.
    fn registry(entries: &[(&str, &str)]) -> Registry {
        let mut registry = Registry::new();
        for (_, family) in entries {
            registry.register_file(&Unlaned, &faces().join("LiberationSans-Regular.ttf"), Some(family)).expect("the repository face registers");
        }
        registry
    }
    #[test]
    fn an_installed_family_keeps_its_weight_suffix_and_a_missing_one_takes_its_metric_twin() {
        let registered =
            registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu"), ("MiriamLibre-Regular.otf", "Carlito"), ("NotoSansHebrew-Regular.ttf", "Twin Lisu Light")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        assert_eq!(measurer.resolve_font(Some("Twin Lisu Light")), ("Twin Lisu Light".to_owned(), 0));
        assert_eq!(measurer.resolve_font(Some("Twin Lisu Semibold")), ("Twin Lisu".to_owned(), 600));
        assert_eq!(measurer.resolve_font(Some("Calibri")), ("Carlito".to_owned(), 0));
        assert!(measurer.font_available("Calibri"));
        assert!(measurer.font_available("Twin Lisu Medium"));
        assert!(!measurer.font_available("Zzz Missing"));
        assert!(measurer.font_available(""));
    }
    #[test]
    fn a_calibrated_face_is_widened_per_script_class() {
        let registered = registry(&[("MiriamLibre-Regular.otf", "Malgun Gothic"), ("MiriamLibre-Regular.otf", "Twin Miriam")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let plain = measurer.measure_text_width("Hello World", &font("Twin Miriam", 18.0)).expect("measures");
        let calibrated = measurer.measure_text_width("Hello World", &font("Malgun Gothic", 18.0)).expect("measures");
        assert!(plain > 0.0);
        assert_eq!(calibrated, plain * 1.032);
        assert_eq!(measurer.measure_text_width("", &font("Twin Miriam", 18.0)), Ok(0.0));
        assert!(measurer.measure_text_width("a\0b", &font("Twin Miriam", 18.0)).is_err());
    }
    #[test]
    fn hangul_in_a_latin_face_is_measured_in_the_east_asian_fallback() {
        assert_eq!(TextMeasurer::new(&Unlaned, &Registry::new()).cjk_fallback, "Malgun Gothic");
        let registered = registry(&[("MiriamLibre-Regular.otf", "Twin Miriam"), ("NotoSansLisu-Regular.ttf", "Noto Sans KR")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        assert_eq!(measurer.cjk_fallback, "Noto Sans KR");
        let latin = font("Twin Miriam", 18.0);
        let mixed = measurer.measure_text_width("Hi 안녕", &latin).expect("measures");
        let head = measurer.measure_text_width("Hi ", &latin).expect("measures");
        let tail = measurer.measure_text_width("안녕", &font("Noto Sans KR", 18.0)).expect("measures");
        assert_eq!(mixed, head + tail);
    }
    #[test]
    fn a_paragraph_wraps_at_spaces_and_a_long_word_between_characters() {
        let registered = registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let spec = font("Twin Lisu", 16.0);
        let one = measurer.measure_text_width("alpha", &spec).expect("measures");
        let lines = measurer.wrap_paragraph("alpha alpha alpha", one * 1.5, &spec).expect("wraps");
        assert_eq!(lines, ["alpha", "alpha", "alpha"]);
        assert_eq!(measurer.wrap_paragraph("", 100.0, &spec), Ok(vec![String::new()]));
        let broken = measurer.wrap_paragraph("alphaalphaalpha", one * 1.2, &spec).expect("wraps");
        assert!(broken.len() > 1);
        assert_eq!(broken.concat(), "alphaalphaalpha");
        assert!(broken.iter().all(|line| !line.is_empty()));
    }
    #[test]
    fn a_block_is_as_tall_as_its_lines_at_one_point_two_em() {
        let registered = registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let paragraph = Paragraph {
            text: "first\nsecond".to_owned(),
            font_name: Some("Twin Lisu".to_owned()),
            font_size: Some(20.0),
            space_before: 3.0,
            space_after: 5.0,
            ..Paragraph::default()
        };
        let block = measurer.measure_text_block(&[paragraph.clone()], &BlockOptions { width: 1000.0, ..BlockOptions::default() }).expect("measures");
        assert_eq!(block.lines, 2);
        assert!((block.height - (2.0 * 20.0 * 1.2 + 3.0 + 5.0)).abs() < 1e-9);
        let spaced =
            measurer.measure_text_block(&[paragraph], &BlockOptions { width: 1000.0, line_spacing: 1.5, ..BlockOptions::default() }).expect("measures");
        assert!((spaced.height - (2.0 * 20.0 * 1.2 * 1.5 + 3.0 + 5.0)).abs() < 1e-9);
    }
    #[test]
    fn a_box_too_short_overflows_and_an_unknown_font_makes_it_approximate() {
        let registered = registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let mut text_box = boxed(3.0, 7.0, 0.0, 0.0, 400.0, 20.0, "alpha beta gamma delta epsilon", 20.0);
        text_box.paragraphs[0].font_name = Some("Twin Lisu".to_owned());
        let found = measurer.review_text_box_fit(&[text_box.clone()], &FitOptions::default()).expect("reviews");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["code"], "text_overflow");
        assert_eq!(found[0]["path"], "/slide[3]/shape[7]");
        text_box.paragraphs[0].font_name = Some("Zzz Missing".to_owned());
        let found = measurer.review_text_box_fit(&[text_box.clone()], &FitOptions::default()).expect("reviews");
        assert_eq!(found[0]["code"], "font_unavailable");
        assert_eq!(found[0]["font"], "Zzz Missing");
        text_box.autofit = true;
        assert!(measurer.review_text_box_fit(&[text_box], &FitOptions::default()).expect("reviews").is_empty());
    }
    #[test]
    fn a_shape_past_the_slide_edge_is_reported() {
        let registered = registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let mut text_box = boxed(1.0, 1.0, 700.0, 0.0, 100.0, 400.0, "hi", 12.0);
        text_box.paragraphs[0].font_name = Some("Twin Lisu".to_owned());
        let options = FitOptions { slide_width: 720.0, slide_height: 540.0, ..FitOptions::default() };
        let found = measurer.review_text_box_fit(&[text_box], &options).expect("reviews");
        assert_eq!(found.last().map(|issue| issue["code"].clone()), Some(json!("shape_out_of_bounds")));
    }
    #[test]
    fn shrinking_lands_on_the_type_ladder_and_gives_up_with_zero() {
        let registered = registry(&[("NotoSansLisu-Regular.ttf", "Twin Lisu")]);
        let measurer = TextMeasurer::new(&Unlaned, &registered);
        let paragraph = Paragraph { text: "alpha beta gamma".into(), font_name: Some("Twin Lisu".into()), font_size: Some(30.0), ..Paragraph::default() };
        let roomy = measurer
            .shrink_font_size_to_fit(&[paragraph.clone()], &ShrinkOptions { width: 2000.0, height: 100.0, ..ShrinkOptions::default() })
            .expect("shrinks");
        assert_eq!(roomy, Shrunk { scale: 1.0, sizes: vec![30.0] });
        let tight = measurer
            .shrink_font_size_to_fit(&[paragraph.clone()], &ShrinkOptions { width: 2000.0, height: 20.0, ..ShrinkOptions::default() })
            .expect("shrinks");
        assert!(tight.scale > 0.0 && tight.scale < 1.0 && tight.sizes[0] < 30.0);
        let none = measurer.shrink_font_size_to_fit(&[paragraph], &ShrinkOptions { width: 2000.0, height: 1.0, ..ShrinkOptions::default() }).expect("shrinks");
        assert_eq!(none, Shrunk { scale: 0.0, sizes: Vec::new() });
    }
}
