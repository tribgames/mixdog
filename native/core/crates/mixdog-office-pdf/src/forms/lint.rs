//! `lintPdfFormFields`, `minimumFieldSize` and `rectanglesOverlap` of `pdf-forms.mjs`: the checks a form's layout gets
//! before its fields are written, on fields as a caller states them (JSON objects of `x`, `y`, `width`, `height`,
//! `page`, `type` and `name`).

use mixdog_js::math::round;
use mixdog_js::{js_to_lowercase, json_number, number_to_string, to_number_of, value_to_string};
use serde_json::{Map, Value};

/// A page size when the page a field names is not in the list: A4.
const DEFAULT_PAGE: [f64; 2] = [595.28, 841.89];

/// A box a person cannot hit or read: 8 pt squares for marks, 24 x 12 pt for anything typed. The comparison carries a
/// hundredth of a point: a form's rectangle stored as 11.999 pt is the 12 pt box its author drew.
pub fn minimum_field_size(field_type: &str) -> [f64; 2] {
    if field_type == "checkbox" || field_type == "radio" { [8.0 - 0.01, 8.0 - 0.01] } else { [24.0 - 0.01, 12.0 - 0.01] }
}

/// Two rectangles (`x`, `y`, `width`, `height`) that share area.
pub fn rectangles_overlap(left: [f64; 4], right: [f64; 4]) -> bool {
    left[0] < right[0] + right[2] && left[0] + left[2] > right[0] && left[1] < right[1] + right[3] && left[1] + left[3] > right[1]
}

/// JavaScript truthiness of an optional value.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// A caller places a field the way a PDF reader reports one: a rectangle and a kind. Both spellings reach the box the
/// writer draws, so the field lands instead of failing as an empty one. Changes the field, as the source does.
pub fn adopt_form_field_shape(field: &mut Value) {
    let Some(map) = field.as_object_mut() else {
        return;
    };
    let rect = match (map.get("rect"), map.get("box")) {
        (Some(Value::Array(rect)), _) => Some(rect.clone()),
        (_, Some(Value::Array(rect))) => Some(rect.clone()),
        _ => None,
    };
    if let Some(rect) = rect {
        if rect.len() >= 4 && !map.contains_key("x") && !map.contains_key("y") {
            let numbers: Vec<f64> = rect.iter().map(|entry| to_number_of(Some(entry))).collect();
            map.insert("x".into(), json_number(numbers[0]));
            map.insert("y".into(), json_number(numbers[1]));
            map.insert("width".into(), json_number(numbers[2]));
            map.insert("height".into(), json_number(numbers[3]));
            map.shift_remove("rect");
            map.shift_remove("box");
        }
    }
    if map.contains_key("kind") && !map.contains_key("type") {
        if let Some(kind) = map.shift_remove("kind") {
            map.insert("type".into(), kind);
        }
    }
}

struct Normalized {
    index: usize,
    name: String,
    field_type: String,
    page: f64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Normalized {
    fn label(&self) -> String {
        if self.name.is_empty() { self.index.to_string() } else { self.name.clone() }
    }

    fn json(&self) -> Value {
        let mut map = Map::new();
        map.insert("index".into(), Value::from(self.index as u64));
        map.insert("name".into(), Value::String(self.name.clone()));
        map.insert("type".into(), Value::String(self.field_type.clone()));
        map.insert("page".into(), json_number(self.page));
        map.insert("x".into(), json_number(self.x));
        map.insert("y".into(), json_number(self.y));
        map.insert("width".into(), json_number(self.width));
        map.insert("height".into(), json_number(self.height));
        Value::Object(map)
    }

    fn rect(&self) -> [f64; 4] {
        [self.x, self.y, self.width, self.height]
    }
}

fn issue(severity: &str, code: &str, index: usize, message: String) -> Value {
    let mut map = Map::new();
    map.insert("severity".into(), Value::String(severity.to_owned()));
    map.insert("code".into(), Value::String(code.to_owned()));
    map.insert("path".into(), Value::String(format!("/field[{index}]")));
    map.insert("message".into(), Value::String(message));
    Value::Object(map)
}

fn normalize(index: usize, field: &Value) -> Normalized {
    let get = |key: &str| field.get(key);
    let name = if truthy(get("name")) { value_to_string(get("name").unwrap_or(&Value::Null)) } else { String::new() };
    let field_type = if truthy(get("type")) { value_to_string(get("type").unwrap_or(&Value::Null)) } else { "text".to_owned() };
    let page = to_number_of(get("page"));
    Normalized {
        index,
        name,
        field_type: js_to_lowercase(&field_type),
        page: if page.is_nan() || page == 0.0 { 1.0 } else { page.max(1.0) },
        x: to_number_of(get("x")),
        y: to_number_of(get("y")),
        width: to_number_of(get("width")),
        height: to_number_of(get("height")),
    }
}

/// `lintPdfFormFields(fields, pages)`: `pages` are the `[width, height]` of the document's pages. The result is
/// `{ ok, fields, issueCount, issues }`; the fields passed in are adopted into the `x`/`y`/`width`/`height`/`type`
/// shape first.
pub fn lint_pdf_form_fields(fields: &mut [Value], pages: &[[f64; 2]]) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    for field in fields.iter_mut() {
        adopt_form_field_shape(field);
    }
    let normalized: Vec<Normalized> = fields.iter().enumerate().map(|(at, field)| normalize(at + 1, field)).collect();
    let mut names: Vec<&str> = Vec::new();
    for field in &normalized {
        let page_at = field.page - 1.0;
        let listed = if page_at >= 0.0 && page_at.fract() == 0.0 { pages.get(page_at as usize).copied() } else { None };
        let size = listed.unwrap_or(DEFAULT_PAGE);
        if field.name.is_empty() {
            issues.push(issue("error", "missing_field_name", field.index, "Form field name is required.".to_owned()));
        }
        if names.contains(&field.name.as_str()) {
            issues.push(issue("error", "duplicate_field_name", field.index, format!("Duplicate form field name: {}", field.name)));
        }
        names.push(&field.name);
        let finite = [field.x, field.y, field.width, field.height].iter().all(|value| value.is_finite());
        if !finite || field.width <= 0.0 || field.height <= 0.0 {
            issues.push(issue(
                "error",
                "invalid_field_box",
                field.index,
                format!(
                    "Form field {} has no usable box: give x, y, width and height in points from the page's bottom-left corner (or rect: [x, y, width, height]).",
                    field.label()
                ),
            ));
        } else if field.x < 0.0 || field.y < 0.0 || field.x + field.width > size[0] || field.y + field.height > size[1] {
            issues.push(issue("error", "field_outside_page", field.index, format!("Form field is outside page {}.", number_to_string(field.page))));
        } else {
            let [min_width, min_height] = minimum_field_size(&field.field_type);
            if field.width < min_width || field.height < min_height {
                issues.push(issue(
                    "warning",
                    "field_too_small",
                    field.index,
                    format!(
                        "Form field {} is {} x {} pt; a {} field needs at least {} x {}.",
                        field.label(),
                        number_to_string(field.width),
                        number_to_string(field.height),
                        field.field_type,
                        number_to_string(round(min_width)),
                        number_to_string(round(min_height))
                    ),
                ));
            }
        }
    }
    for left in 0..normalized.len() {
        for right in left + 1..normalized.len() {
            let (a, b) = (&normalized[left], &normalized[right]);
            if a.page == b.page && rectangles_overlap(a.rect(), b.rect()) {
                issues.push(issue("warning", "overlapping_form_fields", a.index, format!("Form fields {} and {} overlap.", a.label(), b.label())));
            }
        }
    }
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(!issues.iter().any(|entry| entry["severity"] == "error")));
    result.insert("fields".into(), Value::Array(normalized.iter().map(Normalized::json).collect()));
    result.insert("issueCount".into(), Value::from(issues.len() as u64));
    result.insert("issues".into(), Value::Array(issues));
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mark_needs_8_points_and_a_typed_box_24_by_12() {
        assert_eq!(minimum_field_size("checkbox"), [8.0 - 0.01, 8.0 - 0.01]);
        assert_eq!(minimum_field_size("radio"), [8.0 - 0.01, 8.0 - 0.01]);
        assert_eq!(minimum_field_size("text"), [24.0 - 0.01, 12.0 - 0.01]);
    }

    #[test]
    fn rectangles_that_only_touch_do_not_overlap() {
        assert!(rectangles_overlap([0.0, 0.0, 10.0, 10.0], [9.0, 9.0, 10.0, 10.0]));
        assert!(!rectangles_overlap([0.0, 0.0, 10.0, 10.0], [10.0, 0.0, 10.0, 10.0]));
    }

    #[test]
    fn a_reader_shape_is_adopted() {
        let mut fields = vec![json!({ "name": "a", "rect": [1, 2, 30, 20], "kind": "checkbox" })];
        let result = lint_pdf_form_fields(&mut fields, &[[595.0, 842.0]]);
        assert_eq!(fields[0], json!({ "name": "a", "x": 1, "y": 2, "width": 30, "height": 20, "type": "checkbox" }));
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["issueCount"], json!(0));
    }

    #[test]
    fn missing_and_repeated_names_are_errors() {
        let mut fields = vec![json!({ "x": 1, "y": 1, "width": 50, "height": 20 }), json!({ "name": "", "x": 1, "y": 40, "width": 50, "height": 20 })];
        let result = lint_pdf_form_fields(&mut fields, &[]);
        let codes: Vec<&str> = result["issues"].as_array().expect("issues").iter().filter_map(|issue| issue["code"].as_str()).collect();
        assert_eq!(codes, ["missing_field_name", "missing_field_name", "duplicate_field_name"]);
        assert_eq!(result["ok"], json!(false));
    }
}
