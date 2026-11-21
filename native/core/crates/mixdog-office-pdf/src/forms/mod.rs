//! AcroForm fields of the office PDF backend, ported from `src/runtime/office/pdf/pdf-forms.mjs` over the form model of
//! pdf-lib 1.17.1 (`PDFForm`, `PDFField`, `PDFAcro*`, `PDFWidgetAnnotation`).
//!
//! A [`PdfForm`] is pdf-lib's `PDFForm` object: the fields that changed and have no appearance drawn yet and the default font
//! live in it, so a caller keeps one beside the document it edits. A widget written as a dictionary inside its parent's `Kids`
//! array (not an indirect object, which the PDF specification requires) is read but not rewritten.
//!
//! As pdf-lib embeds fonts when the file is saved, the reference of a [`FormFont`] is allocated here and the caller writes the
//! font to it (`Font::embed_into` with that target) before saving.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, LazyLock};

use mixdog_js::math::pow;
use mixdog_js::{JsRegex, is_js_space, json_number, number_to_string};
use mixdog_pdf::embed::{EmbedError, Font, StandardFontName, SuffixRng};
use mixdog_pdf::write::info::{decode_text_string, encode_text_string};
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::write::{PdfDocument, Rect};
use mixdog_pdf::{Dict, Obj, Ref};
use serde_json::{Map, Value};

pub mod appearance;
pub mod create;
pub mod fill;
pub mod lint;

pub use create::{add_form_field, field_text};
pub use fill::{clipped_form_values, fill_form_values};
pub use lint::{lint_pdf_form_fields, minimum_field_size, rectangles_overlap};

/// A refusal of the form code, with the text pdf-lib or `pdf-forms.mjs` gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormError(String);

impl FormError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FormError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<EmbedError> for FormError {
    fn from(error: EmbedError) -> Self {
        Self(error.to_string())
    }
}

pub type FormResult<T> = Result<T, FormError>;

/// The face a form's appearances are drawn with and the reference of its font object in the document.
#[derive(Debug, Clone)]
pub struct FormFont {
    pub font: Font,
    pub reference: Ref,
}

// flags

pub(crate) const FLAG_READ_ONLY: i64 = 1;
pub(crate) const FLAG_REQUIRED: i64 = 1 << 1;
pub(crate) const FLAG_RADIO: i64 = 1 << 15;
pub(crate) const FLAG_PUSH_BUTTON: i64 = 1 << 16;
pub(crate) const FLAG_RADIOS_IN_UNISON: i64 = 1 << 25;
pub(crate) const FLAG_MULTILINE: i64 = 1 << 12;
pub(crate) const FLAG_PASSWORD: i64 = 1 << 13;
pub(crate) const FLAG_FILE_SELECT: i64 = 1 << 20;
pub(crate) const FLAG_COMB: i64 = 1 << 24;
pub(crate) const FLAG_RICH_TEXT: i64 = 1 << 25;
pub(crate) const FLAG_COMBO: i64 = 1 << 17;
pub(crate) const FLAG_EDIT: i64 = 1 << 18;
pub(crate) const FLAG_SORT: i64 = 1 << 19;
pub(crate) const FLAG_MULTI_SELECT: i64 = 1 << 21;
pub(crate) const ANNOT_PRINT: i64 = 1 << 2;

/// How far up a chain of `Parent` entries is followed (a loop in a damaged file ends there).
const MAX_PARENT_DEPTH: usize = 256;

// model

/// The type vocabulary `add_form_field` and `fill_form` use (`formFieldKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Checkbox,
    Radio,
    Dropdown,
    OptionList,
    Text,
    Signature,
    Button,
}

impl FieldKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Checkbox => "checkbox",
            Self::Radio => "radio",
            Self::Dropdown => "dropdown",
            Self::OptionList => "optionlist",
            Self::Text => "text",
            Self::Signature => "signature",
            Self::Button => "button",
        }
    }
}

/// A terminal field of the form: the object holding it and its kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Field {
    pub reference: Ref,
    pub kind: FieldKind,
}

/// A widget annotation of a field: its object (none for a dictionary written inline) and the dictionary as it was read.
#[derive(Debug, Clone)]
pub struct Widget {
    pub reference: Option<Ref>,
    pub dict: Arc<Dict>,
}

/// Where a widget sits (`fieldWidgets`): the 1-based page (0 when the page is not found) and the rectangle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WidgetBox {
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WidgetBox {
    pub fn to_json(self) -> Value {
        let mut map = Map::new();
        map.insert("page".into(), Value::from(self.page as u64));
        map.insert("x".into(), json_number(self.x));
        map.insert("y".into(), json_number(self.y));
        map.insert("width".into(), json_number(self.width));
        map.insert("height".into(), json_number(self.height));
        Value::Object(map)
    }
}

/// pdf-lib's `PDFForm`: the fields whose appearance is out of date and the default font.
#[derive(Debug, Default)]
pub struct PdfForm {
    pub(crate) dirty: BTreeSet<i64>,
    default_font: Option<FormFont>,
}

// numbers and text

/// pdf-lib's `numberToString`: a number in decimal, never in exponent notation.
pub(crate) fn pdf_number(number: f64) -> String {
    let text = number_to_string(number);
    if number.abs() < 1.0 {
        let exponent = text.split("e-").nth(1).and_then(|digits| digits.parse::<i32>().ok());
        if let Some(e) = exponent.filter(|e| *e != 0) {
            let negative = number < 0.0;
            let scaled = (if negative { -number } else { number }) * pow(10.0, f64::from(e - 1));
            let digits = number_to_string(scaled);
            let tail: String = digits.chars().skip(2).collect();
            let zeros = "0".repeat((e - 1).max(0) as usize);
            return format!("{}0.{zeros}{tail}", if negative { "-" } else { "" });
        }
    } else {
        let exponent = text.split('+').nth(1).and_then(|digits| digits.parse::<i32>().ok());
        if let Some(e) = exponent.filter(|e| *e > 20) {
            let e = e - 20;
            let scaled = number / pow(10.0, f64::from(e));
            return format!("{}{}", number_to_string(scaled), "0".repeat(e as usize));
        }
    }
    text
}

/// `PDFHexString.fromText` / a text string: the byte order mark and UTF-16BE.
pub(crate) fn text_object(text: &str) -> Obj {
    Obj::string(&encode_text_string(text))
}

/// A string object as a string of the file (`PDFString.of`): its characters one byte each.
pub(crate) fn latin1_object(text: &str) -> Obj {
    let bytes: Vec<u8> = text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect();
    Obj::string(&bytes)
}

/// `/\s+/g -> ' '` then `trim()`.
pub(crate) fn collapse_whitespace(text: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in text.chars() {
        if is_js_space(c) {
            pending = true;
        } else {
            if pending {
                out.push(' ');
                pending = false;
            }
            out.push(c);
        }
    }
    if pending {
        out.push(' ');
    }
    mixdog_js::js_trim(&out).to_owned()
}

/// pdf-lib's `assertIsOneOf` refusal of a text value.
fn not_one_of(name: &str, allowed: &[String], value: &str) -> FormError {
    let allowed: Vec<String> = allowed.iter().map(|entry| format!("'{entry}'")).collect();
    FormError::new(format!("`{name}` must be one of {}, but was actually '{value}'", allowed.join(" or ")))
}

fn mismatch(expected: &str, got: Option<&Obj>) -> FormError {
    let actual = match got {
        None => "undefined",
        Some(Obj::Null) => "PDFNull",
        Some(Obj::Bool(_)) => "PDFBool",
        Some(Obj::Num(_)) => "PDFNumber",
        Some(Obj::Str(_)) => "PDFString",
        Some(Obj::Name(_)) => "PDFName",
        Some(Obj::Array(_)) => "PDFArray",
        Some(Obj::Dict(_)) => "PDFDict",
        Some(Obj::Stream(_)) => "PDFRawStream",
        Some(_) => "PDFObject",
    };
    FormError::new(format!("Expected instance of {expected}, but got instance of {actual}"))
}

// reading the object store

fn parent_of(store: &ObjectStore, field: Ref) -> Option<Ref> {
    let dict = store.dict(field)?;
    match dict.get_raw("Parent")? {
        Obj::Ref(parent) if store.dict(*parent).is_some() => Some(*parent),
        _ => None,
    }
}

/// `getInheritableAttribute`: the value under `key` on the field or the nearest ancestor that has one, as stored.
pub(crate) fn inherited(store: &ObjectStore, field: Ref, key: &str) -> Option<Obj> {
    let mut current = Some(field);
    for _ in 0..MAX_PARENT_DEPTH {
        let node = current?;
        if let Some(value) = store.dict(node).and_then(|dict| dict.get_raw(key)) {
            return Some(value.clone());
        }
        current = parent_of(store, node);
    }
    None
}

pub(crate) fn field_flags(store: &ObjectStore, field: Ref) -> i64 {
    inherited(store, field, "Ff").and_then(|raw| store.resolve(&raw).and_then(Obj::as_num)).map_or(0, |flags| flags as i64)
}

pub(crate) fn has_flag(store: &ObjectStore, field: Ref, flag: i64) -> bool {
    field_flags(store, field) & flag != 0
}

pub(crate) fn set_flag_to(store: &mut ObjectStore, field: Ref, flag: i64, enable: bool) {
    let flags = field_flags(store, field);
    let flags = if enable { flags | flag } else { flags & !flag };
    store.modify_dict(field, |dict| dict.set("Ff", Obj::Num(flags as f64)));
}

pub(crate) fn set_key(store: &mut ObjectStore, owner: Ref, key: &str, value: Obj) {
    store.modify_dict(owner, |dict| dict.set(key, value));
}

pub(crate) fn delete_key(store: &mut ObjectStore, owner: Ref, key: &str) {
    store.modify_dict(owner, |dict| dict.delete(key));
}

/// Appends `item` to the array under `key` of the dictionary `owner`: the array object itself when the entry is a
/// reference to one, else the array inside the dictionary (made when there is none).
pub(crate) fn push_array(store: &mut ObjectStore, owner: Ref, key: &str, item: Obj) {
    let indirect = store
        .dict(owner)
        .and_then(|dict| dict.get_raw(key))
        .and_then(Obj::as_ref_value)
        .filter(|reference| matches!(store.get(*reference), Some(Obj::Array(_))));
    if let Some(reference) = indirect {
        store.modify(reference, |slot| {
            if let Obj::Array(items) = slot {
                Arc::make_mut(items).push(item);
            }
        });
        return;
    }
    store.modify_dict(owner, |dict| {
        let mut items = match dict.get_raw(key) {
            Some(Obj::Array(existing)) => (**existing).clone(),
            _ => Vec::new(),
        };
        items.push(item);
        dict.set(key, Obj::Array(Arc::new(items)));
    });
}

/// The text of a string object (`decodeText`).
fn string_text(obj: Option<&Obj>) -> Option<String> {
    match obj? {
        Obj::Str(bytes) => Some(decode_text_string(bytes)),
        _ => None,
    }
}

/// `T()` decoded: the partial name.
pub(crate) fn partial_name(store: &ObjectStore, field: Ref) -> Option<String> {
    string_text(store.lookup(store.dict(field)?, "T"))
}

fn qualified_name(store: &ObjectStore, field: Ref, depth: usize) -> Option<String> {
    if depth > MAX_PARENT_DEPTH {
        return None;
    }
    let own = || partial_name(store, field).unwrap_or_else(|| "undefined".to_owned());
    match parent_of(store, field) {
        None => partial_name(store, field),
        Some(parent) => {
            let above = qualified_name(store, parent, depth + 1).unwrap_or_else(|| "undefined".to_owned());
            Some(format!("{above}.{}", own()))
        }
    }
}

/// `field.getName()`.
pub(crate) fn field_name(store: &ObjectStore, field: Ref) -> String {
    qualified_name(store, field, 0).unwrap_or_default()
}

/// The default appearance string of a field or widget dictionary (`getDefaultAppearance`).
pub(crate) fn default_appearance(store: &ObjectStore, dict: &Dict) -> Option<String> {
    string_text(store.lookup(dict, "DA"))
}

pub(crate) fn is_non_terminal(store: &ObjectStore, dict: &Dict) -> bool {
    match store.lookup(dict, "Kids") {
        Some(Obj::Array(kids)) => kids.iter().any(|kid| matches!(store.resolve(kid), Some(Obj::Dict(entry)) if entry.has("T"))),
        _ => false,
    }
}

fn kind_of(store: &ObjectStore, field: Ref) -> FormResult<Option<FieldKind>> {
    let raw = inherited(store, field, "FT");
    let resolved = raw.as_ref().and_then(|raw| store.resolve(raw));
    let Some(Obj::Name(name)) = resolved else {
        return Err(mismatch("PDFName", resolved));
    };
    let flags = field_flags(store, field);
    Ok(match &**name {
        "Btn" if flags & FLAG_PUSH_BUTTON != 0 => Some(FieldKind::Button),
        "Btn" if flags & FLAG_RADIO != 0 => Some(FieldKind::Radio),
        "Btn" => Some(FieldKind::Checkbox),
        "Ch" if flags & FLAG_COMBO != 0 => Some(FieldKind::Dropdown),
        "Ch" => Some(FieldKind::OptionList),
        "Tx" => Some(FieldKind::Text),
        "Sig" => Some(FieldKind::Signature),
        _ => None,
    })
}

fn collect_terminals(store: &ObjectStore, entries: &[Obj], out: &mut Vec<Ref>, depth: usize) {
    if depth > MAX_PARENT_DEPTH {
        return;
    }
    for entry in entries {
        let Obj::Ref(reference) = entry else {
            continue;
        };
        let Some(dict) = store.dict(*reference) else {
            continue;
        };
        if is_non_terminal(store, dict) {
            if let Some(Obj::Array(kids)) = store.lookup(dict, "Kids") {
                collect_terminals(store, kids, out, depth + 1);
            }
        } else {
            out.push(*reference);
        }
    }
}

/// `widget.getAppearances().normal` of one widget: none without an `AP`; a dictionary (an on/off mapping) or a stream.
pub(crate) enum NormalAppearance {
    Mapping(Arc<Dict>),
    Stream,
}

pub(crate) fn normal_appearance(store: &ObjectStore, widget: &Widget) -> FormResult<Option<NormalAppearance>> {
    let ap = match store.lookup(&widget.dict, "AP") {
        None | Some(Obj::Null) => return Ok(None),
        Some(Obj::Dict(ap)) => ap.clone(),
        other => return Err(mismatch("PDFDict", other)),
    };
    match store.lookup(&ap, "N") {
        Some(Obj::Dict(mapping)) => Ok(Some(NormalAppearance::Mapping(mapping.clone()))),
        Some(Obj::Stream(_)) => Ok(Some(NormalAppearance::Stream)),
        other => Err(mismatch("PDFDict", other)),
    }
}

/// `widget.getOnValue()`: the first key of the normal appearance other than `Off`.
pub(crate) fn widget_on_value(store: &ObjectStore, widget: &Widget) -> FormResult<Option<String>> {
    Ok(match normal_appearance(store, widget)? {
        Some(NormalAppearance::Mapping(mapping)) => mapping.keys().find(|key| *key != "Off").map(str::to_owned),
        _ => None,
    })
}

/// `acroField.getWidgets()`.
pub(crate) fn widgets_of(store: &ObjectStore, field: Ref) -> FormResult<Vec<Widget>> {
    let dict = store.dict(field).cloned().ok_or_else(|| FormError::new("Expected instance of PDFDict, but got instance of undefined"))?;
    let Some(Obj::Array(kids)) = store.lookup(&dict, "Kids") else {
        return Ok(vec![Widget { reference: Some(field), dict }]);
    };
    kids.iter()
        .map(|kid| match store.resolve(kid) {
            Some(Obj::Dict(entry)) => Ok(Widget { reference: kid.as_ref_value(), dict: entry.clone() }),
            other => Err(mismatch("PDFDict", other)),
        })
        .collect()
}

/// `widget.getRectangle()`.
pub(crate) fn widget_rectangle(store: &ObjectStore, widget: &Widget) -> FormResult<Rect> {
    let Some(Obj::Array(items)) = store.lookup(&widget.dict, "Rect") else {
        return Err(mismatch("PDFArray", store.lookup(&widget.dict, "Rect")));
    };
    if items.len() != 4 {
        return Err(FormError::new(format!("Attempted to convert PDFArray with {} elements to rectangle, but must have exactly 4 elements.", items.len())));
    }
    let mut numbers = [0.0; 4];
    for (slot, item) in numbers.iter_mut().zip(items.iter()) {
        let resolved = store.resolve(item);
        *slot = resolved.and_then(Obj::as_num).ok_or_else(|| mismatch("PDFNumber", resolved))?;
    }
    Ok(Rect { x: numbers[0], y: numbers[1], width: numbers[2] - numbers[0], height: numbers[3] - numbers[1] })
}

/// The numbers of a colour array of the appearance characteristics (`BC`, `BG`): the entries that are numbers.
pub(crate) fn characteristic_components(store: &ObjectStore, widget: &Widget, key: &str) -> Option<Vec<f64>> {
    let mk = match store.lookup(&widget.dict, "MK") {
        Some(Obj::Dict(mk)) => mk.clone(),
        _ => return None,
    };
    match store.lookup(&mk, key) {
        Some(Obj::Array(items)) => Some(items.iter().filter_map(|item| item.as_num()).collect()),
        _ => None,
    }
}

/// `widget.getAppearanceCharacteristics()?.getRotation()`.
pub(crate) fn characteristic_rotation(store: &ObjectStore, widget: &Widget) -> Option<f64> {
    let mk = match store.lookup(&widget.dict, "MK") {
        Some(Obj::Dict(mk)) => mk.clone(),
        _ => return None,
    };
    store.lookup(&mk, "R").and_then(Obj::as_num)
}

/// `widget.getBorderStyle()?.getWidth()`: none without a `BS`; its `W`, else 1.
pub(crate) fn border_style_width(store: &ObjectStore, widget: &Widget) -> Option<f64> {
    match store.lookup(&widget.dict, "BS") {
        Some(Obj::Dict(bs)) => Some(store.lookup(bs, "W").and_then(Obj::as_num).unwrap_or(1.0)),
        _ => None,
    }
}

// values

/// `acroField.V()`: the value, inherited and resolved.
fn value_object(store: &ObjectStore, field: Ref) -> Option<Obj> {
    let raw = inherited(store, field, "V")?;
    store.resolve(&raw).cloned()
}

/// `getValue()` of a button: the name stored, else `Off`.
pub(crate) fn button_value(store: &ObjectStore, field: Ref) -> String {
    match value_object(store, field) {
        Some(Obj::Name(name)) => name.to_string(),
        _ => "Off".to_owned(),
    }
}

/// `PDFTextField.getText()`: none without a value; a rich text field without one cannot be read.
pub(crate) fn text_value(store: &ObjectStore, field: Ref) -> FormResult<Option<String>> {
    match value_object(store, field) {
        Some(Obj::Str(bytes)) => Ok(Some(decode_text_string(&bytes))),
        _ if has_flag(store, field, FLAG_RICH_TEXT) => {
            Err(FormError::new(format!("Reading rich text fields is not supported: Attempted to read rich text field: {}", field_name(store, field))))
        }
        _ => Ok(None),
    }
}

/// The values of a choice field (`getValues`), decoded.
pub(crate) fn choice_values(store: &ObjectStore, field: Ref) -> Vec<String> {
    match value_object(store, field) {
        Some(Obj::Str(bytes)) => vec![decode_text_string(&bytes)],
        Some(Obj::Array(items)) => items.iter().filter_map(|item| string_text(store.resolve(item))).collect(),
        _ => Vec::new(),
    }
}

/// The options of a choice field, each as `(value, display)`. An entry that is neither a string nor a pair starting
/// with one fails, as pdf-lib's reader does.
pub(crate) fn choice_options(store: &ObjectStore, field: Ref) -> FormResult<Vec<(String, String)>> {
    let Some(dict) = store.dict(field) else {
        return Ok(Vec::new());
    };
    match store.lookup(dict, "Opt") {
        Some(Obj::Str(bytes)) => {
            let text = decode_text_string(bytes);
            Ok(vec![(text.clone(), text)])
        }
        Some(Obj::Array(items)) => {
            let mut out = Vec::new();
            for item in items.iter() {
                match store.resolve(item) {
                    Some(Obj::Str(bytes)) => {
                        let text = decode_text_string(bytes);
                        out.push((text.clone(), text));
                    }
                    Some(Obj::Array(pair)) if !pair.is_empty() => {
                        let first = store.resolve(&pair[0]);
                        let value = string_text(first).ok_or_else(|| mismatch("PDFString", first))?;
                        let display = match pair.get(1).map(|second| store.resolve(second)) {
                            None | Some(None) | Some(Some(Obj::Null)) => value.clone(),
                            Some(Some(Obj::Str(bytes))) => decode_text_string(bytes),
                            Some(other) => return Err(mismatch("PDFString", other)),
                        };
                        out.push((value, display));
                    }
                    _ => {}
                }
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

/// `PDFAcroButton.getExportValues`: the `Opt` strings of a radio group, when it has any.
pub(crate) fn export_values(store: &ObjectStore, field: Ref) -> Option<Vec<String>> {
    let dict = store.dict(field)?;
    match store.lookup(dict, "Opt")? {
        Obj::Str(bytes) => Some(vec![decode_text_string(bytes)]),
        Obj::Array(items) => Some(items.iter().filter_map(|item| string_text(store.resolve(item))).collect()),
        _ => None,
    }
}

/// `PDFAcroRadioButton.getOnValues`.
pub(crate) fn radio_on_values(store: &ObjectStore, field: Ref) -> FormResult<Vec<String>> {
    let mut values = Vec::new();
    for widget in widgets_of(store, field)? {
        if let Some(value) = widget_on_value(store, &widget)? {
            values.push(value);
        }
    }
    Ok(values)
}

/// `PDFRadioGroup.getOptions`.
pub(crate) fn radio_options(store: &ObjectStore, field: Ref) -> FormResult<Vec<String>> {
    match export_values(store, field) {
        Some(values) => Ok(values),
        None => radio_on_values(store, field),
    }
}

/// `PDFRadioGroup.getSelected`.
pub(crate) fn radio_selected(store: &ObjectStore, field: Ref) -> FormResult<Option<String>> {
    let value = button_value(store, field);
    if value == "Off" {
        return Ok(None);
    }
    if let Some(exports) = export_values(store, field) {
        for (index, on) in radio_on_values(store, field)?.iter().enumerate() {
            if *on == value {
                if let Some(export) = exports.get(index) {
                    return Ok(Some(export.clone()));
                }
            }
        }
    }
    Ok(Some(value))
}

/// `PDFCheckBox.getOnValue`: the on value of the first widget.
pub(crate) fn checkbox_on_value(store: &ObjectStore, field: Ref) -> FormResult<Option<String>> {
    match widgets_of(store, field)?.first() {
        Some(widget) => widget_on_value(store, widget),
        None => Ok(None),
    }
}

/// `PDFCheckBox.isChecked`.
pub(crate) fn checkbox_checked(store: &ObjectStore, field: Ref) -> FormResult<bool> {
    Ok(checkbox_on_value(store, field)?.is_some_and(|on| on == button_value(store, field)))
}

/// Writes `value` as the state of every widget of a check box or radio group: the on value of the widget when it is
/// the value, else `Off`.
fn set_button_state(store: &mut ObjectStore, field: Ref, value: &str) -> FormResult<()> {
    set_key(store, field, "V", Obj::name(value));
    for widget in widgets_of(store, field)? {
        let state = if widget_on_value(store, &widget)?.as_deref() == Some(value) { value } else { "Off" };
        if let Some(reference) = widget.reference {
            set_key(store, reference, "AS", Obj::name(state));
        }
    }
    Ok(())
}

// the form

static TF_OPERATOR: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"/([^\x00\t\n\f\r\x20]+)[\x00\t\n\f\r\x20]*(\d*\.\d+|\d+)?[\x00\t\n\f\r\x20]+Tf", ""));

/// `findLastMatch`: the last of the non-overlapping matches scanned from the start, as `(offset, length, groups)` of
/// the whole string, and the position after it.
pub(crate) fn find_last_match(value: &str, regex: &JsRegex, groups: usize) -> Option<(usize, usize, Vec<Option<String>>)> {
    let mut position = 0usize;
    let mut last = None;
    while position < value.len() {
        let rest = &value[position..];
        let Some(caps) = regex.captures(rest) else {
            break;
        };
        let range = caps.range();
        let found = (0..=groups).map(|group| caps.get(group).map(str::to_owned)).collect();
        last = Some((position + range.start, range.len(), found));
        position += range.end;
    }
    last
}

impl PdfForm {
    pub fn new() -> Self {
        Self::default()
    }

    /// `document.getForm()`: the form of the catalog, made when there is none; the XFA data pdf-lib cannot write is
    /// dropped, and `Fields` is an array afterwards. Returns the reference of the form dictionary.
    pub(crate) fn acro_form(&self, doc: &mut PdfDocument) -> FormResult<Ref> {
        let root = doc.catalog_ref().ok_or_else(|| FormError::new("the file has no catalog"))?;
        let store = doc.store_mut();
        let existing = match store.dict(root).and_then(|catalog| catalog.get_raw("AcroForm")).cloned() {
            Some(Obj::Ref(reference)) if store.dict(reference).is_some() => Some(reference),
            Some(Obj::Dict(inline)) => {
                let reference = store.register(Obj::Dict(inline));
                set_key(store, root, "AcroForm", Obj::Ref(reference));
                Some(reference)
            }
            _ => None,
        };
        let form = match existing {
            Some(form) => form,
            None => {
                let mut dict = Dict::new();
                dict.set("Fields", Obj::Array(Arc::new(Vec::new())));
                let reference = store.register(Obj::Dict(Arc::new(dict)));
                set_key(store, root, "AcroForm", Obj::Ref(reference));
                reference
            }
        };
        if store.dict(form).is_some_and(|dict| dict.has("XFA")) {
            delete_key(store, form, "XFA");
        }
        let has_fields = store.dict(form).is_some_and(|dict| matches!(store.lookup(dict, "Fields"), Some(Obj::Array(_))));
        if !has_fields {
            set_key(store, form, "Fields", Obj::Array(Arc::new(Vec::new())));
        }
        Ok(form)
    }

    /// `form.getFields()`: every terminal field of the form in document order; the ones of a kind pdf-lib has no class
    /// for are left out.
    pub fn fields(&self, doc: &mut PdfDocument) -> FormResult<Vec<Field>> {
        let form = self.acro_form(doc)?;
        let store = doc.store();
        let mut terminals = Vec::new();
        if let Some(Obj::Array(entries)) = store.dict(form).and_then(|dict| store.lookup(dict, "Fields")) {
            collect_terminals(store, entries, &mut terminals, 0);
        }
        let mut fields = Vec::new();
        for reference in terminals {
            if let Some(kind) = kind_of(store, reference)? {
                fields.push(Field { reference, kind });
            }
        }
        Ok(fields)
    }

    /// `form.getField(name)`.
    pub fn field(&self, doc: &mut PdfDocument, name: &str) -> FormResult<Field> {
        let store_fields = self.fields(doc)?;
        let store = doc.store();
        store_fields
            .into_iter()
            .find(|field| field_name(store, field.reference) == name)
            .ok_or_else(|| FormError::new(format!("PDFDocument has no form field with the name \"{name}\"")))
    }

    /// `form.getDefaultFont()`: Helvetica, written into the document the first time it is asked for.
    pub fn default_font(&mut self, doc: &mut PdfDocument) -> FormResult<FormFont> {
        if let Some(font) = &self.default_font {
            return Ok(font.clone());
        }
        let font = Font::standard(StandardFontName::Helvetica);
        let reference = font.embed_into(doc.store_mut(), None, &mut SuffixRng::default())?;
        let made = FormFont { font, reference };
        self.default_font = Some(made.clone());
        Ok(made)
    }

    pub(crate) fn mark_dirty(&mut self, field: Ref) {
        self.dirty.insert(field.num);
    }

    pub(crate) fn mark_clean(&mut self, field: Ref) {
        self.dirty.remove(&field.num);
    }

    pub(crate) fn is_dirty(&self, field: Ref) -> bool {
        self.dirty.contains(&field.num)
    }

    // value setters (the methods of the field classes)

    /// `PDFTextField.setText`: a text longer than the field's `MaxLen` is refused.
    pub fn set_text(&mut self, doc: &mut PdfDocument, field: &Field, text: Option<&str>) -> FormResult<()> {
        let store = doc.store_mut();
        let max_length = store.dict(field.reference).and_then(|dict| store.lookup(dict, "MaxLen")).and_then(Obj::as_num);
        if let (Some(max), Some(text)) = (max_length, text.filter(|text| !text.is_empty())) {
            let length = mixdog_js::utf16_len(text);
            if (length as f64) > max {
                return Err(FormError::new(format!(
                    "Attempted to set text with length={length} for TextField with maxLength={} and name={}",
                    number_to_string(max),
                    field_name(store, field.reference)
                )));
            }
        }
        self.mark_dirty(field.reference);
        set_flag_to(store, field.reference, FLAG_RICH_TEXT, false);
        match text.filter(|text| !text.is_empty()) {
            Some(text) => set_key(store, field.reference, "V", text_object(text)),
            None => delete_key(store, field.reference, "V"),
        }
        Ok(())
    }

    /// `PDFTextField.setMaxLength`.
    pub fn set_max_length(&mut self, doc: &mut PdfDocument, field: &Field, max_length: f64) -> FormResult<()> {
        self.mark_dirty(field.reference);
        let current = text_value(doc.store(), field.reference)?;
        let store = doc.store_mut();
        if let Some(text) = current.filter(|text| !text.is_empty()) {
            let length = mixdog_js::utf16_len(&text);
            if (length as f64) > max_length {
                return Err(FormError::new(format!(
                    "Attempted to set maxLength={}, which is less than {length}, the length of this field's current value (name={})",
                    number_to_string(max_length),
                    field_name(store, field.reference)
                )));
            }
        }
        set_key(store, field.reference, "MaxLen", Obj::Num(max_length));
        Ok(())
    }

    /// `PDFTextField.enableMultiline`.
    pub fn enable_multiline(&mut self, doc: &mut PdfDocument, field: &Field) {
        self.mark_dirty(field.reference);
        set_flag_to(doc.store_mut(), field.reference, FLAG_MULTILINE, true);
    }

    /// `setFontSize` of a text field, dropdown or option list: the size of the `Tf` in the field's `DA`.
    pub fn set_font_size(&mut self, doc: &mut PdfDocument, field: &Field, font_size: f64) -> FormResult<()> {
        let store = doc.store_mut();
        let name = field_name(store, field.reference);
        let da = store
            .dict(field.reference)
            .and_then(|dict| default_appearance(store, dict))
            .filter(|da| !da.is_empty())
            .ok_or_else(|| FormError::new(format!("No /DA (default appearance) entry found for field: {name}")))?;
        let (start, length, groups) =
            find_last_match(&da, &TF_OPERATOR, 2).ok_or_else(|| FormError::new(format!("No Tf operator found for DA of field: {name}")))?;
        let font_name = groups.get(1).cloned().flatten().unwrap_or_default();
        let before = &da[..start];
        let after = da.get(start + length..).unwrap_or("");
        let modified = format!("{before} /{font_name} {} Tf {after}", number_to_string(font_size));
        set_key(store, field.reference, "DA", latin1_object(&modified));
        self.mark_dirty(field.reference);
        Ok(())
    }

    /// `PDFCheckBox.check`.
    pub fn check(&mut self, doc: &mut PdfDocument, field: &Field) -> FormResult<()> {
        let on = checkbox_on_value(doc.store(), field.reference)?.unwrap_or_else(|| "Yes".to_owned());
        self.mark_dirty(field.reference);
        set_button_state(doc.store_mut(), field.reference, &on)
    }

    /// `PDFCheckBox.uncheck`.
    pub fn uncheck(&mut self, doc: &mut PdfDocument, field: &Field) -> FormResult<()> {
        self.mark_dirty(field.reference);
        set_button_state(doc.store_mut(), field.reference, "Off")
    }

    /// `PDFRadioGroup.select`: an option the group does not have is refused; the option's on value becomes the value.
    pub fn select_radio(&mut self, doc: &mut PdfDocument, field: &Field, option: &str) -> FormResult<()> {
        let valid = radio_options(doc.store(), field.reference)?;
        if !valid.iter().any(|entry| entry == option) {
            return Err(not_one_of("option", &valid, option));
        }
        self.mark_dirty(field.reference);
        let store = doc.store_mut();
        let on_values = radio_on_values(store, field.reference)?;
        let wanted = match export_values(store, field.reference) {
            Some(exports) => {
                exports.iter().enumerate().filter(|(_, export)| export.as_str() == option).filter_map(|(index, _)| on_values.get(index).cloned()).last()
            }
            None => on_values.iter().filter(|value| value.as_str() == option).last().cloned(),
        };
        match wanted {
            Some(value) => set_button_state(store, field.reference, &value),
            None => Ok(()),
        }
    }

    /// `PDFDropdown.enableEditing` / `PDFOptionList` flags.
    pub fn set_choice_flag(&mut self, doc: &mut PdfDocument, field: &Field, flag: i64, enable: bool) {
        set_flag_to(doc.store_mut(), field.reference, flag, enable);
    }

    /// `addOptions` of a dropdown or option list: the options are appended as `[value, value]` pairs.
    pub fn add_options(&mut self, doc: &mut PdfDocument, field: &Field, options: &[String]) -> FormResult<()> {
        if field.kind == FieldKind::OptionList {
            self.mark_dirty(field.reference);
        }
        let store = doc.store_mut();
        let mut pairs = Vec::new();
        for (value, display) in choice_options(store, field.reference)? {
            pairs.push(Obj::Array(Arc::new(vec![text_object(&value), text_object(&display)])));
        }
        for option in options {
            pairs.push(Obj::Array(Arc::new(vec![text_object(option), text_object(option)])));
        }
        set_key(store, field.reference, "Opt", Obj::Array(Arc::new(pairs)));
        Ok(())
    }

    /// `PDFDropdown.select` / `PDFOptionList.select` (`merge` false): a dropdown given an option it does not list becomes
    /// editable (unless the first such option is empty, which JavaScript reads as none), an option list refuses a value it
    /// does not list, several values make the field multiselect, and a non-editable dropdown refuses a value it does not
    /// list.
    pub fn select_choice(&mut self, doc: &mut PdfDocument, field: &Field, options: &[String]) -> FormResult<()> {
        let reference = field.reference;
        let store = doc.store_mut();
        let valid: Vec<String> = choice_options(store, reference)?.into_iter().map(|(_, display)| display).collect();
        if field.kind == FieldKind::Dropdown {
            if options.iter().find(|option| !valid.contains(option)).is_some_and(|custom| !custom.is_empty()) {
                set_flag_to(store, reference, FLAG_EDIT, true);
            }
        } else if let Some(unknown) = options.iter().find(|option| !valid.contains(option)) {
            return Err(not_one_of("option", &valid, unknown));
        }
        self.mark_dirty(reference);
        if options.len() > 1 {
            set_flag_to(store, reference, FLAG_MULTI_SELECT, true);
        }
        let flags = field_flags(store, reference);
        if flags & FLAG_COMBO != 0 && flags & FLAG_EDIT == 0 {
            if options.iter().any(|option| !valid.contains(option)) {
                return Err(FormError::new("Attempted to set invalid field value"));
            }
        }
        match options {
            [] => delete_key(store, reference, "V"),
            [one] => set_key(store, reference, "V", text_object(one)),
            many => {
                if flags & FLAG_MULTI_SELECT == 0 {
                    return Err(FormError::new("Attempted to select multiple values for single-select field"));
                }
                let values: Vec<Obj> = many.iter().map(|value| text_object(value)).collect();
                set_key(store, reference, "V", Obj::Array(Arc::new(values)));
            }
        }
        if options.len() > 1 {
            let listed = choice_options(store, reference)?;
            let mut indices: Vec<i64> =
                options.iter().map(|value| listed.iter().position(|(_, display)| display == value).map_or(-1, |at| at as i64)).collect();
            indices.sort_by_key(|index| index.to_string());
            let items: Vec<Obj> = indices.into_iter().map(|index| Obj::Num(index as f64)).collect();
            set_key(store, reference, "I", Obj::Array(Arc::new(items)));
        } else {
            delete_key(store, reference, "I");
        }
        Ok(())
    }
}

// describing a field

/// `fieldWidgets(field, document)`: where the widgets of a field sit; none when a widget cannot be read.
pub fn field_widgets(doc: &PdfDocument, field: &Field) -> Vec<WidgetBox> {
    let store = doc.store();
    let pages = doc.pages();
    let read = || -> FormResult<Vec<WidgetBox>> {
        widgets_of(store, field.reference)?
            .iter()
            .map(|widget| {
                let rectangle = widget_rectangle(store, widget)?;
                let page_ref = match widget.dict.get_raw("P") {
                    Some(Obj::Ref(page)) => Some(*page),
                    _ => None,
                };
                let page = page_ref.and_then(|page| pages.iter().position(|entry| *entry == page)).map_or(0, |at| at + 1);
                Ok(WidgetBox { page, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height })
            })
            .collect()
    };
    read().unwrap_or_default()
}

/// The tooltip a form gives a field (`/TU`), whitespace collapsed.
fn field_label(store: &ObjectStore, field: Ref) -> String {
    let Some(dict) = store.dict(field) else {
        return String::new();
    };
    match store.lookup(dict, "TU") {
        Some(Obj::Str(bytes)) => collapse_whitespace(&decode_text_string(bytes)),
        Some(Obj::Name(name)) => collapse_whitespace(name),
        _ => String::new(),
    }
}

fn string_value(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::String).collect())
}

fn field_value(store: &ObjectStore, field: &Field) -> Value {
    let reference = field.reference;
    let read = || -> FormResult<Value> {
        Ok(match field.kind {
            FieldKind::Checkbox => Value::Bool(checkbox_checked(store, reference)?),
            FieldKind::Radio => radio_selected(store, reference)?.map_or(Value::Null, Value::String),
            FieldKind::Dropdown => {
                let selected = choice_values(store, reference);
                if has_flag(store, reference, FLAG_MULTI_SELECT) {
                    string_value(selected)
                } else {
                    Value::String(selected.into_iter().next().unwrap_or_default())
                }
            }
            FieldKind::OptionList => string_value(choice_values(store, reference)),
            FieldKind::Text => Value::String(text_value(store, reference)?.unwrap_or_default()),
            FieldKind::Signature | FieldKind::Button => Value::Null,
        })
    };
    read().unwrap_or(Value::Null)
}

fn field_option_list(store: &ObjectStore, field: &Field) -> Option<Vec<String>> {
    match field.kind {
        FieldKind::Radio => Some(radio_options(store, field.reference).unwrap_or_default()),
        FieldKind::Dropdown | FieldKind::OptionList => {
            Some(choice_options(store, field.reference).map(|options| options.into_iter().map(|(_, display)| display).collect()).unwrap_or_default())
        }
        _ => None,
    }
}

/// `describeFormField(field, document, index)`: the JSON the inspector shows for one field.
pub fn describe_form_field(doc: &PdfDocument, field: &Field, index: usize) -> Value {
    let store = doc.store();
    let reference = field.reference;
    let mut map = Map::new();
    map.insert("path".into(), Value::String(format!("/field[{}]", index + 1)));
    map.insert("index".into(), Value::from((index + 1) as u64));
    map.insert("name".into(), Value::String(field_name(store, reference)));
    let label = field_label(store, reference);
    if !label.is_empty() {
        map.insert("label".into(), Value::String(label));
    }
    map.insert("type".into(), Value::String(field.kind.name().to_owned()));
    map.insert("value".into(), field_value(store, field));
    if let Some(options) = field_option_list(store, field) {
        map.insert("options".into(), string_value(options));
    }
    map.insert("readOnly".into(), Value::Bool(has_flag(store, reference, FLAG_READ_ONLY)));
    map.insert("required".into(), Value::Bool(has_flag(store, reference, FLAG_REQUIRED)));
    if field.kind == FieldKind::Checkbox {
        if let Ok(Some(on)) = checkbox_on_value(store, reference) {
            if !on.is_empty() {
                map.insert("onValue".into(), Value::String(on));
            }
        }
    }
    if field.kind == FieldKind::Text {
        map.insert("multiline".into(), Value::Bool(has_flag(store, reference, FLAG_MULTILINE)));
        let max = store.dict(reference).and_then(|dict| store.lookup(dict, "MaxLen")).and_then(Obj::as_num);
        if let Some(max) = max {
            map.insert("maxLength".into(), json_number(max));
        }
    }
    let widgets = field_widgets(doc, field).into_iter().map(WidgetBox::to_json).collect();
    map.insert("widgets".into(), Value::Array(widgets));
    Value::Object(map)
}

impl PdfForm {
    /// `form.getFields().map((field, index) => describeFormField(field, document, index))`.
    pub fn describe_fields(&self, doc: &mut PdfDocument) -> FormResult<Vec<Value>> {
        let fields = self.fields(doc)?;
        Ok(fields.iter().enumerate().map(|(index, field)| describe_form_field(doc, field, index)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_without_an_exponent() {
        for (number, text) in [
            (1.5, "1.5"),
            (-0.0, "0"),
            (1e-7, "0.00000009999999999999999"),
            (-2.5e-9, "-0.0000000025"),
            (6.123233995736766e-17, "0.00000000000000006123233995736767"),
            (1e21, "1000000000000000000000"),
            (1.5e22, "15000000000000000000000"),
            (123.456, "123.456"),
        ] {
            assert_eq!(pdf_number(number), text, "{number}");
        }
    }

    #[test]
    fn whitespace_collapses_and_trims() {
        assert_eq!(collapse_whitespace("  Line 1 \n\t Name  of entity "), "Line 1 Name of entity");
        assert_eq!(collapse_whitespace(" \u{a0}"), "");
    }

    #[test]
    fn the_last_match_is_found_like_find_last_match() {
        let da = "0 0 0 rg\n/Helv 9 Tf 1 g /Helv 12 Tf";
        let (start, length, groups) = find_last_match(da, &TF_OPERATOR, 2).expect("a match");
        assert_eq!(&da[start..start + length], "/Helv 12 Tf");
        assert_eq!(groups[1].as_deref(), Some("Helv"));
        assert_eq!(groups[2].as_deref(), Some("12"));
        assert!(find_last_match("0 g", &TF_OPERATOR, 2).is_none());
    }

    #[test]
    fn a_value_outside_the_options_is_refused_in_pdf_lib_words() {
        let error = not_one_of("option", &["A".to_owned(), "B".to_owned()], "Z");
        assert_eq!(error.message(), "`option` must be one of 'A' or 'B', but was actually 'Z'");
    }

    #[test]
    fn a_text_string_is_utf16_with_a_byte_order_mark() {
        match text_object("A한") {
            Obj::Str(bytes) => assert_eq!(&*bytes, &[0xfe, 0xff, 0x00, 0x41, 0xd5, 0x5c]),
            other => panic!("{other:?}"),
        }
    }
}

impl std::error::Error for FormError {}
