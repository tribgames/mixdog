//! `fillFormValues` and `clippedFormValues` of `pdf-forms.mjs`: values set by field name, and the report of the values
//! a widget cannot show in full.

use mixdog_js::math::round;
use mixdog_js::{js_object_keys, js_to_lowercase, js_trim, number_to_string, slice_utf16, to_number, utf16_len, value_to_string};
use mixdog_pdf::embed::Font;
use mixdog_pdf::write::PdfDocument;
use serde_json::{Map, Value};

use super::appearance::greedy_line_count;
use super::{
    FLAG_EDIT, FLAG_MULTILINE, Field, FieldKind, FormError, FormResult, PdfForm, border_style_width, choice_options, radio_options, widget_rectangle,
    widgets_of,
};

/// The words that leave a check box unchecked.
const CHECKBOX_OFF: [&str; 7] = ["", "false", "0", "no", "off", "/off", "unchecked"];

/// `checkboxOn(value)`: a boolean as it is, a number unless it is 0, nothing is off, and a text is on unless it says off.
pub(crate) fn checkbox_on(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(_)) => to_number(value.unwrap_or(&Value::Null)) != 0.0,
        Some(other) => {
            let text = js_to_lowercase(js_trim(&value_to_string(other)));
            !CHECKBOX_OFF.contains(&text.as_str())
        }
    }
}

/// `choiceValues(value)`: one value or a list, each as text with a leading slash removed.
pub(crate) fn choice_values_of(value: &Value) -> Vec<String> {
    let entry = |entry: &Value| {
        let text = if entry.is_null() { String::new() } else { value_to_string(entry) };
        text.strip_prefix('/').map_or_else(|| text.clone(), str::to_owned)
    };
    match value {
        Value::Array(items) => items.iter().map(entry).collect(),
        other => vec![entry(other)],
    }
}

/// `Object.entries(values || {})`: the pairs of an object in the order JavaScript lists them; anything else has none.
fn entries(values: &Value) -> Vec<(&String, &Value)> {
    match values {
        Value::Object(map) => js_object_keys(map).into_iter().filter_map(|key| map.get(key).map(|value| (key, value))).collect(),
        _ => Vec::new(),
    }
}

fn list_or_none(items: &[String]) -> String {
    if items.is_empty() { "(none)".to_owned() } else { items.join(", ") }
}

/// Sets every value by field name; an unknown name or option fails with what exists. Returns the names filled.
pub fn fill_form_values(form: &mut PdfForm, doc: &mut PdfDocument, values: &Value) -> FormResult<Vec<String>> {
    let fields = form.fields(doc)?;
    let mut by_name: Vec<(String, Field)> = Vec::new();
    for field in fields {
        let name = super::field_name(doc.store(), field.reference);
        match by_name.iter_mut().find(|(existing, _)| *existing == name) {
            Some(slot) => slot.1 = field,
            None => by_name.push((name, field)),
        }
    }
    let wanted = entries(values);
    let missing: Vec<String> =
        wanted.iter().filter(|(name, _)| !by_name.iter().any(|(existing, _)| existing == *name)).map(|(name, _)| (*name).clone()).collect();
    if !missing.is_empty() {
        let known: Vec<String> = by_name.iter().map(|(name, _)| name.clone()).collect();
        return Err(FormError::new(format!("PDF form has no field named {}; fields: {}", missing.join(", "), list_or_none(&known))));
    }
    let mut filled = Vec::new();
    for (name, value) in wanted {
        let field = by_name.iter().find(|(existing, _)| existing == name).map(|(_, field)| *field);
        let Some(field) = field else {
            continue;
        };
        match field.kind {
            FieldKind::Checkbox => {
                if checkbox_on(Some(value)) {
                    form.check(doc, &field)?;
                } else {
                    form.uncheck(doc, &field)?;
                }
            }
            FieldKind::Radio | FieldKind::Dropdown | FieldKind::OptionList => {
                let options: Vec<String> = if field.kind == FieldKind::Radio {
                    radio_options(doc.store(), field.reference)?
                } else {
                    choice_options(doc.store(), field.reference)?.into_iter().map(|(_, display)| display).collect()
                };
                let chosen = choice_values_of(value);
                let unknown: Vec<String> = chosen.iter().filter(|entry| !options.contains(entry)).cloned().collect();
                let editable = super::has_flag(doc.store(), field.reference, FLAG_EDIT);
                if !unknown.is_empty() && !(field.kind == FieldKind::Dropdown && editable) {
                    return Err(FormError::new(format!("Field {name} has no option {}; options: {}", unknown.join(", "), list_or_none(&options))));
                }
                if field.kind == FieldKind::Radio {
                    let first = chosen.first().ok_or_else(|| FormError::new("`option` must be of type `string`, but was actually of type `undefined`"))?;
                    form.select_radio(doc, &field, first)?;
                } else {
                    if chosen.is_empty() && field.kind == FieldKind::Dropdown {
                        return Err(FormError::new("`options` must be of type `string` or `Array`, but was actually of type `undefined`"));
                    }
                    form.select_choice(doc, &field, &chosen)?;
                }
            }
            FieldKind::Text => {
                let text = if value.is_null() { String::new() } else { value_to_string(value) };
                form.set_text(doc, &field, Some(&text))?;
            }
            FieldKind::Signature | FieldKind::Button => {
                return Err(FormError::new(format!("Field {name} is a {} field and cannot be filled", field.kind.name())));
            }
        }
        filled.push(name.clone());
    }
    Ok(filled)
}

fn clipped_entry(name: &str, reason: &str, needs: f64, available: f64, message: String) -> Value {
    let mut map = Map::new();
    map.insert("field".into(), Value::String(name.to_owned()));
    map.insert("reason".into(), Value::String(reason.to_owned()));
    map.insert("needs".into(), mixdog_js::json_number(round(needs)));
    map.insert("box".into(), mixdog_js::json_number(round(available)));
    map.insert("message".into(), Value::String(message));
    Value::Object(map)
}

/// Values a widget cannot show. The value is set as the string it was given and the widget clips what does not fit, so
/// a form reads as filled while the reader sees half a value: the caller has to be told in the same turn. A value
/// is measured against the first widget of its text field, at the size its appearance was drawn with, inside the 2 pt
/// inset plus the border; a multiline value is wrapped greedily at its spaces.
pub fn clipped_form_values(form: &PdfForm, doc: &mut PdfDocument, values: &Value, font: Option<&Font>) -> FormResult<Vec<Value>> {
    let Some(font) = font else {
        return Ok(Vec::new());
    };
    let mut clipped = Vec::new();
    for (name, value) in entries(values) {
        let Ok(field) = form.field(doc, name) else {
            continue;
        };
        if field.kind != FieldKind::Text {
            continue;
        }
        let text = if value.is_null() { String::new() } else { value_to_string(value) };
        if js_trim(&text).is_empty() {
            continue;
        }
        let widgets = widgets_of(doc.store(), field.reference)?;
        let Some(widget) = widgets.first() else {
            continue;
        };
        let rectangle = widget_rectangle(doc.store(), widget)?;
        let size = PdfForm::appearance_font_size(doc, &field, widget);
        if size == 0.0 || size.is_nan() {
            continue;
        }
        let inset = 2.0 + border_style_width(doc.store(), widget).unwrap_or(1.0);
        let usable_width = (rectangle.width - inset * 2.0).max(1.0);
        let usable_height = (rectangle.height - inset * 2.0).max(1.0);
        let multiline = super::has_flag(doc.store(), field.reference, FLAG_MULTILINE);
        if !multiline {
            let needed = font.width_of_text_at_size(&text, size)?;
            if needed <= usable_width + 0.5 {
                continue;
            }
            let shown = if utf16_len(&text) > 24 { format!("{}…", slice_utf16(&text, 24)) } else { text.clone() };
            clipped.push(clipped_entry(
                name,
                "width",
                needed,
                usable_width,
                format!(
                    "\"{shown}\" needs about {}pt at {}pt but the {name} box offers {}pt, so the end of the value is cut.",
                    number_to_string(round(needed)),
                    number_to_string(size),
                    number_to_string(round(usable_width))
                ),
            ));
            continue;
        }
        let lines = greedy_line_count(&text, font, size, usable_width)?;
        let needed = lines as f64 * size * 1.2;
        if needed <= usable_height + 0.5 {
            continue;
        }
        clipped.push(clipped_entry(
            name,
            "height",
            needed,
            usable_height,
            format!(
                "The {name} value wraps to {lines} line(s) needing about {}pt at {}pt but the box offers {}pt, so the last lines are cut.",
                number_to_string(round(needed)),
                number_to_string(size),
                number_to_string(round(usable_height))
            ),
        ));
    }
    Ok(clipped)
}
