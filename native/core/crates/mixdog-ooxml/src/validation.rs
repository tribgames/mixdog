//! `portable/portable-validation.mjs`: the findings list of a portable OOXML file (`issuesPortableOoxml`): what the package
//! is, what its format measures (slide text fit, contrast and spacing through the text metrics, table height, chart faults,
//! the sheet audits), what the source package is owed, and what the content says (revisions, comments, empty documents,
//! pictures without a description, formula errors and uncached formulas). The order the findings arrive in is the order a
//! reader meets them. `removeOrphanPackageParts` (the package cleaner) lives here too.
//!
//! The structure review of a deck (`reviewOfficeStructure`) is a module of the quality crate, which reads this one, so the
//! caller hands it in as `structure_review`: it receives the deck's snapshot (with `printSheet` set when the options ask) and
//! answers the findings that review answers for it.

use std::collections::HashSet;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::{is_js_space, js_trim, json_number, math, number_to_string, string_to_number, to_number};
use mixdog_raster::image::Image;
use mixdog_raster::stats::stats;
use serde_json::{Map, Value, json};

use crate::cells::{boolean_xml_attribute, sheet_formula_totals, workbook_calculation, workbook_sheets};
use crate::chart_faults::chart_fault_issues;
use crate::docx_xml::{docx_tables, section_text_width};
use crate::opc::{image_pixel_size, part_from_target, part_relationship_path, posix, relationship_map, relationship_owner, remove_content_type_override};
use crate::package::load_package;
use crate::placeholder_scan::placeholder_text_issues;
use crate::pptx_core::{inspect_pptx_text_boxes, resolve_slide_background};
use crate::pptx_table_fit::table_row_cells;
use crate::relations::{Relation, RelationBox};
use crate::review_editability::{review_dead_vector_chart, review_text_fragmentation};
use crate::sheet_audits::{cell_ink_issues, column_fit_issues, formula_consistency_issues, protected_input_issues};
use crate::slide_shapes::EMU_PER_POINT;
use crate::snapshot_docx::snapshot_docx;
use crate::snapshot_pptx::snapshot_pptx;
use crate::snapshot_xlsx::{FULL_READ_CELL_LIMIT, snapshot_xlsx};
use crate::text_metrics::{
    BlockMetrics, Bound, FitOptions, FontSpec, Paragraph, Run, TextBox, TextMeasurer, contrast_ratio, review_cjk_tracking, review_shape_spacing,
    review_stat_label_proximity, review_text_contrast, review_vertical_balance,
};
use crate::validation_package::{ValidateOptions, validate_portable_ooxml};
use crate::xlsx_audit_support::{js_text, truthy};
use crate::xlsx_formula_audit::{AuditOptions, audit_xlsx_formulas, is_checks_sheet_name};
use crate::xml::{compiled, paragraph_texts, top_level_elements, xml_attribute, xml_decode};
use crate::zipio::Package;

/// The structure review of a deck: the deck's snapshot in, the findings out.
pub type StructureReview<'a> = &'a dyn Fn(&Value) -> Vec<Value>;

/// Twenty findings of one kind are all a reader can act on in one pass; the audit keeps measuring past that, it just stops
/// reporting.
const MAX_ISSUES: usize = 20;

const EMU_PER_INCH: f64 = EMU_PER_POINT * 72.0;

/// A picture is only as sharp as the pixels it carries: a 1920-wide projection of a 13.3in canvas asks for about 144 of them
/// per inch, and half of that is where a seat in the room sees the softness. A rule or gradient stretched from a few pixels is
/// not a photograph and is left alone, and a raster that is only the fallback behind a vector is not what the page draws.
const IMAGE_MIN_PPI: f64 = 72.0;
const IMAGE_TARGET_PPI: f64 = 150.0;
const IMAGE_SPACER_PX: f64 = 8.0;

/// A picture that draws nothing leaves a hole the page still makes room for. Only a fully transparent raster is read this way
/// (a flat colour is a band someone meant to draw), and such a file is never large, so only a small one is decoded.
const BLANK_IMAGE_MAX_BYTES: usize = 256 * 1024;

/// A table this long crosses a page break under any ordinary page setup.
const DOCX_LONG_TABLE_ROWS: usize = 25;

/// Word's default cell padding, left and right, when the table names none.
const DOCX_DEFAULT_CELL_MARGIN: f64 = 108.0;

/// Hangul and CJK break between any two characters; only a Latin or numeric word has a width it cannot be broken below.
const UNBREAKABLE_WORD: &str = r"^[^\sᄀ-ᇿ　-鿿가-힯豈-﫿＀-￯]+$";

/// The serif faces, Latin and Korean, a document is likely to name; any other face reads as a sans here.
const SERIF_FACE: &str = r"^(?:cambria|georgia|times new roman|garamond|book antiqua|palatino linotype|constantia|bookman old style|noto serif(?: kr)?|batang|바탕|바탕체|gungsuh|궁서|nanummyeongjo|나눔명조)$";

/// Word's highlighter colours, by the names `w:highlight` stores.
fn highlight_fill(name: &str) -> Option<&'static str> {
    Some(match name {
        "black" => "000000",
        "blue" => "0000FF",
        "cyan" => "00FFFF",
        "green" => "00FF00",
        "magenta" => "FF00FF",
        "red" => "FF0000",
        "yellow" => "FFFF00",
        "white" => "FFFFFF",
        "darkBlue" => "000080",
        "darkCyan" => "008080",
        "darkGreen" => "008000",
        "darkMagenta" => "800080",
        "darkRed" => "800000",
        "darkYellow" => "808000",
        "darkGray" => "808080",
        "lightGray" => "C0C0C0",
        _ => return None,
    })
}

// ---- small readers ----------------------------------------------------------------------------------------------------

/// The first group of the first match, `None` when the pattern does not match.
fn capture(pattern: &str, text: &str) -> Option<String> {
    compiled(pattern, "").captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `Number(pattern.exec(text)?.[1])` for a digit group: the number, or `fallback` when there is no match.
fn number_or(pattern: &str, text: &str, fallback: f64) -> f64 {
    capture(pattern, text).map_or(fallback, |digits| string_to_number(&digits))
}

/// `Number(pattern.exec(text)?.[1]) || 0`.
fn number_or_zero(pattern: &str, text: &str) -> f64 {
    let number = number_or(pattern, text, 0.0);
    if number.is_nan() { 0.0 } else { number }
}

/// Every match of a global pattern.
fn matches(pattern: &str, text: &str) -> Vec<String> {
    compiled(pattern, "g").find_iter(text).map(|range| text[range].to_owned()).collect()
}

fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn finding(severity: &str, code: &str, path: &str, message: &str, source: Option<&str>) -> Value {
    let mut issue = Map::new();
    issue.insert("severity".to_owned(), Value::from(severity));
    issue.insert("code".to_owned(), Value::from(code));
    issue.insert("path".to_owned(), Value::from(path));
    issue.insert("message".to_owned(), Value::from(message));
    if let Some(source) = source {
        issue.insert("source".to_owned(), Value::from(source));
    }
    Value::Object(issue)
}

/// `{ severity, source, ...review }`: the review's own fields follow, and win where they repeat a key.
fn tagged(severity: &str, source: &str, review: &Value) -> Value {
    let mut issue = Map::new();
    issue.insert("severity".to_owned(), Value::from(severity));
    issue.insert("source".to_owned(), Value::from(source));
    if let Value::Object(fields) = review {
        for (key, value) in fields {
            issue.insert(key.clone(), value.clone());
        }
    }
    Value::Object(issue)
}

fn slide_number(part: &str) -> f64 {
    number_or_zero(r"slide(\d+)\.xml$", part)
}

// ---- the readable ink of a Word document ----------------------------------------------------------------------------

/// A run's own shading or highlight is the field its letters sit on: white "inverse video" on a black run shade was measured
/// against the page and reported as 1:1 ink nobody could read.
fn run_field(properties: &str, fill: &str) -> String {
    if let Some(shade) = capture(r#"<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})""#, properties) {
        return shade;
    }
    capture(r#"<w:highlight\b[^>]*\bw:val="([A-Za-z]+)""#, properties).and_then(|name| highlight_fill(&name)).unwrap_or(fill).to_owned()
}

/// Large text (18pt, or 14pt bold) is readable at 3:1; everything else needs 4.5:1.
fn minimum_contrast(size: f64, bold: bool) -> f64 {
    if size >= 18.0 || (size >= 14.0 && bold) { 3.0 } else { 4.5 }
}

struct WorstInk {
    ratio: f64,
    minimum: f64,
    size: f64,
}

/// The worst readable ratio among a block's runs, with the size and weight that decide the minimum. Word keeps sizes in
/// half-points.
fn run_ink_reading(xml: &str, fill: &str) -> Option<WorstInk> {
    let mut worst: Option<WorstInk> = None;
    for run in matches(r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>", xml) {
        if js_trim(&paragraph_texts(&run, "w:t").join("")).is_empty() {
            continue;
        }
        let properties = compiled(r"<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>", "").find(&run).map_or("", |range| &run[range]);
        // Hidden text is not on the printed page. A run that switches an inherited vanish off (w:val="0", "false", "off") is
        // on the page, and reading that flag as hidden left its ink unmeasured.
        if let Some(vanish) = capture(r"<w:vanish\b([^>]*?)\/?>", properties) {
            if !compiled(r"\bw:val=", "").is_match(&vanish) || boolean_xml_attribute(&vanish, "w:val") {
                continue;
            }
        }
        let Some(color) = capture(r#"<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6})""#, properties) else { continue };
        let half_points = number_or(r#"<w:sz\b[^>]*\bw:val="(\d+)""#, properties, 0.0) / 2.0;
        let size = if half_points == 0.0 || half_points.is_nan() { 11.0 } else { half_points };
        let bold = compiled(r"<w:b(?:\s[^>]*)?\/>", "").is_match(properties);
        let Some(ratio) = contrast_ratio(&color, &run_field(properties, fill)) else { continue };
        let minimum = minimum_contrast(size, bold);
        if ratio >= minimum {
            continue;
        }
        if worst.as_ref().is_none_or(|known| ratio < known.ratio) {
            worst = Some(WorstInk { ratio, minimum, size });
        }
    }
    worst
}

/// The fill a container (`w:pPr`, `w:tblPr`, `w:tcPr`) states, empty for none or white.
fn container_fill(xml: &str, container: &str) -> String {
    let block = compiled(&format!(r"<{container}\b[^>]*>[\s\S]*?</{container}>"), "").find(xml).map_or("", |range| &xml[range]);
    let fill = capture(r#"<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})""#, block).unwrap_or_default();
    if !fill.is_empty() && fill.to_lowercase() != "ffffff" { fill } else { String::new() }
}

fn ink_message(subject: &str, worst: &WorstInk, what: &str) -> String {
    format!(
        "{subject} contrast is {}:1 against its {what}; {}:1 is the readable minimum at {}pt.",
        math::to_fixed(worst.ratio, 2),
        number_to_string(worst.minimum),
        number_to_string(math::round(worst.size))
    )
}

/// Ink a reader cannot see, by the rule the deck and the workbook already use: a shaded table row that keeps the body's dark
/// colour, or text so pale it disappears into the page.
fn document_ink_issues(document: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    let body = capture(r"<w:body\b[^>]*>([\s\S]*)<\/w:body>", document).unwrap_or_default();
    let mut paragraph_ordinal = 0;
    let mut table_ordinal = 0;
    for block in top_level_elements(&body, &["w:p", "w:tbl"]) {
        if block.name == "w:p" {
            paragraph_ordinal += 1;
            let fill = container_fill(&block.xml, "w:pPr");
            let Some(worst) = run_ink_reading(&block.xml, if fill.is_empty() { "FFFFFF" } else { &fill }) else { continue };
            issues.push(finding(
                "warning",
                "low_contrast",
                &format!("/body/p[{paragraph_ordinal}]"),
                &ink_message("Text", &worst, "field"),
                Some("text-metrics"),
            ));
            if issues.len() >= MAX_ISSUES {
                return issues;
            }
            continue;
        }
        table_ordinal += 1;
        let table_fill = container_fill(&block.xml, "w:tblPr");
        for (row_index, row) in matches(r"<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>", &block.xml).iter().enumerate() {
            for (cell_index, cell) in matches(r"<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>", row).iter().enumerate() {
                let own = container_fill(cell, "w:tcPr");
                let fill = if !own.is_empty() {
                    own
                } else if !table_fill.is_empty() {
                    table_fill.clone()
                } else {
                    "FFFFFF".to_owned()
                };
                let Some(worst) = run_ink_reading(cell, &fill) else { continue };
                issues.push(finding(
                    "warning",
                    "low_contrast",
                    &format!("/body/tbl[{table_ordinal}]/row[{}]/cell[{}]", row_index + 1, cell_index + 1),
                    &ink_message("Cell text", &worst, "field"),
                    Some("text-metrics"),
                ));
                if issues.len() >= MAX_ISSUES {
                    return issues;
                }
            }
        }
    }
    issues
}

// ---- the parts a review reads --------------------------------------------------------------------------------------

/// The parts whose visible text a review reads: every slide of a deck, the body, headers, and footers of a document (a header
/// prints on every page), nothing for a workbook.
fn text_parts(zip: &Package, format: &str) -> Vec<String> {
    let pattern = match format {
        "pptx" => r"^ppt\/slides\/slide\d+\.xml$",
        "docx" => r"^word\/(?:document|header\d+|footer\d+)\.xml$",
        _ => return Vec::new(),
    };
    let pattern = compiled(pattern, "");
    let mut parts: Vec<String> = zip.names().into_iter().filter(|name| pattern.is_match(name)).collect();
    parts.sort();
    parts
}

fn placeholder_issues(zip: &Package, format: &str) -> Vec<Value> {
    let tag = if format == "pptx" { "a:t" } else { "w:t" };
    let mut issues = Vec::new();
    for part in text_parts(zip, format) {
        let xml = zip.text(&part);
        if xml.is_empty() {
            continue;
        }
        let text = paragraph_texts(&xml, tag).join(" ");
        let slide = slide_number(&part);
        let story = capture(r"^word\/(header|footer)\d+\.xml$", &part);
        let path = if slide != 0.0 {
            format!("/slide[{}]", number_to_string(slide))
        } else if let Some(story) = &story {
            format!("/{story}")
        } else {
            "/body".to_owned()
        };
        let mut extra = Map::new();
        if story.is_some() {
            extra.insert("part".to_owned(), Value::from(part.clone()));
        }
        issues.extend(placeholder_text_issues(&text, &path, &extra));
    }
    issues
}

// ---- pictures --------------------------------------------------------------------------------------------------------

/// What a reader who cannot see the picture is actually told. A writer that stores the file name ("preencoded.png",
/// "image3.jpg") has described nothing, and counting it as a description let the accessibility rule pass on decks whose every
/// picture was unlabelled.
fn describes_picture(description: &str) -> bool {
    let text = js_trim(description);
    if text.is_empty() {
        return false;
    }
    !compiled(r"^[\w ().\-À-ɏ]+\.(?:png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$", "i").is_match(text)
}

fn missing_alt_text_issue(path: &str) -> Value {
    finding("warning", "missing_alt_text", path, "Picture has no alternative text; add_image takes altText.", None)
}

/// `String(picture.altText || '')`.
fn alt_text(picture: &Value) -> String {
    if truthy(picture.get("altText")) { js_text(picture.get("altText")) } else { String::new() }
}

/// The pictures of a snapshot that carry no description (a Word report delivered without one leaves the same reader with
/// nothing). The snapshot's own picture list is the reading, so the finding points at the element the caller can look up, a
/// header logo included.
pub fn picture_description_issues(snapshot: &Value) -> Vec<Value> {
    list(snapshot.get("images"))
        .iter()
        .filter(|picture| !describes_picture(&alt_text(picture)))
        .map(|picture| missing_alt_text_issue(&text_of(picture, "path")))
        .collect()
}

fn draws_nothing(data: &[u8]) -> bool {
    if data.is_empty() || data.len() > BLANK_IMAGE_MAX_BYTES {
        return false;
    }
    // A raster the decoder cannot read is a separate fault; it is not blank.
    match Image::decode(data) {
        Ok(image) => {
            let bands = stats(&image);
            bands.len() == 4 && bands[3].max == 0
        }
        Err(_) => false,
    }
}

/// The fraction of the raster a pptx crop leaves visible on each axis.
fn visible_fraction(picture: &str, format: &str) -> (f64, f64) {
    let source_rect = if format == "pptx" { capture(r"<a:srcRect\b([^>]*)\/?>", picture) } else { None };
    let Some(source_rect) = source_rect.filter(|rect| !rect.is_empty()) else { return (1.0, 1.0) };
    let side = |name: &str| {
        let number = string_to_number(&xml_attribute(&source_rect, name));
        if number.is_nan() { 0.0 } else { number }
    };
    (1.0 - (side("l") + side("r")) / 100_000.0, 1.0 - (side("t") + side("b")) / 100_000.0)
}

struct Placed<'a> {
    width: f64,
    height: f64,
    cx: f64,
    cy: f64,
    picture: &'a str,
    visible: (f64, f64),
    path: &'a str,
}

fn low_resolution_issue(placed: &Placed<'_>) -> Option<Value> {
    let inches_wide = placed.cx / EMU_PER_INCH;
    let inches_tall = placed.cy / EMU_PER_INCH;
    let drawn_at = math::min(
        (placed.width * placed.visible.0) / math::max(inches_wide, 0.01),
        (placed.height * placed.visible.1) / math::max(inches_tall, 0.01),
    );
    let enlarged = !placed.picture.contains("svgBlip") && placed.width >= IMAGE_SPACER_PX && placed.height >= IMAGE_SPACER_PX && drawn_at < IMAGE_MIN_PPI;
    if !enlarged {
        return None;
    }
    let message = format!(
        "Image carries {}x{} px for a {}x{} in frame ({} px per inch); it is enlarged past its own detail and draws soft. Supply about {}x{} px, or place it smaller.",
        number_to_string(placed.width),
        number_to_string(placed.height),
        math::to_fixed(inches_wide, 1),
        math::to_fixed(inches_tall, 1),
        number_to_string(math::round(drawn_at)),
        number_to_string(math::round(inches_wide * IMAGE_TARGET_PPI)),
        number_to_string(math::round(inches_tall * IMAGE_TARGET_PPI)),
    );
    Some(finding("warning", "image_low_resolution", placed.path, &message, Some("image-audit")))
}

fn aspect_distortion_issue(placed: &Placed<'_>) -> Option<Value> {
    let placed_aspect = placed.cx / placed.cy;
    let visible_aspect = ((placed.width / placed.height) * placed.visible.0) / placed.visible.1;
    if !placed_aspect.is_finite() || !visible_aspect.is_finite() || visible_aspect <= 0.0 {
        return None;
    }
    let drift = (placed_aspect - visible_aspect).abs() / visible_aspect;
    if drift <= 0.1 {
        return None;
    }
    let message = format!(
        "Image is stretched {}% off its visible {}x{} aspect ratio; set only width or height to keep the original proportions.",
        number_to_string(math::round(drift * 100.0)),
        number_to_string(placed.width),
        number_to_string(placed.height)
    );
    Some(finding("warning", "image_aspect_distorted", placed.path, &message, Some("image-audit")))
}

/// The findings for one placed picture: a blank raster ends that picture's audit; otherwise enlargement past its own detail,
/// then aspect distortion.
fn picture_issues(bytes: &[u8], placed: &Placed<'_>) -> Vec<Value> {
    if draws_nothing(bytes) {
        return vec![finding(
            "error",
            "blank_image",
            placed.path,
            "Picture draws nothing: every pixel of the raster is transparent, so the page keeps the frame and its caption while the reader sees an empty box.",
            Some("image-audit"),
        )];
    }
    [low_resolution_issue(placed), aspect_distortion_issue(placed)].into_iter().flatten().collect()
}

fn image_placement_issues(zip: &Package, format: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    for part in text_parts(zip, format) {
        let xml = zip.text(&part);
        if xml.is_empty() {
            continue;
        }
        let relationships = relationship_map(&zip.text(&part_relationship_path(&part)));
        let slide = slide_number(&part);
        let pictures = if format == "pptx" { matches(r"<p:pic>[\s\S]*?<\/p:pic>", &xml) } else { matches(r"<w:drawing>[\s\S]*?<\/w:drawing>", &xml) };
        for (index, picture) in pictures.iter().enumerate() {
            let ordinal = index + 1;
            let Some(embed) = capture(r#"<a:blip\b[^>]*\br:embed="([^"]+)""#, picture) else { continue };
            let extent_pattern = if format == "pptx" { r#"<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""# } else { r#"<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""# };
            let Some(extent) = compiled(extent_pattern, "").captures(picture) else { continue };
            let (cx, cy) = (string_to_number(extent.get(1).unwrap_or("")), string_to_number(extent.get(2).unwrap_or("")));
            let Some(target) = relationships.get(&embed) else { continue };
            let media = part_from_target(&posix::dirname(&part), target);
            let Some(bytes) = zip.file(&media) else { continue };
            let Some(source) = image_pixel_size(bytes) else { continue };
            if source.width == 0 || source.height == 0 {
                continue;
            }
            let path = if slide != 0.0 { format!("/slide[{}]/picture[{ordinal}]", number_to_string(slide)) } else { format!("/body/picture[{ordinal}]") };
            let placed = Placed {
                width: f64::from(source.width),
                height: f64::from(source.height),
                cx,
                cy,
                picture,
                visible: visible_fraction(picture, format),
                path: &path,
            };
            for issue in picture_issues(bytes, &placed) {
                issues.push(issue);
                if issues.len() >= MAX_ISSUES {
                    return issues;
                }
            }
        }
    }
    issues
}

// ---- the package cleaner -----------------------------------------------------------------------------------------------

/// What `removeOrphanPackageParts` did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OrphanSweep {
    /// The parts removed, each orphan followed by its relationships part when it had one.
    pub removed: Vec<String>,
    /// Why nothing was done (`no-relationship-parts`), when that is the case.
    pub skipped: Option<&'static str>,
}

fn referenced_parts(zip: &Package) -> HashSet<String> {
    let mut referenced = HashSet::new();
    for relationships in zip.names().into_iter().filter(|name| name.ends_with(".rels")) {
        let owner = relationship_owner(&relationships);
        let xml = zip.text(&relationships);
        if xml.is_empty() {
            continue;
        }
        for tag in matches(r"<Relationship\b[^>]*?\/?>", &xml) {
            if compiled(r#"\bTargetMode="External""#, "i").is_match(&tag) {
                continue;
            }
            let target = xml_decode(&xml_attribute(&tag, "Target"));
            if target.is_empty() {
                continue;
            }
            referenced.insert(match target.strip_prefix('/') {
                Some(rooted) => rooted.to_owned(),
                None => posix::normalize(&posix::join(&[&posix::dirname(&owner), &target])),
            });
        }
    }
    referenced
}

/// `removeOrphanPackageParts(zip)`: the media, embeddings, charts, drawings, diagrams, ink and notes parts no relationship
/// reaches, removed with their relationships and content-type overrides (up to eight passes, as removing one can orphan
/// another). A package that carries no relationship part is left alone; one whose relationships resolve to nothing is refused.
pub fn remove_orphan_package_parts(zip: &mut Package) -> Result<OrphanSweep, String> {
    let mut sweep = OrphanSweep::default();
    if !zip.names().iter().any(|name| name.ends_with(".rels")) {
        sweep.skipped = Some("no-relationship-parts");
        return Ok(sweep);
    }
    let cleanable = compiled(r"^(?:ppt|xl|word)\/(?:media|embeddings|charts|drawings|diagrams|ink|notesSlides)\/", "i");
    for _ in 0..8 {
        let referenced = referenced_parts(zip);
        if referenced.is_empty() {
            return Err("Refusing to clean the package: no relationship resolves to a part".to_owned());
        }
        let orphans: Vec<String> = zip
            .entries()
            .into_iter()
            .filter(|entry| !entry.dir && cleanable.is_match(&entry.name) && !entry.name.contains("/_rels/") && !referenced.contains(&entry.name))
            .map(|entry| entry.name.clone())
            .collect();
        if orphans.is_empty() {
            break;
        }
        for orphan in orphans {
            zip.remove(&orphan);
            sweep.removed.push(orphan.clone());
            let relationships = part_relationship_path(&orphan);
            if zip.file(&relationships).is_some() {
                zip.remove(&relationships);
                sweep.removed.push(relationships);
            }
            remove_content_type_override(zip, &format!("/{orphan}"));
        }
    }
    Ok(sweep)
}

// ---- the package's own findings --------------------------------------------------------------------------------------

/// What the package itself is missing or contradicts, read from a validation result.
fn package_structure_issues(validation: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let error = |code: &str, path: String, message: String| finding("error", code, &path, &message, None);
    for missing in list(validation.get("missing")) {
        let name = js_text(Some(missing));
        issues.push(error("missing_part", format!("/{name}"), format!("Required package part is missing: {name}")));
    }
    for unsafe_entry in list(validation.get("unsafeEntries")) {
        let name = js_text(Some(unsafe_entry));
        issues.push(error("unsafe_zip_entry", format!("/{name}"), format!("Unsafe ZIP entry path: {name}")));
    }
    for malformed in list(validation.get("malformedXml")) {
        issues.push(error("malformed_xml", format!("/{}", text_of(malformed, "part")), text_of(malformed, "error")));
    }
    for relationship in list(validation.get("missingRelationships")) {
        let id = text_of(relationship, "id");
        let resolved = text_of(relationship, "resolved");
        let target = if resolved.is_empty() { text_of(relationship, "target") } else { resolved };
        issues.push(error(
            "missing_relationship_target",
            format!("/{}", text_of(relationship, "relationship")),
            format!("Relationship {} targets missing part {target}", if id.is_empty() { "(unnamed)" } else { id.as_str() }),
        ));
    }
    for relationship in list(validation.get("duplicateRelationshipIds")) {
        issues.push(error(
            "duplicate_relationship_id",
            format!("/{}", text_of(relationship, "relationship")),
            format!("Relationship id is duplicated: {}", js_text(relationship.get("id"))),
        ));
    }
    for fault in list(validation.get("presentationFaults")) {
        issues.push(error(&text_of(fault, "code"), format!("/{}", text_of(fault, "part")), text_of(fault, "message")));
    }
    for part in list(validation.get("missingContentTypes")) {
        issues.push(error("missing_content_type", format!("/{}", js_text(Some(part))), "Package part has no matching content type declaration.".to_owned()));
    }
    if truthy(validation.get("mainContentTypeMissing")) {
        issues.push(error(
            "missing_main_content_type",
            format!("/{}", js_text(validation.get("mainPart"))),
            "The main Office document part needs an explicit content type override.".to_owned(),
        ));
    }
    issues
}

/// What the source package carried and this copy must answer for: protected parts, signatures, macros, connections, embedded
/// objects, external links.
fn package_provenance_issues(validation: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let security = validation.get("security");
    let baseline = validation.get("baseline");
    let error = |code: &str, path: String, message: &str| finding("error", code, &path, message, None);
    let warning = |code: &str, path: String, message: String| finding("warning", code, &path, &message, None);
    for part in list(baseline.and_then(|found| found.get("lostProtectedParts"))) {
        issues.push(error("lost_protected_part", format!("/{}", js_text(Some(part))), "A macro, master, layout, or theme part from the source package was removed."));
    }
    for part in list(baseline.and_then(|found| found.get("changedProtectedParts"))) {
        issues.push(error(
            "changed_protected_part",
            format!("/{}", js_text(part.get("part"))),
            "A macro, signature, embedded object, external link, connection, master, layout, or theme part changed unexpectedly.",
        ));
    }
    if truthy(security.and_then(|found| found.get("digitalSignatureInvalidated"))) {
        issues.push(error("digital_signature_invalidated", "/".to_owned(), "The source package was digitally signed and document changes invalidate that signature."));
    }
    for macro_part in list(validation.get("macros")) {
        issues.push(warning(
            "macro_present",
            format!("/{}", js_text(Some(macro_part))),
            "VBA macro payload is present and is never executed by the portable backend.".to_owned(),
        ));
    }
    for connection in list(security.and_then(|found| found.get("dataConnections"))) {
        issues.push(warning(
            "data_connection_present",
            format!("/{}", js_text(Some(connection))),
            "Workbook data connection is preserved but never refreshed automatically.".to_owned(),
        ));
    }
    for embedded in list(security.and_then(|found| found.get("embeddedObjects"))) {
        issues.push(warning(
            "embedded_object_present",
            format!("/{}", js_text(Some(embedded))),
            "Embedded object is preserved but never activated by Mixdog.".to_owned(),
        ));
    }
    for relationship in list(validation.get("externalRelationships")) {
        issues.push(warning(
            "external_relationship",
            format!("/{}", text_of(relationship, "relationship")),
            format!("External relationship: {}", js_text(relationship.get("target"))),
        ));
    }
    issues
}

/// The workbook audits that read the sheet parts rather than a snapshot. A percentage stored as a whole number is the shared
/// formula audit's finding (`percentage_stored_as_whole`, on both backends): read here too it put one defect in the list twice.
fn sheet_audit_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package) -> Result<Vec<Value>, String> {
    let sheets = workbook_sheets(zip);
    let mut issues = column_fit_issues(measurer, zip, &sheets)?;
    issues.extend(protected_input_issues(zip, &sheets)?);
    issues.extend(cell_ink_issues(zip, &sheets)?);
    issues.extend(formula_consistency_issues(zip, &sheets));
    Ok(issues)
}

// ---- slides ----------------------------------------------------------------------------------------------------------

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn paragraph_of(value: &Value) -> Paragraph {
    Paragraph {
        text: string_field(value, "text").unwrap_or_default(),
        font_name: string_field(value, "fontName"),
        font_size: number_field(value, "fontSize"),
        bold: value["bold"] == json!(true),
        italic: value["italic"] == json!(true),
        line_spacing: number_field(value, "lineSpacing"),
        space_before: number_field(value, "spaceBefore").unwrap_or(0.0),
        space_after: number_field(value, "spaceAfter").unwrap_or(0.0),
        runs: value
            .get("runs")
            .and_then(Value::as_array)
            .map(|runs| runs.iter().map(|run| Run { text: string_field(run, "text").unwrap_or_default(), font_size: number_field(run, "fontSize") }).collect()),
        color: string_field(value, "color"),
        char_spacing: number_field(value, "charSpacing").unwrap_or(0.0),
    }
}

fn text_box_of(value: &Value) -> TextBox {
    let frame = RelationBox {
        slide: number_field(value, "slide").unwrap_or(f64::NAN),
        shape: number_field(value, "shape").unwrap_or(f64::NAN),
        left: number_field(value, "left").unwrap_or(f64::NAN),
        top: number_field(value, "top").unwrap_or(f64::NAN),
        width: number_field(value, "width").unwrap_or(f64::NAN),
        height: number_field(value, "height").unwrap_or(f64::NAN),
        relation: value.get("relation").and_then(Relation::from_value),
        relation_error: string_field(value, "relationError"),
    };
    let mut text_box = TextBox::new(frame);
    text_box.paragraphs = list(value.get("paragraphs")).iter().map(paragraph_of).collect();
    text_box.background = string_field(value, "background");
    text_box.wrap = value["wrap"] != json!(false);
    text_box.autofit = value["autofit"] == json!(true);
    text_box.inset_left = number_field(value, "insetLeft").unwrap_or(0.0);
    text_box.inset_right = number_field(value, "insetRight").unwrap_or(0.0);
    text_box.inset_top = number_field(value, "insetTop").unwrap_or(0.0);
    text_box.inset_bottom = number_field(value, "insetBottom").unwrap_or(0.0);
    text_box
}

fn bound_of(value: &Value) -> Bound {
    Bound {
        slide: number_field(value, "slide").unwrap_or(f64::NAN),
        left: number_field(value, "left").unwrap_or(0.0),
        top: number_field(value, "top").unwrap_or(f64::NAN),
        width: number_field(value, "width").unwrap_or(0.0),
        height: number_field(value, "height").unwrap_or(0.0),
        kind: string_field(value, "kind").unwrap_or_default(),
        name: string_field(value, "name").unwrap_or_default(),
    }
}

/// A header row on a dark fill with the body's dark ink is unreadable in exactly the way a shape's text would be; cells are
/// measured the same way, against their own fill or the slide behind them.
fn table_cell_contrast(cell_xml: &str, body: &str, slide_surface: &str) -> Option<f64> {
    let properties = compiled(r"<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>", "").find(cell_xml).map_or("", |range| &cell_xml[range]);
    // The cell's own fill follows its border definitions, and each border carries a colour of its own: read the fill after
    // the lines are out.
    let pairs = compiled(r"<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*>[\s\S]*?<\/a:ln(?:L|R|T|B|TlToBr|BlToTr)>", "g").replace_all_with(properties, |_| String::new());
    let surface = compiled(r"<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*\/>", "g").replace_all_with(&pairs, |_| String::new());
    let fill = capture(r#"<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, &surface).unwrap_or_else(|| slide_surface.to_owned());
    let ink = capture(r#"<a:rPr\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, body).unwrap_or_default();
    if !fill.is_empty() && !ink.is_empty() { contrast_ratio(&ink, &fill) } else { None }
}

struct CellOverflow {
    cell_path: String,
    measured: BlockMetrics,
    available: f64,
}

struct RowContext<'a> {
    widths: &'a [f64],
    path_prefix: &'a str,
    slide_surface: &'a str,
}

/// Measures one table row's cells for contrast (pushing at most twenty reports in total) and collects the cells whose text
/// needs more height than the row declares into `overflows`; returns the row's drawn height in EMU (the larger of its
/// declared height and its tallest cell).
fn audit_table_row<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    row_xml: &str,
    context: &RowContext<'_>,
    issues: &mut Vec<Value>,
    overflows: &mut Vec<CellOverflow>,
) -> Result<f64, String> {
    let row = table_row_cells(measurer, row_xml, context.widths).map_err(|error| error.to_string())?;
    for cell in &row.cells {
        let cell_path = format!("{}/cell[{}]", context.path_prefix, cell.column_ordinal);
        let ratio = table_cell_contrast(&cell.xml, &cell.body, context.slide_surface);
        let minimum = minimum_contrast(cell.size, cell.bold);
        // The cap is on the reports; the rows are still measured so the table's height is known.
        if let Some(ratio) = ratio.filter(|ratio| *ratio < minimum) {
            if issues.len() < MAX_ISSUES {
                let worst = WorstInk { ratio, minimum, size: cell.size };
                issues.push(finding("warning", "low_contrast", &cell_path, &ink_message("Cell text", &worst, "fill"), Some("text-metrics")));
            }
        }
        let Some(fit) = &cell.fit else { continue };
        if fit.measured.height > fit.available * 1.08 {
            overflows.push(CellOverflow { cell_path, measured: fit.measured, available: fit.available });
        }
    }
    Ok(row.height)
}

/// One report per table for the cells that outgrow their rows: a frame declared too short for its ten rows named every one of
/// its cells, twenty reports of one fault. The first cell names the place; the count names the extent.
fn table_overflow_issue(overflows: &[CellOverflow]) -> Option<Value> {
    let first = overflows.first()?;
    let tallest = overflows.iter().fold(first, |top, entry| if entry.measured.height > top.measured.height { entry } else { top });
    let message = if overflows.len() == 1 {
        format!(
            "Cell text needs about {}pt across {} line(s) but the row offers {}pt; shorten the text or widen the column.",
            number_to_string(math::round(first.measured.height)),
            first.measured.lines,
            number_to_string(math::round(first.available))
        )
    } else {
        format!(
            "{} cells need more height than their rows give (the tallest about {}pt in a {}pt row); each row grows to its text, so the table draws taller than its frame \u{2014} widen the columns, shorten the text, or give the frame the height.",
            overflows.len(),
            number_to_string(math::round(tallest.measured.height)),
            number_to_string(math::round(tallest.available))
        )
    };
    Some(finding("warning", "table_cell_overflow", &first.cell_path, &message, Some("text-metrics")))
}

fn table_cell_overflow_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    // A row grows to its tallest cell when the text needs more than the declared height, so a table whose rows are declared to
    // fit can still run off the canvas once drawn. The predicted height (each row at the larger of its declared height and its
    // tallest cell) is compared with the room under the frame's top.
    let slide_height = number_or_zero(r#"<p:sldSz\b[^>]*\bcy="(\d+)""#, &zip.text("ppt/presentation.xml"));
    for part in text_parts(zip, "pptx") {
        let xml = zip.text(&part);
        if xml.is_empty() {
            continue;
        }
        let slide = number_to_string(slide_number(&part));
        // A cell with no fill of its own shows whatever the slide shows.
        let slide_surface = resolve_slide_background(zip, &part, &xml)?;
        let mut table_ordinal = 0;
        for frame in matches(r"<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>", &xml) {
            let Some(range) = compiled(r"<a:tbl>[\s\S]*?<\/a:tbl>", "").find(&frame) else { continue };
            let table = &frame[range];
            table_ordinal += 1;
            let frame_top = number_or_zero(r#"<p:xfrm>[\s\S]*?<a:off\b[^>]*\by="(-?\d+)""#, &frame);
            let widths: Vec<f64> = compiled(r#"<a:gridCol\b[^>]*\bw="(\d+)""#, "g").captures_iter(table).map(|found| string_to_number(found.get(1).unwrap_or(""))).collect();
            if widths.is_empty() {
                continue;
            }
            let table_path = format!("/slide[{slide}]/table[{table_ordinal}]");
            let mut predicted = 0.0;
            let mut overflows = Vec::new();
            for (row_index, row) in matches(r"<a:tr\b[^>]*>[\s\S]*?<\/a:tr>", table).iter().enumerate() {
                let path_prefix = format!("{table_path}/row[{}]", row_index + 1);
                let context = RowContext { widths: &widths, path_prefix: &path_prefix, slide_surface: &slide_surface };
                predicted += audit_table_row(measurer, row, &context, &mut issues, &mut overflows)?;
            }
            if let Some(overflow) = table_overflow_issue(&overflows) {
                if issues.len() < MAX_ISSUES {
                    issues.push(overflow);
                }
            }
            // The lower safe margin is 0.4 in (a source line or page number may sit there; a table may not).
            let room = slide_height - 0.4 * 914_400.0 - frame_top;
            if slide_height != 0.0 && frame_top >= 0.0 && predicted > room {
                let message = format!(
                    "The table's rows draw to about {}pt tall but only {}pt remain under its top; the rows that wrap or the count push it past the canvas \u{2014} fewer rows, wider columns, or a smaller pitch.",
                    number_to_string(math::round(predicted / EMU_PER_POINT)),
                    number_to_string(math::round(room / EMU_PER_POINT))
                );
                issues.push(finding("warning", "table_exceeds_canvas", &table_path, &message, Some("text-metrics")));
            }
        }
    }
    Ok(issues)
}

/// What the slides measure: fit, contrast, tracking, spacing, balance, structure, charts.
fn presentation_metric_issues<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &Package,
    options: &Value,
    structure_review: StructureReview<'_>,
) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    let inspected = inspect_pptx_text_boxes(zip)?;
    let boxes_value = list(inspected.get("boxes"));
    let boxes: Vec<TextBox> = boxes_value.iter().map(text_box_of).collect();
    let content = list(inspected.get("content"));
    let slide_width = number_field(&inspected, "slideWidth").unwrap_or(0.0);
    let slide_height = number_field(&inspected, "slideHeight").unwrap_or(0.0);
    let fit_options = FitOptions { slide_width, slide_height, ..FitOptions::default() };
    for fit in measurer.review_text_box_fit(&boxes, &fit_options).map_err(|error| error.to_string())? {
        issues.push(tagged("warning", "text-metrics", &fit));
    }
    for contrast in review_text_contrast(&boxes) {
        issues.push(tagged("warning", "text-metrics", &contrast));
    }
    for tracking in review_cjk_tracking(&boxes) {
        issues.push(tagged("warning", "text-metrics", &tracking));
    }
    for spacing in review_shape_spacing(&boxes, 21.6) {
        issues.push(tagged("info", "text-metrics", &spacing));
    }
    let bounds: Vec<Bound> = content.iter().map(bound_of).collect();
    for balance in review_vertical_balance(&bounds, slide_width, slide_height, &boxes) {
        issues.push(tagged("warning", "text-metrics", &balance));
    }
    for detached in review_stat_label_proximity(&boxes, 36.0) {
        issues.push(tagged("warning", "text-metrics", &detached));
    }
    // The measured read that rides on author and batch sees the same geometry the design review sees: an element a few points
    // off an axis its neighbours share, a margin breach, a collision. A defect is cheapest to answer in the turn that wrote
    // it, not one call later. Contrast stays with the metrics pass above, which measures it against the resolved surface. A
    // PDF's designed sheets (printSheet) are held to the print type floors, not a screen's.
    let mut document = snapshot_pptx(zip, &json!({}), measurer).map_err(|error| error.to_string())?;
    if truthy(options.get("printSheet")) {
        if let Value::Object(fields) = &mut document {
            fields.insert("printSheet".to_owned(), Value::Bool(true));
        }
    }
    for review in structure_review(&document) {
        if review.get("code").and_then(Value::as_str) == Some("low_contrast") {
            continue;
        }
        issues.push(review);
    }
    issues.extend(table_cell_overflow_issues(measurer, zip)?);
    issues.extend(chart_fault_issues(zip));
    for fragment in review_text_fragmentation(boxes_value, 3.0) {
        issues.push(tagged("warning", "editability", &fragment));
    }
    for dead in review_dead_vector_chart(content, boxes_value, 4.0) {
        issues.push(tagged("warning", "editability", &dead));
    }
    Ok(issues)
}

/// Slide pictures delivered without a description, on the requested pages.
fn slide_picture_issues(zip: &Package, options: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let requested: Vec<f64> = list(options.get("pages")).iter().map(to_number).collect();
    // The slides in the order the package lists them (this read does not sort them, unlike the text and table reads).
    let slide_part = compiled(r"^ppt\/slides\/slide\d+\.xml$", "");
    for slide_path in zip.names().into_iter().filter(|name| slide_part.is_match(name)) {
        let slide = slide_number(&slide_path);
        if !requested.is_empty() && !requested.contains(&slide) {
            continue;
        }
        let xml = zip.text(&slide_path);
        for (index, picture) in matches(r"<p:pic(?:\s[^>]*)?>[\s\S]*?<\/p:pic>", &xml).iter().enumerate() {
            let description = capture(r#"\bdescr="([^"]*)""#, picture).unwrap_or_default();
            if describes_picture(&description) {
                continue;
            }
            issues.push(missing_alt_text_issue(&format!("/slide[{}]/picture[{}]", number_to_string(slide), index + 1)));
        }
    }
    issues
}

// ---- Word documents -------------------------------------------------------------------------------------------------

struct BrokenWord {
    row_ordinal: usize,
    cell_ordinal: usize,
    room: f64,
    word: String,
    width: f64,
}

/// A word wider than its cell is broken between letters: "Sun" set as "Su / n", a date "11" stacked as "1 / 1". Word and
/// LibreOffice both do it without a warning, so the column reads as a typo on the printed page.
fn broken_cell_word<P: ReadProof>(measurer: &TextMeasurer<'_, P>, table: &str) -> Result<Option<BrokenWord>, String> {
    let grid = compiled(r"<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>", "").find(table).map_or("", |range| &table[range]);
    let columns: Vec<f64> = compiled(r#"<w:gridCol\b[^>]*\bw:w="(\d+)""#, "g").captures_iter(grid).map(|found| string_to_number(found.get(1).unwrap_or(""))).collect();
    if columns.is_empty() {
        return Ok(None);
    }
    let margins = compiled(r"<w:tblCellMar\b[^>]*>[\s\S]*?<\/w:tblCellMar>", "").find(table).map_or("", |range| &table[range]);
    // A cell's own w:tcMar wins over the table's, which wins over Word's default.
    let side = |name: &str, own: &str| -> f64 {
        let pattern = format!(r#"<w:{name}\b[^>]*\bw:w="(\d+)""#);
        capture(&pattern, own).or_else(|| capture(&pattern, margins)).map_or(DOCX_DEFAULT_CELL_MARGIN, |width| string_to_number(&width))
    };
    let unbreakable = compiled(UNBREAKABLE_WORD, "");
    for (row_index, row) in matches(r"<w:tr[\s>][\s\S]*?<\/w:tr>", table).iter().enumerate() {
        let mut column = 0;
        for (cell_index, cell) in matches(r"<w:tc[\s>][\s\S]*?<\/w:tc>", row).iter().enumerate() {
            let span = math::max(1.0, number_or_zero(r#"<w:gridSpan\b[^>]*\bw:val="(\d+)""#, cell)) as usize;
            let width: f64 = columns.iter().skip(column).take(span).sum();
            column += span;
            if width == 0.0 || compiled(r"<w:tbl[\s>]", "").is_match(cell) {
                continue;
            }
            let own = compiled(r"<w:tcMar\b[^>]*>[\s\S]*?<\/w:tcMar>", "").find(cell).map_or("", |range| &cell[range]);
            let room = (width - side("left", own) - side("right", own)) / 20.0;
            for paragraph in matches(r"<w:p[\s>][\s\S]*?<\/w:p>", cell) {
                let run = compiled(r"<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>", "").find(&paragraph).map_or("", |range| &paragraph[range]);
                let font = FontSpec {
                    font_name: Some(capture(r#"<w:rFonts\b[^>]*\bw:ascii="([^"]+)""#, run).unwrap_or_else(|| "Calibri".to_owned())),
                    font_size: Some(number_or(r#"<w:sz\b[^>]*\bw:val="(\d+)""#, run, 22.0) / 2.0),
                    bold: compiled(r#"<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>"#, "").is_match(run),
                    italic: false,
                };
                let indent = capture(r"<w:pPr\b[^>]*>[\s\S]*?<w:ind\b([^>]*)\/>", &paragraph).unwrap_or_default();
                let inset: f64 = ["left", "start", "right", "end", "firstLine"].iter().map(|name| number_or_zero(&format!(r#"\bw:{name}="(\d+)""#), &indent)).sum();
                let text = paragraph_texts(&paragraph, "w:t").join("");
                let mut widest: Option<(String, f64)> = None;
                for word in text.split(is_js_space).filter(|word| !word.is_empty() && unbreakable.is_match(word)) {
                    let measured = measurer.measure_text_width(word, &font).map_err(|error| error.to_string())?;
                    if widest.as_ref().is_none_or(|(_, known)| measured > *known) {
                        widest = Some((word.to_owned(), measured));
                    }
                }
                let line = room - inset / 20.0;
                if let Some((word, width)) = widest {
                    if width > math::max(0.0, line) * 1.05 {
                        return Ok(Some(BrokenWord { row_ordinal: row_index + 1, cell_ordinal: cell_index + 1, room: line, word, width }));
                    }
                }
            }
        }
    }
    Ok(None)
}

/// Tables wider than the text column, and long tables whose styled header row does not repeat after a page break.
fn document_table_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, document: &str) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    for (index, table) in docx_tables(document).iter().enumerate() {
        let ordinal = index + 1;
        let usable = section_text_width(document, table.index + table.xml.len());
        let row_count = matches(r"<w:tr[\s>]", &table.xml).len();
        let first_row = compiled(r"<w:tr[\s>][\s\S]*?<\/w:tr>", "").find(&table.xml).map_or("", |range| &table.xml[range]);
        if row_count >= DOCX_LONG_TABLE_ROWS
            && compiled(r"<w:b\b[^>]*\/>|<w:shd\b", "").is_match(first_row)
            && !compiled(r"<w:tblHeader\b", "").is_match(first_row)
        {
            issues.push(finding(
                "warning",
                "table_header_not_repeated",
                &format!("/body/table[{ordinal}]"),
                &format!("Table runs {row_count} rows and its header row does not repeat, so every page after the break shows columns with nothing naming them; add_table properties.repeatHeader carries the first row onto each continuation page."),
                None,
            ));
        }
        if let Some(broken) = broken_cell_word(measurer, &table.xml)? {
            issues.push(finding(
                "warning",
                "table_cell_word_broken",
                &format!("/body/table[{ordinal}]/row[{}]/cell[{}]", broken.row_ordinal, broken.cell_ordinal),
                &format!(
                    "\"{}\" needs {}pt and its cell leaves {}pt, so the word breaks between letters; give that column more of the width (add_table properties.columnWidths), shorten the word, or set it smaller.",
                    broken.word,
                    math::to_fixed(broken.width, 0),
                    math::to_fixed(math::max(0.0, broken.room), 0)
                ),
                Some("text-metrics"),
            ));
        }
        let grid = compiled(r"<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>", "").find(&table.xml).map_or("", |range| &table.xml[range]);
        let columns: Vec<f64> = compiled(r#"<w:gridCol\b[^>]*\bw:w="(\d+)""#, "g").captures_iter(grid).map(|found| string_to_number(found.get(1).unwrap_or(""))).collect();
        if columns.is_empty() {
            continue;
        }
        let width: f64 = columns.iter().sum();
        if width <= usable * 1.02 {
            continue;
        }
        issues.push(finding(
            "warning",
            "table_wider_than_page",
            &format!("/body/table[{ordinal}]"),
            &format!(
                "Table spans {}in across a {}in text column; run fit_table to rebalance.",
                math::to_fixed(width / 1440.0, 2),
                math::to_fixed(usable / 1440.0, 2)
            ),
            None,
        ));
    }
    Ok(issues)
}

fn review_state_issues(snapshot: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    if truthy(snapshot.get("revisionCount")) || truthy(snapshot.get("propertyChangeCount")) {
        let formatting = if truthy(snapshot.get("propertyChangeCount")) {
            format!(" and {} formatting change record(s)", js_text(snapshot.get("propertyChangeCount")))
        } else {
            String::new()
        };
        issues.push(finding(
            "info",
            "unresolved_revisions",
            "/body",
            &format!("{} tracked revision element(s){formatting} remain unresolved.", js_text(snapshot.get("revisionCount"))),
            None,
        ));
    }
    // A resolved thread is settled and its replies belong to it: counting them as outstanding tells a reviewer to answer
    // comments Word already closed.
    let open: Vec<&Value> = list(snapshot.get("comments")).iter().filter(|comment| !truthy(comment.get("replyTo")) && !truthy(comment.get("resolved"))).collect();
    if let Some(first) = open.first() {
        let path = if truthy(first.get("path")) { js_text(first.get("path")) } else { "/body".to_owned() };
        issues.push(finding("info", "unresolved_comments", &path, &format!("{} comment thread(s) remain unresolved.", open.len()), None));
    }
    issues
}

fn empty_document_issues(document: &str) -> Vec<Value> {
    let body = capture(r"<w:body\b[^>]*>([\s\S]*)<\/w:body>", document).unwrap_or_default();
    let without_pairs = compiled(r"<w:sectPr\b[\s\S]*?<\/w:sectPr>", "g").replace_all_with(&body, |_| String::new());
    let printable = compiled(r"<w:sectPr\b[^>]*\/>", "g").replace_all_with(&without_pairs, |_| String::new());
    if [r"<w:t[\s>]", "<w:tbl>", "<w:drawing>"].iter().any(|pattern| compiled(pattern, "").is_match(&printable)) {
        return Vec::new();
    }
    vec![finding("error", "empty_document", "/body", "The document body carries no text, table, or image; the requested content never reached the file.", None)]
}

fn face_class(face: &str) -> &'static str {
    if compiled(SERIF_FACE, "i").is_match(js_trim(face)) { "serif" } else { "sans" }
}

/// A run that sets Hangul beside Latin letters or digits in two classes of face (Cambria digits in a Malgun Gothic sentence,
/// the setting a serif `name` without its `nameEastAsia` falls into) reads as two typefaces in one line. Only a Latin face the
/// run names is judged; its Korean face is the run's own or the document default.
fn document_font_pairing_issues(document: &str, styles: &str) -> Vec<Value> {
    let defaults = compiled(r"<w:rPrDefault\b[\s\S]*?<\/w:rPrDefault>", "").find(styles).map_or("", |range| &styles[range]);
    let default_east_asia = xml_decode(&capture(r#"<w:rFonts\b[^>]*\bw:eastAsia="([^"]+)""#, defaults).unwrap_or_else(|| "Malgun Gothic".to_owned()));
    let body = capture(r"<w:body\b[^>]*>([\s\S]*)<\/w:body>", document).unwrap_or_default();
    let mut mixed: Vec<(String, String, String)> = Vec::new();
    let mut paragraph_ordinal = 0;
    for block in top_level_elements(&body, &["w:p", "w:tbl"]) {
        if block.name == "w:p" {
            paragraph_ordinal += 1;
        }
        for run in matches(r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>", &block.xml) {
            let text = paragraph_texts(&run, "w:t").join("");
            if !compiled(r"[가-힣]", "").is_match(&text) || !compiled(r"[A-Za-z0-9]", "").is_match(&text) {
                continue;
            }
            let fonts = compiled(r"<w:rFonts\b[^>]*>", "").find(&run).map_or("", |range| &run[range]);
            let latin = xml_decode(&capture(r#"\bw:ascii="([^"]+)""#, fonts).unwrap_or_default());
            let own = xml_decode(&capture(r#"\bw:eastAsia="([^"]+)""#, fonts).unwrap_or_default());
            let east_asia = if own.is_empty() { default_east_asia.clone() } else { own };
            if latin.is_empty() || face_class(&latin) == face_class(&east_asia) {
                continue;
            }
            let path = if block.name == "w:p" { format!("/body/p[{paragraph_ordinal}]") } else { "/body".to_owned() };
            mixed.push((path, latin, east_asia));
            break;
        }
    }
    let Some((path, latin, east_asia)) = mixed.first() else { return Vec::new() };
    let message = format!(
        "{} block{} Hangul in {east_asia} beside Latin and digits in {latin}, a {} and a {}: the line reads as two typefaces. Pair the faces by class (nameEastAsia beside name, fontNameEastAsia on a table) \u{2014} Cambria with Batang, or Malgun Gothic for both in a sans line.",
        mixed.len(),
        if mixed.len() > 1 { "s set" } else { " sets" },
        face_class(east_asia),
        face_class(latin)
    );
    vec![finding("info", "font_pairing_mismatch", path, &message, Some("document-lint"))]
}

/// What the Word document says about itself: revisions, comments, lint, emptiness, tables wider than the text column or losing
/// their header after a page break, ink, font pairing, and pictures without a description.
fn document_content_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, validation: &Value) -> Result<Vec<Value>, String> {
    let snapshot = snapshot_docx(zip, &json!({}));
    let document = zip.text("word/document.xml");
    let mut issues = review_state_issues(&snapshot);
    for lint in list(validation.get("documentLint")) {
        let part = text_of(lint, "part");
        let path = if !part.is_empty() && part != "word/document.xml" { format!("/{part}") } else { "/body".to_owned() };
        let mut entry = Map::new();
        entry.insert("severity".to_owned(), lint.get("severity").cloned().unwrap_or(Value::Null));
        entry.insert("code".to_owned(), lint.get("code").cloned().unwrap_or(Value::Null));
        entry.insert("path".to_owned(), Value::from(path));
        entry.insert("message".to_owned(), lint.get("message").cloned().unwrap_or(Value::Null));
        entry.insert("source".to_owned(), Value::from("document-lint"));
        issues.push(Value::Object(entry));
    }
    issues.extend(empty_document_issues(&document));
    issues.extend(document_table_issues(measurer, &document)?);
    issues.extend(document_ink_issues(&document));
    issues.extend(document_font_pairing_issues(&document, &zip.text("word/styles.xml")));
    issues.extend(picture_description_issues(&snapshot));
    Ok(issues)
}

// ---- workbooks ------------------------------------------------------------------------------------------------------

/// One sheet's values: how far the audit read, formula errors, and formulas without a cached value.
fn sheet_value_issues(sheet: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let sheet_path = text_of(sheet, "path");
    let cells = list(sheet.get("cells"));
    // Past the audit's own ceiling the answer says how far it read, so a clean report is never mistaken for a sheet that was
    // read to the end. How far the audit read is a fact about this call, not a defect in the document: it is reported, never
    // handed to a fix round.
    if truthy(sheet.get("truncated")) {
        issues.push(finding(
            "info",
            "audit_scope_limited",
            &sheet_path,
            &format!(
                "Only the first {} of {} populated cells on this sheet were audited; audit the rest with issues sheet:'{}' range:'\u{2026}' in ranges of at most {} cells.",
                cells.len(),
                js_text(sheet.get("cellCount")),
                js_text(sheet.get("name")),
                number_to_string(FULL_READ_CELL_LIMIT)
            ),
            None,
        ));
    }
    // One uncached formula and a thousand are the same fact about the sheet: it has not been recalculated. Reported per cell,
    // a model fills the issue budget with that one fact and hides every other finding.
    let error_pattern = compiled(r"^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$", "i");
    let mut uncached: Vec<&Value> = Vec::new();
    for cell in cells {
        if truthy(cell.get("formula")) && cell.get("cacheState").and_then(Value::as_str) == Some("missing") {
            uncached.push(cell);
        }
        let value = if truthy(cell.get("value")) { js_text(cell.get("value")) } else { String::new() };
        if error_pattern.is_match(&value) {
            issues.push(finding("error", "formula_error", &text_of(cell, "path"), &format!("Cell contains formula error {}", js_text(cell.get("value"))), None));
        }
    }
    if !uncached.is_empty() {
        let shown = uncached.iter().take(3).map(|cell| text_of(cell, "ref")).collect::<Vec<_>>().join(", ");
        let path = if uncached.len() == 1 { text_of(uncached[0], "path") } else { format!("/sheet[{}]", js_text(sheet.get("name"))) };
        let message = format!(
            "{} formula{} no cached value ({shown}{}); the workbook is marked for full recalculation on open.",
            uncached.len(),
            if uncached.len() == 1 { " on this sheet has" } else { "s on this sheet have" },
            if uncached.len() > 3 { ", \u{2026}" } else { "" }
        );
        let mut issue = finding("warning", "formula_cache_missing", &path, &message, None);
        if uncached.len() > 1 {
            if let Value::Object(fields) = &mut issue {
                fields.insert("cells".to_owned(), Value::Array(uncached.iter().take(20).map(|cell| Value::from(text_of(cell, "ref"))).collect()));
                fields.insert("cellCount".to_owned(), Value::from(uncached.len()));
            }
        }
        issues.push(issue);
    }
    issues
}

/// What the workbook's values say: formula errors, uncached formulas, how far the audit read, the profile's required sheets,
/// pictures without a description.
fn workbook_content_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, options: &Value) -> Result<Vec<Value>, String> {
    let mut issues = Vec::new();
    let selective = truthy(options.get("sheet")) || truthy(options.get("range"));
    let snapshot_options = if selective {
        let mut selected = Map::new();
        selected.insert("paged".to_owned(), Value::Bool(true));
        for key in ["sheet", "range"] {
            if let Some(value) = options.get(key) {
                selected.insert(key.to_owned(), value.clone());
            }
        }
        selected.insert("offset".to_owned(), json_number(0.0));
        selected.insert("limit".to_owned(), json_number(9_007_199_254_740_991.0));
        Value::Object(selected)
    } else {
        json!({ "full": true })
    };
    let snapshot = snapshot_xlsx(measurer, zip, &snapshot_options)?;
    let sheets = list(snapshot.get("sheets"));
    for sheet in sheets {
        issues.extend(sheet_value_issues(sheet));
    }
    // Sheet names come from the workbook, not the (possibly selective) snapshot, so a cross-sheet reference to an unselected
    // sheet still audits.
    let workbook_sheet_list = workbook_sheets(zip);
    let sheet_names: Vec<String> = workbook_sheet_list.iter().map(|sheet| sheet.name.clone()).collect();
    // Every formula carries a cached value and the workbook is still marked for a full calculation: the numbers on this page
    // are the ones from before the edit that set the mark. A successful recalculation clears it, and a workbook whose formulas
    // were never calculated at all is already reported as formula_cache_missing, so this is the case a clean-looking cache
    // hides.
    let mut cached_formulas = 0;
    let mut uncached_formulas = 0;
    for sheet in &workbook_sheet_list {
        let (formula_count, cache_missing) = sheet_formula_totals(&zip.text(&sheet.path));
        cached_formulas += formula_count - cache_missing;
        uncached_formulas += cache_missing;
    }
    let profile = options.get("auditProfile").and_then(Value::as_str).unwrap_or("");
    if cached_formulas > 0 && uncached_formulas == 0 && workbook_calculation(&zip.text("xl/workbook.xml")).full_calc_on_load {
        // A state, not a defect: render, qa, and finalize recalculate before they read, so an ordinary edit's audit must not
        // fail on it. A decision model read through `issues` alone still refuses to present stale numbers.
        issues.push(finding(
            if profile == "financial-model" { "error" } else { "info" },
            "stale_calculation",
            "/",
            "The workbook was edited after its last calculation, so cached formula values may predate the edit. render, qa, and finalize recalculate first; recalculate before reading numbers from a snapshot.",
            None,
        ));
    }
    if profile == "financial-model" && !sheet_names.iter().any(|name| is_checks_sheet_name(name)) {
        issues.push(finding("warning", "missing_checks_sheet", "/", "Financial-model audit expects a Checks sheet with explicit tie-out formulas.", None));
    }
    for sheet in sheets {
        for image in list(sheet.get("images")) {
            if describes_picture(&alt_text(image)) {
                continue;
            }
            issues.push(missing_alt_text_issue(&text_of(image, "path")));
        }
    }
    let audit = AuditOptions { audit_profile: profile, sheet_names: &sheet_names, defined_names: list(snapshot.get("definedNames")) };
    issues.extend(audit_xlsx_formulas(sheets, &audit).iter().map(|issue| issue.to_json()));
    Ok(issues)
}

// ---- the findings list ----------------------------------------------------------------------------------------------

/// `issuesPortableOoxml(path, format, options)`: the findings of the package at `path`, read as a `format` file, in the order
/// a reader meets them: what the package is, what the format measures, what the source package is owed, then what the content
/// itself says. `options` is the tool call's own (`sheet`, `range`, `pages`, `auditProfile`, `printSheet`). An error only when
/// the file cannot be read as a package.
pub fn issues_portable_ooxml<P: ReadProof>(
    proof: &P,
    measurer: &TextMeasurer<'_, P>,
    structure_review: StructureReview<'_>,
    path: &Path,
    format: &str,
    options: &Value,
) -> Result<Value, String> {
    let zip = load_package(proof, path)?;
    let validation = validate_portable_ooxml(proof, path, format, &ValidateOptions::default())?;
    let mut issues = package_structure_issues(&validation);
    issues.extend(placeholder_issues(&zip, format));
    issues.extend(image_placement_issues(&zip, format));
    if format == "xlsx" {
        issues.extend(sheet_audit_issues(measurer, &zip)?);
    }
    if format == "pptx" {
        issues.extend(presentation_metric_issues(measurer, &zip, options, structure_review)?);
    }
    issues.extend(package_provenance_issues(&validation));
    match format {
        "docx" => issues.extend(document_content_issues(measurer, &zip, &validation)?),
        "xlsx" => issues.extend(workbook_content_issues(measurer, &zip, options)?),
        "pptx" => issues.extend(slide_picture_issues(&zip, options)),
        _ => {}
    }
    let ok = !issues.iter().any(|issue| issue.get("severity").and_then(Value::as_str) == Some("error"));
    let mut answer = Map::new();
    answer.insert("ok".to_owned(), Value::Bool(ok));
    answer.insert("format".to_owned(), Value::from(format));
    answer.insert("issueCount".to_owned(), Value::from(issues.len()));
    answer.insert("issues".to_owned(), Value::Array(issues));
    Ok(Value::Object(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(issues: &[Value]) -> Vec<&str> {
        issues.iter().map(|issue| issue["code"].as_str().unwrap_or("")).collect()
    }

    fn body(inner: &str) -> String {
        format!("<w:document xmlns:w=\"w\"><w:body>{inner}<w:sectPr/></w:body></w:document>")
    }

    fn near(found: (f64, f64), wanted: (f64, f64)) -> bool {
        (found.0 - wanted.0).abs() < 1e-9 && (found.1 - wanted.1).abs() < 1e-9
    }

    #[test]
    fn a_file_name_is_not_a_description() {
        assert!(!describes_picture(""));
        assert!(!describes_picture("  image3.JPG "));
        assert!(!describes_picture("preencoded.png"));
        assert!(describes_picture("Company logo"));
        assert!(describes_picture("Chart of 2024.5 revenue"));
    }

    #[test]
    fn pale_ink_is_reported_and_hidden_ink_is_not() {
        let pale = "<w:p><w:r><w:rPr><w:color w:val=\"CCCCCC\"/></w:rPr><w:t>pale</w:t></w:r></w:p>";
        let issues = document_ink_issues(&body(pale));
        assert_eq!(codes(&issues), ["low_contrast"]);
        assert_eq!(issues[0]["path"], "/body/p[1]");
        assert!(issues[0]["message"].as_str().unwrap_or("").ends_with("4.5:1 is the readable minimum at 11pt."));
        let hidden = "<w:p><w:r><w:rPr><w:vanish/><w:color w:val=\"CCCCCC\"/></w:rPr><w:t>note</w:t></w:r></w:p>";
        assert!(document_ink_issues(&body(hidden)).is_empty());
        let shown = "<w:p><w:r><w:rPr><w:vanish w:val=\"0\"/><w:color w:val=\"CCCCCC\"/></w:rPr><w:t>note</w:t></w:r></w:p>";
        assert_eq!(codes(&document_ink_issues(&body(shown))), ["low_contrast"]);
        let inverse = "<w:p><w:r><w:rPr><w:color w:val=\"FFFFFF\"/><w:highlight w:val=\"black\"/></w:rPr><w:t>inverse</w:t></w:r></w:p>";
        assert!(document_ink_issues(&body(inverse)).is_empty());
    }

    #[test]
    fn a_shaded_cell_keeps_its_own_field() {
        let table = "<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill=\"1F3864\"/></w:tcPr><w:p><w:r><w:rPr><w:color w:val=\"333333\"/></w:rPr><w:t>dark</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
        let issues = document_ink_issues(&body(table));
        assert_eq!(issues[0]["path"], "/body/tbl[1]/row[1]/cell[1]");
        assert!(issues[0]["message"].as_str().unwrap_or("").starts_with("Cell text contrast is "));
    }

    #[test]
    fn a_body_with_nothing_printable_is_empty() {
        assert_eq!(codes(&empty_document_issues(&body(""))), ["empty_document"]);
        assert!(empty_document_issues(&body("<w:p><w:r><w:t>x</w:t></w:r></w:p>")).is_empty());
        assert!(empty_document_issues(&body("<w:tbl></w:tbl>")).is_empty());
    }

    #[test]
    fn hangul_beside_a_serif_latin_face_reads_as_two_typefaces() {
        let run = "<w:p><w:r><w:rPr><w:rFonts w:ascii=\"Cambria\"/></w:rPr><w:t>2024 매출</w:t></w:r></w:p>";
        let issues = document_font_pairing_issues(&body(run), "");
        assert_eq!(codes(&issues), ["font_pairing_mismatch"]);
        assert!(issues[0]["message"].as_str().unwrap_or("").starts_with("1 block sets Hangul in Malgun Gothic beside Latin and digits in Cambria, a sans and a serif"));
        let paired = "<w:p><w:r><w:rPr><w:rFonts w:ascii=\"Cambria\" w:eastAsia=\"Batang\"/></w:rPr><w:t>2024 매출</w:t></w:r></w:p>";
        assert!(document_font_pairing_issues(&body(paired), "").is_empty());
    }

    #[test]
    fn resolved_threads_and_their_replies_are_not_outstanding() {
        let snapshot = json!({
            "revisionCount": 2,
            "propertyChangeCount": 1,
            "comments": [{ "path": "/body/p[2]" }, { "replyTo": "a" }, { "resolved": true }],
        });
        let issues = review_state_issues(&snapshot);
        assert_eq!(codes(&issues), ["unresolved_revisions", "unresolved_comments"]);
        assert_eq!(issues[0]["message"], "2 tracked revision element(s) and 1 formatting change record(s) remain unresolved.");
        assert_eq!(issues[1]["path"], "/body/p[2]");
        assert_eq!(issues[1]["message"], "1 comment thread(s) remain unresolved.");
        assert!(review_state_issues(&json!({ "revisionCount": 0, "comments": [] })).is_empty());
    }

    #[test]
    fn uncached_formulas_are_one_finding_per_sheet() {
        let cell = |reference: &str, formula: &str| json!({ "ref": reference, "path": format!("/sheet[S]/cell[{reference}]"), "formula": formula, "cacheState": "missing" });
        let sheet = json!({
            "name": "S",
            "path": "/sheet[S]",
            "cells": [cell("A1", "B1"), cell("A2", "B2"), cell("A3", "B3"), cell("A4", "B4"), { "ref": "B1", "path": "/sheet[S]/cell[B1]", "value": "#DIV/0!" }],
        });
        let issues = sheet_value_issues(&sheet);
        assert_eq!(codes(&issues), ["formula_error", "formula_cache_missing"]);
        assert_eq!(issues[1]["path"], "/sheet[S]");
        assert_eq!(issues[1]["cellCount"], 4);
        assert!(issues[1]["message"].as_str().unwrap_or("").starts_with("4 formulas on this sheet have no cached value (A1, A2, A3, \u{2026})"));
        let single = sheet_value_issues(&json!({ "name": "S", "path": "/sheet[S]", "cells": [cell("A1", "B1")] }));
        assert_eq!(single[0]["path"], "/sheet[S]/cell[A1]");
        assert!(single[0].get("cells").is_none());
    }

    #[test]
    fn the_sweep_removes_what_nothing_reaches_and_what_only_it_reached() {
        let mut package = Package::new();
        package.set("_rels/.rels", "<Relationships><Relationship Id=\"rId1\" Type=\"t/officeDocument\" Target=\"ppt/presentation.xml\"/></Relationships>");
        package.set("ppt/presentation.xml", "<p/>");
        package.set("ppt/media/stray.png", "x");
        package.set("ppt/charts/chart1.xml", "<c/>");
        package.set("ppt/charts/_rels/chart1.xml.rels", "<Relationships><Relationship Id=\"rId1\" Type=\"t/image\" Target=\"../media/chained.png\"/></Relationships>");
        package.set("ppt/media/chained.png", "x");
        package.set("[Content_Types].xml", "<Types><Override PartName=\"/ppt/charts/chart1.xml\" ContentType=\"c\"/></Types>");
        let sweep = remove_orphan_package_parts(&mut package).expect("a sweep");
        assert_eq!(sweep.removed, ["ppt/media/stray.png", "ppt/charts/chart1.xml", "ppt/charts/_rels/chart1.xml.rels", "ppt/media/chained.png"]);
        assert!(package.file("ppt/presentation.xml").is_some() && package.file("ppt/charts/chart1.xml").is_none());
        assert_eq!(package.text("[Content_Types].xml"), "<Types></Types>");
    }

    #[test]
    fn a_package_without_relationships_is_left_alone_and_one_that_resolves_nothing_is_refused() {
        let mut bare = Package::new();
        bare.set("ppt/media/a.png", "x");
        assert_eq!(remove_orphan_package_parts(&mut bare), Ok(OrphanSweep { removed: Vec::new(), skipped: Some("no-relationship-parts") }));
        let mut hollow = Package::new();
        hollow.set("_rels/.rels", "<Relationships/>");
        hollow.set("ppt/media/a.png", "x");
        assert_eq!(remove_orphan_package_parts(&mut hollow), Err("Refusing to clean the package: no relationship resolves to a part".to_owned()));
        assert!(hollow.file("ppt/media/a.png").is_some());
    }

    #[test]
    fn a_stretched_or_enlarged_picture_is_reported_and_a_cropped_one_is_judged_by_what_shows() {
        let placed = |width: f64, height: f64, cx: f64, cy: f64, picture: &'static str, visible: (f64, f64)| {
            let at = Placed { width, height, cx, cy, picture, visible, path: "/slide[1]/picture[1]" };
            (low_resolution_issue(&at), aspect_distortion_issue(&at))
        };
        let (soft, stretched) = placed(16.0, 16.0, 1_828_800.0, 914_400.0, "<p:pic/>", (1.0, 1.0));
        assert_eq!(soft.expect("soft")["code"], "image_low_resolution");
        assert_eq!(
            stretched.expect("stretched")["message"],
            "Image is stretched 100% off its visible 16x16 aspect ratio; set only width or height to keep the original proportions."
        );
        let (vector, _) = placed(16.0, 16.0, 1_828_800.0, 914_400.0, "<p:pic><asvg:svgBlip/></p:pic>", (1.0, 1.0));
        assert!(vector.is_none());
        let (spacer, fine) = placed(4.0, 4.0, 1_828_800.0, 1_828_800.0, "<p:pic/>", (1.0, 1.0));
        assert!(spacer.is_none() && fine.is_none());
        let (_, cropped) = placed(300.0, 100.0, 914_400.0, 914_400.0, "<p:pic/>", (1.0 / 3.0, 1.0));
        assert!(cropped.is_none());
    }

    #[test]
    fn a_crop_states_the_fraction_the_picture_keeps() {
        assert!(near(visible_fraction("<a:srcRect l=\"10000\" r=\"20000\"/>", "pptx"), (0.7, 1.0)));
        assert!(near(visible_fraction("<a:srcRect t=\"50000\"/>", "pptx"), (1.0, 0.5)));
        assert!(near(visible_fraction("<a:srcRect l=\"10000\"/>", "docx"), (1.0, 1.0)));
        assert!(near(visible_fraction("<a:blip/>", "pptx"), (1.0, 1.0)));
    }
}
