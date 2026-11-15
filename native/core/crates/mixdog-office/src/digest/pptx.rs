//! The PowerPoint digest: the portable reader's shapes and slides, and PowerPoint (COM)'s, which report every property
//! the object model has (null facets, the MSO "mixed" sentinel, an invisible shadow, single-precision points).

use mixdog_js::{to_number, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::Value;

use super::common::{
    MSO_UNDEFINED, Object, digest_object_with, entries, filtered, is_bool, is_number, is_str, is_truthy, number_truthy, remove,
    round2, round_all, strict_equals,
};

/// A shape's run summary lists every size, face and colour its runs use; when the runs agree it holds one value, the
/// one its `font` already states.
const RUN_SUMMARY: [(&str, &str); 3] = [("sizes", "size"), ("fonts", "name"), ("colors", "color")];

/// Excel's chart kinds by the name the portable reader and add_chart use; a kind outside this list keeps its number.
fn chart_type_name(value: &Value) -> Value {
    let Value::Number(number) = value else { return value.clone() };
    let Some(kind) = number.as_f64().filter(|kind| kind.fract() == 0.0 && kind.abs() < 1e9) else { return value.clone() };
    let name = match kind as i64 {
        51 => "column",
        52 => "stacked_column",
        53 => "stacked_column_100",
        57 => "bar",
        58 => "stacked_bar",
        59 => "stacked_bar_100",
        4 | 65 => "line",
        1 => "area",
        76 => "stacked_area",
        5 => "pie",
        -4120 => "doughnut",
        -4169 => "scatter",
        15 => "bubble",
        -4151 => "radar",
        _ => return value.clone(),
    };
    Value::from(name)
}

/// A series on the primary axis with no name formula, trendline, error bars or labels says so by omission.
fn quiet_series_entry(key: &str, value: &Value) -> bool {
    match key {
        "formula" => is_str(Some(value), ""),
        "axisGroup" => is_number(Some(value), 1.0),
        "trendlineCount" => is_number(Some(value), 0.0),
        "hasErrorBars" | "hasDataLabels" => is_bool(Some(value), false),
        "dataLabels" => value.is_null(),
        _ => false,
    }
}

fn com_series_digest(entry: &Object) -> Object {
    let mut digest = filtered(entry, |key, value| !quiet_series_entry(key, value));
    if let Some(kind) = entry.get("chartType") {
        digest.insert("chartType".to_owned(), chart_type_name(kind));
    }
    digest
}

/// `bgrHex`: the three low bytes of a COM colour (blue, green, red), as the upper-case hex of red, green, blue.
fn bgr_hex(value: &Value) -> String {
    let number = to_number(value);
    let int32 = if number.is_finite() { number.trunc().rem_euclid(4_294_967_296.0) as u32 as i32 } else { 0 };
    let part = |shift: u32| (int32 >> shift) & 0xff;
    format!("{:02X}{:02X}{:02X}", part(0), part(8), part(16))
}

/// PowerPoint's own defaults say nothing: the inset every new box gets (7.2 pt sides, 3.6 pt top and bottom) and no space
/// between paragraphs.
fn default_text_frame_entry(key: &str, value: &Value) -> bool {
    let default = match key {
        "marginLeft" | "marginRight" => 7.2,
        "marginTop" | "marginBottom" => 3.6,
        "paragraphSpacing" => 0.0,
        _ => return false,
    };
    is_number(Some(value), default)
}

fn com_shape_digest(shape: &Object) -> Object {
    let mut digest = Object::new();
    for (key, value) in entries(shape) {
        if value.is_null() || value.as_f64() == Some(MSO_UNDEFINED) {
            continue;
        }
        let kept = if matches!(key.as_str(), "left" | "top" | "width" | "height" | "rotation") { round2(value) } else { value.clone() };
        digest.insert(key.clone(), kept);
    }
    // A chart, table or picture holds no text of its own: its empty frame, zero bounds and blank face say nothing.
    if digest.get("text").is_none_or(|text| is_str(Some(text), "")) {
        remove(&mut digest, "textFrame");
        remove(&mut digest, "textBounds");
        let blank_font = digest
            .get("font")
            .is_some_and(|font| truthy(font) && !is_truthy(font.get("name")) && !number_truthy(font.get("size")));
        if blank_font {
            remove(&mut digest, "font");
        }
    }
    if let Some(Value::Object(chart)) = digest.get("chart") {
        let mut chart = chart.clone();
        if let Some(kind) = chart.get("chartType").cloned() {
            chart.insert("chartType".to_owned(), chart_type_name(&kind));
        }
        if let Some(Value::Array(series)) = chart.get("series").cloned() {
            let series = series.iter().map(|entry| digest_object_with(entry, com_series_digest)).collect();
            chart.insert("series".to_owned(), Value::Array(series));
        }
        digest.insert("chart".to_owned(), Value::Object(chart));
    }
    for key in ["textBounds", "textFrame"] {
        if let Some(Value::Object(object)) = digest.get(key) {
            let rounded = round_all(object);
            digest.insert(key.to_owned(), Value::Object(rounded));
        }
    }
    if let Some(Value::Object(shadow)) = digest.get("shadow") {
        if is_truthy(shadow.get("visible")) {
            let rounded = round_all(shadow);
            digest.insert("shadow".to_owned(), Value::Object(rounded));
        } else {
            remove(&mut digest, "shadow");
        }
    }
    if is_bool(digest.get("fillVisible"), false) {
        for key in ["fillColor", "fillTransparency", "fillVisible"] {
            remove(&mut digest, key);
        }
    }
    if is_bool(digest.get("lineVisible"), false) {
        for key in ["lineColor", "lineTransparency", "lineVisible"] {
            remove(&mut digest, key);
        }
    }
    // An upright shape, a text box with no preset, the default inset, no space between paragraphs, and a face that is
    // neither bold nor italic: the portable reader reports none of them either.
    if is_number(digest.get("rotation"), 0.0) {
        remove(&mut digest, "rotation");
    }
    if is_str(digest.get("geometry"), "") {
        remove(&mut digest, "geometry");
    }
    if let Some(Value::Object(frame)) = digest.get("textFrame") {
        let frame = filtered(frame, |key, value| !default_text_frame_entry(key, value));
        if frame.is_empty() {
            remove(&mut digest, "textFrame");
        } else {
            digest.insert("textFrame".to_owned(), Value::Object(frame));
        }
    }
    if let Some(Value::Object(font)) = digest.get("font") {
        let font = filtered(font, |key, value| {
            !(matches!(key, "bold" | "italic" | "underline") && (is_number(Some(value), 0.0) || is_bool(Some(value), false)))
        });
        digest.insert("font".to_owned(), Value::Object(font));
    }
    if let Some(Value::Object(runs)) = digest.get("runs") {
        let mut rest = runs.clone();
        let font = digest.get("font");
        let size = font.and_then(|font| font.get("size"));
        if matches!(rest.get("sizes"), Some(Value::Array(sizes)) if sizes.len() == 1 && strict_equals(sizes.first(), size)) {
            remove(&mut rest, "sizes");
        }
        let color = match font.and_then(|font| font.get("color")) {
            Some(color) if truthy(color) => value_to_string(color).to_uppercase(),
            _ => String::new(),
        };
        if matches!(rest.get("colors"), Some(Value::Array(colors)) if colors.len() == 1 && bgr_hex(&colors[0]) == color) {
            remove(&mut rest, "colors");
        }
        if rest.is_empty() {
            remove(&mut digest, "runs");
        } else {
            digest.insert("runs".to_owned(), Value::Object(rest));
        }
    }
    digest
}

/// A COM slide's empty notes, comment and animation lists and an untimed transition with no effect read the same as
/// absent.
fn com_slide_digest(slide: &Object) -> Object {
    let mut digest = Object::new();
    for (key, value) in entries(slide) {
        let empty = is_str(Some(value), "") || value.is_null() || matches!(value, Value::Array(items) if items.is_empty());
        // notes is the backend contract's string on every slide, empty or not, as the portable reader reports it.
        if key != "notes" && empty {
            continue;
        }
        digest.insert(key.clone(), value.clone());
    }
    let untimed = digest.get("transition").is_some_and(|transition| {
        truthy(transition) && !is_truthy(transition.get("effect")) && !is_truthy(transition.get("advanceOnTime"))
    });
    if untimed {
        remove(&mut digest, "transition");
    }
    digest
}

fn shape_digest(shape: &Value) -> Value {
    let Value::Object(map) = shape else { return shape.clone() };
    if matches!(map.get("type"), Some(Value::Number(_))) {
        return Value::Object(com_shape_digest(map));
    }
    let Some(font) = map.get("font").filter(|font| truthy(font)) else { return shape.clone() };
    let mut digest = map.clone();
    for (list, key) in RUN_SUMMARY {
        if matches!(map.get(list), Some(Value::Array(values)) if values.len() == 1 && strict_equals(values.first(), font.get(key))) {
            remove(&mut digest, list);
        }
    }
    Value::Object(digest)
}

fn slide_digest(slide: &Value) -> Value {
    let Value::Object(map) = slide else { return slide.clone() };
    let Some(Value::Array(shapes)) = map.get("shapes") else { return slide.clone() };
    // A PowerPoint (COM) slide names its shapes' kinds by number and carries a transition; one without shapes is known by
    // the transition and animation lists only it reports.
    let com = shapes.iter().any(|shape| matches!(shape.get("type"), Some(Value::Number(_))))
        || (map.contains_key("transition") && matches!(map.get("animations"), Some(Value::Array(_))));
    let mut shaped = map.clone();
    // A shown slide says so by omission; a hidden one is withheld from the show and keeps the flag.
    if !is_truthy(map.get("hidden")) {
        remove(&mut shaped, "hidden");
    }
    shaped.insert("shapes".to_owned(), Value::Array(shapes.iter().map(shape_digest).collect()));
    Value::Object(if com { com_slide_digest(&shaped) } else { shaped })
}

fn layout_digest(position: usize, layout: &Value) -> Value {
    let Value::Object(layout) = layout else { return layout.clone() };
    let mut kept = Object::new();
    let index = match layout.get("index") {
        Some(index) if !index.is_null() => index.clone(),
        _ => Value::from(position + 1),
    };
    kept.insert("index".to_owned(), index);
    if let Some(name) = layout.get("name") {
        kept.insert("name".to_owned(), name.clone());
    }
    Value::Object(kept)
}

/// The deck a model reads. `add_slide` names a layout by its name or position; the part it lives in and a path built from
/// that same position repeat what the runtime resolves itself, on every one of a template's dozens of layouts.
pub fn pptx_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    if !is_str(map.get("format"), "pptx") {
        return document.clone();
    }
    let Some(Value::Array(slides)) = map.get("slides") else { return document.clone() };
    let mut digest = map.clone();
    if let Some(Value::Array(layouts)) = map.get("layouts") {
        let layouts = layouts.iter().enumerate().map(|(position, layout)| layout_digest(position, layout)).collect();
        digest.insert("layouts".to_owned(), Value::Array(layouts));
    }
    digest.insert("slides".to_owned(), Value::Array(slides.iter().map(slide_digest).collect()));
    Value::Object(digest)
}
