//! `design-deck-diversity.mjs`: what only the whole deck can say about how its pages differ: the page grammar the receipt
//! assigns (beats, evidence, text), runs of one composition, one decoration drawn page after page, too few visual roles,
//! and the art direction the deck selected.

use mixdog_js::{js_to_lowercase, js_trim, json_stringify, math, number_to_string, to_number_of, utf16_len, value_to_string};
use mixdog_office_design::discipline::{is_picture_shape, signed_visual_type};
use serde_json::{Map, Value};

use super::{AuthorReads, squash, utf16_sorted};
use crate::issue::issue_with;
use crate::structure::{list, num0, text, trimmed};
use crate::{field, field_of, is_truthy};

fn issue(code: &str, message: &str) -> Value {
    issue_with(code, "/", message, "design-review", "warning")
}

/// `${value}` of a slide index (`slide?.index`) with the position a deck without one is read at.
fn index_or(slide: Option<&Value>, fallback: f64) -> f64 {
    let number = num0(field_of(slide, "index"));
    if number == 0.0 { fallback } else { number }
}

fn number_at(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

/// The deck's shape, read from the page grammar the receipt assigns (beat | evidence | text). Thirteen reference decks
/// (400 pages) run beats (dark or field pages) on 0-21% of their pages (median 13%) and never three in a row past the
/// front matter; the one deck above that is dark on three pages in four, which is a theme, not beats. Beats on more than
/// three pages in ten is a slideshow of covers; three in a row is a hole in the argument where the reader waits for
/// content.
fn deck_shape_issues(reads: &dyn AuthorReads, slides: &[Value]) -> Vec<Value> {
    let receipts: Vec<Value> = slides.iter().map(|slide| reads.slide_receipt(slide)).collect();
    let grammar: Vec<&str> = receipts.iter().map(|receipt| field(receipt, "grammar").and_then(Value::as_str).unwrap_or("")).collect();
    // The cover and the closing are beats by their job; the share is read over the pages between them.
    let inner: &[&str] = if grammar.len() >= 2 { &grammar[1..grammar.len() - 1] } else { &[] };
    let beats = inner.iter().filter(|value| **value == "beat").count();
    let dark = receipts.iter().filter(|receipt| field(receipt, "background").and_then(Value::as_str) == Some("dark")).count();
    let mut issues = Vec::new();
    if slides.len() >= 8 && beats as f64 / inner.len() as f64 > 0.25 && (dark as f64 / slides.len() as f64) < 0.6 {
        issues.push(issue(
            "beat_share_high",
            &format!(
                "{beats} of the {} slides between the cover and the closing are beats (dark or field pages); the reference decks run one in eight. Give the body pages their evidence and keep the field for the section marks.",
                inner.len()
            ),
        ));
    }
    let mut run = 0;
    for (index, kind) in grammar.iter().enumerate() {
        run = if *kind == "beat" { run + 1 } else { 0 };
        // The first three slides may be front matter (cover, disclaimer, agenda); a run that ends inside them is not read.
        if run == 3 && index >= 3 {
            let first = index_or(slides.get(index - 2), index as f64 - 1.0);
            issues.push(issue(
                "consecutive_beats",
                &format!(
                    "Slides {}-{} are three beats in a row (dark or field pages with no evidence); a beat opens or closes a run of content pages, it never replaces them.",
                    number_to_string(first),
                    number_to_string(first + 2.0)
                ),
            ));
            break;
        }
    }
    // A body page that carries one sentence and nothing else (no chart, table, picture, or structure) is a page the
    // reader turns without learning anything (the reference body pages carry 330-900). The cover, the closing, and the
    // beats are statements by their job.
    for (index, receipt) in receipts.iter().enumerate() {
        if index == 0 || index == receipts.len() - 1 || grammar[index] == "beat" {
            continue;
        }
        // A structure the kit draws (lanes, a hub, a loop, the agenda) is the page's carrier as much as a chart is.
        let structures = number_at(field_of(field_of(field(receipt, "specs"), "structure"), "count"));
        let carriers = ["charts", "tables", "pictures", "groups"].iter().map(|key| number_at(field(receipt, key))).sum::<f64>() + structures;
        let chars = match field(receipt, "chars") {
            Some(Value::Number(chars)) => chars.as_f64().unwrap_or(f64::NAN),
            _ => continue,
        };
        if carriers > 0.0 || chars >= 80.0 {
            continue;
        }
        let shown = match field_of(slides.get(index), "index") {
            Some(Value::Null) | None => number_to_string(index as f64 + 1.0),
            Some(value) => value_to_string(value),
        };
        issues.push(issue_with(
            "page_underfill",
            &format!("/slide[{shown}]"),
            &format!("Slide {shown} carries {} characters and no chart, table, picture, or structure; a body page needs its payload or belongs to the page it introduces.", number_to_string(chars)),
            "design-review",
            "warning",
        ));
    }
    issues
}

fn shape_role(shape: &Value) -> &'static str {
    if is_truthy(field(shape, "chart")) {
        return "chart";
    }
    if is_truthy(field(shape, "table")) {
        return "table";
    }
    if is_picture_shape(shape) {
        return "image";
    }
    if is_truthy(field(shape, "group")) {
        return "group";
    }
    if js_trim(&text(field(shape, "text"))).is_empty() {
        return "shape";
    }
    let size = num0(field_of(field(shape, "font"), "size"));
    if size >= 32.0 {
        "title"
    } else if size > 0.0 && size <= 12.0 {
        "caption"
    } else {
        "text"
    }
}

fn size_bucket(value: f64, total: f64) -> &'static str {
    let ratio = if total > 0.0 { value / total } else { 0.0 };
    if ratio >= 0.62 {
        "wide"
    } else if ratio >= 0.3 {
        "medium"
    } else {
        "small"
    }
}

fn position_bucket(value: f64, total: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    math::min(2.0, math::max(0.0, math::floor((value / total) * 3.0)))
}

fn shapes_of(slide: &Value) -> &[Value] {
    field(slide, "shapes").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn layout_grammar_signature(slide: &Value, canvas: (f64, f64)) -> String {
    let mut parts: Vec<String> = shapes_of(slide)
        .iter()
        .filter(|shape| !js_trim(&text(field(shape, "text"))).is_empty() || shape_role(shape) != "shape")
        .map(|shape| {
            let left = num0(field(shape, "left"));
            let top = num0(field(shape, "top"));
            let width = num0(field(shape, "width"));
            let height = num0(field(shape, "height"));
            [
                shape_role(shape).to_owned(),
                number_to_string(position_bucket(left + width / 2.0, canvas.0)),
                number_to_string(position_bucket(top + height / 2.0, canvas.1)),
                size_bucket(width, canvas.0).to_owned(),
                size_bucket(height, canvas.1).to_owned(),
            ]
            .join(":")
        })
        .collect();
    parts = utf16_sorted(parts);
    parts.join("|")
}

/// Native preset geometry families, each a distinct evidence structure. Rect and line are surfaces and rules, not
/// structures, so they fall through.
const GEOMETRY_FAMILIES: [(&str, &[&str]); 8] = [
    (
        "process",
        &["chevron", "homePlate", "rightArrow", "leftArrow", "leftRightArrow", "upArrow", "downArrow", "bentArrow", "curvedRightArrow", "notchedRightArrow"],
    ),
    ("share", &["blockArc", "pie", "donut", "arc"]),
    ("tiers", &["trapezoid", "triangle", "funnel"]),
    ("silhouette", &["custGeom", "parallelogram", "hexagon", "diamond"]),
    ("module", &["roundRect", "round1Rect", "round2SameRect", "snip1Rect", "snip2SameRect", "snipRoundRect", "frame"]),
    ("callout", &["wedgeRectCallout", "wedgeRoundRectCallout", "wedgeEllipseCallout", "cloudCallout"]),
    ("bracket", &["leftBrace", "rightBrace", "bracePair", "leftBracket", "rightBracket", "bracketPair"]),
    ("node", &["ellipse"]),
];

fn geometry_family(slide: &Value) -> &'static str {
    let geometries: Vec<String> = shapes_of(slide).iter().map(|shape| text(field(shape, "geometry"))).filter(|name| !name.is_empty()).collect();
    for (family, names) in GEOMETRY_FAMILIES {
        if geometries.iter().any(|geometry| names.contains(&geometry.as_str())) {
            return family;
        }
    }
    ""
}

/// `/^[+\-−]?\d/` over the text of a hero numeral of at most twelve characters at 36 pt or more.
fn is_metric_text(shape: &Value) -> bool {
    let shown = trimmed(field(shape, "text"));
    if num0(field_of(field(shape, "font"), "size")) < 36.0 || utf16_len(&shown) > 12 {
        return false;
    }
    let rest = shown.strip_prefix(['+', '-', '\u{2212}']).unwrap_or(&shown);
    rest.chars().next().is_some_and(|first| first.is_ascii_digit())
}

fn inferred_visual_type(slide: &Value) -> String {
    let shapes = shapes_of(slide);
    let roles: Vec<&str> = shapes.iter().map(shape_role).collect();
    if roles.contains(&"chart") {
        return "chart".into();
    }
    if roles.contains(&"table") {
        return "table".into();
    }
    let signed = signed_visual_type(slide);
    if !signed.is_empty() {
        return signed;
    }
    let family = geometry_family(slide);
    if !family.is_empty() {
        return family.into();
    }
    if roles.contains(&"image") {
        return "image".into();
    }
    if shapes.iter().any(is_metric_text) {
        return "metric".into();
    }
    if roles.contains(&"group") || roles.contains(&"shape") {
        return "diagram".into();
    }
    "typography".into()
}

/// The decoration a page carries, read from the description the kit writes on its device ("rings motif"). A style runs a
/// set of devices, not one, and an anchor that names no kind takes the next of the set, so two pages in a row drawing
/// the same device are one page twice however their type differs. A page with no device reads as its own kind and never
/// joins a run. `/^([a-z]+) motif$/i`.
fn decoration_kind(slide: &Value) -> String {
    for shape in shapes_of(slide) {
        let alt = trimmed(field(shape, "altText"));
        let Some(kind) = alt.get(..alt.len().saturating_sub(" motif".len())) else { continue };
        let tail = &alt[kind.len()..];
        if !kind.is_empty() && tail.eq_ignore_ascii_case(" motif") && kind.chars().all(|c| c.is_ascii_alphabetic()) {
            return js_to_lowercase(kind);
        }
    }
    String::new()
}

/// The longest run of consecutive entries that read the same: `(length, start)`. The third same page in a row is what a
/// reader notices first at contact-sheet scale.
fn longest_repeat_run(entries: &[String]) -> (usize, usize) {
    let mut best = (0, 0);
    let mut start = 0;
    for index in 1..=entries.len() {
        if index < entries.len() && entries[index] == entries[index - 1] {
            continue;
        }
        if index - start > best.0 {
            best = (index - start, start);
        }
        start = index;
    }
    best
}

fn layout_grammar_issue(content: &[Value], grammar: &[String]) -> Option<Value> {
    let mut counts: Vec<(&String, usize)> = Vec::new();
    for signature in grammar.iter().filter(|signature| !signature.is_empty()) {
        match counts.iter_mut().find(|(known, _)| *known == signature) {
            Some((_, count)) => *count += 1,
            None => counts.push((signature, 1)),
        }
    }
    let repeated = counts.iter().map(|(_, count)| *count).max().unwrap_or(0);
    if content.len() < 4 || (repeated as f64 / content.len() as f64) < 0.6 {
        return None;
    }
    Some(issue("repeated_layout_grammar", &format!("{repeated} of {} content slides reuse the same coarse layout grammar.", content.len())))
}

fn composition_repeat_issue(content: &[Value], grammar: &[String], visual_types: &[String]) -> Option<Value> {
    let keyed: Vec<String> = grammar
        .iter()
        .enumerate()
        .map(|(index, signature)| if signature.is_empty() { format!("\u{0}{index}") } else { format!("{signature}\u{0}{}", visual_types[index]) })
        .collect();
    let (length, start) = longest_repeat_run(&keyed);
    if length < 3 {
        return None;
    }
    let first = index_or(content.get(start), start as f64 + 2.0);
    let last = index_or(content.get(start + length - 1), first + length as f64 - 1.0);
    Some(issue(
        "consecutive_composition_repeat",
        &format!(
            "Slides {}-{} repeat one composition ({}) {length} pages in a row; change the structure where the meaning changes, or merge the pages.",
            number_to_string(first),
            number_to_string(last),
            visual_types[start]
        ),
    ))
}

fn decoration_repeat_issue(slides: &[Value]) -> Option<Value> {
    let decorations: Vec<String> = slides.iter().map(decoration_kind).collect();
    let keyed: Vec<String> = decorations.iter().enumerate().map(|(index, kind)| if kind.is_empty() { format!("\u{0}{index}") } else { kind.clone() }).collect();
    let (length, start) = longest_repeat_run(&keyed);
    if length < 2 {
        return None;
    }
    let first = index_or(slides.get(start), start as f64 + 1.0);
    let last = index_or(slides.get(start + length - 1), first + length as f64 - 1.0);
    Some(issue(
        "repeated_decoration",
        &format!(
            "Slides {}-{} draw the same {} device {length} pages in a row; take the next device of the deck's set on the later page, or leave it undecorated.",
            number_to_string(first),
            number_to_string(last),
            decorations[start]
        ),
    ))
}

fn visual_variety_issue(content: &[Value], visual_types: &[String]) -> Option<Value> {
    let mut seen: Vec<&String> = Vec::new();
    for kind in visual_types.iter().filter(|kind| !kind.is_empty()) {
        if !seen.contains(&kind) {
            seen.push(kind);
        }
    }
    let unique = seen.len();
    let required = usize::min(3, content.len().div_ceil(2));
    if content.len() < 5 || unique >= required {
        return None;
    }
    Some(issue("visual_role_variety_low", &format!("The deck uses {unique} visual role(s) across {} content slides; use at least {required}.", content.len())))
}

/// `{ ...candidate, id: undefined }` written by `JSON.stringify`: the candidate with its id left out.
fn candidate_without_id(candidate: &Value) -> String {
    match candidate {
        Value::Object(map) => {
            let mut rest = Map::new();
            for (key, value) in map {
                if key != "id" {
                    rest.insert(key.clone(), value.clone());
                }
            }
            json_stringify(&Value::Object(rest))
        }
        Value::String(written) => {
            let mut rest = Map::new();
            for (at, unit) in written.chars().enumerate() {
                rest.insert(at.to_string(), Value::String(unit.to_string()));
            }
            json_stringify(&Value::Object(rest))
        }
        Value::Array(items) => {
            let mut rest = Map::new();
            for (at, item) in items.iter().enumerate() {
                rest.insert(at.to_string(), item.clone());
            }
            json_stringify(&Value::Object(rest))
        }
        _ => "{}".to_owned(),
    }
}

/// An authored deck declares its directions on the brief's `directions:` line: the two compared compositions and the one
/// selected, which is what the skill asks for; the composer's own route builds three candidates instead. Reading only
/// the composer's payload told every authored deck it had no art direction, whatever its brief said.
fn art_direction_issue(design: &Value) -> Option<Value> {
    let brief_directions = field_of(field(design, "brief"), "directions");
    let art_direction = field(design, "artDirection");
    let composed = list(field_of(art_direction, "candidates"));
    let direction_candidates: &[Value] = if composed.is_empty() { list(field_of(brief_directions, "candidates")) } else { composed };
    let selected = is_truthy(field_of(field_of(art_direction, "selected"), "id")) || (composed.is_empty() && is_truthy(field_of(brief_directions, "selected")));
    let required = if !composed.is_empty() || !is_truthy(brief_directions) { 3 } else { 2 };
    // Candidates that say the same thing are one candidate: only textual differences count.
    let mut distinct: Vec<String> = Vec::new();
    for candidate in direction_candidates {
        let written = match field(candidate, "text") {
            Some(Value::Null) | None => candidate_without_id(candidate),
            Some(value) => value_to_string(value),
        };
        let normalised = squash(&js_to_lowercase(&written));
        if !distinct.contains(&normalised) {
            distinct.push(normalised);
        }
    }
    if distinct.len() >= required && selected {
        return None;
    }
    Some(issue("art_direction_candidates_missing", &format!("The deck has no selected art direction backed by {required} distinct candidates.")))
}

/// `reviewPptxDeckDiversity({ document, design })`: the deck-wide readings that make a deck of different pages out of
/// pages that merely differ. `reads` answers the page receipt and the brief; a deck whose design allows repetition is
/// not read.
pub fn review_pptx_deck_diversity(reads: &dyn AuthorReads, document: &Value, design: &Value) -> Vec<Value> {
    if is_truthy(field_of(field(design, "review"), "allowRepetition")) {
        return Vec::new();
    }
    let slides = field(document, "slides").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let content: &[Value] = if slides.len() >= 3 { &slides[1..slides.len() - 1] } else { slides.get(1..).unwrap_or(&[]) };
    if content.is_empty() {
        return Vec::new();
    }
    let pick = |first: f64, second: f64, fallback: f64| [first, second].into_iter().find(|number| !number.is_nan() && *number != 0.0).unwrap_or(fallback);
    let format = field(design, "format");
    let canvas = (
        pick(to_number_of(field(document, "slideWidth")), to_number_of(field_of(format, "canvasWidth")), 960.0),
        pick(to_number_of(field(document, "slideHeight")), to_number_of(field_of(format, "canvasHeight")), 540.0),
    );
    let grammar: Vec<String> = content.iter().map(|slide| layout_grammar_signature(slide, canvas)).collect();
    let plans = list(field(design, "slidePlans"));
    let visual_types: Vec<String> = content
        .iter()
        .map(|slide| {
            let index = to_number_of(field(slide, "index"));
            let planned = plans
                .iter()
                .rev()
                .find(|plan| {
                    let slide_number = to_number_of(field(plan, "slide"));
                    slide_number == index || (slide_number.is_nan() && index.is_nan())
                })
                .map(|plan| js_to_lowercase(&text(field(plan, "visualType"))))
                .unwrap_or_default();
            if planned.is_empty() { inferred_visual_type(slide) } else { planned }
        })
        .collect();
    let showcase = reads.is_showcase_brief(field(design, "brief").unwrap_or(&Value::Null));
    let issues = [
        layout_grammar_issue(content, &grammar),
        composition_repeat_issue(content, &grammar, &visual_types),
        decoration_repeat_issue(slides),
        visual_variety_issue(content, &visual_types),
    ];
    // Beats, runs of beats, and sparse body pages are the grammar of a read deck; a presentation, keynote, or showcase
    // deck is composed of such pages on purpose.
    let shape = if showcase { Vec::new() } else { deck_shape_issues(reads, slides) };
    let direction = art_direction_issue(design);
    let mut out: Vec<Value> = issues.into_iter().flatten().collect();
    out.extend(shape);
    out.extend(direction);
    out
}
