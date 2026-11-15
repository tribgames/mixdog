//! The authored-package normaliser (`authoring/pptx-script-normalize.mjs`): the post-processing a saved deck's XML gets
//! after pptxgenjs, or the Rust writer, has written it. One `a:pPr` per paragraph with hanging punctuation off, no
//! `invertIfNegative` on a series that cannot carry it, the accent overlay series of the kit merged back into one series
//! with a per-point fill (and its embedded workbook with it), East Asian and complex-script faces beside every latin
//! face of a chart, only the axis ids a plot area declares, the chart children in schema order, native gradients for the
//! shapes the kit marks, the SVG of an icon beside its picture, one id for each drawing object of a slide, and the
//! notes master list of the presentation ahead of its slide list (the notes master taking a theme of its own first).
//!
//! The functions work on text and on the [`Package`]; [`normalize_authored_pptx`] is the one that reads and writes the
//! file.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use mixdog_fsio::WriteProof;
use mixdog_js::{Caps, JsRegex, string_to_number, to_number};
use mixdog_office_base::write_note::WriteNote;
use mixdog_ooxml::opc::{ensure_content_type_override, next_relationship_id, part_relationship_path, posix};
use mixdog_ooxml::package::{load_package, save_package};
use mixdog_ooxml::zipio::Package;
use serde_json::Value;

macro_rules! pattern {
    ($name:ident, $source:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($source, $flags));
    };
}

pattern!(TEXT_PARTS, r"^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$", "");
pattern!(PARAGRAPH, r"<a:p>([\s\S]*?)<\/a:p>", "g");
pattern!(PARAGRAPH_PROPS, r"<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>", "g");
pattern!(HANGING_PUNCT, r#"\bhangingPunct="[^"]*""#, "");
pattern!(PARAGRAPH_OPEN, r"^<a:pPr\b", "");
pattern!(CHART_PARTS, r"^ppt\/charts\/chart[^/]+\.xml$", "");
pattern!(NON_BAR_CHART, r"<c:(lineChart|line3DChart|areaChart|area3DChart|pieChart|pie3DChart|doughnutChart|radarChart|scatterChart|ofPieChart)\b[\s\S]*?<\/c:\1>", "g");
pattern!(INVERT_IF_NEGATIVE, r"<c:invertIfNegative\b[^>]*\/>|<c:invertIfNegative\b[^>]*>[\s\S]*?<\/c:invertIfNegative>", "g");
pattern!(CHART_GROUP, r"<c:(barChart|lineChart|areaChart|radarChart|scatterChart|bubbleChart)>[\s\S]*?<\/c:\1>", "g");
pattern!(AXIS_ID, r#"<c:(?:catAx|valAx|dateAx|serAx)>\s*<c:axId val="([^"]+)""#, "g");
pattern!(AXIS_ID_TAG, r#"<c:axId val="([^"]+)"\s*\/>"#, "g");
pattern!(NOTES_MASTER_LIST, r"<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>", "");
pattern!(RELATIONSHIP_TAG, r"<Relationship\b[^>]*\/>", "g");
pattern!(THEME_TYPE_ATTRIBUTE, r#"\bType="[^"]*\/theme""#, "");
pattern!(TARGET_ATTRIBUTE, r#"\bTarget="([^"]+)""#, "");
pattern!(TARGET_ATTRIBUTE_ANY, r#"\bTarget="[^"]+""#, "");
pattern!(NOTES_MASTER_PART, r"^ppt\/notesMasters\/[^/]+\.xml$", "");
pattern!(SLIDE_MASTER_PART, r"^ppt\/slideMasters\/[^/]+\.xml$", "");
pattern!(THEME_PART_NUMBER, r"^ppt\/theme\/theme(\d+)\.xml$", "");
pattern!(SERIES, r"<c:ser>[\s\S]*?<\/c:ser>", "g");
pattern!(OVERLAY_NAME, r"<c:tx>[\s\S]*?<c:v>([^<]*) ·<\/c:v>[\s\S]*?<\/c:tx>", "");
pattern!(SERIES_VALUES, r"<c:val>[\s\S]*?<\/c:val>", "");
pattern!(SERIES_POINT, r#"<c:pt idx="(\d+)"><c:v>([^<]*)<\/c:v><\/c:pt>"#, "g");
pattern!(BAR_CHART, r"<c:barChart>[\s\S]*?<\/c:barChart>", "");
pattern!(STACKED_GROUPING, r#"<c:grouping val="stacked"\/>"#, "");
pattern!(SERIES_FILL_COLOR, r#"<c:spPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})""#, "");
pattern!(INVERT_IF_NEGATIVE_TAG, r"<c:invertIfNegative\b[^>]*\/>", "");
pattern!(SERIES_SHAPE_PROPERTIES_CLOSE, r"<\/c:spPr>", "");
pattern!(OVERLAP, r#"<c:overlap val="[^"]*"\/>"#, "");
pattern!(WORKBOOK_CELL_C, r#"<c r="C\d+"[^>]*>[\s\S]*?<\/c>|<c r="C\d+"[^>]*\/>"#, "g");
pattern!(WORKBOOK_CELL_B, r#"<c r="B(\d+)"([^>]*)><v>[^<]*<\/v><\/c>"#, "g");
pattern!(WORKBOOK_DIMENSION, r#"<dimension ref="A1:C(\d+)"\/>"#, "");
pattern!(TABLE_REF, r#"ref="A1:C(\d+)""#, "g");
pattern!(TABLE_COLUMNS, r#"<tableColumns count="3">([\s\S]*?)<\/tableColumns>"#, "");
pattern!(TABLE_COLUMN_THREE, r#"<tableColumn id="3"[^>]*\/>"#, "");
pattern!(CHART_RELS_NAME, r"charts\/(chart\d+\.xml)$", "");
pattern!(EMBEDDED_TARGET, r#"Target="([^"]+\.xlsx)""#, "");
pattern!(LEADING_PARENT, r"^\.\.\/", "");
pattern!(CHART_LATIN, r#"<a:latin typeface="([^"]+)"([^>]*)\/>((?:\s*<a:(?:ea|cs)\b[^>]*\/>)*)"#, "g");
pattern!(EAST_ASIAN, r"<a:ea\b[^>]*\/>", "g");
pattern!(COMPLEX_SCRIPT, r"<a:cs\b[^>]*\/>", "g");
pattern!(CJK_FACE, r"\b(kr|sc|tc|jp|cjk)\b|malgun|yahei|jhenghei|yu gothic|meiryo", "i");
pattern!(CHART_TEXT_DEFAULT, r"<c:txPr>[\s\S]*<\/c:txPr>\s*(<c:externalData|<c:printSettings|<c:userShapes|<\/c:chartSpace>)", "");
pattern!(CHART_THEN_TEXT_DEFAULT, r"<\/c:chart>\s*<c:txPr>", "");
pattern!(CHART_THEN_SHAPE_PROPERTIES, r"<\/c:chart>\s*<c:spPr>[\s\S]*?<\/c:spPr>", "");
pattern!(SHAPE, r"<p:sp>[\s\S]*?<\/p:sp>", "g");
pattern!(SHAPE_NAME, r#"<p:cNvPr\b[^>]*\bname="([^"]*)""#, "");
pattern!(SHAPE_NAME_OPEN, r#"(<p:cNvPr\b[^>]*\bname=)"[^"]*""#, "");
pattern!(SHAPE_PROPERTIES, r"<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>", "");
pattern!(SHAPE_FILL, r"<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\s*\/>", "");
pattern!(SHAPE_LINE, r"<a:ln\b[^>]*\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>", "");
pattern!(SHAPE_GEOMETRY_END, r"(<\/a:prstGeom>|<a:prstGeom\b[^>]*\/>|<\/a:custGeom>)", "");
pattern!(PICTURE, r"<p:pic>[\s\S]*?<\/p:pic>", "g");
pattern!(BLIP, r"<a:blip\b[^>]*(?:\/>|>[\s\S]*?<\/a:blip>)", "");
pattern!(SVG_MEDIA, r"^ppt\/media\/mixdog-icon-", "");
pattern!(SVG_EXTENSION_DECLARED, r#"Extension="svg""#, "i");
pattern!(DRAWING_ID, r#"<p:cNvPr\b[^>]*\bid="(\d+)""#, "g");
pattern!(DRAWING_ID_ATTRIBUTE, r#"(<p:cNvPr\b[^>]*\bid=")(\d+)(")"#, "g");
pattern!(PREFIX, r"^\w+:", "");
pattern!(RELATIONSHIP_ID, r#"\bId="rId(\d+)""#, "g");
pattern!(SERIES_BODY, r"<c:ser>([\s\S]*?)<\/c:ser>", "g");
pattern!(CHILD_TAG, r"<(\/?)([\w:]+)[^>]*?(\/?)>", "g");
pattern!(LINE_GROUPING, r"<c:grouping\b", "");

const HANGING_OFF: &str = "hangingPunct=\"0\"";
const THEME_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";
const GRADIENT_PREFIX: &str = "mixdog-gradient:";
const SVG_PREFIX: &str = "mixdog-svg:";
const SVG_EXTENSION_URI: &str = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}";
const SVG_NAMESPACE: &str = "http://schemas.microsoft.com/office/drawing/2016/SVG/main";
const IMAGE_RELATIONSHIP: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/// What `normalizeAuthoredPptx` answers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Normalized {
    pub removed: usize,
    pub changed_parts: usize,
    pub merged_charts: usize,
    pub gradients: usize,
    pub vector_icons: usize,
}

/// `{ xml, changed }` of a step that either rewrote the text or left it as it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewrite {
    pub xml: String,
    pub changed: bool,
}

/// `{ xml, changed }` of a step that counts what it rewrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counted {
    pub xml: String,
    pub changed: usize,
}

/// `normalizeParagraphProperties`' answer: the text, the `a:pPr` it removed and whether it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraphs {
    pub xml: String,
    pub removed: usize,
    pub changed: bool,
}

/// `mergeAccentSeries`' answer: the text, whether the series merged, the merged points and the values the workbook gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub xml: String,
    pub changed: bool,
    pub accent: Vec<usize>,
    /// The merged series' value of each point, in the order the base series lists them.
    pub values: Vec<(usize, String)>,
}

/// `normalizeChartFonts`' answer: the text, how many runs and defaults it changed and the face it chose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChartFonts {
    pub xml: String,
    pub changed: usize,
    pub face: String,
}

/// `String.prototype.replace` of a global pattern with a replacer function that may keep state.
fn replace_each(pattern: &JsRegex, text: &str, mut with: impl FnMut(&Caps<'_>) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for found in pattern.captures_iter(text) {
        let whole = found.range();
        out.push_str(&text[last..whole.start]);
        out.push_str(&with(&found));
        last = whole.end;
    }
    out.push_str(&text[last..]);
    out
}

/// `String.prototype.replace` of a pattern without the `g` flag with a replacer function.
fn replace_first(pattern: &JsRegex, text: &str, with: impl FnOnce(&Caps<'_>) -> String) -> String {
    match pattern.captures(text) {
        Some(found) => {
            let whole = found.range();
            format!("{}{}{}", &text[..whole.start], with(&found), &text[whole.end..])
        }
        None => text.to_owned(),
    }
}

/// The text of a match.
fn whole<'t>(text: &'t str, found: &Caps<'_>) -> &'t str {
    &text[found.range()]
}

// ---- paragraphs ---------------------------------------------------------------------------------------------------

/// `withoutHangingPunctuation`: the paragraph properties with `hangingPunct="0"`.
fn without_hanging_punctuation(props: &str) -> String {
    if HANGING_PUNCT.is_match(props) {
        return replace_first(&HANGING_PUNCT, props, |_| HANGING_OFF.to_owned());
    }
    replace_first(&PARAGRAPH_OPEN, props, |_| format!("<a:pPr {HANGING_OFF}"))
}

/// `normalizeParagraphProperties`: pptxgenjs writes an `a:pPr` for every run of a paragraph, DrawingML allows one and
/// it must be the first child; hanging punctuation is off on every paragraph so a text box is the measure.
pub fn normalize_paragraph_properties(xml: &str) -> Paragraphs {
    let mut removed = 0;
    let output = replace_each(&PARAGRAPH, xml, |paragraph| {
        let inner = paragraph.get(1).unwrap_or("");
        let mut seen = false;
        let cleaned = replace_each(&PARAGRAPH_PROPS, inner, |props| {
            let text = &inner[props.range()];
            if seen {
                removed += 1;
                return String::new();
            }
            seen = true;
            without_hanging_punctuation(text)
        });
        format!("<a:p>{}</a:p>", if seen { cleaned } else { format!("<a:pPr {HANGING_OFF}/>{cleaned}") })
    });
    Paragraphs { changed: output != xml, xml: output, removed }
}

// ---- charts -------------------------------------------------------------------------------------------------------

/// `normalizeChartSeries`: `invertIfNegative` only stays in bar and bubble series.
fn normalize_chart_series(xml: &str) -> (String, usize) {
    let mut removed = 0;
    let output = replace_each(&NON_BAR_CHART, xml, |chart| {
        let text = whole(xml, chart);
        replace_each(&INVERT_IF_NEGATIVE, text, |_| {
            removed += 1;
            String::new()
        })
    });
    (output, removed)
}

/// `pruneUndeclaredAxisIds`: a 2D chart group keeps only the axis ids its plot area declares.
pub fn prune_undeclared_axis_ids(xml: &str) -> Rewrite {
    let declared: HashSet<&str> = AXIS_ID.captures_iter(xml).filter_map(|found| found.get(1)).collect();
    if declared.is_empty() {
        return Rewrite { xml: xml.to_owned(), changed: false };
    }
    let mut changed = false;
    let output = replace_each(&CHART_GROUP, xml, |group| {
        let text = whole(xml, group);
        replace_each(&AXIS_ID_TAG, text, |tag| {
            if declared.contains(tag.get(1).unwrap_or("")) {
                return whole(text, tag).to_owned();
            }
            changed = true;
            String::new()
        })
    });
    Rewrite { xml: output, changed }
}

/// `orderPresentationLists`: the notes master list goes ahead of the slide list (or the handout master list).
pub fn order_presentation_lists(xml: &str) -> Rewrite {
    let unchanged = || Rewrite { xml: xml.to_owned(), changed: false };
    let Some(found) = NOTES_MASTER_LIST.find(xml) else { return unchanged() };
    let notes = &xml[found];
    let without = xml.replacen(notes, "", 1);
    let Some(anchor) = ["<p:handoutMasterIdLst", "<p:sldIdLst"].iter().find_map(|tag| without.find(tag)) else { return unchanged() };
    if xml.find(notes).is_some_and(|at| at <= anchor) {
        return unchanged();
    }
    Rewrite { xml: format!("{}{}{}", &without[..anchor], notes, &without[anchor..]), changed: true }
}

/// What `themeTarget` finds: the theme relationship's tag and the part it names.
struct ThemeTarget {
    tag: String,
    part: String,
}

fn theme_target(relationships_xml: &str, part: &str) -> Option<ThemeTarget> {
    for tag in RELATIONSHIP_TAG.find_iter(relationships_xml) {
        let tag = &relationships_xml[tag];
        if !THEME_TYPE_ATTRIBUTE.is_match(tag) {
            continue;
        }
        if let Some(target) = TARGET_ATTRIBUTE.captures(tag).and_then(|found| found.get(1)) {
            let directory = posix::dirname(part);
            return Some(ThemeTarget { tag: tag.to_owned(), part: posix::normalize(&posix::join(&[directory.as_str(), target])) });
        }
    }
    None
}

/// `giveNotesMasterOwnTheme`: the notes master points at the slide master's theme; it takes a copy of its own so the
/// presentation's lists can take their schema order. Answers whether the notes master now owns its theme.
fn give_notes_master_own_theme(zip: &mut Package) -> bool {
    let names = zip.names();
    let Some(notes) = names.iter().find(|name| NOTES_MASTER_PART.is_match(name)) else { return false };
    let relationships_path = part_relationship_path(notes);
    let relationships = zip.text(&relationships_path);
    let Some(theme) = theme_target(&relationships, notes) else { return false };
    if zip.file(&theme.part).is_none() {
        return false;
    }
    let shared = names.iter().filter(|name| SLIDE_MASTER_PART.is_match(name)).any(|master| {
        theme_target(&zip.text(&part_relationship_path(master)), master).is_some_and(|found| found.part == theme.part)
    });
    if !shared {
        return true;
    }
    let highest = names
        .iter()
        .map(|name| THEME_PART_NUMBER.captures(name).and_then(|found| found.get(1)).map_or(0.0, string_to_number))
        .fold(0.0_f64, f64::max);
    let own = format!("ppt/theme/theme{}.xml", mixdog_js::number_to_string(highest + 1.0));
    let theme_xml = zip.text(&theme.part);
    zip.set(&own, theme_xml);
    let theme_relationships = zip.text(&part_relationship_path(&theme.part));
    if !theme_relationships.is_empty() {
        zip.set(&part_relationship_path(&own), theme_relationships);
    }
    ensure_content_type_override(zip, &format!("/{own}"), THEME_TYPE);
    let retargeted = retarget_theme(&theme.tag, &posix::basename(&own));
    zip.set(&relationships_path, relationships.replacen(&theme.tag, &retargeted, 1));
    true
}

/// `tag.replace(/\bTarget="[^"]+"/, () => 'Target="../theme/<name>"')`.
fn retarget_theme(tag: &str, theme_name: &str) -> String {
    replace_first(&TARGET_ATTRIBUTE_ANY, tag, |_| format!("Target=\"../theme/{theme_name}\""))
}

/// The points of a series' values (`seriesValues`): index and text, in the order they are written; a point written
/// twice keeps its first place and its last text.
fn series_values(series: &str) -> Vec<(usize, String)> {
    let values = SERIES_VALUES.find(series).map_or("", |found| &series[found]);
    let mut points: Vec<(usize, String)> = Vec::new();
    for point in SERIES_POINT.captures_iter(values) {
        let index = point.get(1).unwrap_or("").parse::<usize>().unwrap_or(0);
        let text = point.get(2).unwrap_or("").to_owned();
        match points.iter_mut().find(|(at, _)| *at == index) {
            Some(existing) => existing.1 = text,
            None => points.push((index, text)),
        }
    }
    points
}

/// `mergeAccentSeries`: the kit draws one accented bar as two stacked series, the base with a zero at the accent
/// index and an overlay named `<series> ·` carrying only that value; they merge into one clustered series with a
/// `c:dPt` override on the accent point.
pub fn merge_accent_series(xml: &str) -> Merged {
    let unchanged = || Merged { xml: xml.to_owned(), changed: false, accent: Vec::new(), values: Vec::new() };
    let Some(chart) = BAR_CHART.find(xml) else { return unchanged() };
    let chart = &xml[chart];
    if !STACKED_GROUPING.is_match(chart) {
        return unchanged();
    }
    let series: Vec<&str> = SERIES.find_iter(chart).map(|found| &chart[found]).collect();
    if series.len() != 2 || !OVERLAY_NAME.is_match(series[1]) {
        return unchanged();
    }
    let (base, overlay) = (series[0], series[1]);
    let base_values = series_values(base);
    let overlay_values = series_values(overlay);
    let accent: Vec<usize> = overlay_values.iter().filter(|(_, value)| !value.is_empty() && string_to_number(value) != 0.0).map(|(index, _)| *index).collect();
    let color = SERIES_FILL_COLOR.captures(overlay).and_then(|found| found.get(1));
    let Some(color) = color.filter(|_| !accent.is_empty()) else { return unchanged() };
    let merged: Vec<(usize, String)> = base_values
        .iter()
        .map(|(index, value)| {
            let text = if accent.contains(index) { overlay_values.iter().find(|(at, _)| at == index).map(|(_, text)| text.clone()) } else { Some(value.clone()) };
            (*index, text.unwrap_or_default())
        })
        .collect();
    let mut merged_series = replace_first(&SERIES_VALUES, base, |values| {
        let text = whole(base, values);
        replace_each(&SERIES_POINT_ANY, text, |point| {
            let index = point.get(1).unwrap_or("");
            let number = index.parse::<usize>().unwrap_or(0);
            let shown = merged.iter().find(|(at, _)| *at == number).map_or("", |(_, text)| text.as_str());
            format!("<c:pt idx=\"{index}\"><c:v>{shown}</c:v></c:pt>")
        })
    });
    let points: String = accent
        .iter()
        .map(|index| format!("<c:dPt><c:idx val=\"{index}\"/><c:invertIfNegative val=\"0\"/><c:bubble3D val=\"0\"/><c:spPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></c:spPr></c:dPt>"))
        .collect();
    merged_series = if INVERT_IF_NEGATIVE_TAG.is_match(&merged_series) {
        replace_first(&INVERT_IF_NEGATIVE_TAG, &merged_series, |tag| format!("{}{points}", whole(&merged_series, tag)))
    } else {
        replace_first(&SERIES_SHAPE_PROPERTIES_CLOSE, &merged_series, |tag| format!("{}{points}", whole(&merged_series, tag)))
    };
    let bar = chart.replacen(overlay, "", 1).replacen(base, &merged_series, 1).replacen("<c:grouping val=\"stacked\"/>", "<c:grouping val=\"clustered\"/>", 1);
    let bar = replace_first(&OVERLAP, &bar, |_| String::new());
    Merged { xml: xml.replacen(chart, &bar, 1), changed: true, accent, values: merged }
}

pattern!(SERIES_POINT_ANY, r#"<c:pt idx="(\d+)"><c:v>[^<]*<\/c:v><\/c:pt>"#, "g");

/// `mergeWorkbookColumns`: the workbook's sheet loses its second value column, and the accent row keeps its real value.
fn merge_workbook_columns(sheet_xml: &str, values: &[(usize, String)]) -> String {
    let without_c = replace_each(&WORKBOOK_CELL_C, sheet_xml, |_| String::new());
    let merged = replace_each(&WORKBOOK_CELL_B, &without_c, |cell| {
        let row: i64 = cell.get(1).unwrap_or("0").parse().unwrap_or(0);
        let kept = usize::try_from(row - 2).ok().and_then(|index| values.iter().find(|(at, _)| *at == index));
        match kept {
            Some((_, value)) => format!("<c r=\"B{}\"{}><v>{value}</v></c>", cell.get(1).unwrap_or(""), cell.get(2).unwrap_or("")),
            None => whole(&without_c, cell).to_owned(),
        }
    });
    let spans = merged.replace("spans=\"1:3\"", "spans=\"1:2\"");
    replace_first(&WORKBOOK_DIMENSION, &spans, |dimension| format!("<dimension ref=\"A1:B{}\"/>", dimension.get(1).unwrap_or("")))
}

/// `mergeWorkbookTable`.
fn merge_workbook_table(table_xml: &str) -> String {
    let refs = replace_each(&TABLE_REF, table_xml, |found| format!("ref=\"A1:B{}\"", found.get(1).unwrap_or("")));
    replace_first(&TABLE_COLUMNS, &refs, |columns| {
        let inner = columns.get(1).unwrap_or("");
        format!("<tableColumns count=\"2\">{}</tableColumns>", replace_first(&TABLE_COLUMN_THREE, inner, |_| String::new()))
    })
}

/// `mergeEmbeddedWorkbook`: the workbook behind the chart shows one column of real values in "Edit data".
fn merge_embedded_workbook(zip: &mut Package, chart_part: &str, values: &[(usize, String)]) -> Result<bool, String> {
    let relationships_part = replace_first(&CHART_RELS_NAME, chart_part, |found| format!("charts/_rels/{}.rels", found.get(1).unwrap_or("")));
    let relationships = if zip.file(&relationships_part).is_some() { zip.text(&relationships_part) } else { String::new() };
    let Some(target) = EMBEDDED_TARGET.captures(&relationships).and_then(|found| found.get(1)) else { return Ok(false) };
    let embedded = format!("ppt/{}", replace_first(&LEADING_PARENT, target, |_| String::new()));
    let Some(bytes) = zip.file(&embedded) else { return Ok(false) };
    let mut workbook = Package::load_unchecked(bytes)?;
    let Some(sheet) = workbook.file("xl/worksheets/sheet1.xml").map(|bytes| String::from_utf8_lossy(bytes).into_owned()) else { return Ok(false) };
    workbook.set("xl/worksheets/sheet1.xml", merge_workbook_columns(&sheet, values));
    if let Some(table) = workbook.file("xl/tables/table1.xml").map(|bytes| String::from_utf8_lossy(bytes).into_owned()) {
        workbook.set("xl/tables/table1.xml", merge_workbook_table(&table));
    }
    zip.set(&embedded, workbook.generate()?);
    Ok(true)
}

/// `normalizeChartFonts`: every chart run gets `a:ea` and `a:cs` matching its latin face, and a chart without a
/// chart-level `c:txPr` gets one in the deck face.
pub fn normalize_chart_fonts(xml: &str) -> ChartFonts {
    let mut changed = 0;
    let mut faces: Vec<String> = Vec::new();
    let mut output = replace_each(&CHART_LATIN, xml, |run| {
        let tag = whole(xml, run);
        let typeface = run.get(1).unwrap_or("");
        let attributes = run.get(2).unwrap_or("");
        let following = run.get(3).unwrap_or("");
        faces.push(typeface.to_owned());
        let east_asian: Vec<&str> = EAST_ASIAN.find_iter(following).map(|found| &following[found]).collect();
        let complex: Vec<&str> = COMPLEX_SCRIPT.find_iter(following).map(|found| &following[found]).collect();
        if east_asian.len() == 1 && complex.len() == 1 {
            return tag.to_owned();
        }
        changed += 1;
        let latin = if following.is_empty() { tag } else { &tag[..tag.len() - following.len()] };
        format!(
            "{latin}{}{}",
            east_asian.first().map_or_else(|| format!("<a:ea typeface=\"{typeface}\"{attributes}/>"), |tag| (*tag).to_owned()),
            complex.first().map_or_else(|| format!("<a:cs typeface=\"{typeface}\"{attributes}/>"), |tag| (*tag).to_owned())
        )
    });
    // The chart default prefers the face that carries CJK glyphs (the kit's sans over its Latin data face).
    let face = faces.iter().find(|name| CJK_FACE.is_match(name)).or_else(|| faces.first()).cloned().unwrap_or_default();
    if !face.is_empty() && !CHART_TEXT_DEFAULT.is_match(&output) && !CHART_THEN_TEXT_DEFAULT.is_match(&output) {
        let text_properties = format!(
            "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface=\"{face}\"/><a:ea typeface=\"{face}\"/><a:cs typeface=\"{face}\"/></a:defRPr></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>"
        );
        // Schema order after </c:chart>: c:spPr?, c:txPr?, c:externalData?, ...
        output = if CHART_THEN_SHAPE_PROPERTIES.is_match(&output) {
            replace_first(&CHART_THEN_SHAPE_PROPERTIES, &output, |found| format!("{}{text_properties}", whole(&output, found)))
        } else {
            output.replacen("</c:chart>", &format!("</c:chart>{text_properties}"), 1)
        };
        changed += 1;
    }
    ChartFonts { xml: output, changed, face }
}

// ---- gradients ----------------------------------------------------------------------------------------------------

/// `unit(value)`: a 0-1 value as the hundred-thousandths DrawingML takes.
fn unit(value: f64) -> f64 {
    let value = if value.is_nan() { 0.0 } else { value };
    mixdog_js::math::round(value.clamp(0.0, 1.0) * 100_000.0)
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = value.map_or(0.0, to_number);
    if number.is_nan() { 0.0 } else { number }
}

/// Whether a JSON value is truthy in JavaScript (`null`, `false`, `0` and `''` are not; an empty array or object is).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map_or_else(String::new, mixdog_js::value_to_string)
}

/// `gradientFillXml({ stops, angle, radial })`: the native `a:gradFill` of a gradient spec. A stop is `[offset 0-100,
/// hex, alpha 0-1]`; the angle is in degrees (0 is left to right, 90 top to bottom); `radial` puts stop 0 at its focus.
pub fn gradient_fill_xml(spec: &Value) -> Result<String, String> {
    let mut list = String::new();
    for stop in spec.get("stops").and_then(Value::as_array).into_iter().flatten() {
        let Some(stop) = stop.as_array() else { return Err(format!("{} is not iterable", mixdog_js::value_to_string(stop))) };
        let color = text_or_empty(stop.get(1)).replacen('#', "", 1).to_uppercase();
        let alpha = stop.get(2).map_or(1.0, to_number);
        let position = mixdog_js::math::round(number_or_zero(stop.first()).clamp(0.0, 100.0) * 1000.0);
        let fill = if alpha < 1.0 {
            format!("<a:srgbClr val=\"{color}\"><a:alpha val=\"{}\"/></a:srgbClr>", mixdog_js::number_to_string(unit(alpha)))
        } else {
            format!("<a:srgbClr val=\"{color}\"/>")
        };
        list.push_str(&format!("<a:gs pos=\"{}\">{fill}</a:gs>", mixdog_js::number_to_string(position)));
    }
    let radial = spec.get("radial").filter(|radial| truthy(radial));
    let path = match radial {
        Some(radial) => {
            let focus = |key: &str| radial.get(key).filter(|value| !value.is_null()).map_or(0.5, to_number);
            let (fx, fy) = (focus("fx"), focus("fy"));
            format!(
                "<a:path path=\"circle\"><a:fillToRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/></a:path>",
                mixdog_js::number_to_string(unit(fx)),
                mixdog_js::number_to_string(unit(fy)),
                mixdog_js::number_to_string(unit(1.0 - fx)),
                mixdog_js::number_to_string(unit(1.0 - fy))
            )
        }
        None => {
            let angle = number_or_zero(spec.get("angle"));
            let turned = ((angle % 360.0) + 360.0) % 360.0;
            format!("<a:lin ang=\"{}\" scaled=\"0\"/>", mixdog_js::number_to_string(mixdog_js::math::round(turned * 60_000.0)))
        }
    };
    Ok(format!("<a:gradFill rotWithShape=\"1\"><a:gsLst>{list}</a:gsLst>{path}</a:gradFill>"))
}

/// `decodeURIComponent`; `None` for a malformed escape or a sequence that is not UTF-8 (a `URIError`).
fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.to_owned());
    }
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let pair = text.get(at + 1..at + 3)?;
            if !pair.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(pair, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `nativeGradients`: a shape the kit's `gradient()` named with its stops keeps the gradient as a native `a:gradFill`
/// (editable in PowerPoint, no raster), the marker name cleared and the outline gone.
pub fn native_gradients(xml: &str) -> Result<Counted, String> {
    let mut changed = 0;
    let mut failure: Option<String> = None;
    let output = replace_each(&SHAPE, xml, |found| {
        let shape = whole(xml, found);
        let name = SHAPE_NAME.captures(shape).and_then(|found| found.get(1)).unwrap_or("");
        let Some(encoded) = name.strip_prefix(GRADIENT_PREFIX) else { return shape.to_owned() };
        let Some(spec) = decode_uri_component(encoded).and_then(|text| mixdog_js::json_parse(&text).ok()) else { return shape.to_owned() };
        if spec.get("stops").and_then(Value::as_array).is_none_or(|stops| stops.len() < 2) {
            return shape.to_owned();
        }
        let fill = match gradient_fill_xml(&spec) {
            Ok(fill) => fill,
            Err(message) => {
                failure.get_or_insert(message);
                return shape.to_owned();
            }
        };
        changed += 1;
        let renamed = replace_first(&SHAPE_NAME_OPEN, shape, |found| format!("{}\"Gradient\"", found.get(1).unwrap_or("")));
        replace_first(&SHAPE_PROPERTIES, &renamed, |properties| {
            let properties = whole(&renamed, properties);
            // Schema order inside spPr: xfrm, geometry, fill, ln, effects: the fill is swapped in place and the outline
            // becomes none, so a gradient never shows a solid rim of its first stop.
            let filled = if SHAPE_FILL.is_match(properties) {
                replace_first(&SHAPE_FILL, properties, |_| fill.clone())
            } else {
                replace_first(&SHAPE_GEOMETRY_END, properties, |geometry| format!("{}{fill}", whole(properties, geometry)))
            };
            if SHAPE_LINE.is_match(&filled) {
                replace_first(&SHAPE_LINE, &filled, |_| "<a:ln><a:noFill/></a:ln>".to_owned())
            } else {
                filled.replacen(&fill, &format!("{fill}<a:ln><a:noFill/></a:ln>"), 1)
            }
        })
    });
    match failure {
        Some(message) => Err(message),
        None => Ok(Counted { xml: output, changed }),
    }
}

// ---- icons --------------------------------------------------------------------------------------------------------

/// `relationshipsPart(slidePart)`.
fn relationships_part(slide_part: &str) -> String {
    match slide_part.rfind('/') {
        Some(slash) => format!("{}/_rels{}.rels", &slide_part[..slash], &slide_part[slash..]),
        None => format!("_rels/{slide_part}.rels"),
    }
}

/// `attachSvgIcons`: the SVG each kit icon carries on its name goes beside its picture as the vector source (PowerPoint
/// 2016 and later draw it, the PNG stays the fallback). Answers the slide text and how many it attached.
fn attach_svg_icons(zip: &mut Package, slide_part: &str, xml: &str) -> (String, usize) {
    if !xml.contains(SVG_PREFIX) {
        return (xml.to_owned(), 0);
    }
    let relationships_path = relationships_part(slide_part);
    let mut relationships = zip.text(&relationships_path);
    if relationships.is_empty() {
        return (xml.to_owned(), 0);
    }
    let mut attached = 0;
    let mut output = xml.to_owned();
    for found in PICTURE.find_iter(xml) {
        let picture = &xml[found];
        let name = SHAPE_NAME.captures(picture).and_then(|found| found.get(1)).unwrap_or("");
        let Some(encoded) = name.strip_prefix(SVG_PREFIX) else { continue };
        let Some(svg) = decode_uri_component(encoded) else { continue };
        if !svg.trim().starts_with("<svg") {
            continue;
        }
        let blip = BLIP.find(picture).map_or("", |found| &picture[found]);
        if blip.is_empty() || blip.contains(SVG_EXTENSION_URI) {
            continue;
        }
        attached += 1;
        let existing = zip.names().iter().filter(|entry| SVG_MEDIA.is_match(entry)).count();
        let media_name = format!("ppt/media/mixdog-icon-{}.svg", existing + 1);
        zip.set(&media_name, svg);
        let id = next_relationship_id(&relationships);
        relationships = relationships.replacen(
            "</Relationships>",
            &format!("<Relationship Id=\"{id}\" Type=\"{IMAGE_RELATIONSHIP}\" Target=\"../media/{}\"/></Relationships>", posix::basename(&media_name)),
            1,
        );
        let extension = format!("<a:extLst><a:ext uri=\"{SVG_EXTENSION_URI}\"><asvg:svgBlip xmlns:asvg=\"{SVG_NAMESPACE}\" r:embed=\"{id}\"/></a:ext></a:extLst>");
        let with_svg = match blip.strip_suffix("/>") {
            Some(open) => format!("{open}>{extension}</a:blip>"),
            None => blip.replacen("</a:blip>", &format!("{extension}</a:blip>"), 1),
        };
        let replaced = replace_first(&SHAPE_NAME_OPEN, &picture.replacen(blip, &with_svg, 1), |found| format!("{}\"Icon\"", found.get(1).unwrap_or("")));
        output = output.replacen(picture, &replaced, 1);
    }
    if attached == 0 {
        return (output, 0);
    }
    zip.set(&relationships_path, relationships);
    let content_types = zip.text("[Content_Types].xml");
    if !content_types.is_empty() && !SVG_EXTENSION_DECLARED.is_match(&content_types) {
        zip.set("[Content_Types].xml", content_types.replacen("<Default", "<Default Extension=\"svg\" ContentType=\"image/svg+xml\"/><Default", 1));
    }
    (output, attached)
}

// ---- shape ids ----------------------------------------------------------------------------------------------------

/// `uniqueShapeIds`: one id per drawing object of a slide. pptxgenjs numbers a table's frame by its own rule (the
/// table's ordinal times the slide number, plus one) while every other shape takes the next id, so a table and a text
/// box could share one; every later holder of a taken id gets the next free one.
pub fn unique_shape_ids(xml: &str) -> Counted {
    let ids: Vec<u64> = DRAWING_ID.captures_iter(xml).filter_map(|found| found.get(1)).map(|id| id.parse::<u64>().unwrap_or(0)).collect();
    let distinct: HashSet<u64> = ids.iter().copied().collect();
    if distinct.len() == ids.len() {
        return Counted { xml: xml.to_owned(), changed: 0 };
    }
    let mut next = ids.iter().copied().max().unwrap_or(0);
    let mut seen: HashSet<String> = HashSet::new();
    let mut changed = 0;
    let output = replace_each(&DRAWING_ID_ATTRIBUTE, xml, |found| {
        let id = found.get(2).unwrap_or("");
        if seen.insert(id.to_owned()) {
            return whole(xml, found).to_owned();
        }
        next += 1;
        changed += 1;
        seen.insert(next.to_string());
        format!("{}{next}{}", found.get(1).unwrap_or(""), found.get(3).unwrap_or(""))
    });
    Counted { xml: output, changed }
}

// ---- schema order -------------------------------------------------------------------------------------------------

const CAT_AX_ORDER: &[&str] = &[
    "axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title", "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx", "crosses", "crossesAt", "auto", "lblAlgn",
    "lblOffset", "tickLblSkip", "tickMarkSkip", "noMultiLvlLbl", "extLst",
];
const DATE_AX_ORDER: &[&str] = &[
    "axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title", "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx", "crosses", "crossesAt", "auto",
    "lblOffset", "baseTimeUnit", "majorUnit", "majorTimeUnit", "minorUnit", "minorTimeUnit", "extLst",
];
const VAL_AX_ORDER: &[&str] = &[
    "axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title", "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx", "crosses", "crossesAt", "crossBetween",
    "majorUnit", "minorUnit", "dispUnits", "extLst",
];
const BAR_CHART_ORDER: &[&str] = &["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth", "overlap", "serLines", "axId", "extLst"];
const LINE_CHART_ORDER: &[&str] = &["grouping", "varyColors", "ser", "dLbls", "dropLines", "hiLowLines", "upDownBars", "marker", "smooth", "axId", "extLst"];
const AREA_CHART_ORDER: &[&str] = &["grouping", "varyColors", "ser", "dLbls", "dropLines", "axId", "extLst"];
const PIE_CHART_ORDER: &[&str] = &["varyColors", "ser", "dLbls", "firstSliceAng", "extLst"];
const DOUGHNUT_CHART_ORDER: &[&str] = &["varyColors", "ser", "dLbls", "firstSliceAng", "holeSize", "extLst"];
const BAR_SERIES_ORDER: &[&str] = &["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "shape", "extLst"];
const LINE_SERIES_ORDER: &[&str] = &["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "smooth", "extLst"];
const AREA_SERIES_ORDER: &[&str] = &["idx", "order", "tx", "spPr", "pictureOptions", "dPt", "dLbls", "trendline", "errBars", "cat", "val", "extLst"];
const PIE_SERIES_ORDER: &[&str] = &["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val", "extLst"];

/// The elements `orderChartChildren` puts in order: the element, its children's order and its series' children's order.
const CHART_ORDERS: [(&str, &[&str], Option<&[&str]>); 8] = [
    ("c:catAx", CAT_AX_ORDER, None),
    ("c:dateAx", DATE_AX_ORDER, None),
    ("c:valAx", VAL_AX_ORDER, None),
    ("c:barChart", BAR_CHART_ORDER, Some(BAR_SERIES_ORDER)),
    ("c:lineChart", LINE_CHART_ORDER, Some(LINE_SERIES_ORDER)),
    ("c:areaChart", AREA_CHART_ORDER, Some(AREA_SERIES_ORDER)),
    ("c:pieChart", PIE_CHART_ORDER, Some(PIE_SERIES_ORDER)),
    ("c:doughnutChart", DOUGHNUT_CHART_ORDER, Some(PIE_SERIES_ORDER)),
];

/// The pattern of each element of [`CHART_ORDERS`]: the element with no attributes and everything up to its close.
static CHART_ELEMENT_PATTERNS: LazyLock<Vec<JsRegex>> =
    LazyLock::new(|| CHART_ORDERS.iter().map(|(element, _, _)| JsRegex::new_static(&format!("<{element}>([\\s\\S]*?)</{element}>"), "g")).collect());

/// An element's direct children, whole, in document order, with their names without the prefix.
fn direct_children(inner: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut depth: i64 = 0;
    let mut start: Option<usize> = None;
    let mut name = String::new();
    for tag in CHILD_TAG.captures_iter(inner) {
        let range = tag.range();
        let closing = !tag.get(1).unwrap_or("").is_empty();
        let self_closing = !tag.get(3).unwrap_or("").is_empty();
        if !closing && depth == 0 {
            start = Some(range.start);
            name = tag.get(2).unwrap_or("").to_owned();
        }
        if closing {
            depth -= 1;
        } else if !self_closing {
            depth += 1;
        }
        if depth == 0 {
            if let Some(from) = start.take() {
                out.push((replace_first(&PREFIX, &name, |_| String::new()), inner[from..range.end].to_owned()));
            }
        }
    }
    out
}

fn sorted_children(inner: &str, order: &[&str]) -> String {
    let rank = |name: &str| order.iter().position(|known| *known == name).map_or(order.len() as f64 - 1.5, |at| at as f64);
    let children = direct_children(inner);
    let mut indexed: Vec<(usize, &(String, String))> = children.iter().enumerate().collect();
    indexed.sort_by(|a, b| rank(&a.1.0).partial_cmp(&rank(&b.1.0)).unwrap_or(Ordering::Equal).then(a.0.cmp(&b.0)));
    indexed.into_iter().map(|(_, child)| child.1.as_str()).collect()
}

/// `orderChartChildren`: the schema's child order for the chart elements pptxgenjs and the accent merge write out of
/// sequence (`tickLblSkip` after the axis tail, `dPt` after `dLbls`, `varyColors` and `marker` misplaced). A line chart
/// without its required `c:grouping` gets the standard one.
pub fn order_chart_children(xml: &str) -> Rewrite {
    let mut changed = false;
    let mut output = xml.to_owned();
    for ((element, order, series_order), pattern) in CHART_ORDERS.iter().zip(CHART_ELEMENT_PATTERNS.iter()) {
        let source = output;
        output = replace_each(pattern, &source, |found| {
            let original = whole(&source, found);
            let inner = found.get(1).unwrap_or("");
            let filled = if *element == "c:lineChart" && !LINE_GROUPING.is_match(inner) { format!("<c:grouping val=\"standard\"/>{inner}") } else { inner.to_owned() };
            let mut body = sorted_children(&filled, order);
            if let Some(series_order) = *series_order {
                let sorted = body;
                body = replace_each(&SERIES_BODY, &sorted, |series| format!("<c:ser>{}</c:ser>", sorted_children(series.get(1).unwrap_or(""), series_order)));
            }
            let next = format!("<{element}>{body}</{element}>");
            if next != original {
                changed = true;
            }
            next
        });
    }
    Rewrite { xml: output, changed }
}

// ---- the package --------------------------------------------------------------------------------------------------

/// `normalizeAuthoredPptx` on a package already read: the parts it changes are set in place (a new part, the notes
/// master's own theme or an icon, goes last).
pub fn normalize_package(zip: &mut Package) -> Result<Normalized, String> {
    let parts: Vec<String> = zip.names().into_iter().filter(|name| TEXT_PARTS.is_match(name) || CHART_PARTS.is_match(name)).collect();
    let mut result = Normalized::default();
    for part in parts {
        let xml = zip.text(&part);
        let chart = CHART_PARTS.is_match(&part);
        let (mut text, removed, mut changed) = if chart {
            let (text, removed) = normalize_chart_series(&xml);
            (text, removed, false)
        } else {
            let paragraphs = normalize_paragraph_properties(&xml);
            (paragraphs.xml, paragraphs.removed, paragraphs.changed)
        };
        if chart {
            let merged = merge_accent_series(&text);
            if merged.changed {
                text = merged.xml;
                changed = true;
                result.merged_charts += 1;
                merge_embedded_workbook(zip, &part, &merged.values)?;
            }
            let fonts = normalize_chart_fonts(&text);
            if fonts.changed > 0 {
                text = fonts.xml;
                changed = true;
            }
            let axes = prune_undeclared_axis_ids(&text);
            if axes.changed {
                text = axes.xml;
                changed = true;
            }
            let ordered = order_chart_children(&text);
            if ordered.changed {
                text = ordered.xml;
                changed = true;
            }
        } else {
            let native = native_gradients(&text)?;
            if native.changed > 0 {
                text = native.xml;
                changed = true;
                result.gradients += native.changed;
            }
            let identified = unique_shape_ids(&text);
            if identified.changed > 0 {
                text = identified.xml;
                changed = true;
            }
            let (with_icons, attached) = attach_svg_icons(zip, &part, &text);
            if attached > 0 {
                text = with_icons;
                changed = true;
                result.vector_icons += attached;
            }
        }
        if removed == 0 && !changed {
            continue;
        }
        zip.set(&part, text);
        result.removed += removed;
        result.changed_parts += 1;
    }
    let presentation = zip.text("ppt/presentation.xml");
    if !presentation.is_empty() {
        let ordered = order_presentation_lists(&presentation);
        // The lists move only once the notes master no longer shares the slide master's theme: the shared theme is what
        // the out-of-order list tolerates.
        if ordered.changed && give_notes_master_own_theme(zip) {
            zip.set("ppt/presentation.xml", ordered.xml);
            result.changed_parts += 1;
        }
    }
    Ok(result)
}

/// `normalizeAuthoredPptx(path)`: the saved deck read, normalised and written back when something changed.
pub fn normalize_authored_pptx<P: WriteProof>(proof: &P, note: &dyn WriteNote, path: &Path) -> Result<Normalized, String> {
    let mut zip = load_package(proof, path)?;
    let result = normalize_package(&mut zip)?;
    if result.changed_parts > 0 {
        save_package(proof, note, &zip, path)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // pptxgenjs numbers a table frame as its ordinal times the slide number plus one: the first table on slide 5 took id 6
    // beside a text box that was id 6 too, and a batch naming shape 6 could not tell the two apart.
    #[test]
    fn an_authored_slide_gives_every_drawing_object_an_id_of_its_own() {
        let object = |tag: &str, id: u32| format!("<p:{tag}><p:nv><p:cNvPr id=\"{id}\" name=\"{tag}{id}\"/></p:nv></p:{tag}>");
        let xml = format!(
            "<p:spTree>{}{}{}{}{}{}</p:spTree>",
            object("sp", 1),
            object("sp", 2),
            object("graphicFrame", 6),
            object("sp", 5),
            object("sp", 6),
            object("sp", 25)
        );
        let fixed = unique_shape_ids(&xml);
        assert_eq!(fixed.changed, 1);
        let ids = ids_of(&fixed.xml);
        assert_eq!(ids, vec![1, 2, 6, 5, 26, 25], "the table keeps its id; the later text box takes the next free one");
        assert_eq!(unique_shape_ids(&fixed.xml).changed, 0, "idempotent");
    }

    fn ids_of(xml: &str) -> Vec<u32> {
        let pattern = JsRegex::new_static(r#"id="(\d+)""#, "g");
        pattern.captures_iter(xml).map(|found| found.get(1).unwrap_or("0").parse().unwrap_or(0)).collect()
    }

    fn count(xml: &str, needle: &str) -> usize {
        xml.matches(needle).count()
    }

    #[test]
    fn a_2d_chart_group_keeps_only_the_axis_ids_its_plot_area_declares() {
        let xml = "<c:plotArea><c:barChart><c:barDir val=\"col\"/><c:gapWidth val=\"80\"/><c:axId val=\"11\"/><c:axId val=\"22\"/><c:axId val=\"33\"/></c:barChart><c:catAx><c:axId val=\"11\"/><c:crossAx val=\"22\"/></c:catAx><c:valAx><c:axId val=\"22\"/><c:crossAx val=\"11\"/></c:valAx></c:plotArea>";
        let pruned = prune_undeclared_axis_ids(xml);
        assert!(pruned.changed);
        assert_eq!(count(&pruned.xml, "<c:axId val=\"33\"/>"), 0);
        assert_eq!(JsRegex::new_static(r#"<c:axId val="\d+"\/>"#, "g").find_iter(&pruned.xml).count(), 4, "two in the group, one per axis");
        assert!(!prune_undeclared_axis_ids(&pruned.xml).changed);
        // A pie has no axes at all and is left as written.
        assert!(!prune_undeclared_axis_ids("<c:plotArea><c:pieChart/></c:plotArea>").changed);
    }

    #[test]
    fn the_notes_master_list_moves_ahead_of_the_slide_list_and_only_when_it_follows_it() {
        let written = "<p:presentation><p:sldMasterIdLst><p:sldMasterId id=\"1\"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id=\"256\"/></p:sldIdLst><p:notesMasterIdLst><p:notesMasterId r:id=\"rId3\"/></p:notesMasterIdLst><p:sldSz cx=\"1\" cy=\"1\"/></p:presentation>";
        let ordered = order_presentation_lists(written);
        assert!(ordered.changed);
        assert!(ordered.xml.find("<p:notesMasterIdLst>") < ordered.xml.find("<p:sldIdLst>"));
        assert!(ordered.xml.find("</p:sldMasterIdLst>") < ordered.xml.find("<p:notesMasterIdLst>"));
        assert!(!order_presentation_lists(&ordered.xml).changed);
    }

    fn run(face: &str) -> String {
        format!("<a:defRPr sz=\"1100\"><a:solidFill><a:srgbClr val=\"5A6B7B\"/></a:solidFill><a:latin typeface=\"{face}\" pitchFamily=\"34\" charset=\"0\"/></a:defRPr>")
    }

    fn chart(body: &str) -> String {
        format!("<c:chartSpace><c:chart><c:plotArea><c:barChart><c:catAx><c:txPr><a:p><a:pPr>{body}</a:pPr></a:p></c:txPr></c:catAx></c:barChart></c:plotArea></c:chart><c:spPr><a:noFill/></c:spPr><c:externalData r:id=\"rId1\"/></c:chartSpace>")
    }

    #[test]
    fn chart_runs_get_east_asian_and_complex_script_faces_matching_their_latin_face() {
        let fonts = normalize_chart_fonts(&chart(&run("Noto Sans KR")));
        assert_eq!(fonts.face, "Noto Sans KR");
        assert!(fonts.changed >= 2, "the run and the chart-level default both changed");
        let faces = JsRegex::new_static(r#"<a:latin typeface="Noto Sans KR"[^>]*\/><a:ea typeface="Noto Sans KR"[^>]*\/><a:cs typeface="Noto Sans KR"[^>]*\/>"#, "");
        assert!(faces.is_match(&fonts.xml));
        let default = JsRegex::new_static(r#"<\/c:spPr><c:txPr>[\s\S]*<a:latin typeface="Noto Sans KR"\/><a:ea typeface="Noto Sans KR"\/>[\s\S]*<\/c:txPr><c:externalData"#, "");
        assert!(default.is_match(&fonts.xml), "the chart default sits after c:spPr and before c:externalData");
        assert_eq!(normalize_chart_fonts(&fonts.xml).changed, 0, "idempotent: a run that already carries a:ea is left alone");
    }

    #[test]
    fn a_chart_without_any_explicit_face_is_left_untouched() {
        let plain = "<c:chartSpace><c:chart><c:plotArea/></c:chart></c:chartSpace>";
        assert_eq!(normalize_chart_fonts(plain), ChartFonts { xml: plain.to_owned(), changed: 0, face: String::new() });
    }

    #[test]
    fn existing_chart_script_faces_survive_normalization_without_duplicate_or_out_of_order_font_elements() {
        for existing in [
            "\n  <a:cs    typeface=\"Traditional Arabic\"/>",
            "\n  <a:ea typeface=\"Noto Serif KR\"/>\n  <a:cs typeface=\"Traditional Arabic\"/>",
            "<a:ea typeface=\"Noto Serif KR\"/><a:cs typeface=\"Traditional Arabic\"/><a:cs typeface=\"Traditional Arabic\"/>",
        ] {
            let input = chart(&format!("<a:defRPr><a:latin typeface=\"Noto Sans KR\"/>{existing}</a:defRPr>"));
            let normalized = normalize_chart_fonts(&input);
            let properties = JsRegex::new_static(r"<a:defRPr>([\s\S]*?)<\/a:defRPr>", "").captures(&normalized.xml).and_then(|found| found.get(1)).unwrap_or("").to_owned();
            assert_eq!(JsRegex::new_static(r"<a:ea\b", "g").find_iter(&properties).count(), 1);
            assert_eq!(JsRegex::new_static(r"<a:cs\b", "g").find_iter(&properties).count(), 1);
            assert!(JsRegex::new_static(r#"<a:ea\b[^>]*\/>\s*<a:cs\b[^>]*typeface="Traditional Arabic""#, "").is_match(&properties));
            if existing.contains("Noto Serif KR") {
                assert!(properties.contains("typeface=\"Noto Serif KR\""));
            }
            assert_eq!(normalize_chart_fonts(&normalized.xml).changed, 0);
        }
    }

    #[test]
    fn chart_children_are_put_in_schema_order_axis_tail_series_points_chart_level_flags() {
        let xml = "<c:barChart><c:barDir val=\"col\"/><c:ser><c:idx val=\"0\"/><c:order val=\"0\"/><c:dLbls><c:showVal val=\"1\"/></c:dLbls><c:dPt><c:idx val=\"2\"/></c:dPt><c:cat/><c:val/></c:ser><c:varyColors val=\"0\"/><c:gapWidth val=\"60\"/><c:axId val=\"1\"/></c:barChart><c:catAx><c:axId val=\"1\"/><c:tickLblSkip val=\"1\"/><c:crossAx val=\"2\"/><c:noMultiLvlLbl val=\"0\"/></c:catAx>";
        let ordered = order_chart_children(xml);
        assert!(ordered.changed);
        assert!(ordered.xml.contains("<c:barDir val=\"col\"/><c:varyColors val=\"0\"/><c:ser>"));
        assert!(ordered.xml.contains("<c:order val=\"0\"/><c:dPt><c:idx val=\"2\"/></c:dPt><c:dLbls>"));
        assert!(ordered.xml.contains("<c:crossAx val=\"2\"/><c:tickLblSkip val=\"1\"/><c:noMultiLvlLbl"));
        assert!(!order_chart_children(&ordered.xml).changed);
        let line = order_chart_children("<c:lineChart><c:varyColors val=\"0\"/><c:ser><c:idx val=\"0\"/></c:ser><c:marker val=\"1\"/><c:axId val=\"1\"/></c:lineChart>");
        assert!(line.xml.starts_with("<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/><c:ser>"));
    }

    fn accent_series(name: &str, values: [u32; 3], color: &str) -> String {
        let points: String = values.iter().enumerate().map(|(index, value)| format!("<c:pt idx=\"{index}\"><c:v>{value}</c:v></c:pt>")).collect();
        format!("<c:ser><c:idx val=\"0\"/><c:tx><c:strRef><c:f>x</c:f><c:strCache><c:pt idx=\"0\"><c:v>{name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></c:spPr><c:invertIfNegative val=\"0\"/><c:val><c:numRef><c:numCache>{points}</c:numCache></c:numRef></c:val></c:ser>")
    }

    #[test]
    fn the_accent_overlay_series_merges_into_one_series_with_a_per_point_fill() {
        let xml = format!(
            "<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"stacked\"/>{}{}<c:overlap val=\"100\"/></c:barChart>",
            accent_series("처리량", [12, 18, 0], "E7EBEE"),
            accent_series("처리량 ·", [0, 0, 31], "B81E38")
        );
        let merged = merge_accent_series(&xml);
        assert!(merged.changed);
        assert_eq!(merged.accent, vec![2]);
        assert_eq!(count(&merged.xml, "<c:ser>"), 1);
        assert!(JsRegex::new_static(r#"<c:dPt><c:idx val="2"\/>[\s\S]*B81E38"#, "").is_match(&merged.xml));
        assert!(merged.xml.contains("<c:pt idx=\"2\"><c:v>31</c:v>"));
        assert!(merged.xml.contains("<c:grouping val=\"clustered\"/>"));
    }

    #[test]
    fn replacement_patterns_in_a_series_name_are_written_literally_when_the_accent_series_merge() {
        let xml = format!(
            "<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"stacked\"/>{}{}<c:overlap val=\"100\"/></c:barChart>",
            accent_series("A$&B", [12, 18, 0], "E7EBEE"),
            accent_series("A$&B ·", [0, 0, 31], "B81E38")
        );
        let merged = merge_accent_series(&xml);
        assert!(merged.changed);
        assert_eq!(count(&merged.xml, "A$&B"), 1);
        assert_eq!(count(&merged.xml, "<c:ser>"), 1);
    }

    #[test]
    fn a_gradient_marked_shape_is_saved_as_a_native_gradfill_without_an_outline_and_the_marker_is_cleared() {
        let spec = "%7B%22stops%22%3A%5B%5B0%2C%220B1B2B%22%2C1%5D%2C%5B100%2C%221F3A5F%22%2C0.4%5D%5D%2C%22angle%22%3A90%7D";
        let shape = |name: &str, fill: &str| {
            format!("<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"{name}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"100\" cy=\"100\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>{fill}<a:ln w=\"12700\"><a:solidFill><a:srgbClr val=\"0B1B2B\"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>")
        };
        let xml = format!(
            "<p:spTree>{}{}</p:spTree>",
            shape(&format!("{GRADIENT_PREFIX}{spec}"), "<a:solidFill><a:srgbClr val=\"0B1B2B\"/></a:solidFill>"),
            shape("Plain", "<a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill>")
        );
        let native = native_gradients(&xml).expect("a gradient");
        assert_eq!(native.changed, 1);
        assert!(native.xml.contains("name=\"Gradient\""));
        assert!(!native.xml.contains("mixdog-gradient:"));
        assert!(native.xml.contains("</a:prstGeom><a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\"><a:srgbClr val=\"0B1B2B\"/></a:gs><a:gs pos=\"100000\"><a:srgbClr val=\"1F3A5F\"><a:alpha val=\"40000\"/></a:srgbClr></a:gs></a:gsLst><a:lin ang=\"5400000\" scaled=\"0\"/></a:gradFill><a:ln><a:noFill/></a:ln></p:spPr>"));
        assert!(
            JsRegex::new_static(r#"name="Plain"[\s\S]*?<a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:ln w="12700">"#, "").is_match(&native.xml),
            "an unmarked shape keeps its fill and outline"
        );
        assert_eq!(native_gradients(&native.xml).expect("again").changed, 0, "idempotent");
        let radial = gradient_fill_xml(&serde_json::json!({ "stops": [[0, "FFAA00", 0.35], [100, "FFAA00", 0]], "radial": { "fx": 0.25, "fy": 0.5 } })).expect("a radial gradient");
        assert!(radial.contains("<a:path path=\"circle\"><a:fillToRect l=\"25000\" t=\"50000\" r=\"75000\" b=\"50000\"/></a:path>"));
        assert!(radial.contains("<a:gs pos=\"100000\"><a:srgbClr val=\"FFAA00\"><a:alpha val=\"0\"/>"));
    }

    #[test]
    fn a_paragraph_keeps_its_first_properties_with_hanging_punctuation_off_and_loses_the_others() {
        let xml = "<a:p><a:pPr algn=\"l\"/><a:r><a:t>a</a:t></a:r><a:pPr algn=\"r\"/><a:r><a:t>b</a:t></a:r></a:p><a:p><a:r><a:t>c</a:t></a:r></a:p>";
        let paragraphs = normalize_paragraph_properties(xml);
        assert_eq!(paragraphs.removed, 1);
        assert!(paragraphs.changed);
        assert_eq!(
            paragraphs.xml,
            "<a:p><a:pPr hangingPunct=\"0\" algn=\"l\"/><a:r><a:t>a</a:t></a:r><a:r><a:t>b</a:t></a:r></a:p><a:p><a:pPr hangingPunct=\"0\"/><a:r><a:t>c</a:t></a:r></a:p>"
        );
        assert!(!normalize_paragraph_properties(&paragraphs.xml).changed);
    }

    #[test]
    fn the_sheet_and_the_table_of_a_merged_chart_lose_their_third_column() {
        let sheet = "<dimension ref=\"A1:C4\"/><row r=\"2\" spans=\"1:3\"><c r=\"A2\" t=\"s\"><v>4</v></c><c r=\"B2\"><v>0</v></c><c r=\"C2\"><v>31</v></c></row>";
        let merged = merge_workbook_columns(sheet, &[(0, "31".to_owned())]);
        assert_eq!(merged, "<dimension ref=\"A1:B4\"/><row r=\"2\" spans=\"1:2\"><c r=\"A2\" t=\"s\"><v>4</v></c><c r=\"B2\"><v>31</v></c></row>");
        let table = merge_workbook_table("<table ref=\"A1:C4\"><tableColumns count=\"3\"><tableColumn id=\"1\" name=\"a\"/><tableColumn id=\"3\" name=\"c\"/></tableColumns></table>");
        assert_eq!(table, "<table ref=\"A1:B4\"><tableColumns count=\"2\"><tableColumn id=\"1\" name=\"a\"/></tableColumns></table>");
    }
}
