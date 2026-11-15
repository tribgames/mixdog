//! `pptx-deck-rubric.mjs`: a deck's score, read from what the runtime already measures. The rubric benchmarks the field
//! settled on grade a finished deck against fixed criteria; this is the local stand-in: every check reads a number the
//! composition receipt or the measured review produced, so one round can be compared with the last instead of judged by
//! eye. It grades, it never gates: a deliberate breathing page or a motif plane costs points and is still the right
//! call; the score is a conversation starter, not a verdict.

use mixdog_js::{json_number, math, to_number_of};
use serde_json::{Map, Value, json};

use super::{AuthorReads, fixed};
use mixdog_office_base::values::truthy;

use crate::{field, field_of, is_truthy};

/// `[id, weight, what it reads]`.
const CHECKS: [(&str, f64, &str); 16] = [
    ("fit", 3.0, "measured defects — overflow, out of bounds, contrast, broken chart, fragmentation"),
    ("body_line", 2.0, "content slides sharing one body top"),
    ("vertical_fill", 2.0, "content reaching down its zone instead of stopping halfway"),
    ("owned_planes", 2.0, "tinted planes their own content covers"),
    ("spacing_vocabulary", 2.0, "distinct vertical gaps across the deck"),
    ("type_scale", 2.0, "distinct type sizes across the deck"),
    ("color_ladder", 2.0, "distinct text colors across the deck"),
    ("balance", 3.0, "pixel weight balance of the rendered pages"),
    ("rhythm", 2.0, "density varying across the sequence instead of flatlining"),
    ("carriers", 2.0, "slides carrying something besides text"),
    ("presence", 2.0, "the largest carrier on a content slide at a readable share of the canvas"),
    ("alignment", 1.0, "text boxes whose right edge aligns with nothing"),
    ("density", 2.0, "characters a body page carries (the reference decks: 330-900 median)"),
    ("deck_shape", 2.0, "beats (dark or field pages) kept to about one page in eight"),
    ("colour_pacing", 2.0, "colourfulness varying across the rendered sequence (frontier spread 16-36)"),
    ("object_scale", 2.0, "the largest rendered object on a body page (the reference decks: median 0.4 of the canvas)"),
];

/// Checks that read a body-page grammar a presentation, keynote, or showcase deck does not follow.
const READ_DECK_ONLY: [&str; 3] = ["density", "object_scale", "body_line"];
/// Informational checks are reported with their reading but carry no weight in the score.
const INFORMATIONAL: [&str; 1] = ["body_line"];

const NOTE: &str = "Every check is a reading, not a rule: a breathing page lowers vertical_fill and a motif plane lowers owned_planes on purpose. Compare the same deck across rounds, and read `weakest` before the total.";

fn clamp01(value: f64) -> f64 {
    math::min(1.0, math::max(0.0, value))
}

/// 1 at `good`, 0 at `bad`, linear between: for readings where lower is better (defects, distinct gaps).
fn band(value: f64, good: f64, bad: f64) -> f64 {
    clamp01((bad - value) / (bad - good))
}

fn mean(list: &[f64]) -> f64 {
    list.iter().fold(0.0, |sum, entry| sum + entry) / list.len() as f64
}

fn deviation(list: &[f64]) -> f64 {
    let average = mean(list);
    let squares: Vec<f64> = list.iter().map(|entry| (entry - average) * (entry - average)).collect();
    math::sqrt(mean(&squares))
}

/// `typeof value === 'number'` of a reading, as the number.
fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    }
}

struct Check {
    id: &'static str,
    weight: f64,
    score: f64,
    value: Value,
    reads: &'static str,
    informational: bool,
}

/// `scoreDeck({ receipt, issues, brief })`: `{ score, slides, checks, weakest, note }`. `issues` is the number of
/// measured defects; `brief` is the deck's authoring brief (a showcase deck skips the body-page readings).
pub fn score_deck(reads: &dyn AuthorReads, receipt: Option<&Value>, issue_count: usize, brief: Option<&Value>) -> Value {
    let showcase = reads.is_showcase_brief(brief.unwrap_or(&Value::Null));
    let slides: &[Value] = field_of(receipt, "slides").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let deck = field_of(receipt, "deck");
    let rhythm = field_of(deck, "rhythm").filter(|value| truthy(value));
    let observed: Vec<&Value> = slides.iter().filter_map(|slide| field(slide, "observe")).filter(|observe| truthy(observe)).collect();
    let mut checks: Vec<Check> = Vec::new();
    let mut add = |id: &'static str, score: f64, value: Value| {
        if score.is_nan() {
            return;
        }
        if showcase && READ_DECK_ONLY.contains(&id) {
            return;
        }
        let informational = INFORMATIONAL.contains(&id);
        let (_, weight, note) = CHECKS.iter().find(|(known, _, _)| *known == id).copied().expect("a known check");
        checks.push(Check { id, weight: if informational { 0.0 } else { weight }, score: fixed(clamp01(score), 2), value, reads: note, informational });
    };

    add("fit", band(issue_count as f64, 0.0, 6.0), json!(issue_count));

    let body_tops: Vec<f64> = observed.iter().filter_map(|observe| number(field(observe, "bodyTop"))).collect();
    if body_tops.len() > 1 {
        let mut counts: Vec<(f64, usize)> = Vec::new();
        for top in &body_tops {
            match counts.iter_mut().find(|(known, _)| known == top) {
                Some((_, count)) => *count += 1,
                None => counts.push((*top, 1)),
            }
        }
        let most = counts.iter().map(|(_, count)| *count).max().unwrap_or(0);
        add("body_line", most as f64 / body_tops.len() as f64, json!(counts.len()));
    }

    let fills: Vec<f64> = observed.iter().filter_map(|observe| number(field(observe, "bodyFill"))).collect();
    // Half a zone is where a page stops reading as composed and starts reading as unfinished.
    if !fills.is_empty() {
        add("vertical_fill", fills.iter().filter(|fill| **fill >= 0.5).count() as f64 / fills.len() as f64, json_number(fixed(mean(&fills), 2)));
    }

    let planes: Vec<f64> = observed.iter().filter_map(|observe| number(field(observe, "fieldFill").and_then(Value::as_array).and_then(|list| list.first()))).collect();
    if !planes.is_empty() {
        let least = planes.iter().fold(f64::INFINITY, |least, plane| math::min(least, *plane));
        add("owned_planes", planes.iter().filter(|plane| **plane >= 0.25).count() as f64 / planes.len() as f64, json_number(fixed(least, 2)));
    }

    let set_length = |key: &str| field_of(rhythm, key).and_then(Value::as_array).map(Vec::len);
    if let Some(gaps) = set_length("gapSet") {
        add("spacing_vocabulary", band(gaps as f64, 4.0, 12.0), json!(gaps));
    }
    if let Some(types) = set_length("typeSet") {
        add("type_scale", band(types as f64, 7.0, 14.0), json!(types));
    }
    if let Some(colors) = set_length("textColors") {
        add("color_ladder", band(colors as f64, 5.0, 10.0), json!(colors));
    }

    let balances: Vec<f64> = observed.iter().filter_map(|observe| number(field_of(field(observe, "renderBalance"), "score"))).collect();
    if !balances.is_empty() {
        let balance = mean(&balances);
        add("balance", balance, json_number(fixed(balance, 2)));
    }

    let air: Vec<f64> = observed.iter().filter_map(|observe| number(field(observe, "air"))).collect();
    if air.len() > 2 {
        let spread = deviation(&air);
        add("rhythm", clamp01((spread - 0.02) / 0.08), json_number(fixed(spread, 3)));
    }

    if !slides.is_empty() {
        let text_only = {
            let counted = field_of(deck, "textOnly").filter(|value| truthy(value));
            counted.map_or(0.0, |value| to_number_of(Some(value)))
        };
        add("carriers", 1.0 - text_only / slides.len() as f64, json_number(text_only));
    }

    // A quarter of the canvas is where a chart's labels and a picture's subject still read from the back of the room;
    // content slides (those with a body under a title) are read, anchors carry a statement on purpose.
    let presences: Vec<f64> = observed
        .iter()
        .filter(|observe| number(field(observe, "bodyTop")).is_some())
        .filter_map(|observe| number(field(observe, "presence")))
        .collect();
    if !presences.is_empty() {
        let shares: Vec<f64> = presences.iter().map(|share| clamp01(share / 0.25)).collect();
        add("presence", mean(&shares), json_number(fixed(mean(&presences), 2)));
    }

    let strays: Vec<f64> = observed.iter().filter_map(|observe| number(field_of(field(observe, "textColumns"), "rightStray"))).collect();
    if !strays.is_empty() {
        let stray = mean(&strays);
        add("alignment", band(stray, 1.0, 4.0), json_number(fixed(stray, 1)));
    }

    // Body pages (evidence and text, never a beat) by the characters they carry: the reference decks run 330-900 per
    // page at the median, ours ran 60-150 before this work: a page that says one sentence beside its chart.
    let is_body = |slide: &Value| is_truthy(field(slide, "grammar")) && field(slide, "grammar").and_then(Value::as_str) != Some("beat");
    let mut body: Vec<f64> = slides.iter().filter(|slide| is_body(slide)).filter_map(|slide| number(field(slide, "chars"))).collect();
    if !body.is_empty() {
        body.sort_by(f64::total_cmp);
        let median = body[body.len() / 2];
        add("density", clamp01((median - 80.0) / (280.0 - 80.0)), json_number(median));
    }

    let shape = field_of(deck, "shape").filter(|value| truthy(value));
    if let Some(shape) = shape
        && slides.len() >= 4
    {
        let beat = field(shape, "beat");
        add("deck_shape", band(beat.map_or(f64::NAN, |value| to_number_of(Some(value))), 0.2, 0.45), beat.cloned().unwrap_or(Value::Null));
    }

    if let Some(spread) = number(field_of(field_of(deck, "pacing"), "colourSpread")) {
        add("colour_pacing", clamp01((spread - 5.0) / (15.0 - 5.0)), json_number(spread));
    }

    // The largest rendered object on the body pages (beats are a field by design and are left out): a chart with its
    // bars, a table, a picture row. The reference pages sit at 0.4 of the canvas at the median; 0.1 is a strip.
    let objects: Vec<f64> = slides.iter().filter(|slide| is_body(slide)).filter_map(|slide| number(field_of(field(slide, "observe"), "renderLargest"))).collect();
    if !objects.is_empty() {
        let largest = mean(&objects);
        add("object_scale", clamp01((largest - 0.1) / (0.35 - 0.1)), json_number(fixed(largest, 2)));
    }

    let total: f64 = checks.iter().fold(0.0, |sum, check| sum + check.weight);
    let score = if total == 0.0 {
        Value::Null
    } else {
        json_number(math::round((checks.iter().fold(0.0, |sum, check| sum + check.weight * check.score) / total) * 100.0))
    };
    let mut weighted: Vec<&Check> = checks.iter().filter(|check| check.weight > 0.0).collect();
    weighted.sort_by(|left, right| left.score.total_cmp(&right.score));
    let weakest: Vec<&str> = weighted.iter().take(3).map(|check| check.id).collect();
    let rows: Vec<Value> = checks
        .iter()
        .map(|check| {
            let mut row = Map::new();
            row.insert("id".into(), json!(check.id));
            row.insert("weight".into(), json_number(check.weight));
            row.insert("score".into(), json_number(check.score));
            row.insert("value".into(), check.value.clone());
            row.insert("reads".into(), json!(check.reads));
            if check.informational {
                row.insert("informational".into(), json!(true));
            }
            Value::Object(row)
        })
        .collect();
    json!({ "score": score, "slides": slides.len(), "checks": rows, "weakest": weakest, "note": NOTE })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The showcase reading of the brief (`isShowcaseBrief`); the rubric asks nothing else of the authoring side.
    struct Showcase;

    impl AuthorReads for Showcase {
        fn slide_receipt(&self, _: &Value) -> Value {
            unreachable!("the rubric reads no page receipt")
        }
        fn is_showcase_brief(&self, brief: &Value) -> bool {
            ["readingMode", "argumentMode"].iter().any(|key| matches!(brief[key].as_str(), Some("presentation" | "keynote" | "showcase")))
        }
        fn review_brief_promises(&self, _: &Value, _: &Value) -> Vec<Value> {
            unreachable!("the rubric reads no brief promise")
        }
        fn review_fact_coverage(&self, _: &Value, _: &Value) -> Vec<Value> {
            unreachable!("the rubric reads no fact coverage")
        }
        fn review_source_grounding(&self, _: &Value) -> Vec<Value> {
            unreachable!("the rubric reads no source grounding")
        }
    }

    fn slide(index: u32, observe: Value) -> Value {
        json!({ "slide": index, "observe": observe })
    }

    fn observed(air: f64, top: f64, fill: f64, plane: f64, presence: f64, balance: f64, stray: f64) -> Value {
        json!({ "air": air, "bodyTop": top, "bodyFill": fill, "fieldFill": [plane], "presence": presence, "renderBalance": { "score": balance }, "textColumns": { "rightStray": stray } })
    }

    /// A deck built the way the skill teaches: one body line, content filling its zone, planes carrying something, two
    /// spacing steps, one type scale, one color ladder, balanced pages, a varying density.
    fn good() -> Value {
        json!({
            "slides": [
                slide(1, observed(0.3, 4.6, 1.0, 0.62, 0.36, 0.88, 1.0)),
                slide(2, observed(0.42, 2.22, 0.94, 0.31, 0.31, 0.86, 1.0)),
                slide(3, observed(0.54, 2.22, 0.97, 0.95, 0.27, 0.82, 2.0)),
                slide(4, observed(0.33, 2.22, 1.0, 0.9, 0.44, 0.9, 1.0)),
            ],
            "deck": { "textOnly": 0, "rhythm": { "gapSet": [0.1, 0.45, 0.95], "typeSet": [11, 13, 18, 22, 36], "textColors": ["A", "B", "C", "D"] } },
        })
    }

    /// The same deck before today's repairs: two hollow planes, content stopping halfway, a hand-spaced vocabulary, a
    /// left-heavy render, and three measured defects.
    fn poor() -> Value {
        json!({
            "slides": [
                slide(1, observed(0.3, 4.6, 0.3, 0.0, 0.08, 0.6, 3.0)),
                slide(2, observed(0.31, 2.2, 0.4, 0.05, 0.06, 0.55, 4.0)),
                slide(3, observed(0.32, 3.1, 0.42, 0.1, 0.1, 0.62, 3.0)),
                slide(4, observed(0.3, 2.9, 0.45, 0.12, 0.0, 0.58, 5.0)),
            ],
            "deck": {
                "textOnly": 3,
                "rhythm": {
                    "gapSet": [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1.1, 1.4],
                    "typeSet": [9, 10, 11, 12, 13, 14, 18, 22, 30, 36, 44, 56],
                    "textColors": ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
                },
            },
        })
    }

    fn check<'a>(result: &'a Value, id: &str) -> &'a Value {
        result["checks"].as_array().expect("checks").iter().find(|check| check["id"] == id).unwrap_or_else(|| panic!("no {id} check"))
    }

    fn ids(result: &Value) -> Vec<&str> {
        result["checks"].as_array().expect("checks").iter().map(|check| check["id"].as_str().expect("id")).collect()
    }

    #[test]
    fn the_rubric_separates_a_composed_deck_from_a_hand_spaced_one_and_names_the_weakest_readings() {
        let good = score_deck(&Showcase, Some(&good()), 0, None);
        let poor = score_deck(&Showcase, Some(&poor()), 3, None);
        let (good_score, poor_score) = (good["score"].as_i64().expect("score"), poor["score"].as_i64().expect("score"));
        assert!(good_score >= 80, "a composed deck scores well: {good_score}");
        assert!(poor_score <= 55, "a hollow, hand-spaced deck scores low: {poor_score}");
        assert!(good_score - poor_score >= 25, "the two are far apart");
        let weakest: Vec<&str> = poor["weakest"].as_array().expect("weakest").iter().filter_map(Value::as_str).collect();
        assert!(weakest.contains(&"owned_planes") && weakest.len() == 3, "weakest names the hollow planes: {weakest:?}");
        assert_eq!(good["slides"], 4);
        assert_eq!(check(&good, "presence")["score"], 1, "carriers at a quarter of the canvas or more read as present");
        assert!(check(&poor, "presence")["score"].as_f64().expect("score") < 0.35, "a strip beside paragraphs reads as small");
    }

    #[test]
    fn each_reading_contributes_only_when_the_deck_carries_it_and_every_check_keeps_its_evidence() {
        let receipt = json!({ "slides": [slide(1, json!({ "air": 0.3, "bodyTop": 2.2, "bodyFill": 0.9, "textColumns": { "rightStray": 1 } }))], "deck": { "textOnly": 0, "rhythm": {} } });
        let measured_only = score_deck(&Showcase, Some(&receipt), 0, None);
        let found = ids(&measured_only);
        assert!(found.contains(&"fit") && found.contains(&"vertical_fill"));
        assert!(!found.contains(&"balance"), "a deck read without a render has no pixel balance to score");
        assert!(!found.contains(&"owned_planes"), "a deck with no tinted plane is not marked down for one");
        for entry in measured_only["checks"].as_array().expect("checks") {
            assert!(
                entry["weight"].as_f64().expect("weight") > 0.0 && !entry["value"].is_null() && !entry["reads"].as_str().expect("reads").is_empty(),
                "{} carries its evidence",
                entry["id"]
            );
        }
        let empty = score_deck(&Showcase, None, 0, None);
        assert_eq!(empty["slides"], 0);
        assert!(!empty["score"].is_null(), "an empty deck still returns a number rather than throwing");
    }

    #[test]
    fn showcase_decks_skip_density_and_object_scale_and_body_line_is_informational_and_weightless() {
        let body = |index: u32, chars: u32| json!({ "slide": index, "grammar": "body", "chars": chars, "observe": { "bodyTop": if index % 2 == 1 { 2.2 } else { 3.1 }, "renderLargest": 0.05 } });
        let receipt = json!({ "slides": [body(1, 20), body(2, 25), body(3, 30), body(4, 22)], "deck": { "rhythm": {} } });
        let read = score_deck(&Showcase, Some(&receipt), 0, Some(&json!({ "readingMode": "balanced" })));
        assert!(ids(&read).contains(&"density") && ids(&read).contains(&"object_scale"));
        for mode in ["presentation", "keynote", "showcase"] {
            let shown = score_deck(&Showcase, Some(&receipt), 0, Some(&json!({ "readingMode": mode })));
            for id in ["density", "object_scale", "body_line"] {
                assert!(!ids(&shown).contains(&id), "{mode} skips {id}");
            }
            assert!(shown["score"].as_i64() > read["score"].as_i64(), "the skipped checks no longer pull the score down");
        }
        let line = check(&read, "body_line");
        assert_eq!(line["weight"], 0);
        assert_eq!(line["informational"], true);
        assert!(!read["weakest"].as_array().expect("weakest").iter().any(|id| id == "body_line"));
    }
}
