//! `portable/review-editability.mjs`: the structural tells that make a deck a picture of a slide instead of a slide. Both
//! checks run on the inspected shape geometry (points) that the text-fit review already collects: text boxes (`boxes`) and
//! every visible object (`content`), as [`crate::pptx_core::inspect_pptx_text_boxes`] reads them.

use std::collections::HashSet;

use mixdog_js::{js_sort_by, js_trim, math, number_to_string, to_number_of};
use mixdog_office_base::values::truthy;
use serde_json::{Value, json};

use crate::relations::{Relation, RelationBox, by_slide, independent_text_unit, relation_index};
use crate::slide_shapes::{text_if_truthy, text_of};

fn near(a: f64, b: f64, tolerance: f64) -> bool {
    math::abs(a - b) <= tolerance
}

fn field(entry: &Value, key: &str) -> f64 {
    to_number_of(entry.get(key))
}

/// What a box that holds one line of text says about it.
#[derive(Clone)]
struct Line {
    size: f64,
    bold: bool,
    font: Value,
}

fn single_line_text(entry: &Value) -> Option<Line> {
    let paragraphs: &[Value] = entry.get("paragraphs").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let filled: Vec<&Value> = paragraphs.iter().filter(|paragraph| !js_trim(&text_if_truthy(paragraph.get("text"))).is_empty()).collect();
    if filled.len() != 1 {
        return None;
    }
    let paragraph = filled[0];
    let size = {
        let number = to_number_of(paragraph.get("fontSize"));
        if number.is_nan() { 0.0 } else { number }
    };
    if size == 0.0 {
        return None;
    }
    // A box taller than two lines holds a paragraph already; only line-sized boxes fragment.
    if field(entry, "height") > size * 1.2 * 2.2 {
        return None;
    }
    let font = paragraph.get("fontName").filter(|value| truthy(value)).cloned().unwrap_or_else(|| Value::from(""));
    Some(Line { size, bold: paragraph.get("bold").is_some_and(truthy), font })
}

/// A text box as the relation helpers read it.
fn relation_box(entry: &Value) -> RelationBox {
    RelationBox {
        slide: field(entry, "slide"),
        shape: field(entry, "shape"),
        left: field(entry, "left"),
        top: field(entry, "top"),
        width: field(entry, "width"),
        height: field(entry, "height"),
        relation: entry.get("relation").and_then(Relation::from_value),
        relation_error: entry.get("relationError").filter(|value| truthy(value)).map(mixdog_js::value_to_string),
    }
}

#[derive(Clone)]
struct Candidate<'a> {
    entry: &'a Value,
    line: Line,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

/// `a.top - b.top || a.left - b.left` as `Array.prototype.sort` reads it.
fn reading_order(first: &Candidate, second: &Candidate) -> f64 {
    let rows = first.top - second.top;
    if rows != 0.0 && !rows.is_nan() { rows } else { first.left - second.left }
}

/// `reviewTextFragmentation(boxes, { minimumRun })`: a paragraph authored as a stack of single-line text boxes (same left
/// edge, same size, line-step gaps). It reads fine and edits badly: nothing reflows, and every line is its own object.
pub fn review_text_fragmentation(boxes: &[Value], minimum_run: f64) -> Vec<Value> {
    let mut issues = Vec::new();
    for (_, shapes) in by_slide(boxes, |entry| field(entry, "slide")) {
        let relation_boxes: Vec<RelationBox> = shapes.iter().map(|entry| relation_box(entry)).collect();
        let relations = relation_index(&relation_boxes);
        let mut lines: Vec<Candidate> = shapes
            .iter()
            .enumerate()
            .filter(|(at, _)| !independent_text_unit(&relation_boxes, *at, &relations))
            .filter_map(|(_, entry)| {
                let entry: &Value = *entry;
                single_line_text(entry).map(|line| Candidate {
                    entry,
                    line,
                    left: field(entry, "left"),
                    top: field(entry, "top"),
                    width: field(entry, "width"),
                    height: field(entry, "height"),
                })
            })
            .collect();
        js_sort_by(&mut lines, reading_order);
        let mut used = vec![false; lines.len()];
        for start in 0..lines.len() {
            if used[start] {
                continue;
            }
            let mut run = vec![start];
            let mut last = start;
            for candidate in 0..lines.len() {
                // `run` opens with `start`, so the run scan also skips the line the run began at, and finds it at its first
                // entry.
                if used[candidate] || run.contains(&candidate) {
                    continue;
                }
                let (next, previous) = (&lines[candidate], &lines[last]);
                let same_column =
                    near(next.left, previous.left, 4.0) && near(next.width, previous.width, math::max(12.0, previous.width * 0.15));
                let same_role = next.line.size == previous.line.size && next.line.bold == previous.line.bold && next.line.font == previous.line.font;
                let step = next.top - previous.top;
                let line_step = previous.line.size * 1.2;
                let consecutive = step > 0.0 && step <= math::max(line_step * 2.2, previous.height + line_step * 0.9);
                if same_column && same_role && consecutive {
                    run.push(candidate);
                    last = candidate;
                }
            }
            if (run.len() as f64) < minimum_run {
                continue;
            }
            // Bulleted or numbered lines are a list drawn line by line: the same fault.
            for entry in &run {
                used[*entry] = true;
            }
            let numbers: Vec<String> = run.iter().map(|entry| shape_text(lines[*entry].entry)).collect();
            issues.push(json!({
                "code": "text_fragmentation",
                "severity": "info",
                "confidence": "inferred",
                "path": format!("/slide[{}]/shape[{}]", text_of(lines[start].entry.get("slide")), text_of(lines[start].entry.get("shape"))),
                "message": format!(
                    "{} single-line text boxes may form one paragraph (shapes {}). Their relationship is unknown; inspect whether they should reflow together before merging.",
                    run.len(),
                    numbers.join(", ")
                ),
                "shapes": run.iter().map(|entry| lines[*entry].entry.get("shape").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
            }));
        }
    }
    issues
}

/// An array element's text in `join`: absent and null read as empty.
fn shape_text(entry: &Value) -> String {
    entry.get("shape").filter(|value| !value.is_null()).map(mixdog_js::value_to_string).unwrap_or_default()
}

struct Solid<'a> {
    entry: &'a Value,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

struct Group {
    axis: f64,
    thickness: f64,
    shapes: Vec<usize>,
}

/// Four or more equal-thickness shapes on one axis, of lengths that differ.
fn series(
    solids: &[Solid],
    minimum_bars: f64,
    axis_of: impl Fn(&Solid) -> f64,
    thickness_of: impl Fn(&Solid) -> f64,
    length_of: impl Fn(&Solid) -> f64,
) -> Option<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for (at, shape) in solids.iter().enumerate() {
        let found = groups
            .iter_mut()
            .find(|entry| near(axis_of(shape), entry.axis, 3.0) && near(thickness_of(shape), entry.thickness, math::max(3.0, entry.thickness * 0.2)));
        match found {
            Some(group) => group.shapes.push(at),
            None => groups.push(Group { axis: axis_of(shape), thickness: thickness_of(shape), shapes: vec![at] }),
        }
    }
    groups.into_iter().find(|group| {
        if (group.shapes.len() as f64) < minimum_bars {
            return false;
        }
        let lengths: Vec<f64> = group.shapes.iter().map(|at| length_of(&solids[*at])).collect();
        let distinct: HashSet<String> = lengths.iter().map(|value| number_to_string(math::round(value / 4.0))).collect();
        let longest = lengths.iter().copied().fold(f64::NEG_INFINITY, math::max);
        let shortest = lengths.iter().copied().fold(f64::INFINITY, math::min);
        distinct.len() >= 3 && longest / math::max(1.0, shortest) >= 1.3
    })
}

/// `reviewDeadVectorChart(content, boxes, { minimumBars })`: a bar chart drawn from rectangles. Four or more filled,
/// text-free shapes share a baseline (columns) or a left edge (bars), match in thickness, and vary in length, on a slide
/// with no native chart frame.
pub fn review_dead_vector_chart(content: &[Value], boxes: &[Value], minimum_bars: f64) -> Vec<Value> {
    let mut issues = Vec::new();
    let text_shapes: HashSet<String> =
        boxes.iter().map(|entry| format!("{}:{}", text_of(entry.get("slide")), text_of(entry.get("shape")))).collect();
    for (_, entries) in by_slide(content, |entry| field(entry, "slide")) {
        if entries.iter().any(|entry| entry.get("kind").and_then(Value::as_str) == Some("p:graphicFrame")) {
            continue;
        }
        let solids: Vec<Solid> = entries
            .iter()
            .filter(|entry| {
                entry.get("kind").and_then(Value::as_str) == Some("p:sp")
                    && !text_shapes.contains(&format!("{}:{}", text_of(entry.get("slide")), text_of(entry.get("shape"))))
                    && field(entry, "width") > 4.0
                    && field(entry, "height") > 4.0
            })
            .map(|entry| Solid { entry, left: field(entry, "left"), top: field(entry, "top"), width: field(entry, "width"), height: field(entry, "height") })
            .collect();
        if (solids.len() as f64) < minimum_bars {
            continue;
        }
        let columns = series(&solids, minimum_bars, |shape| shape.top + shape.height, |shape| shape.width, |shape| shape.height);
        let bars = if columns.is_some() { None } else { series(&solids, minimum_bars, |shape| shape.left, |shape| shape.height, |shape| shape.width) };
        let is_columns = columns.is_some();
        let Some(found) = columns.or(bars) else { continue };
        issues.push(json!({
            "code": "dead_vector_chart",
            "path": format!("/slide[{}]/shape[{}]", text_of(solids[found.shapes[0]].entry.get("slide")), text_of(solids[found.shapes[0]].entry.get("shape"))),
            "message": format!(
                "{} rectangles of varying {} draw a {} chart by hand; use a native chart (addChart / the kit's chart()) so the data stays editable.",
                found.shapes.len(),
                if is_columns { "height on one baseline" } else { "width on one left edge" },
                if is_columns { "column" } else { "bar" }
            ),
            "shapes": found.shapes.iter().map(|at| solids[*at].entry.get("shape").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        }));
    }
    issues
}

#[cfg(test)]
mod tests {
    use mixdog_js::json_number;

    use super::*;

    /// A one-line text box 400 pt wide at the left margin; `size` is the font size, its height 1.4 lines.
    fn line(slide: u32, shape: u32, top: f64, text: &str, size: f64) -> Value {
        json!({
            "slide": slide, "shape": shape, "left": 72, "top": top, "width": 400, "height": json_number(size * 1.4),
            "paragraphs": [{ "text": text, "fontSize": size, "bold": false, "fontName": "Calibri" }],
        })
    }

    fn bold(mut entry: Value) -> Value {
        entry["paragraphs"][0]["bold"] = Value::Bool(true);
        entry
    }

    fn at_left(mut entry: Value, left: f64) -> Value {
        entry["left"] = json_number(left);
        entry
    }

    fn rect(slide: u32, shape: u32, left: f64, top: f64, width: f64, height: f64) -> Value {
        json!({ "slide": slide, "shape": shape, "kind": "p:sp", "left": left, "top": top, "width": width, "height": height })
    }

    #[test]
    fn a_paragraph_split_into_stacked_single_line_boxes_is_reported_once_per_run() {
        let boxes = [
            bold(line(2, 1, 60.0, "Title of the slide", 36.0)),
            line(2, 2, 140.0, "First line of the paragraph", 18.0),
            line(2, 3, 166.0, "second line of the paragraph", 18.0),
            line(2, 4, 192.0, "third line of the paragraph", 18.0),
            line(2, 5, 218.0, "fourth line", 18.0),
            line(2, 6, 400.0, "Standalone caption", 12.0),
        ];
        let issues = review_text_fragmentation(&boxes, 3.0);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], "text_fragmentation");
        assert_eq!(issues[0]["path"], "/slide[2]/shape[2]");
        assert_eq!(issues[0]["shapes"], json!([2, 3, 4, 5]));
    }

    #[test]
    fn real_paragraphs_labels_in_different_columns_and_two_line_pairs_are_not_fragmentation() {
        let paragraph = json!({
            "slide": 1, "shape": 1, "left": 72, "top": 100, "width": 400, "height": 200,
            "paragraphs": [{ "text": "a", "fontSize": 18 }, { "text": "b", "fontSize": 18 }],
        });
        let mut boxes = vec![paragraph];
        boxes.extend([
            line(1, 2, 300.0, "A", 18.0),
            at_left(line(1, 3, 300.0, "B", 18.0), 300.0),
            at_left(line(1, 4, 300.0, "C", 18.0), 528.0),
            bold(line(1, 5, 400.0, "value", 40.0)),
            line(1, 6, 460.0, "label", 12.0),
            line(1, 7, 500.0, "one", 18.0),
            line(1, 8, 600.0, "two", 18.0),
            line(1, 9, 700.0, "three", 18.0),
        ]);
        assert_eq!(review_text_fragmentation(&boxes, 3.0), Vec::<Value>::new());
    }

    #[test]
    fn columns_of_varying_height_on_one_baseline_are_a_hand_drawn_chart_unless_a_native_chart_is_present() {
        let content = vec![
            rect(3, 1, 72.0, 300.0, 40.0, 120.0),
            rect(3, 2, 132.0, 240.0, 40.0, 180.0),
            rect(3, 3, 192.0, 360.0, 40.0, 60.0),
            rect(3, 4, 252.0, 200.0, 40.0, 220.0),
            rect(3, 5, 72.0, 60.0, 500.0, 40.0),
        ];
        let title = [json!({ "slide": 3, "shape": 5, "paragraphs": [{ "text": "Title", "fontSize": 30 }] })];
        let issues = review_dead_vector_chart(&content, &title, 4.0);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], "dead_vector_chart");
        assert!(issues[0]["message"].as_str().is_some_and(|message| message.contains("column chart by hand")));
        assert_eq!(issues[0]["shapes"], json!([1, 2, 3, 4]));
        let mut with_native = content;
        with_native.push(json!({ "slide": 3, "shape": 6, "kind": "p:graphicFrame", "left": 0, "top": 0, "width": 100, "height": 100 }));
        assert_eq!(review_dead_vector_chart(&with_native, &[], 4.0), Vec::<Value>::new());
    }

    #[test]
    fn horizontal_bars_from_one_left_edge_are_reported_and_equal_cards_are_not() {
        let bars = [rect(4, 1, 72.0, 100.0, 300.0, 24.0), rect(4, 2, 72.0, 140.0, 180.0, 24.0), rect(4, 3, 72.0, 180.0, 420.0, 24.0), rect(4, 4, 72.0, 220.0, 90.0, 24.0)];
        let issues = review_dead_vector_chart(&bars, &[], 4.0);
        assert!(issues[0]["message"].as_str().is_some_and(|message| message.contains("bar chart by hand")));
        let cards = [
            rect(5, 1, 72.0, 100.0, 200.0, 150.0),
            rect(5, 2, 300.0, 100.0, 200.0, 150.0),
            rect(5, 3, 528.0, 100.0, 200.0, 150.0),
            rect(5, 4, 756.0, 100.0, 200.0, 150.0),
        ];
        assert_eq!(review_dead_vector_chart(&cards, &[], 4.0), Vec::<Value>::new());
    }
}
