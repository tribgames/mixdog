//! `addFormField` and `fieldText` of `pdf-forms.mjs`: a field of the form is made with its widget, border, colours,
//! flags and tooltip, over the form model of [`super`] the way pdf-lib's `PDFForm.create*` and `addToPage` make one.

use std::sync::Arc;

use mixdog_js::math::floor;
use mixdog_js::{js_to_lowercase, js_trim, to_number_of, value_to_string};
use mixdog_pdf::author::draw::parse_color;
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::{Dict, Obj, Ref};
use serde_json::Value;

use super::appearance::{Color, draw_new_widget};
use super::fill::{checkbox_on, choice_values_of};
use super::lint::truthy;
use super::{
    ANNOT_PRINT, FLAG_COMBO, FLAG_RADIO, FLAG_RADIOS_IN_UNISON, FLAG_READ_ONLY, FLAG_REQUIRED, Field, FieldKind, FormError, FormFont, FormResult, PdfForm,
    default_appearance, delete_key, has_flag, is_non_terminal, latin1_object, partial_name, push_array, set_flag_to, set_key, text_object, widget_on_value,
    widgets_of,
};
use super::{FLAG_EDIT, FLAG_MULTI_SELECT};

/// A text box at least this tall is a box for a paragraph: two lines of 11 pt body text with the box's insets. Left
/// single-line, an answer set at the box's height (35 pt in a 60 pt box) was cut at the right edge.
const MULTILINE_MIN_HEIGHT: f64 = 40.0;

/// `String(value)`: `undefined` for a missing one.
fn js_string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `Number(value ?? fallback)`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    if nullish(value) { fallback } else { to_number_of(value) }
}

/// Every string a field carries, so the writer can pick a font that covers it: its value, its caption and the words of
/// its options.
pub fn field_text(field: &Value) -> String {
    let get = |key: &str| field.get(key);
    let shown = |value: Option<&Value>| if nullish(value) { String::new() } else { js_string(value) };
    let mut parts = vec![shown(get("value")), shown(get("label"))];
    if let Some(Value::Array(options)) = get("options") {
        for option in options {
            let pick = ["value", "label"].iter().filter_map(|key| option.get(key)).find(|entry| !entry.is_null());
            parts.push(shown(Some(pick.unwrap_or(option))));
        }
    }
    parts.join(" ")
}

fn colour(value: Option<&Value>, fallback: &str) -> FormResult<[f64; 3]> {
    let text = match value {
        Some(value) if truthy(Some(value)) => value_to_string(value),
        _ => fallback.to_owned(),
    };
    parse_color(&text).map_err(FormError::new)
}

fn numbers(values: &[f64]) -> Obj {
    Obj::Array(Arc::new(values.iter().map(|value| Obj::Num(*value)).collect()))
}

// making the field

fn split_field_name(name: &str) -> FormResult<(Vec<String>, String)> {
    if name.is_empty() {
        return Err(FormError::new("PDF field names must not be empty strings"));
    }
    let mut parts: Vec<String> = name.split('.').map(str::to_owned).collect();
    if parts.iter().any(String::is_empty) {
        return Err(FormError::new(format!("Periods in PDF field names must be separated by at least one character: \"{name}\"")));
    }
    let terminal = parts.pop().unwrap_or_default();
    Ok((parts, terminal))
}

/// The fields and non-terminal nodes under the form (`Fields`) or a node (`Kids`).
fn children(store: &ObjectStore, parent: Ref, is_form: bool) -> Vec<Ref> {
    let key = if is_form { "Fields" } else { "Kids" };
    let Some(dict) = store.dict(parent) else {
        return Vec::new();
    };
    match store.lookup(dict, key) {
        Some(Obj::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Obj::Ref(reference) if store.dict(*reference).is_some() => Some(*reference),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn already_exists(name: &str) -> FormError {
    FormError::new(format!("A field already exists with the specified name: \"{name}\""))
}

/// `findOrCreateNonTerminals`: the node the dotted parts of a name lead to, made where it does not exist.
fn find_or_create_non_terminals(store: &mut ObjectStore, form: Ref, parts: &[String]) -> FormResult<(Ref, bool)> {
    let mut parent = form;
    let mut is_form = true;
    for part in parts {
        if part.is_empty() {
            return Err(FormError::new(format!("Field name contains invalid component: \"{part}\"")));
        }
        let mut found = None;
        for child in children(store, parent, is_form) {
            if partial_name(store, child).as_deref() == Some(part.as_str()) {
                let non_terminal = store.dict(child).is_some_and(|dict| is_non_terminal(store, dict));
                if !non_terminal {
                    return Err(already_exists(part));
                }
                found = Some(child);
                break;
            }
        }
        parent = match found {
            Some(child) => child,
            None => {
                let mut node = Dict::new();
                node.set("Kids", Obj::Array(Arc::new(Vec::new())));
                node.set("T", text_object(part));
                if !is_form {
                    node.set("Parent", Obj::Ref(parent));
                }
                let reference = store.register(Obj::Dict(Arc::new(node)));
                push_array(store, parent, if is_form { "Fields" } else { "Kids" }, Obj::Ref(reference));
                reference
            }
        };
        is_form = false;
    }
    Ok((parent, is_form))
}

/// `form.createCheckBox` and its siblings: an empty field of `kind` named `name`, added to the form.
fn create_field(form: &PdfForm, doc: &mut PdfDocument, kind: FieldKind, name: &str) -> FormResult<Field> {
    let (non_terminal, terminal) = split_field_name(name)?;
    let form_ref = form.acro_form(doc)?;
    let store = doc.store_mut();
    let (parent, parent_is_form) = find_or_create_non_terminals(store, form_ref, &non_terminal)?;
    let mut dict = Dict::new();
    let field_type = match kind {
        FieldKind::Checkbox | FieldKind::Radio => "Btn",
        FieldKind::Dropdown | FieldKind::OptionList => "Ch",
        _ => "Tx",
    };
    dict.set("FT", Obj::name(field_type));
    match kind {
        FieldKind::Radio => dict.set("Ff", Obj::Num(FLAG_RADIO as f64)),
        FieldKind::Dropdown => dict.set("Ff", Obj::Num(FLAG_COMBO as f64)),
        _ => {}
    }
    dict.set("Kids", Obj::Array(Arc::new(Vec::new())));
    let reference = store.register(Obj::Dict(Arc::new(dict)));
    set_key(store, reference, "T", text_object(&terminal));
    if children(store, parent, parent_is_form).into_iter().any(|child| partial_name(store, child).as_deref() == Some(terminal.as_str())) {
        return Err(already_exists(&terminal));
    }
    push_array(store, parent, if parent_is_form { "Fields" } else { "Kids" }, Obj::Ref(reference));
    if parent_is_form {
        delete_key(store, reference, "Parent");
    } else {
        set_key(store, reference, "Parent", Obj::Ref(parent));
    }
    Ok(Field { reference, kind })
}

/// The look of a widget (`FieldAppearanceOptions` of one widget).
#[derive(Clone)]
struct WidgetSpec {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    text_color: [f64; 3],
    background: [f64; 3],
    border_color: [f64; 3],
    border_width: f64,
}

/// `PDFField.createWidget` with the widget registered: its rectangle, `MK`, border style and print flag, and the text
/// colour added to the field's default appearance. It is not yet a kid of the field.
fn new_widget(store: &mut ObjectStore, field: Ref, spec: &WidgetSpec, page: Ref) -> Ref {
    let half = spec.border_width / 2.0;
    let width = spec.width + spec.border_width;
    let height = spec.height + spec.border_width;
    let (x, y) = (spec.x - half, spec.y - half);
    let mut mk = Dict::new();
    mk.set("BG", numbers(&spec.background));
    mk.set("R", Obj::Num(0.0));
    mk.set("BC", numbers(&spec.border_color));
    let mut border = Dict::new();
    border.set("W", Obj::Num(spec.border_width));
    let mut dict = Dict::new();
    dict.set("Type", Obj::name("Annot"));
    dict.set("Subtype", Obj::name("Widget"));
    dict.set("Rect", numbers(&[x, y, x + width, y + height]));
    dict.set("Parent", Obj::Ref(field));
    dict.set("P", Obj::Ref(page));
    dict.set("MK", Obj::Dict(Arc::new(mk)));
    dict.set("BS", Obj::Dict(Arc::new(border)));
    dict.set("F", Obj::Num(ANNOT_PRINT as f64));
    let reference = store.register(Obj::Dict(Arc::new(dict)));
    let [r, g, b] = spec.text_color;
    let existing = store.dict(field).and_then(|dict| default_appearance(store, dict)).unwrap_or_default();
    let da = format!("{existing}\n{}", Color::Rgb(r, g, b).fill());
    set_key(store, field, "DA", latin1_object(&da));
    reference
}

/// `PDFAcroButton.addWidgetWithOpt`: the option is appended to the group's `Opt` (after the export values of the widgets
/// it already has, written out when they were only implied) and the widget becomes a kid. Returns the name the widget's
/// on appearance goes by.
fn add_radio_widget(store: &mut ObjectStore, field: Ref, widget: Ref, option: &str) -> FormResult<String> {
    let widgets = widgets_of(store, field)?;
    let existing: Vec<Obj> = match store.dict(field).and_then(|dict| store.lookup(dict, "Opt")) {
        Some(Obj::Str(bytes)) => vec![Obj::Str(bytes.clone())],
        Some(Obj::Array(items)) => items
            .iter()
            .filter_map(|item| match store.resolve(item) {
                Some(Obj::Str(bytes)) => Some(Obj::Str(bytes.clone())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut opt = Vec::new();
    for (index, existing_widget) in widgets.iter().enumerate() {
        let item = match existing.get(index) {
            Some(item) => item.clone(),
            None => text_object(&widget_on_value(store, existing_widget)?.unwrap_or_default()),
        };
        opt.push(item);
    }
    let existing_index = if has_flag(store, field, FLAG_RADIOS_IN_UNISON) {
        opt.iter()
            .enumerate()
            .filter(|(_, item)| matches!(item, Obj::Str(bytes) if mixdog_pdf::write::info::decode_text_string(bytes) == option))
            .map(|(index, _)| index)
            .last()
    } else {
        None
    };
    opt.push(text_object(option));
    let index = existing_index.unwrap_or(opt.len() - 1);
    set_key(store, field, "Opt", Obj::Array(Arc::new(opt)));
    push_array(store, field, "Kids", Obj::Ref(widget));
    Ok(index.to_string())
}

fn string_options(field: &Value) -> FormResult<Vec<String>> {
    match field.get("options") {
        value if !truthy(value) => Ok(Vec::new()),
        Some(Value::Array(options)) => Ok(options.iter().map(value_to_string).collect()),
        _ => Err(FormError::new("(field.options || []).map is not a function")),
    }
}

/// What one `addFormField` call is making: the request, the name, the look and place of its widget and the face it is
/// drawn with.
struct NewField<'a> {
    request: &'a Value,
    name: &'a str,
    spec: &'a WidgetSpec,
    page: Ref,
    font: &'a FormFont,
}

impl NewField<'_> {
    fn get(&self, key: &str) -> Option<&Value> {
        self.request.get(key)
    }
}

/// Adds one field to the page it names. `font` is the face its appearance is drawn with: pdf-lib paints a widget
/// the moment it is added, so a dropdown or list whose options are Korean needs the embedded face here, not only at
/// save time (the default font, Helvetica, when none is given).
pub fn add_form_field(form: &mut PdfForm, doc: &mut PdfDocument, field: &Value, font: Option<&FormFont>) -> FormResult<()> {
    let get = |key: &str| field.get(key);
    // Named as every page operation names it, rather than pdf-lib's "`index` must be at most …".
    let asked = to_number_of(get("page"));
    let number = if asked.is_nan() || asked == 0.0 { 1.0 } else { asked.max(1.0) };
    if number.fract() != 0.0 || number > doc.page_count() as f64 {
        return Err(FormError::new(format!("PDF page out of range: {}", js_string(get("page")))));
    }
    let page = doc.pages()[number as usize - 1];
    let font = match font {
        Some(font) => font.clone(),
        None => form.default_font(doc)?,
    };
    let spec = WidgetSpec {
        x: to_number_of(get("x")),
        y: to_number_of(get("y")),
        width: to_number_of(get("width")),
        height: to_number_of(get("height")),
        text_color: colour(get("textColor"), "000000")?,
        background: colour(get("backgroundColor"), "FFFFFF")?,
        border_color: colour(get("borderColor"), "666666")?,
        border_width: number_or(get("borderWidth"), 1.0),
    };
    let name = js_string(get("name"));
    let field_type = js_to_lowercase(&if truthy(get("type")) { js_string(get("type")) } else { "text".to_owned() });
    let new = NewField { request: field, name: &name, spec: &spec, page, font: &font };
    let control = match field_type.as_str() {
        "checkbox" => add_checkbox(form, doc, &new)?,
        "dropdown" => add_dropdown(form, doc, &new)?,
        "optionlist" => add_option_list(form, doc, &new)?,
        "radio" => add_radio_group(form, doc, &new)?,
        _ => add_text_field(form, doc, &new)?,
    };
    if truthy(get("required")) {
        set_flag_to(doc.store_mut(), control.reference, FLAG_REQUIRED, true);
    }
    if truthy(get("readOnly")) {
        set_flag_to(doc.store_mut(), control.reference, FLAG_READ_ONLY, true);
    }
    let label = if nullish(get("label")) { String::new() } else { js_string(get("label")) };
    let label = js_trim(&label);
    if !label.is_empty() {
        set_key(doc.store_mut(), control.reference, "TU", text_object(label));
    }
    Ok(())
}

fn add_checkbox(form: &mut PdfForm, doc: &mut PdfDocument, new: &NewField<'_>) -> FormResult<Field> {
    let control = create_field(form, doc, FieldKind::Checkbox, new.name)?;
    let widget = new_widget(doc.store_mut(), control.reference, new.spec, new.page);
    push_array(doc.store_mut(), control.reference, "Kids", Obj::Ref(widget));
    set_key(doc.store_mut(), widget, "AS", Obj::name("Off"));
    draw_new_widget(doc, &control, widget, new.font, Some("Yes"))?;
    push_array(doc.store_mut(), new.page, "Annots", Obj::Ref(widget));
    if checkbox_on(new.get("value")) {
        form.check(doc, &control)?;
    }
    Ok(control)
}

fn add_dropdown(form: &mut PdfForm, doc: &mut PdfDocument, new: &NewField<'_>) -> FormResult<Field> {
    let control = create_field(form, doc, FieldKind::Dropdown, new.name)?;
    form.add_options(doc, &control, &string_options(new.request)?)?;
    add_text_widget(doc, &control, new.spec, new.page, new.font)?;
    if truthy(new.get("editable")) {
        form.set_choice_flag(doc, &control, FLAG_EDIT, true);
    }
    if !nullish(new.get("value")) {
        form.select_choice(doc, &control, &[js_string(new.get("value"))])?;
    }
    Ok(control)
}

fn add_option_list(form: &mut PdfForm, doc: &mut PdfDocument, new: &NewField<'_>) -> FormResult<Field> {
    let control = create_field(form, doc, FieldKind::OptionList, new.name)?;
    form.add_options(doc, &control, &string_options(new.request)?)?;
    add_text_widget(doc, &control, new.spec, new.page, new.font)?;
    let values = match new.get("value") {
        value if nullish(value) => Vec::new(),
        Some(value) => choice_values_of(value),
        None => Vec::new(),
    };
    if truthy(new.get("multiselect")) || values.len() > 1 {
        form.set_choice_flag(doc, &control, FLAG_MULTI_SELECT, true);
    }
    if !values.is_empty() {
        form.select_choice(doc, &control, &values)?;
    }
    Ok(control)
}

fn add_radio_group(form: &mut PdfForm, doc: &mut PdfDocument, new: &NewField<'_>) -> FormResult<Field> {
    let control = create_field(form, doc, FieldKind::Radio, new.name)?;
    if let Some(Value::Array(options)) = new.get("options").filter(|value| truthy(Some(*value))) {
        for option in options {
            let value = option.get("value").filter(|entry| !entry.is_null()).unwrap_or(option);
            let at = |key: &str| {
                let own = option.get(key).filter(|entry| !entry.is_null());
                to_number_of(own.or_else(|| new.get(key)))
            };
            let placed = WidgetSpec { x: at("x"), y: at("y"), ..new.spec.clone() };
            let widget = new_widget(doc.store_mut(), control.reference, &placed, new.page);
            let state = add_radio_widget(doc.store_mut(), control.reference, widget, &value_to_string(value))?;
            set_key(doc.store_mut(), widget, "AS", Obj::name("Off"));
            draw_new_widget(doc, &control, widget, new.font, Some(&state))?;
            push_array(doc.store_mut(), new.page, "Annots", Obj::Ref(widget));
        }
    }
    if !nullish(new.get("value")) {
        form.select_radio(doc, &control, &js_string(new.get("value")))?;
    }
    Ok(control)
}

fn add_text_field(form: &mut PdfForm, doc: &mut PdfDocument, new: &NewField<'_>) -> FormResult<Field> {
    let control = create_field(form, doc, FieldKind::Text, new.name)?;
    add_text_widget(doc, &control, new.spec, new.page, new.font)?;
    let multiline = match new.get("multiline") {
        Some(value) if !value.is_null() => truthy(Some(value)),
        _ => new.spec.height >= MULTILINE_MIN_HEIGHT,
    };
    if multiline {
        form.enable_multiline(doc, &control);
    }
    let max_length = to_number_of(new.get("maxLength"));
    if max_length > 0.0 {
        form.set_max_length(doc, &control, floor(max_length))?;
    }
    let font_size = to_number_of(new.get("fontSize"));
    if font_size > 0.0 {
        form.set_font_size(doc, &control, font_size)?;
    } else if multiline {
        form.set_font_size(doc, &control, 11.0)?;
    }
    if !nullish(new.get("value")) {
        form.set_text(doc, &control, Some(&js_string(new.get("value"))))?;
    }
    Ok(control)
}

/// `addToPage` of a text field, dropdown or option list: the widget, drawn with the font, on the page.
fn add_text_widget(doc: &mut PdfDocument, field: &Field, spec: &WidgetSpec, page: Ref, font: &FormFont) -> FormResult<()> {
    let widget = new_widget(doc.store_mut(), field.reference, spec, page);
    push_array(doc.store_mut(), field.reference, "Kids", Obj::Ref(widget));
    draw_new_widget(doc, field, widget, font, None)?;
    push_array(doc.store_mut(), page, "Annots", Obj::Ref(widget));
    Ok(())
}
