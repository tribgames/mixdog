//! A field declared as a block travels in the flow, so the writer fixes its page and its coordinates where the reader
//! meets it; a field given absolute coordinates still goes exactly where it was put, which is what
//! stamping a form onto a scan needs. A checkbox or a radio is a square with its label beside it; a radio group with its
//! options is a question, its label above and each option a mark with its own words beside it in one row.

use mixdog_js::math::max;
use mixdog_js::{js_to_lowercase, json_number};
use mixdog_pdf::author::draw::parse_color;
use serde_json::{Map, Value};

use crate::forms::{FormFont, PdfForm, add_form_field, lint_pdf_form_fields};

use super::blocks::{block_type, items_of, num, num_nn, text_of, text_or};
use super::layout::{Flow, TextBox, caption_height};
use super::{Face, WriterError, WriterResult, trimmed};

const FIELD_HEIGHT: f64 = 22.0;
const FIELD_GUTTER: f64 = 12.0;
/// What a field block hands to the field it makes.
const FIELD_KEYS: [&str; 12] =
    ["name", "label", "value", "options", "multiline", "maxLength", "fontSize", "labelSize", "required", "readOnly", "width", "height"];
/// A checkbox or a radio is a square with its label beside it; stretched to the column like a text box it drew a 350 pt
/// bar with the tick floating in its middle.
const MARK_SIZE: f64 = 14.0;

fn is_field_row(kind: &str) -> bool {
    kind == "fieldrow" || kind == "fieldRow"
}

/// `fieldSpec(source)`: the type a block or an item declares (`text` when it names none) and the keys a field takes.
fn field_spec(source: &Value) -> Value {
    let declared = js_to_lowercase(&match source.get("fieldType") {
        Some(found) if super::blocks::truthy(found) => text_of(Some(found)),
        _ => text_or(source.get("type"), ""),
    });
    let mut spec = Map::new();
    let kind = if !declared.is_empty() && declared != "field" && declared != "fieldrow" { declared } else { "text".to_owned() };
    spec.insert("type".into(), Value::String(kind));
    for key in FIELD_KEYS {
        if let Some(value) = source.get(key) {
            spec.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(spec)
}

fn field_specs(block: &Value, kind: &str) -> Vec<Value> {
    if !is_field_row(kind) {
        return vec![field_spec(block)];
    }
    items_of(block.get("items")).iter().filter(|item| matches!(item, Value::Object(_) | Value::Array(_))).map(field_spec).collect()
}

/// `flowedFieldSpecs(blocks)`: the fields the blocks declare, so the document embeds a font that covers their captions
/// and values before anything is drawn.
pub fn flowed_field_specs(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .flat_map(|block| {
            let kind = block_type(block);
            if kind == "field" || kind == "fieldRow" { field_specs(block, &kind) } else { Vec::new() }
        })
        .collect()
}

fn declared_type(item: &Value) -> String {
    text_or(item.get("type"), "")
}

/// A radio group with its options is a question: its label above, each option a mark with its own words beside it in one
/// row. Drawn like a single mark, every option sat on the same spot under the question alone.
fn is_choice_group(item: &Value) -> bool {
    declared_type(item) == "radio" && !items_of(item.get("options")).is_empty() && !(num(item.get("width")) > 0.0)
}

fn is_mark_field(item: &Value) -> bool {
    matches!(declared_type(item).as_str(), "checkbox" | "radio") && !(num(item.get("width")) > 0.0) && !is_choice_group(item)
}

/// The row's geometry, shared by the reservation and the placement: the caption band above typed boxes and above a
/// question's options, and a row of marks only as tall as a mark and its label.
fn field_row_geometry(block: &Value, items: &[Value]) -> (f64, f64, f64) {
    let asked = num(block.get("labelSize"));
    let label_size = if asked > 0.0 { asked } else { 9.0 };
    let marks_only = items.iter().all(|item| is_mark_field(item) || is_choice_group(item));
    let mut height = FIELD_HEIGHT;
    if marks_only {
        height = max(MARK_SIZE + 4.0, label_size * 1.8);
    } else if num(block.get("height")) > 0.0 {
        height = num(block.get("height"));
    }
    let captioned = items.iter().any(|item| !is_mark_field(item) && !trimmed(item.get("label")).is_empty());
    (label_size, height, if captioned { label_size * 1.7 } else { 0.0 })
}

/// A question's options in a row from x: each mark, its words beside it, then a gap before the next.
fn choice_options(flow: &Flow, item: &Value, x: f64, y: f64, label_size: f64) -> WriterResult<Vec<Value>> {
    let mut at = x;
    let mut placed = Vec::new();
    for option in items_of(item.get("options")) {
        let by_value = |found: &Value| found.get("value").filter(|value| !value.is_null()).map(|value| text_of(Some(value)));
        let value = by_value(option).unwrap_or_else(|| text_of(Some(option)));
        let label = option.get("label").filter(|label| !label.is_null()).map(|label| text_of(Some(label))).unwrap_or_else(|| value.clone());
        let mut entry = Map::new();
        entry.insert("value".into(), Value::String(value));
        entry.insert("label".into(), Value::String(label.clone()));
        entry.insert("x".into(), json_number(at));
        entry.insert("y".into(), json_number(y));
        placed.push(Value::Object(entry));
        at += MARK_SIZE + 6.0 + flow.font.width(&label, label_size + 1.0)? + 18.0;
    }
    Ok(placed)
}

/// The room a field block needs, so the heading that introduces a form is not left at the foot of a page while its boxes
/// move to the next one.
pub fn field_block_height(block: &Value) -> f64 {
    let kind = block_type(block);
    if kind != "field" && kind != "fieldRow" {
        return 0.0;
    }
    let items = field_specs(block, &kind);
    if items.is_empty() {
        return 0.0;
    }
    let (_, height, caption) = field_row_geometry(block, &items);
    caption + height
}

/// A field as the flow resolves it: the label size, the item's own keys, then where the flow put it.
fn resolved_field(label_size: f64, item: &Value, placed: &[(&str, Value)]) -> Value {
    let mut map = Map::new();
    map.insert("labelSize".into(), json_number(label_size));
    if let Value::Object(own) = item {
        for (key, value) in own {
            map.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in placed {
        map.insert((*key).to_owned(), value.clone());
    }
    Value::Object(map)
}

/// Where the flow put a field: its page and its box.
fn placement(page: usize, x: f64, y: f64, width: f64, height: f64) -> Vec<(&'static str, Value)> {
    vec![("page", json_number(page as f64)), ("x", json_number(x)), ("y", json_number(y)), ("width", json_number(width)), ("height", json_number(height))]
}

pub fn place_field_block(flow: &mut Flow, block: &Value, text_box: TextBox, kind: &str, following: Option<&Value>) -> WriterResult<()> {
    let items = field_specs(block, kind);
    if items.is_empty() {
        return Ok(());
    }
    let (label_size, height, caption) = field_row_geometry(block, &items);
    // A caption under the form's last row travels with it, as it does under a table: on its own it opened a page of
    // nothing but one grey line.
    flow.keep_together(caption + height + num_nn(block.get("after"), 14.0) + caption_height(following, &flow.font, text_box.width)?)?;
    let gutter = num_nn(block.get("gutter"), FIELD_GUTTER);
    let count = items.len() as f64;
    let share = (text_box.width - gutter * (count - 1.0)) / count;
    let top = flow.y - caption;
    let page = flow.pages.len();
    let mark_y = top - height + (height - MARK_SIZE) / 2.0;
    for (index, item) in items.iter().enumerate() {
        let x = text_box.left + (share + gutter) * index as f64;
        let placed = if is_mark_field(item) {
            let mut placed = placement(page, x, mark_y, MARK_SIZE, MARK_SIZE);
            placed.push(("labelBeside", Value::Bool(true)));
            placed
        } else if is_choice_group(item) {
            let mut placed = placement(page, x, mark_y, MARK_SIZE, MARK_SIZE);
            placed.push(("options", Value::Array(choice_options(flow, item, x, mark_y, label_size)?)));
            placed
        } else {
            let wide = num(item.get("width"));
            let tall = num(item.get("height"));
            placement(page, x, top - height, if wide > 0.0 { wide } else { share }, if tall > 0.0 { tall } else { height })
        };
        flow.resolved_fields.push(resolved_field(label_size, item, &placed));
    }
    flow.y = top - height - num_nn(block.get("after"), 14.0);
    Ok(())
}

/// `lintForm(document, fields)`: the form's check, refused with the errors it names when the layout is invalid.
pub fn lint_form(flow: &Flow, fields: &mut [Value]) -> WriterResult<Value> {
    let sizes: Vec<[f64; 2]> = flow.pages.iter().map(|page| [page.width(), page.height()]).collect();
    let checked = lint_pdf_form_fields(fields, &sizes);
    if checked.get("ok") == Some(&Value::Bool(true)) {
        return Ok(checked);
    }
    let errors: Vec<String> = items_of(checked.get("issues"))
        .iter()
        .filter(|issue| issue.get("severity").and_then(Value::as_str) == Some("error"))
        .map(|issue| text_of(issue.get("message")))
        .collect();
    Err(WriterError::new(format!("PDF form layout is invalid: {}", errors.join(" "))))
}

/// The page a field names, when it names one the document has (`pages[Math.max(1, Number(page) || 1) - 1]`).
fn page_index(flow: &Flow, field: &Value) -> Option<usize> {
    let asked = num(field.get("page"));
    let asked = if asked.is_nan() || asked == 0.0 { 1.0 } else { asked };
    let at = max(1.0, asked) - 1.0;
    (at.fract() == 0.0 && at < flow.pages.len() as f64).then_some(at as usize)
}

/// The words a field carries on the page: its label above its box, or beside a mark's square on the square's middle, and
/// each option of a question beside its own mark.
fn draw_field_labels(flow: &mut Flow, font: &Face, field: &Value, page: usize) -> WriterResult<()> {
    let asked = num(field.get("labelSize"));
    let label_size = if asked > 0.0 { asked } else { 9.0 };
    let (x, y) = (num(field.get("x")), num(field.get("y")));
    let (wide, tall) = (num(field.get("width")), num(field.get("height")));
    let label = trimmed(field.get("label"));
    if !label.is_empty() {
        let (at_x, at_y, size, ink) = if field.get("labelBeside").is_some_and(super::blocks::truthy) {
            (x + wide + 6.0, y + (tall - label_size * 0.72) / 2.0, label_size + 1.0, "1F2937")
        } else {
            (x, y + tall + label_size * 0.45, label_size, "444444")
        };
        flow.pages[page].draw_text(&label, at_x, at_y, size, font, parse_color(ink)?)?;
    }
    for option in items_of(field.get("options")) {
        let Value::Object(_) = option else { continue };
        let option_x = num(option.get("x"));
        if trimmed(option.get("label")).is_empty() || !option_x.is_finite() {
            continue;
        }
        let option_y = num(option.get("y"));
        flow.pages[page].draw_text(
            &text_of(option.get("label")),
            option_x + wide + 6.0,
            option_y + (tall - label_size * 0.72) / 2.0,
            label_size + 1.0,
            font,
            parse_color("1F2937")?,
        )?;
    }
    Ok(())
}

/// A PDF field is a box with no caption of its own. A form whose fields were named but never labelled reaches the reader
/// as blank rectangles, so the label each field declares is drawn above its box, then the field is added and its
/// appearance drawn.
pub fn draw_form_fields(flow: &mut Flow, fields: &[Value]) -> WriterResult<()> {
    let font = flow.font.clone();
    let form_font = FormFont { font: font.font.clone(), reference: font.reference };
    let mut form = PdfForm::new();
    for field in fields {
        if let Some(page) = page_index(flow, field) {
            draw_field_labels(flow, &font, field, page)?;
        }
        let mut control = field.clone();
        if let Value::Object(map) = &mut control {
            map.remove("labelBeside");
        }
        add_form_field(&mut form, &mut flow.document, &control, Some(&form_font))?;
    }
    if !fields.is_empty() {
        form.update_field_appearances(&mut flow.document, Some(&form_font))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_field_block_declares_its_type_and_keeps_the_keys_a_field_takes() {
        let spec = field_spec(&json!({ "type": "field", "name": "n", "fieldType": "Checkbox", "after": 3, "label": "L" }));
        assert_eq!(spec, json!({ "type": "checkbox", "name": "n", "label": "L" }));
        assert_eq!(field_spec(&json!({ "type": "field", "name": "n" }))["type"], "text");
        assert_eq!(field_spec(&json!({ "type": "fieldRow" }))["type"], "text");
        assert_eq!(field_spec(&json!({ "name": "n", "type": "radio" }))["type"], "radio");
    }

    #[test]
    fn a_field_row_takes_its_objects() {
        let block = json!({ "type": "fieldRow", "items": [{ "name": "a" }, null, 3, { "name": "b", "type": "dropdown" }] });
        let specs = field_specs(&block, "fieldRow");
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[1]["type"], "dropdown");
        assert_eq!(flowed_field_specs(&[block, json!({ "type": "paragraph", "text": "t" })]).len(), 2);
    }

    #[test]
    fn marks_and_question_groups_are_told_from_typed_boxes() {
        assert!(is_mark_field(&json!({ "type": "checkbox" })));
        assert!(is_mark_field(&json!({ "type": "radio" })));
        assert!(!is_mark_field(&json!({ "type": "checkbox", "width": 80 })));
        let group = json!({ "type": "radio", "options": ["a", "b"] });
        assert!(is_choice_group(&group));
        assert!(!is_mark_field(&group));
        assert!(!is_choice_group(&json!({ "type": "radio", "options": [] })));
    }

    #[test]
    fn a_row_of_marks_is_as_tall_as_a_mark_and_a_typed_row_has_a_caption_band() {
        let marks = [json!({ "type": "checkbox", "label": "x" })];
        assert_eq!(field_row_geometry(&json!({}), &marks), (9.0, 18.0, 0.0));
        let typed = [json!({ "type": "text", "label": "Name" })];
        assert_eq!(field_row_geometry(&json!({ "labelSize": 10 }), &typed), (10.0, 22.0, 10.0 * 1.7));
        assert_eq!(field_row_geometry(&json!({ "height": 30 }), &typed).1, 30.0);
        assert_eq!(field_block_height(&json!({ "type": "field", "name": "n", "label": "N" })), 22.0 + 9.0 * 1.7);
        assert_eq!(field_block_height(&json!({ "type": "paragraph", "text": "t" })), 0.0);
    }

    fn flow() -> Flow {
        use mixdog_pdf::Ref;
        use mixdog_pdf::embed::{Font, StandardFontName};
        use mixdog_pdf::write::PdfDocument;
        let face = |key: &str, name, number| Face { font: Font::standard(name), key: key.to_owned(), reference: Ref::new(number, 0) };
        let (font, bold) = (face("F1", StandardFontName::Helvetica, 1), face("F2", StandardFontName::HelveticaBold, 2));
        Flow::new(PdfDocument::create(), [595.0, 842.0], 54.0, font, bold, None, None).unwrap()
    }

    fn row() -> Value {
        json!({ "type": "fieldRow", "items": [
            { "name": "a", "label": "A" },
            { "type": "checkbox", "name": "c", "label": "C" },
            { "type": "radio", "name": "r", "options": [{ "value": "x", "label": "X" }, { "value": "y", "label": "Y" }] }
        ] })
    }

    #[test]
    fn a_field_row_is_placed_in_equal_shares_with_marks_and_questions_on_the_mark_line() {
        let mut flow = flow();
        place_field_block(&mut flow, &row(), TextBox { left: 54.0, width: 487.0 }, "fieldRow", None).unwrap();
        let top = 842.0 - 54.0 - 9.0 * 1.7;
        let share = (487.0 - 24.0) / 3.0;
        let [typed, mark, group] = &flow.resolved_fields[..] else { panic!("three fields") };
        assert_eq!((typed["page"].as_f64(), typed["x"].as_f64(), typed["y"].as_f64()), (Some(0.0), Some(54.0), Some(top - 22.0)));
        assert_eq!((typed["width"].as_f64(), typed["height"].as_f64()), (Some(share), Some(22.0)));
        assert_eq!((mark["x"].as_f64(), mark["y"].as_f64()), (Some(54.0 + (share + 12.0)), Some(top - 22.0 + 4.0)));
        assert_eq!((mark["width"].as_f64(), mark["height"].as_f64(), &mark["labelBeside"]), (Some(14.0), Some(14.0), &json!(true)));
        let options = group["options"].as_array().expect("options");
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["x"], group["x"]);
        assert!(options[1]["x"].as_f64() > options[0]["x"].as_f64());
        assert!((flow.y - (top - 22.0 - 14.0)).abs() < 1e-9);
    }

    #[test]
    fn labels_are_drawn_above_boxes_and_beside_marks_and_options() {
        let mut flow = flow();
        place_field_block(&mut flow, &row(), TextBox { left: 54.0, width: 487.0 }, "fieldRow", None).unwrap();
        let fields = flow.resolved_fields.clone();
        draw_form_fields(&mut flow, &fields).unwrap();
        let content = &flow.pages[0].content;
        for label in ["<41> Tj", "<43> Tj", "<58> Tj", "<59> Tj"] {
            assert_eq!(content.matches(label).count(), 1, "{label}");
        }
        assert_eq!(content.matches(" Tj\n").count(), 4, "one text for each label and option, nothing else");
    }
}
