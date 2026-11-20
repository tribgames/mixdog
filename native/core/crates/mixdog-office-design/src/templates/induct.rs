//! `design-template-induct.mjs`: the roles of a deck someone drew, induced from geometry. Its pages carry plain text
//! boxes instead of `{{TOKEN}}` slots or layout placeholders, so the token and placeholder rules find no title on them
//! and never a column or a step. What such a page does show is its geometry: the box set in the loudest type is the
//! title, a row of equally sized boxes reads as columns, a number above its caption reads as a metric, and a row of
//! arrows reads as steps.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use mixdog_js::{js_trim, to_number_of};
use mixdog_office_base::values::truthy;
use mixdog_ooxml::xml::compiled;
use serde_json::{Value, json};

use super::inspect::{infer_pptx_sample_kind, utf16_len};
use crate::discipline::is_picture_shape;
use crate::{opt_prop, prop, text};

const WIDE_CANVAS: (f64, f64) = (12_192_000.0, 6_858_000.0);
// A row is peers when the boxes sit on one band at one height; the tolerances are shares of the members themselves, so
// they hold at any slide scale.
const ROW_TOP_TOLERANCE: f64 = 0.34;
const PEER_HEIGHT_TOLERANCE: f64 = 0.06;
const COLUMN_ALIGN_TOLERANCE: f64 = 0.12;
const PAIR_GAP_TOLERANCE: f64 = 1.5;
// The title leads the page's other type by a clear step; without that lead the page has no single loudest voice and no
// title is claimed.
const TITLE_SIZE_LEAD: f64 = 1.15;
const TITLE_MAX_CHARS: usize = 140;
// A full-bleed rectangle is the page's surface, not one of its objects.
const BACKGROUND_AREA_SHARE: f64 = 0.7;
const STEP_PRESETS: [&str; 5] = ["chevron", "homePlate", "rightArrow", "pentagon", "arrow"];
// A metric reads as a figure and its unit, never as a sentence. A Korean unit is often spaced from its multiplier
// ("14만 건", "2.6억 원"): only a multiplier takes the space, so a title such as "3분기 지표" stays a title.
const VALUE_TEXT: &str = r"^[+\-−]?[₩$€£¥]?\d[\d.,]*(?:\s*[만억천조])?\s*[%a-zA-Z가-힣]{0,6}$";
// A source line names where the page's figures came from; on a page about something else it names the wrong place.
const SOURCE_TEXT: &str = r"^(출처|자료|주|단위|source|sources|note|notes|units?)\s*[:：]";
// Prose, as opposed to a node label or a unit: a sentence the page states.
const BODY_MIN_CHARS: usize = 25;
const EYEBROW_MAX_CHARS: usize = 60;

/// One shape as the induction reads it: the shape number, its kind (`text`, `image`, `chart`, `table`, ...), text,
/// frame, the size of its type (NaN where it has none) and its preset outline.
#[derive(Debug, Clone)]
pub(crate) struct Drawn {
    pub shape: f64,
    pub kind: String,
    pub text: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    pub preset: String,
}

/// A role map: a shape number's bits to its role (`Map<number, string>`).
pub type Roles = HashMap<u64, String>;

/// The key of a shape number in a [`Roles`].
pub fn role_key(shape: f64) -> u64 {
    if shape == 0.0 { 0.0_f64.to_bits() } else { shape.to_bits() }
}

fn trimmed(shape: &Drawn) -> &str {
    js_trim(&shape.text)
}

fn area(shape: &Drawn) -> f64 {
    let side = |value: f64| if value.is_nan() { 0.0 } else { value.max(0.0) };
    side(shape.width) * side(shape.height)
}

fn drawable(shape: &Drawn, canvas: (f64, f64)) -> bool {
    let size = area(shape);
    if size == 0.0 {
        return false;
    }
    size < (canvas.0 * canvas.1).max(1.0) * BACKGROUND_AREA_SHARE
}

fn compare(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

// The band is a share of the shorter box, so a 26pt caption does not join the 170pt card it sits inside. Width is free:
// a chevron flow and a two-panel page both size their boxes to the words they carry, and demanding equal widths read a
// four-step flow as three columns with one step missing.
fn shares_row(left: &Drawn, right: &Drawn) -> bool {
    let shorter = left.height.min(right.height);
    let taller = left.height.max(right.height);
    (left.top - right.top).abs() <= shorter * ROW_TOP_TOLERANCE && (left.height - right.height).abs() <= taller * PEER_HEIGHT_TOLERANCE
}

fn row_bands<'a>(shapes: &[&'a Drawn]) -> Vec<Vec<&'a Drawn>> {
    let mut rows: Vec<Vec<&Drawn>> = Vec::new();
    let mut ordered: Vec<&Drawn> = shapes.to_vec();
    ordered.sort_by(|left, right| compare(left.top, right.top).then(compare(left.left, right.left)));
    for shape in ordered {
        match rows.iter_mut().find(|members| shares_row(members[0], shape)) {
            Some(row) => row.push(shape),
            None => rows.push(vec![shape]),
        }
    }
    rows.into_iter()
        .filter(|members| members.len() >= 2)
        .map(|mut members| {
            members.sort_by(|left, right| compare(left.left, right.left));
            members
        })
        .collect()
}

// The caption row sits directly under its values and shares their left edges; anything further down belongs to another
// band of the page.
fn pairs_with(top: &[&Drawn], bottom: &[&Drawn]) -> bool {
    if top.len() != bottom.len() {
        return false;
    }
    let lead = top[0];
    let gap = bottom[0].top - (lead.top + lead.height);
    if gap < 0.0 || gap > lead.height.max(bottom[0].height) * PAIR_GAP_TOLERANCE {
        return false;
    }
    top.iter().zip(bottom).all(|(shape, other)| (shape.left - other.left).abs() <= shape.width.max(other.width) * COLUMN_ALIGN_TOLERANCE)
}

fn is_value_text(text: &str) -> bool {
    compiled(VALUE_TEXT, "").is_match(js_trim(text))
}

fn induced_title<'a>(shapes: &[&'a Drawn]) -> Option<&'a Drawn> {
    let sized: Vec<&Drawn> = shapes.iter().copied().filter(|shape| shape.kind == "text" && !trimmed(shape).is_empty() && shape.font_size > 0.0).collect();
    if sized.is_empty() {
        return None;
    }
    // A row of equal boxes is the page's structure, not its title: on a metrics page the numerals are the loudest type
    // on the canvas and there are several of them. The peers step aside; the title is the largest box left standing alone.
    let peers: HashSet<u64> = row_bands(&sized)
        .into_iter()
        .filter(|members| members.iter().all(|shape| shape.font_size == members[0].font_size))
        .flat_map(|members| members.into_iter().map(|shape| role_key(shape.shape)))
        .collect();
    // A figure is the page's evidence, never its title.
    let mut candidates: Vec<&Drawn> = sized.into_iter().filter(|shape| !peers.contains(&role_key(shape.shape)) && !is_value_text(&shape.text)).collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|left, right| compare(right.font_size, left.font_size));
    let (largest, runner_up) = (candidates[0], candidates.get(1));
    if utf16_len(trimmed(largest)) > TITLE_MAX_CHARS {
        return None;
    }
    if runner_up.is_some_and(|runner| largest.font_size < runner.font_size * TITLE_SIZE_LEAD) {
        return None;
    }
    Some(largest)
}

fn assign_group(roles: &mut Roles, row: &[&Drawn], prefix: &str) {
    for (position, shape) in row.iter().enumerate() {
        roles.insert(role_key(shape.shape), format!("{prefix}-{}", position + 1));
    }
}

fn row_area(row: &[&Drawn]) -> f64 {
    row.iter().map(|shape| area(shape)).sum()
}

// One page carries one such structure. Two stacked rows of equal boxes are a grid, not six columns, and a role has to
// name exactly one box for the page to be filled by role at all, so the page's strongest row is the one that speaks: the
// widest row first, then the row that captions another, then the heavier.
fn strongest_row(rows: &[Vec<&Drawn>], captions: &dyn Fn(usize) -> bool) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (at, row) in rows.iter().enumerate() {
        let Some(held) = best else {
            best = Some(at);
            continue;
        };
        if row.len() != rows[held].len() {
            if row.len() > rows[held].len() {
                best = Some(at);
            }
            continue;
        }
        if captions(at) != captions(held) {
            if captions(at) {
                best = Some(at);
            }
            continue;
        }
        if row_area(row) > row_area(&rows[held]) {
            best = Some(at);
        }
    }
    best
}

fn induce_group_roles(roles: &mut Roles, shapes: &[&Drawn], title: Option<&Drawn>) {
    // A band holds what the reader takes as one row: the boxes carrying the words and the markers drawn behind them. A
    // chevron with its label on top is one step, so the marker names the structure and the label fills the slot.
    let others: Vec<&Drawn> = shapes.iter().copied().filter(|shape| title.is_none_or(|head| shape.shape != head.shape)).collect();
    let mut texts: Vec<Vec<&Drawn>> = Vec::new();
    let mut steps: Vec<Vec<&Drawn>> = Vec::new();
    for members in row_bands(&others) {
        let labels: Vec<&Drawn> = members.iter().copied().filter(|shape| shape.kind == "text" && !trimmed(shape).is_empty()).collect();
        let stepped = members.iter().any(|shape| trimmed(shape).is_empty() && STEP_PRESETS.contains(&shape.preset.as_str()));
        if labels.len() < 2 {
            continue;
        }
        if stepped {
            steps.push(labels.clone());
        }
        texts.push(labels);
    }
    // Where one row captions another the upper row leads: it is what the page states, and the caption row underneath
    // belongs to it.
    let captions = |at: usize| texts.iter().enumerate().any(|(other, row)| other != at && pairs_with(&texts[at], row));
    if let Some(step) = strongest_row(&steps, &|_| false) {
        assign_group(roles, &steps[step], "step-title");
        return;
    }
    let Some(leading) = strongest_row(&texts, &captions) else { return };
    let metric = texts[leading].iter().all(|shape| is_value_text(&shape.text));
    assign_group(roles, &texts[leading], if metric { "metric-value" } else { "column-title" });
    let partner = texts.iter().enumerate().position(|(at, row)| at != leading && pairs_with(&texts[leading], row));
    if let Some(partner) = partner {
        assign_group(roles, &texts[partner], if metric { "metric-label" } else { "column-body" });
    }
    // A second row of peers beside the page's structure (column titles under a band of metrics) is the template's words
    // as much as the structure is. Left without a slot, a filled page kept "확장 · 배포 · 비용" from the deck it was taken
    // from; named, a fill that does not write it empties it.
    let mut aside = 0;
    for (at, row) in texts.iter().enumerate() {
        if at == leading || Some(at) == partner {
            continue;
        }
        for shape in row {
            roles.entry(role_key(shape.shape)).or_insert_with(|| {
                aside += 1;
                format!("aside-{aside}")
            });
        }
    }
}

// The page's other words around its title and its structure: the kicker set just above the title, the line just below
// it, the prose it states, and the source at its foot. They are the template's words, not the deck's, so each one needs
// a slot to be written or emptied through.
fn induced_frame(shapes: &[&Drawn], title: Option<&Drawn>, taken: &HashSet<u64>) -> Roles {
    let mut roles = Roles::new();
    let free: Vec<&Drawn> =
        shapes.iter().copied().filter(|shape| shape.kind == "text" && !trimmed(shape).is_empty() && !taken.contains(&role_key(shape.shape))).collect();
    for shape in &free {
        if compiled(SOURCE_TEXT, "i").is_match(trimmed(shape)) {
            roles.insert(role_key(shape.shape), "source".to_owned());
        }
    }
    let quieter = |shape: &Drawn| title.is_none_or(|head| !(shape.font_size >= head.font_size));
    if let Some(head) = title {
        let bottom = |shape: &Drawn| shape.top + shape.height;
        let open: Vec<&Drawn> = free
            .iter()
            .copied()
            .filter(|shape| {
                !roles.contains_key(&role_key(shape.shape)) && quieter(shape) && (shape.left - head.left).abs() <= head.width * COLUMN_ALIGN_TOLERANCE
            })
            .collect();
        let mut above: Vec<&Drawn> =
            open.iter().copied().filter(|shape| bottom(shape) <= head.top + head.height * 0.1 && head.top - bottom(shape) <= head.height).collect();
        above.sort_by(|left, right| compare(bottom(right), bottom(left)));
        if let Some(above) = above.first().filter(|shape| utf16_len(trimmed(shape)) <= EYEBROW_MAX_CHARS) {
            roles.insert(role_key(above.shape), "eyebrow".to_owned());
        }
        let mut below: Vec<&Drawn> = open
            .iter()
            .copied()
            .filter(|shape| {
                !roles.contains_key(&role_key(shape.shape)) && shape.top >= bottom(head) - head.height * 0.1 && shape.top - bottom(head) <= head.height
            })
            .collect();
        below.sort_by(|left, right| compare(left.top, right.top));
        if let Some(below) = below.first() {
            roles.insert(role_key(below.shape), "subtitle".to_owned());
        }
    }
    let mut prose = 0;
    for shape in &free {
        if roles.contains_key(&role_key(shape.shape)) || !quieter(shape) || utf16_len(trimmed(shape)) < BODY_MIN_CHARS {
            continue;
        }
        prose += 1;
        roles.insert(role_key(shape.shape), if prose == 1 { "body".to_owned() } else { format!("body-{prose}") });
    }
    roles
}

/// The roles of a page's shapes, induced from the boxes.
pub(crate) fn induce_roles(boxes: &[Drawn], canvas: (f64, f64)) -> Roles {
    let mut roles = Roles::new();
    let shapes: Vec<&Drawn> = boxes.iter().filter(|shape| drawable(shape, canvas)).collect();
    let title = induced_title(&shapes);
    if let Some(title) = title {
        roles.insert(role_key(title.shape), "title".to_owned());
    }
    induce_group_roles(&mut roles, &shapes, title);
    let taken: HashSet<u64> = roles.keys().copied().collect();
    roles.extend(induced_frame(&shapes, title, &taken));
    roles
}

fn sample_box(shape: &Value) -> Drawn {
    let geometry = prop(shape, "geometry");
    Drawn {
        shape: to_number_of(prop(shape, "shape")),
        kind: text(prop(shape, "type")),
        text: prop(shape, "text").map(mixdog_js::value_to_string).unwrap_or_default(),
        left: to_number_of(opt_prop(geometry, "left")),
        top: to_number_of(opt_prop(geometry, "top")),
        width: to_number_of(opt_prop(geometry, "width")),
        height: to_number_of(opt_prop(geometry, "height")),
        font_size: to_number_of(prop(shape, "fontSize")),
        preset: text(prop(shape, "preset")),
    }
}

/// `inducePptxSampleRoles(sample, canvas)`: the role of each box of an inspected page by shape number; the canvas is
/// the page size in EMU (the wide slide where it is not known).
pub fn induce_pptx_sample_roles(sample: &Value, canvas: Option<(f64, f64)>) -> Roles {
    let boxes: Vec<Drawn> = prop(sample, "shapes").and_then(Value::as_array).map(|shapes| shapes.iter().map(sample_box).collect()).unwrap_or_default();
    induce_roles(&boxes, canvas.unwrap_or(WIDE_CANVAS))
}

// Microsoft Office reports a shape type as a number and the portable reader as the element name; both name their preset
// outline and their type size the same way, so one reading of a snapshot serves either backend.
fn object_role(shape: &Value) -> &'static str {
    if prop(shape, "chart").is_some_and(truthy) || to_number_of(prop(shape, "type")) == 3.0 {
        return "chart";
    }
    if prop(shape, "table").is_some_and(truthy) {
        return "table";
    }
    if is_picture_shape(shape) {
        return "image";
    }
    ""
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

fn snapshot_box(shape: &Value) -> Drawn {
    let role = object_role(shape);
    Drawn {
        shape: number_or_zero(prop(shape, "index")),
        kind: if role.is_empty() { "text".to_owned() } else { role.to_owned() },
        text: text(prop(shape, "text")),
        left: number_or_zero(prop(shape, "left")),
        top: number_or_zero(prop(shape, "top")),
        width: number_or_zero(prop(shape, "width")),
        height: number_or_zero(prop(shape, "height")),
        font_size: number_or_zero(opt_prop(prop(shape, "font"), "size")),
        preset: text(prop(shape, "geometry")),
    }
}

/// `annotatePptxSnapshotRoles(document)`: a page of a deck snapshot answers with the job it does (`role`) and each box
/// with the slot it fills (`slot`), so a page the user already owns can be chosen and filled instead of composed again.
pub fn annotate_pptx_snapshot_roles(document: &mut Value) {
    let width = number_or_zero(prop(document, "slideWidth"));
    let height = number_or_zero(prop(document, "slideHeight"));
    let slide_count = number_or_zero(prop(document, "slideCount"));
    let Some(slides) = document.get_mut("slides").and_then(Value::as_array_mut) else { return };
    if slides.is_empty() || width <= 0.0 || height <= 0.0 {
        return;
    }
    let total = if slide_count == 0.0 { slides.len() as f64 } else { slide_count };
    for slide in slides.iter_mut() {
        let boxes: Vec<Drawn> = prop(slide, "shapes").and_then(Value::as_array).map(|shapes| shapes.iter().map(snapshot_box).collect()).unwrap_or_default();
        let induced = induce_roles(&boxes, (width, height));
        let mut slots: Vec<Value> = Vec::new();
        if let Some(shapes) = slide.get_mut("shapes").and_then(Value::as_array_mut) {
            for shape in shapes.iter_mut() {
                let role = induced.get(&role_key(number_or_zero(prop(shape, "index")))).cloned().unwrap_or_else(|| object_role(shape).to_owned());
                if role.is_empty() {
                    continue;
                }
                shape["slot"] = Value::String(role.clone());
                slots.push(json!({ "role": role }));
            }
        }
        let shapes: Vec<Value> = prop(slide, "shapes").and_then(Value::as_array).cloned().unwrap_or_default();
        let title = shapes
            .iter()
            .find(|shape| prop(shape, "slot") == Some(&Value::String("title".to_owned())))
            .map(|shape| text(prop(shape, "text")))
            .unwrap_or_default();
        let text_chars: usize = shapes.iter().map(|shape| utf16_len(&text(prop(shape, "text")))).sum();
        let sample = json!({
            "slide": number_or_zero(prop(slide, "index")),
            "slots": slots,
            "title": title,
            "textChars": text_chars,
            "shapes": shapes,
        });
        slide["role"] = Value::String(infer_pptx_sample_kind(&sample, total));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_box(shape: f64, text: &str, left: f64, top: f64, width: f64, height: f64, font_size: f64) -> Drawn {
        Drawn { shape, kind: "text".to_owned(), text: text.to_owned(), left, top, width, height, font_size, preset: String::new() }
    }

    #[test]
    fn the_loudest_box_is_the_title_and_equal_boxes_are_columns() {
        let boxes = [
            text_box(1.0, "A drawn page", 500_000.0, 300_000.0, 8_000_000.0, 900_000.0, 40.0),
            text_box(2.0, "Alpha", 500_000.0, 2_000_000.0, 3_000_000.0, 400_000.0, 20.0),
            text_box(3.0, "Beta", 4_500_000.0, 2_000_000.0, 3_000_000.0, 400_000.0, 20.0),
            text_box(4.0, "first body", 500_000.0, 2_500_000.0, 3_000_000.0, 600_000.0, 14.0),
            text_box(5.0, "second body", 4_500_000.0, 2_500_000.0, 3_000_000.0, 600_000.0, 14.0),
        ];
        let roles = induce_roles(&boxes, WIDE_CANVAS);
        let role = |shape: f64| roles.get(&role_key(shape)).map(String::as_str);
        assert_eq!(role(1.0), Some("title"));
        assert_eq!(role(2.0), Some("column-title-1"));
        assert_eq!(role(3.0), Some("column-title-2"));
        assert_eq!(role(4.0), Some("column-body-1"));
        assert_eq!(role(5.0), Some("column-body-2"));
    }

    #[test]
    fn a_figure_is_never_the_title() {
        let boxes = [
            text_box(1.0, "18", 500_000.0, 300_000.0, 2_000_000.0, 1_500_000.0, 82.0),
            text_box(2.0, "What the number means for the quarter", 3_000_000.0, 600_000.0, 7_000_000.0, 700_000.0, 30.0),
        ];
        let roles = induce_roles(&boxes, WIDE_CANVAS);
        assert_eq!(roles.get(&role_key(2.0)).map(String::as_str), Some("title"));
        assert_eq!(roles.get(&role_key(1.0)), None);
    }

    #[test]
    fn a_full_bleed_rectangle_is_not_an_object_of_the_page() {
        let boxes =
            [text_box(1.0, "Surface", 0.0, 0.0, 12_192_000.0, 6_858_000.0, 60.0), text_box(2.0, "Title", 500_000.0, 300_000.0, 5_000_000.0, 800_000.0, 36.0)];
        let roles = induce_roles(&boxes, WIDE_CANVAS);
        assert_eq!(roles.get(&role_key(1.0)), None);
        assert_eq!(roles.get(&role_key(2.0)).map(String::as_str), Some("title"));
    }

    #[test]
    fn a_snapshot_is_annotated_with_the_job_of_each_page() {
        let mut document = json!({
            "slideWidth": 12_192_000, "slideHeight": 6_858_000, "slideCount": 1,
            "slides": [{ "index": 1, "shapes": [{ "index": 1, "text": "Cover", "left": 500_000, "top": 300_000, "width": 8_000_000, "height": 900_000, "font": { "size": 44 } }] }],
        });
        annotate_pptx_snapshot_roles(&mut document);
        assert_eq!(document["slides"][0]["role"], "cover");
        assert_eq!(document["slides"][0]["shapes"][0]["slot"], "title");
    }
}
