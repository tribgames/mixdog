//! Text on a slide: what `addText` is given (`TextProps`, `TextPropsOptions`), how pptxgenjs 4.0.1 cleans those
//! options (`addTextDefinition`), and the `p:sp` it writes for a text box with its `p:txBody` (`genXmlTextBody` with
//! `genXmlBodyProperties`, `genXmlParagraphProperties`, `genXmlTextRunProperties` and `genXmlTextRun`). The text body
//! writer is shared with the table cells (`table`): a cell is a `tablecell` object of the same function.
//!
//! pptxgenjs keeps its options as JavaScript objects that the writer mutates while it writes: a string given to
//! `addText` shares the options object of the call with its one run, a run without options of a table cell shares
//! the options of the cell, `opts.fontSize` is filled in by the first run that has a size and then reaches the runs
//! after it, and a paragraph's options are copied into every run of it. The writer here keeps every options object in
//! one list (the object's own options first) and runs hold an index into it, so the same sharing happens.
//!
//! Not carried: placeholders (`placeholder`, `defineSlideMaster`'s objects), the custom geometry points
//! (`shape: 'custGeom'`) and the deprecated spellings of options (`lineSize`, `lineDash`, `lineHead`, `lineTail`).

use super::shapes::{
    Fill, Hyperlink, Line, ShapeOptions, adjustments_xml, color_element, color_selection, line_xml, link_click_xml, location_attributes, shape_shadow_xml,
};
use super::{Axis, CRLF, Dim, Layout, ONE_PT, encode_xml_entities, inch_to_emu, is_set, num, or, round, smart_parse, val_to_pts};

const DEFAULT_FONT_COLOR: &str = "000000";
const DEFAULT_SHAPE_LINE_COLOR: &str = "333333";
const DEFAULT_BULLET_MARGIN: f64 = 27.0;
const DEFAULT_BULLET: &str = "&#x2022;";

/// `margin` of a text box (points, in the order left, right, bottom, top) or of a table cell (inches, top, right,
/// bottom, left): one number for all four sides, or a list.
#[derive(Debug, Clone, PartialEq)]
pub enum Margin {
    All(f64),
    Each(Vec<f64>),
}

/// `strike`: `true` is a single strike, a string is the strike type.
#[derive(Debug, Clone, PartialEq)]
pub enum Strike {
    Flag(bool),
    Style(String),
}

/// `underline`: a flag (a text box turns `true` into a single underline, a table cell does not), a style with an
/// optional colour, or the style as a string.
#[derive(Debug, Clone, PartialEq)]
pub enum Underline {
    Flag(bool),
    Style { style: Option<String>, color: Option<String> },
    Text(String),
}

/// `glow` of a run: size in points, colour, opacity 0-1 (the unset ones are 8, `FFFFFF`, 0.75).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Glow {
    pub size: Option<f64>,
    pub color: Option<String>,
    pub opacity: Option<f64>,
}

/// `outline` of a run: size in points (0.75) and colour (`FFFFFF`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outline {
    pub size: Option<f64>,
    pub color: Option<String>,
}

/// `bullet` of a paragraph: `true`/`false`, or the details of a bullet.
#[derive(Debug, Clone, PartialEq)]
pub enum Bullet {
    Flag(bool),
    Spec(BulletSpec),
}

/// `bullet` as an object: `indent` in points, `type` (`number` for a numbered list), the numbering `style`, where the
/// numbering starts, or the code of a bullet character (four hex digits).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BulletSpec {
    pub indent: Option<f64>,
    pub kind: Option<String>,
    pub style: Option<String>,
    pub number_start_at: Option<f64>,
    pub start_at: Option<f64>,
    pub character_code: Option<String>,
    pub code: Option<String>,
}

/// One tab stop: position in inches (1 when unset) and alignment (`l`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TabStop {
    pub position: Option<f64>,
    pub alignment: Option<String>,
}

/// One side of a table cell's border: `type` (`none`, `solid`, `dash`), colour and width in points.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Border {
    pub kind: Option<String>,
    pub color: Option<String>,
    pub pt: Option<f64>,
}

/// `border` of a table or a cell: one object for all four sides, or a list (top, right, bottom, left; a missing or
/// null side has no border).
#[derive(Debug, Clone, PartialEq)]
pub enum Borders {
    One(Border),
    Each(Vec<Option<Border>>),
}

/// The options of `addText`, of the text runs and of a table's cells (`TextPropsOptions`, `TextBaseProps`,
/// `TableCellProps`): the frame of the box (position, fill, outline, shadow, hyperlink...) is the options of a shape.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextOptions {
    pub frame: ShapeOptions,
    /// The preset geometry of the box (`rect` when unset).
    pub shape: Option<String>,
    pub is_text_box: bool,
    pub color: Option<String>,
    pub font_face: Option<String>,
    pub font_size: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    pub strike: Option<Strike>,
    pub underline: Option<Underline>,
    pub baseline: Option<f64>,
    pub subscript: bool,
    pub superscript: bool,
    /// Letter spacing in points.
    pub char_spacing: Option<f64>,
    /// Percent transparent.
    pub transparency: Option<f64>,
    pub highlight: Option<String>,
    pub glow: Option<Glow>,
    pub outline: Option<Outline>,
    pub lang: Option<String>,
    pub align: Option<String>,
    pub valign: Option<String>,
    pub line_spacing: Option<f64>,
    pub line_spacing_multiple: Option<f64>,
    pub indent_level: Option<f64>,
    pub para_space_before: Option<f64>,
    pub para_space_after: Option<f64>,
    pub bullet: Option<Bullet>,
    pub tab_stops: Option<Vec<TabStop>>,
    pub rtl_mode: bool,
    /// The run ends its paragraph.
    pub break_line: bool,
    /// The run starts on a new line of the same paragraph.
    pub soft_break_before: bool,
    pub margin: Option<Margin>,
    pub wrap: Option<bool>,
    pub vert: Option<String>,
    /// `none`, `shrink` or `resize`.
    pub fit: Option<String>,
    pub shrink_text: bool,
    pub auto_fit: bool,
    /// Inches, all four sides (deprecated by pptxgenjs, still read).
    pub inset: Option<f64>,
    /// Table cells: the border, the spans and the text direction.
    pub border: Option<Borders>,
    pub colspan: Option<usize>,
    pub rowspan: Option<usize>,
    pub text_direction: Option<String>,
    /// The relationship the run's or the frame's hyperlink was given (`hyperlink._rId`).
    pub hyperlink_rid: Option<usize>,
}

/// One piece of formatted text (`TextProps`): its text, and its own options.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub options: Option<TextOptions>,
}

/// What `addText` (and a table cell) is given: a string, or a list of runs.
#[derive(Debug, Clone, PartialEq)]
pub enum TextContent {
    Plain(String),
    Runs(Vec<TextRun>),
}

/// Where a text object goes: its place among the slide's objects, how many text-type objects the slide has, and the
/// sheet it is on.
pub(crate) struct Placement<'a> {
    pub index: usize,
    pub text_objects: usize,
    pub layout: &'a Layout,
}

/// A text object on a slide, written (`p:sp` with its text body) when it is added: nothing in it depends on what the
/// slide gets after it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TextObject {
    xml: String,
}

impl TextObject {
    pub(crate) fn xml(&self) -> &str {
        &self.xml
    }

    /// `addTextDefinition` and the text branch of `slideObjectToXml`. `link` is given a hyperlink and returns the
    /// relationship id the slide stored it under.
    pub(crate) fn new(
        content: TextContent,
        options: Option<TextOptions>,
        place: &Placement<'_>,
        link: &mut dyn FnMut(&Hyperlink) -> usize,
    ) -> Result<Self, String> {
        let shared = options.is_some() && matches!(content, TextContent::Plain(_));
        let mut main = options.unwrap_or_default();
        if main.shape.as_deref() == Some("custGeom") {
            return Err("custGeom text boxes are not carried by the pptx writer".to_owned());
        }
        let mut body = clean_options(&mut main, None, place.text_objects)?;
        let main_color = main.color.clone();
        let mut arena = vec![main];
        let mut runs: Vec<Run> = Vec::new();
        match content {
            TextContent::Plain(text) => {
                if shared {
                    body = clean_options(&mut arena[0], None, place.text_objects)?;
                    runs.push(Run { text, opt: 0 });
                } else {
                    let mut own = TextOptions::default();
                    clean_options(&mut own, main_color.as_deref(), place.text_objects)?;
                    arena.push(own);
                    runs.push(Run { text, opt: 1 });
                }
            }
            TextContent::Runs(items) => {
                let items = if items.is_empty() { vec![TextRun::default()] } else { items };
                for item in items {
                    let mut own = item.options.unwrap_or_default();
                    clean_options(&mut own, main_color.as_deref(), place.text_objects)?;
                    arena.push(own);
                    runs.push(Run { text: item.text, opt: arena.len() - 1 });
                }
            }
        }
        register_run_links(&runs, &mut arena, link);
        apply_margin(&arena[0], &mut body);
        let text_body = text_body_xml(BodyKind::Shape, &mut arena, &runs, &body)?;
        let xml = shape_xml(&arena[0], &text_body, place);
        Ok(Self { xml })
    }
}

/// `createHyperlinkRels`: every run's hyperlink gets its relationship once.
fn register_run_links(runs: &[Run], arena: &mut [TextOptions], link: &mut dyn FnMut(&Hyperlink) -> usize) {
    for run in runs {
        let options = &mut arena[run.opt];
        if options.hyperlink_rid.is_none() {
            if let Some(hyperlink) =
                options.frame.hyperlink.as_ref().filter(|hyperlink| hyperlink.url.as_deref().is_some_and(|url| !url.is_empty()) || is_set(hyperlink.slide))
            {
                let rid = link(hyperlink);
                options.hyperlink_rid = Some(rid);
            }
        }
    }
}

/// One run of a text body: its text and the options it reads (an index into the list of options).
pub(crate) struct Run {
    pub text: String,
    pub opt: usize,
}

/// What `_bodyProp` holds: the attributes of `a:bodyPr`.
#[derive(Debug, Clone, Default)]
pub(crate) struct BodyProperties {
    auto_fit: bool,
    anchor: Option<String>,
    vert: Option<String>,
    wrap: bool,
    l_ins: Option<f64>,
    t_ins: Option<f64>,
    r_ins: Option<f64>,
    b_ins: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BodyKind {
    Shape,
    Cell,
}

fn has(text: &Option<String>) -> bool {
    text.as_deref().is_some_and(|text| !text.is_empty())
}

fn bullet_on(bullet: &Option<Bullet>) -> bool {
    match bullet {
        Some(Bullet::Flag(on)) => *on,
        Some(Bullet::Spec(_)) => true,
        None => false,
    }
}

fn underline_on(underline: &Option<Underline>) -> bool {
    match underline {
        Some(Underline::Flag(on)) => *on,
        Some(Underline::Style { .. }) => true,
        Some(Underline::Text(text)) => !text.is_empty(),
        None => false,
    }
}

fn strike_on(strike: &Option<Strike>) -> bool {
    match strike {
        Some(Strike::Flag(on)) => *on,
        Some(Strike::Style(text)) => !text.is_empty(),
        None => false,
    }
}

/// `cleanOpts` of `addTextDefinition`: the colour, the object name, the line, the line spacings, the body properties
/// (anchor, wrap, vertical text, inset), the alignment and the corrected shadow. `main_color` is the colour of the
/// object's own options, which a run takes when it has none.
fn clean_options(options: &mut TextOptions, main_color: Option<&str>, text_objects: usize) -> Result<BodyProperties, String> {
    if !has(&options.color) {
        options.color = Some(main_color.filter(|color| !color.is_empty()).unwrap_or(DEFAULT_FONT_COLOR).to_owned());
    }
    options.frame.object_name = Some(match options.frame.object_name.as_deref() {
        Some(name) if !name.is_empty() => encode_xml_entities(name),
        _ => format!("Text {text_objects}"),
    });
    if options.shape.as_deref() == Some("line") {
        let line = options.frame.line.as_ref().ok_or_else(|| "Cannot read properties of undefined (reading 'type')".to_owned())?;
        options.frame.line = Some(Line {
            kind: Some(line.kind.clone().filter(|kind| !kind.is_empty()).unwrap_or_else(|| "solid".to_owned())),
            color: Some(line.color.clone().filter(|color| !color.is_empty()).unwrap_or_else(|| DEFAULT_SHAPE_LINE_COLOR.to_owned())),
            transparency: Some(or(line.transparency, 0.0)),
            width: Some(or(line.width, 1.0)),
            dash_type: Some(line.dash_type.clone().filter(|dash| !dash.is_empty()).unwrap_or_else(|| "solid".to_owned())),
            begin_arrow_type: line.begin_arrow_type.clone().filter(|arrow| !arrow.is_empty()),
            end_arrow_type: line.end_arrow_type.clone().filter(|arrow| !arrow.is_empty()),
        });
    }
    if options.frame.line.is_none() {
        options.frame.line = Some(Line::default());
    }
    if !is_set(options.line_spacing) {
        options.line_spacing = None;
    }
    if !is_set(options.line_spacing_multiple) {
        options.line_spacing_multiple = None;
    }
    let mut body = BodyProperties {
        auto_fit: options.auto_fit,
        anchor: Some("ctr".to_owned()),
        vert: options.vert.clone().filter(|vert| !vert.is_empty()),
        wrap: options.wrap.unwrap_or(true),
        ..BodyProperties::default()
    };
    if let Some(inset) = options.inset.filter(|inset| !inset.is_nan()) {
        let emu = inch_to_emu(inset);
        body.l_ins = Some(emu);
        body.r_ins = Some(emu);
        body.t_ins = Some(emu);
        body.b_ins = Some(emu);
    }
    if matches!(options.underline, Some(Underline::Flag(true))) {
        options.underline = Some(Underline::Style { style: Some("sng".to_owned()), color: None });
    }
    let valign = options.valign.as_deref().unwrap_or("").to_lowercase();
    if valign.starts_with('b') {
        body.anchor = Some("b".to_owned());
    } else if valign.starts_with('m') {
        body.anchor = Some("ctr".to_owned());
    } else if valign.starts_with('t') {
        body.anchor = Some("t".to_owned());
    }
    options.frame.shadow = options.frame.shadow.take().map(super::shapes::Shadow::corrected);
    Ok(body)
}

/// The margin of a text box, which `slideObjectToXml` sets as the insets after the options are cleaned.
fn apply_margin(options: &TextOptions, body: &mut BodyProperties) {
    match &options.margin {
        Some(Margin::Each(margin)) => {
            let at = |index: usize| val_to_pts(or(margin.get(index).copied(), 0.0));
            body.l_ins = Some(at(0));
            body.r_ins = Some(at(1));
            body.b_ins = Some(at(2));
            body.t_ins = Some(at(3));
        }
        Some(Margin::All(margin)) => {
            let all = val_to_pts(*margin);
            body.l_ins = Some(all);
            body.r_ins = Some(all);
            body.b_ins = Some(all);
            body.t_ins = Some(all);
        }
        None => {}
    }
}

/// The `p:sp` of a text box (`slideObjectToXml`, text case).
fn shape_xml(options: &TextOptions, text_body: &str, place: &Placement<'_>) -> String {
    let frame = &options.frame;
    let layout = place.layout;
    let value = |dim: Option<Dim>, axis: Axis, fallback: f64| dim.map_or(fallback, |dim| smart_parse(dim, axis, layout));
    let x = value(frame.x, Axis::X, 0.0);
    let y = value(frame.y, Axis::Y, 0.0);
    let cx = value(frame.w, Axis::X, smart_parse(Dim::Percent(75.0), Axis::X, layout));
    let cy = value(frame.h, Axis::Y, 0.0);
    let mut xml = String::from("<p:sp>");
    xml.push_str(&format!("<p:nvSpPr><p:cNvPr id=\"{}\" name=\"{}\">", place.index + 2, frame.object_name.as_deref().unwrap_or("")));
    if let Some(link) = &frame.hyperlink {
        let rid = options.hyperlink_rid.map_or_else(|| "undefined".to_owned(), |rid| rid.to_string());
        xml.push_str(&link_click_xml(link, rid));
    }
    xml.push_str("</p:cNvPr>");
    xml.push_str(if options.is_text_box { "<p:cNvSpPr txBox=\"1\"/>" } else { "<p:cNvSpPr/>" });
    xml.push_str("<p:nvPr></p:nvPr>");
    xml.push_str("</p:nvSpPr><p:spPr>");
    xml.push_str(&format!("<a:xfrm{}>", location_attributes(frame.rotate, frame.flip_h, frame.flip_v)));
    xml.push_str(&format!("<a:off x=\"{}\" y=\"{}\"/>", num(x), num(y)));
    xml.push_str(&format!("<a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>", num(cx), num(cy)));
    xml.push_str(&format!(
        "<a:prstGeom prst=\"{}\"><a:avLst>{}</a:avLst></a:prstGeom>",
        options.shape.as_deref().filter(|shape| !shape.is_empty()).unwrap_or("rect"),
        adjustments_xml(frame, cx, cy)
    ));
    match &frame.fill {
        Some(fill) => xml.push_str(&color_selection(fill)),
        None => xml.push_str("<a:noFill/>"),
    }
    if let Some(line) = &frame.line {
        xml.push_str(&line_xml(line));
    }
    if let Some(shadow) = &frame.shadow {
        xml.push_str(&shape_shadow_xml(shadow));
    }
    xml.push_str("</p:spPr>");
    xml.push_str(text_body);
    xml.push_str("</p:sp>");
    xml
}

/// `genXmlBodyProperties`.
fn body_properties_xml(kind: BodyKind, main: &TextOptions, body: &BodyProperties) -> String {
    if kind == BodyKind::Cell {
        return "<a:bodyPr/>".to_owned();
    }
    let mut xml = String::from("<a:bodyPr");
    xml.push_str(if body.wrap { " wrap=\"square\"" } else { " wrap=\"none\"" });
    for (name, value) in [("lIns", body.l_ins), ("tIns", body.t_ins), ("rIns", body.r_ins), ("bIns", body.b_ins)] {
        if let Some(value) = value.filter(|value| !value.is_nan()) {
            xml.push_str(&format!(" {name}=\"{}\"", num(value)));
        }
    }
    xml.push_str(" rtlCol=\"0\"");
    if let Some(anchor) = body.anchor.as_deref().filter(|anchor| !anchor.is_empty()) {
        xml.push_str(&format!(" anchor=\"{anchor}\""));
    }
    if let Some(vert) = &body.vert {
        xml.push_str(&format!(" vert=\"{vert}\""));
    }
    xml.push('>');
    match main.fit.as_deref() {
        Some("shrink") => xml.push_str("<a:normAutofit/>"),
        Some("resize") => xml.push_str("<a:spAutoFit/>"),
        _ => {}
    }
    if main.shrink_text {
        xml.push_str("<a:normAutofit/>");
    }
    if body.auto_fit {
        xml.push_str("<a:spAutoFit/>");
    }
    xml.push_str("</a:bodyPr>");
    xml
}

/// The text of a run with every line break as CRLF (`replace(/\r*\n/g, CRLF)`).
fn crlf_breaks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut carriage_returns = 0;
    for ch in text.chars() {
        match ch {
            '\r' => carriage_returns += 1,
            '\n' => {
                carriage_returns = 0;
                out.push_str(CRLF);
            }
            other => {
                out.extend(std::iter::repeat_n('\r', carriage_returns));
                carriage_returns = 0;
                out.push(other);
            }
        }
    }
    out.extend(std::iter::repeat_n('\r', carriage_returns));
    out
}

/// `genXmlTextBody`: `arena[0]` is the options of the object (`opts`), a run reads the options at its index. The
/// text of a table cell is written with [`BodyKind::Cell`].
pub(crate) fn text_body_xml(kind: BodyKind, arena: &mut [TextOptions], runs: &[Run], body: &BodyProperties) -> Result<String, String> {
    let cell = kind == BodyKind::Cell;
    let mut xml = String::from(if cell { "<a:txBody>" } else { "<p:txBody>" });
    xml.push_str(&body_properties_xml(kind, &arena[0], body));
    let main = &arena[0];
    if main.frame.h == Some(Dim::Number(0.0)) && main.frame.line.is_some() && has(&main.align) {
        xml.push_str("<a:lstStyle><a:lvl1pPr algn=\"l\"/></a:lstStyle>");
    } else {
        xml.push_str("<a:lstStyle/>");
    }
    let texts = split_run_lines(arena, runs);
    let lines = group_paragraphs(arena, &texts);
    for line in &lines {
        let mut closing_font_size = false;
        xml.push_str("<a:p>");
        for (position, &text_index) in line.iter().enumerate() {
            let (text, opt) = (&texts[text_index].0, texts[text_index].1);
            if position > 0 && arena[opt].soft_break_before {
                xml.push_str("<a:br/>");
            }
            let main = arena[0].clone();
            inherit_paragraph(&mut arena[opt], &main);
            let paragraph = paragraph_properties_xml(&arena[opt]);
            xml.push_str(&paragraph.replacen("<a:pPr></a:pPr>", "", 1));
            let own_link = arena[opt].frame.hyperlink.is_some();
            inherit_run(&mut arena[opt], &main, own_link);
            if !text.is_empty() {
                xml.push_str(&format!("<a:r>{}<a:t>{}</a:t></a:r>", run_properties_xml(&arena[opt])?, encode_xml_entities(text)));
            }
            let run_size = arena[opt].font_size;
            if (text.is_empty() && is_set(arena[0].font_size)) || is_set(run_size) {
                closing_font_size = true;
                if !is_set(arena[0].font_size) {
                    arena[0].font_size = run_size;
                }
            }
        }
        xml.push_str(&end_paragraph_xml(&arena[0], cell, closing_font_size));
        xml.push_str("</a:p>");
    }
    if !xml.contains("<a:p>") {
        xml.push_str("<a:p><a:endParaRPr/></a:p>");
    }
    xml.push_str(if cell { "</a:txBody>" } else { "</p:txBody>" });
    Ok(xml)
}

/// Breaks the text of each run at its line breaks; returns each piece with the index of the options it reads.
fn split_run_lines(arena: &mut [TextOptions], runs: &[Run]) -> Vec<(String, usize)> {
    let mut texts: Vec<(String, usize)> = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let opt = run.opt;
        if index == 0 && !bullet_on(&arena[opt].bullet) && bullet_on(&arena[0].bullet) {
            arena[opt].bullet = arena[0].bullet.clone();
        }
        let text = crlf_breaks(&run.text);
        if text.contains(CRLF) && !text.ends_with('\n') {
            for line in text.split(CRLF) {
                arena[opt].break_line = true;
                texts.push((line.to_owned(), opt));
            }
        } else {
            texts.push((text, opt));
        }
    }
    texts
}

/// Groups the pieces of text into paragraphs, each a list of indices into `texts`.
fn group_paragraphs(arena: &mut [TextOptions], texts: &[(String, usize)]) -> Vec<Vec<usize>> {
    let mut lines: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for index in 0..texts.len() {
        let opt = texts[index].1;
        if !current.is_empty() && (has(&arena[opt].align) || has(&arena[0].align)) {
            let previous = texts[index - 1].1;
            if arena[opt].align != arena[previous].align {
                lines.push(std::mem::take(&mut current));
            }
        } else if !current.is_empty() && bullet_on(&arena[opt].bullet) {
            lines.push(std::mem::take(&mut current));
            arena[opt].break_line = false;
        }
        current.push(index);
        if arena[opt].break_line && index + 1 < texts.len() {
            lines.push(std::mem::take(&mut current));
        }
        if index + 1 == texts.len() {
            lines.push(std::mem::take(&mut current));
        }
    }
    lines
}

fn end_paragraph_xml(opts: &TextOptions, cell: bool, closing_font_size: bool) -> String {
    let lang = opts.lang.as_deref().filter(|lang| !lang.is_empty()).unwrap_or("en-US");
    let size = if is_set(opts.font_size) { format!(" sz=\"{}\"", num(round(opts.font_size.unwrap_or(0.0) * 100.0))) } else { String::new() };
    if cell && (is_set(opts.font_size) || has(&opts.font_face)) {
        if let Some(face) = opts.font_face.as_deref().filter(|face| !face.is_empty()) {
            format!(
                "<a:endParaRPr lang=\"{lang}\"{size} dirty=\"0\"><a:latin typeface=\"{face}\" charset=\"0\"/><a:ea typeface=\"{face}\" charset=\"0\"/><a:cs typeface=\"{face}\" charset=\"0\"/></a:endParaRPr>"
            )
        } else {
            format!("<a:endParaRPr lang=\"{lang}\"{size} dirty=\"0\"/>")
        }
    } else if closing_font_size {
        format!("<a:endParaRPr lang=\"{lang}\"{size} dirty=\"0\"/>")
    } else {
        format!("<a:endParaRPr lang=\"{lang}\" dirty=\"0\"/>")
    }
}

/// `a = a || b` for a number option.
fn first_set(own: Option<f64>, main: Option<f64>) -> Option<f64> {
    if is_set(own) { own } else { main }
}

/// The paragraph options a run takes from the object's (`textObj.options.align = ... || opts.align`...).
fn inherit_paragraph(run: &mut TextOptions, main: &TextOptions) {
    if !has(&run.align) {
        run.align.clone_from(&main.align);
    }
    run.line_spacing = first_set(run.line_spacing, main.line_spacing);
    run.line_spacing_multiple = first_set(run.line_spacing_multiple, main.line_spacing_multiple);
    run.indent_level = first_set(run.indent_level, main.indent_level);
    run.para_space_before = first_set(run.para_space_before, main.para_space_before);
    run.para_space_after = first_set(run.para_space_after, main.para_space_after);
}

/// The loop over `Object.entries(opts)`: every option of the object the run lacks is copied into it, except the
/// bullet, and except the colour of a run that has a hyperlink.
fn inherit_run(run: &mut TextOptions, main: &TextOptions, own_link: bool) {
    if !own_link && !has(&run.color) {
        run.color.clone_from(&main.color);
    }
    if !has(&run.font_face) {
        run.font_face.clone_from(&main.font_face);
    }
    run.font_size = first_set(run.font_size, main.font_size);
    run.bold = run.bold || main.bold;
    run.italic = run.italic || main.italic;
    if !strike_on(&run.strike) {
        run.strike.clone_from(&main.strike);
    }
    if !underline_on(&run.underline) {
        run.underline.clone_from(&main.underline);
    }
    run.baseline = first_set(run.baseline, main.baseline);
    run.subscript = run.subscript || main.subscript;
    run.superscript = run.superscript || main.superscript;
    run.char_spacing = first_set(run.char_spacing, main.char_spacing);
    run.transparency = first_set(run.transparency, main.transparency);
    if !has(&run.highlight) {
        run.highlight.clone_from(&main.highlight);
    }
    if run.glow.is_none() {
        run.glow.clone_from(&main.glow);
    }
    if run.outline.is_none() {
        run.outline.clone_from(&main.outline);
    }
    if !has(&run.lang) {
        run.lang.clone_from(&main.lang);
    }
    if run.frame.hyperlink.is_none() {
        run.frame.hyperlink.clone_from(&main.frame.hyperlink);
        run.hyperlink_rid = main.hyperlink_rid;
    }
    if run.tab_stops.is_none() {
        run.tab_stops.clone_from(&main.tab_stops);
    }
    run.rtl_mode = run.rtl_mode || main.rtl_mode;
}

/// The `a:pPr` margin attributes and the bullet element of a paragraph.
fn bullet_xml(bullet: &Option<Bullet>, level: Option<f64>) -> (String, String) {
    let mut bullet_margin = val_to_pts(DEFAULT_BULLET_MARGIN);
    let mut attributes = String::new();
    let mut bullet_xml = String::new();
    let margin_of = |bullet_margin: f64| match level {
        Some(level) => bullet_margin + bullet_margin * level,
        None => bullet_margin,
    };
    let hanging = |bullet_margin: f64| format!(" marL=\"{}\" indent=\"-{}\"", num(margin_of(bullet_margin)), num(bullet_margin));
    let default_bullet = format!("<a:buSzPct val=\"100000\"/><a:buChar char=\"{DEFAULT_BULLET}\"/>");
    let character = |code: &str| {
        if code.len() == 4 && code.chars().all(|ch| ch.is_ascii_hexdigit()) { format!("&#x{code};") } else { DEFAULT_BULLET.to_owned() }
    };
    match bullet {
        Some(Bullet::Spec(spec)) => {
            if is_set(spec.indent) {
                bullet_margin = val_to_pts(spec.indent.unwrap_or(0.0));
            }
            if has(&spec.kind) {
                if spec.kind.as_deref().unwrap_or("").to_lowercase() == "number" {
                    attributes.push_str(&hanging(bullet_margin));
                    let start = if is_set(spec.number_start_at) {
                        num(spec.number_start_at.unwrap_or(0.0))
                    } else if is_set(spec.start_at) {
                        num(spec.start_at.unwrap_or(0.0))
                    } else {
                        "1".to_owned()
                    };
                    bullet_xml = format!(
                        "<a:buSzPct val=\"100000\"/><a:buFont typeface=\"+mj-lt\"/><a:buAutoNum type=\"{}\" startAt=\"{start}\"/>",
                        spec.style.as_deref().filter(|style| !style.is_empty()).unwrap_or("arabicPeriod")
                    );
                }
            } else if let Some(code) = spec.character_code.as_deref().filter(|code| !code.is_empty()) {
                attributes.push_str(&hanging(bullet_margin));
                bullet_xml = format!("<a:buSzPct val=\"100000\"/><a:buChar char=\"{}\"/>", character(code));
            } else if let Some(code) = spec.code.as_deref().filter(|code| !code.is_empty()) {
                attributes.push_str(&hanging(bullet_margin));
                bullet_xml = format!("<a:buSzPct val=\"100000\"/><a:buChar char=\"{}\"/>", character(code));
            } else {
                attributes.push_str(&hanging(bullet_margin));
                bullet_xml = default_bullet;
            }
        }
        Some(Bullet::Flag(true)) => {
            attributes.push_str(&hanging(bullet_margin));
            bullet_xml = default_bullet;
        }
        _ => {
            attributes.push_str(" indent=\"0\" marL=\"0\"");
            bullet_xml = "<a:buNone/>".to_owned();
        }
    }
    (attributes, bullet_xml)
}

/// `genXmlParagraphProperties` for a paragraph (not the placeholder's list style).
fn paragraph_properties_xml(options: &TextOptions) -> String {
    let mut xml = String::from("<a:pPr");
    if options.rtl_mode {
        xml.push_str(" rtl=\"1\" ");
    }
    match options.align.as_deref() {
        Some("left") => xml.push_str(" algn=\"l\""),
        Some("right") => xml.push_str(" algn=\"r\""),
        Some("center") => xml.push_str(" algn=\"ctr\""),
        Some("justify") => xml.push_str(" algn=\"just\""),
        _ => {}
    }
    let mut line_spacing = String::new();
    if is_set(options.line_spacing) {
        line_spacing = format!("<a:lnSpc><a:spcPts val=\"{}\"/></a:lnSpc>", num(round(options.line_spacing.unwrap_or(0.0) * 100.0)));
    } else if is_set(options.line_spacing_multiple) {
        line_spacing = format!("<a:lnSpc><a:spcPct val=\"{}\"/></a:lnSpc>", num(round(options.line_spacing_multiple.unwrap_or(0.0) * 100_000.0)));
    }
    let level = options.indent_level.filter(|level| is_set(Some(*level)) && *level > 0.0);
    if let Some(level) = level {
        xml.push_str(&format!(" lvl=\"{}\"", num(level)));
    }
    let mut spacing = String::new();
    if let Some(before) = options.para_space_before.filter(|before| is_set(Some(*before)) && *before > 0.0) {
        spacing.push_str(&format!("<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>", num(round(before * 100.0))));
    }
    if let Some(after) = options.para_space_after.filter(|after| is_set(Some(*after)) && *after > 0.0) {
        spacing.push_str(&format!("<a:spcAft><a:spcPts val=\"{}\"/></a:spcAft>", num(round(after * 100.0))));
    }
    let (bullet_attributes, bullet_xml) = bullet_xml(&options.bullet, level);
    xml.push_str(&bullet_attributes);
    let mut tab_stops = String::new();
    if let Some(stops) = &options.tab_stops {
        let tabs: String = stops
            .iter()
            .map(|stop| {
                format!(
                    "<a:tab pos=\"{}\" algn=\"{}\"/>",
                    num(inch_to_emu(or(stop.position, 1.0))),
                    stop.alignment.as_deref().filter(|align| !align.is_empty()).unwrap_or("l")
                )
            })
            .collect();
        tab_stops = format!("<a:tabLst>{tabs}</a:tabLst>");
    }
    xml.push('>');
    xml.push_str(&line_spacing);
    xml.push_str(&spacing);
    xml.push_str(&bullet_xml);
    xml.push_str(&tab_stops);
    xml.push_str("</a:pPr>");
    xml
}

/// `genXmlTextRunProperties` for a run (`a:rPr`). A hyperlink with neither `url` nor `slide` is what pptxgenjs
/// refuses with an error when it writes.
fn run_properties_xml(options: &TextOptions) -> Result<String, String> {
    let mut xml = String::from("<a:rPr");
    let lang = options.lang.as_deref().filter(|lang| !lang.is_empty());
    xml.push_str(&format!(" lang=\"{}\"", lang.unwrap_or("en-US")));
    if lang.is_some() {
        xml.push_str(" altLang=\"en-US\"");
    }
    if is_set(options.font_size) {
        xml.push_str(&format!(" sz=\"{}\"", num(round(options.font_size.unwrap_or(0.0) * 100.0))));
    }
    if options.bold {
        xml.push_str(" b=\"1\"");
    }
    if options.italic {
        xml.push_str(" i=\"1\"");
    }
    if strike_on(&options.strike) {
        let style = match &options.strike {
            Some(Strike::Style(style)) => style.as_str(),
            _ => "sngStrike",
        };
        xml.push_str(&format!(" strike=\"{style}\""));
    }
    let hyperlink = options.frame.hyperlink.as_ref();
    match &options.underline {
        Some(Underline::Style { style: Some(style), .. }) if !style.is_empty() => xml.push_str(&format!(" u=\"{style}\"")),
        Some(Underline::Text(style)) => xml.push_str(&format!(" u=\"{style}\"")),
        _ if hyperlink.is_some() => xml.push_str(" u=\"sng\""),
        _ => {}
    }
    if is_set(options.baseline) {
        xml.push_str(&format!(" baseline=\"{}\"", num(round(options.baseline.unwrap_or(0.0) * 50.0))));
    } else if options.subscript {
        xml.push_str(" baseline=\"-40000\"");
    } else if options.superscript {
        xml.push_str(" baseline=\"30000\"");
    }
    if is_set(options.char_spacing) {
        xml.push_str(&format!(" spc=\"{}\" kern=\"0\"", num(round(options.char_spacing.unwrap_or(0.0) * 100.0))));
    }
    xml.push_str(" dirty=\"0\">");
    let underline_color = match &options.underline {
        Some(Underline::Style { color: Some(color), .. }) if !color.is_empty() => Some(color.as_str()),
        _ => None,
    };
    let color = options.color.as_deref().filter(|color| !color.is_empty());
    if color.is_some() || has(&options.font_face) || options.outline.is_some() || underline_color.is_some() {
        if let Some(outline) = &options.outline {
            let outline_color = outline.color.as_deref().filter(|color| !color.is_empty()).unwrap_or("FFFFFF");
            xml.push_str(&format!("<a:ln w=\"{}\">{}</a:ln>", num(val_to_pts(or(outline.size, 0.75))), color_selection(&Fill::color(outline_color))));
        }
        if let Some(color) = color {
            xml.push_str(&color_selection(&Fill { color: Some(color.to_owned()), transparency: options.transparency, ..Fill::default() }));
        }
        if let Some(highlight) = options.highlight.as_deref().filter(|highlight| !highlight.is_empty()) {
            xml.push_str(&format!("<a:highlight>{}</a:highlight>", color_element(highlight, "")));
        }
        if let Some(color) = underline_color {
            xml.push_str(&format!("<a:uFill>{}</a:uFill>", color_selection(&Fill::color(color))));
        }
        if let Some(glow) = &options.glow {
            let size = round(glow.size.unwrap_or(8.0) * ONE_PT);
            let opacity = round(glow.opacity.unwrap_or(0.75) * 100_000.0);
            let glow_color = glow.color.as_deref().unwrap_or("FFFFFF");
            xml.push_str(&format!(
                "<a:effectLst><a:glow rad=\"{}\">{}</a:glow></a:effectLst>",
                num(size),
                color_element(glow_color, &format!("<a:alpha val=\"{}\"/>", num(opacity)))
            ));
        }
        if let Some(face) = options.font_face.as_deref().filter(|face| !face.is_empty()) {
            xml.push_str(&format!(
                "<a:latin typeface=\"{face}\" pitchFamily=\"34\" charset=\"0\"/><a:ea typeface=\"{face}\" pitchFamily=\"34\" charset=\"-122\"/><a:cs typeface=\"{face}\" pitchFamily=\"34\" charset=\"-120\"/>"
            ));
        }
    }
    if let Some(link) = hyperlink {
        xml.push_str(&hyperlink_click_xml(link, options.hyperlink_rid, color.is_some())?);
    }
    xml.push_str("</a:rPr>");
    Ok(xml)
}

fn hyperlink_click_xml(link: &Hyperlink, hyperlink_rid: Option<usize>, coloured: bool) -> Result<String, String> {
    let rid = hyperlink_rid.map_or_else(|| "undefined".to_owned(), |rid| rid.to_string());
    let tooltip = link.tooltip.as_deref().filter(|tooltip| !tooltip.is_empty()).map(encode_xml_entities).unwrap_or_default();
    let ending = if coloured { ">" } else { "/>" };
    let mut xml = if link.url.as_deref().is_some_and(|url| !url.is_empty()) {
        format!(
            "<a:hlinkClick r:id=\"rId{rid}\" invalidUrl=\"\" action=\"\" tgtFrame=\"\" tooltip=\"{tooltip}\" history=\"1\" highlightClick=\"0\" endSnd=\"0\"{ending}"
        )
    } else if is_set(link.slide) {
        format!("<a:hlinkClick r:id=\"rId{rid}\" action=\"ppaction://hlinksldjump\" tooltip=\"{tooltip}\"{ending}")
    } else {
        return Err("ERROR: 'hyperlink requires either `url` or `slide`'".to_owned());
    };
    if coloured {
        xml.push_str(" <a:extLst>");
        xml.push_str("  <a:ext uri=\"{A12FA001-AC4F-418D-AE19-62706E023703}\">");
        xml.push_str("   <ahyp:hlinkClr xmlns:ahyp=\"http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor\" val=\"tx\"/>");
        xml.push_str("  </a:ext>");
        xml.push_str(" </a:extLst>");
        xml.push_str("</a:hlinkClick>");
    }
    Ok(xml)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide() -> Layout {
        Layout { name: "custom".to_owned(), width: 12_192_000.0, height: 6_858_000.0 }
    }

    fn no_links(_: &Hyperlink) -> usize {
        panic!("no hyperlink expected")
    }

    fn built_with(content: TextContent, options: Option<TextOptions>, link: &mut dyn FnMut(&Hyperlink) -> usize) -> Result<TextObject, String> {
        let layout = wide();
        TextObject::new(content, options, &Placement { index: 0, text_objects: 0, layout: &layout }, link)
    }

    fn built(content: TextContent, options: Option<TextOptions>) -> String {
        built_with(content, options, &mut no_links).expect("text").xml().to_owned()
    }

    fn sized(font_size: f64) -> TextOptions {
        TextOptions { font_size: Some(font_size), ..TextOptions::default() }
    }

    #[test]
    fn a_plain_text_box_has_a_body_a_paragraph_and_a_run() {
        let options = TextOptions {
            frame: ShapeOptions {
                x: Some(Dim::Number(1.0)),
                y: Some(Dim::Number(2.0)),
                w: Some(Dim::Number(3.0)),
                h: Some(Dim::Number(1.0)),
                ..ShapeOptions::default()
            },
            ..sized(18.0)
        };
        let xml = built(TextContent::Plain("Hello & <you>".to_owned()), Some(options));
        assert!(xml.starts_with("<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Text 0\"></p:cNvPr><p:cNvSpPr/><p:nvPr></p:nvPr></p:nvSpPr><p:spPr>"));
        assert!(xml.contains("<a:off x=\"914400\" y=\"1828800\"/><a:ext cx=\"2743200\" cy=\"914400\"/>"));
        assert!(xml.contains("<a:noFill/><a:ln></a:ln></p:spPr><p:txBody><a:bodyPr wrap=\"square\" rtlCol=\"0\" anchor=\"ctr\"></a:bodyPr><a:lstStyle/>"));
        assert!(xml.contains("<a:pPr indent=\"0\" marL=\"0\"><a:buNone/></a:pPr><a:r><a:rPr lang=\"en-US\" sz=\"1800\" dirty=\"0\"><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill></a:rPr><a:t>Hello &amp; &lt;you&gt;</a:t></a:r>"));
        assert!(xml.ends_with("<a:endParaRPr lang=\"en-US\" sz=\"1800\" dirty=\"0\"/></a:p></p:txBody></p:sp>"));
    }

    #[test]
    fn a_string_with_line_breaks_makes_a_paragraph_for_each_line() {
        let xml = built(TextContent::Plain("one\r\ntwo\nthree".to_owned()), None);
        assert_eq!(xml.matches("<a:p>").count(), 3);
        assert!(xml.contains("<a:t>two</a:t>"));
        let trailing = built(TextContent::Plain("one\n".to_owned()), None);
        assert_eq!(trailing.matches("<a:p>").count(), 1);
        assert!(trailing.contains("<a:t>one\r\n</a:t>"));
    }

    #[test]
    fn a_soft_break_continues_the_paragraph_and_a_break_line_ends_it() {
        let runs = vec![
            TextRun { text: "a".to_owned(), options: Some(sized(10.0)) },
            TextRun { text: "b".to_owned(), options: Some(TextOptions { soft_break_before: true, break_line: true, ..sized(10.0) }) },
            TextRun { text: "c".to_owned(), options: None },
        ];
        let xml = built(TextContent::Runs(runs), None);
        assert_eq!(xml.matches("<a:p>").count(), 2);
        assert!(xml.contains("</a:r><a:br/><a:pPr indent=\"0\" marL=\"0\"><a:buNone/></a:pPr><a:r>"));
    }

    #[test]
    fn the_size_of_the_first_sized_run_reaches_the_runs_and_paragraphs_after_it() {
        let runs = vec![
            TextRun { text: "a".to_owned(), options: Some(sized(14.0)) },
            TextRun { text: "b".to_owned(), options: Some(TextOptions { break_line: true, ..TextOptions::default() }) },
            TextRun { text: "c".to_owned(), options: None },
        ];
        let xml = built(TextContent::Runs(runs), None);
        assert_eq!(xml.matches("<a:rPr lang=\"en-US\" sz=\"1400\" dirty=\"0\">").count(), 3);
        assert_eq!(xml.matches("<a:endParaRPr lang=\"en-US\" sz=\"1400\" dirty=\"0\"/>").count(), 2);
    }

    #[test]
    fn margins_set_the_insets_in_the_order_left_right_bottom_top() {
        let options = TextOptions {
            margin: Some(Margin::Each(vec![1.0, 2.0, 3.0, 4.0])),
            valign: Some("middle".to_owned()),
            wrap: Some(false),
            ..TextOptions::default()
        };
        let xml = built(TextContent::Plain("x".to_owned()), Some(options));
        assert!(xml.contains("<a:bodyPr wrap=\"none\" lIns=\"12700\" tIns=\"50800\" rIns=\"25400\" bIns=\"38100\" rtlCol=\"0\" anchor=\"ctr\">"));
    }

    #[test]
    fn bullets_alignment_and_spacing_make_the_paragraph_properties() {
        let options = TextOptions {
            bullet: Some(Bullet::Flag(true)),
            align: Some("center".to_owned()),
            line_spacing_multiple: Some(1.5),
            indent_level: Some(1.0),
            para_space_after: Some(6.0),
            ..TextOptions::default()
        };
        let xml = paragraph_properties_xml(&options);
        assert_eq!(
            xml,
            "<a:pPr algn=\"ctr\" lvl=\"1\" marL=\"685800\" indent=\"-342900\"><a:lnSpc><a:spcPct val=\"150000\"/></a:lnSpc><a:spcAft><a:spcPts val=\"600\"/></a:spcAft><a:buSzPct val=\"100000\"/><a:buChar char=\"&#x2022;\"/></a:pPr>"
        );
        let numbered = TextOptions {
            bullet: Some(Bullet::Spec(BulletSpec { kind: Some("Number".to_owned()), start_at: Some(3.0), ..BulletSpec::default() })),
            ..TextOptions::default()
        };
        assert!(paragraph_properties_xml(&numbered).contains("<a:buAutoNum type=\"arabicPeriod\" startAt=\"3\"/>"));
        let odd = TextOptions {
            bullet: Some(Bullet::Spec(BulletSpec { character_code: Some("22AB".to_owned()), ..BulletSpec::default() })),
            ..TextOptions::default()
        };
        assert!(paragraph_properties_xml(&odd).contains("<a:buChar char=\"&#x22AB;\"/>"));
        let bad = TextOptions { bullet: Some(Bullet::Spec(BulletSpec { code: Some("ZZ".to_owned()), ..BulletSpec::default() })), ..TextOptions::default() };
        assert!(paragraph_properties_xml(&bad).contains("<a:buChar char=\"&#x2022;\"/>"));
    }

    #[test]
    fn run_properties_write_the_font_the_colour_and_the_spacing() {
        let options = TextOptions {
            font_face: Some("Noto Sans KR".to_owned()),
            font_size: Some(10.5),
            bold: true,
            italic: true,
            color: Some("#abcdef".to_owned()),
            transparency: Some(40.0),
            char_spacing: Some(-0.5),
            highlight: Some("FFFF00".to_owned()),
            underline: Some(Underline::Style { style: Some("dbl".to_owned()), color: Some("FF0000".to_owned()) }),
            ..TextOptions::default()
        };
        let xml = run_properties_xml(&options).expect("run");
        assert!(xml.starts_with("<a:rPr lang=\"en-US\" sz=\"1050\" b=\"1\" i=\"1\" u=\"dbl\" spc=\"-50\" kern=\"0\" dirty=\"0\">"));
        assert!(xml.contains("<a:solidFill><a:srgbClr val=\"ABCDEF\"><a:alpha val=\"60000\"/></a:srgbClr></a:solidFill><a:highlight><a:srgbClr val=\"FFFF00\"/></a:highlight><a:uFill>"));
        assert!(xml.ends_with("<a:latin typeface=\"Noto Sans KR\" pitchFamily=\"34\" charset=\"0\"/><a:ea typeface=\"Noto Sans KR\" pitchFamily=\"34\" charset=\"-122\"/><a:cs typeface=\"Noto Sans KR\" pitchFamily=\"34\" charset=\"-120\"/></a:rPr>"));
    }

    #[test]
    fn a_hyperlink_takes_the_relationship_the_slide_gave_and_underlines_the_run() {
        let link = Hyperlink { url: Some("https://x.test".to_owned()), ..Hyperlink::default() };
        let runs = vec![TextRun {
            text: "go".to_owned(),
            options: Some(TextOptions { frame: ShapeOptions { hyperlink: Some(link), ..ShapeOptions::default() }, ..TextOptions::default() }),
        }];
        let mut asked = Vec::new();
        let object = built_with(TextContent::Runs(runs), None, &mut |link: &Hyperlink| {
            asked.push(link.url.clone());
            5
        })
        .expect("text");
        assert_eq!(asked, vec![Some("https://x.test".to_owned())]);
        assert!(
            object.xml().contains("u=\"sng\" dirty=\"0\"><a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill><a:hlinkClick r:id=\"rId5\" invalidUrl=\"\"")
        );
        assert!(object.xml().contains("endSnd=\"0\"> <a:extLst>"));
        let refused = vec![TextRun {
            text: "go".to_owned(),
            options: Some(TextOptions { frame: ShapeOptions { hyperlink: Some(Hyperlink::default()), ..ShapeOptions::default() }, ..TextOptions::default() }),
        }];
        assert!(built_with(TextContent::Runs(refused), None, &mut no_links).is_err());
    }

    #[test]
    fn the_object_name_of_a_string_with_options_is_encoded_twice() {
        let options = TextOptions { frame: ShapeOptions { object_name: Some("A&B".to_owned()), ..ShapeOptions::default() }, ..TextOptions::default() };
        assert!(built(TextContent::Plain("x".to_owned()), Some(options.clone())).contains("name=\"A&amp;amp;B\""));
        assert!(built(TextContent::Runs(vec![TextRun { text: "x".to_owned(), options: None }]), Some(options)).contains("name=\"A&amp;B\""));
    }

    #[test]
    fn a_line_box_needs_its_line_and_gets_the_line_defaults() {
        let bare = TextOptions { shape: Some("line".to_owned()), ..TextOptions::default() };
        assert!(built_with(TextContent::Plain("x".to_owned()), Some(bare), &mut no_links).is_err());
        let line = TextOptions {
            shape: Some("line".to_owned()),
            frame: ShapeOptions { line: Some(Line::default()), ..ShapeOptions::default() },
            ..TextOptions::default()
        };
        let xml = built(TextContent::Plain("x".to_owned()), Some(line));
        assert!(xml.contains("<a:prstGeom prst=\"line\"><a:avLst></a:avLst></a:prstGeom><a:noFill/><a:ln w=\"12700\"><a:solidFill><a:srgbClr val=\"333333\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>"));
    }
}
