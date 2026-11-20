//! `design/docx/document-typography.mjs`: the faces a document sets Korean text in beside the Latin faces of its
//! design, and the East Asian face a table takes.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys, js_trim, json_stringify};
use serde_json::{Map, Value};

use mixdog_office_base::values::truthy;

use crate::{first_truthy, opt_prop, prop, text};

/// The serif Latin faces the presets set their display role in (`SERIF_FACE`, read case-insensitively).
const SERIF_FACES: [&str; 8] = ["cambria", "georgia", "bookman old style", "times new roman", "garamond", "book antiqua", "palatino linotype", "constantia"];

/// The Latin faces the presets assign that carry no Hangul (`LATIN_OFFICE_FACE`).
const LATIN_OFFICE_FACES: [&str; 9] = ["calibri", "arial", "cambria", "bookman old style", "courier new", "times new roman", "georgia", "segoe ui", "aptos"];

/// `SERIF_FACE.test(face)`: the whole text is one of the serif faces, whatever its case. The names are ASCII, so the
/// comparison is ASCII-insensitive (the `i` flag does not fold the Kelvin sign onto `k`).
pub fn is_serif_face(face: &str) -> bool {
    SERIF_FACES.iter().any(|name| face.eq_ignore_ascii_case(name))
}

fn is_latin_office_face(face: &str) -> bool {
    LATIN_OFFICE_FACES.iter().any(|name| face.eq_ignore_ascii_case(name))
}

/// A Hangul letter: `[ᄀ-ᇿ㄰-㆏가-힯]`.
fn is_hangul(c: char) -> bool {
    matches!(c, '\u{1100}'..='\u{11ff}' | '\u{3130}'..='\u{318f}' | '\u{ac00}'..='\u{d7af}')
}

/// `HANGUL.test(text)`.
pub fn has_hangul(text: &str) -> bool {
    text.chars().any(is_hangul)
}

/// `koreanDesign(design, text)`: for a sheet that holds Hangul, each Latin office face of the design's roles becomes
/// the Korean face of its class (a serif role Batang, any other Malgun Gothic); a face that is not one of them is the
/// author's and stays. A design without typography, or text without Hangul, is returned as it is.
pub fn korean_design(design: &Value, text: &str) -> Value {
    let typography = opt_prop(prop(design, "tokens"), "typography");
    let Some(typography) = typography.filter(|inner| truthy(inner)) else {
        return design.clone();
    };
    if !has_hangul(text) {
        return design.clone();
    }
    let mut faces = Map::new();
    if let Some(map) = typography.as_object() {
        for role in js_object_keys(map) {
            let face = &map[role];
            let name = js_trim(&crate::text_of(face)).to_owned();
            let replaced = if !is_latin_office_face(&name) {
                face.clone()
            } else if is_serif_face(&name) {
                Value::String("Batang".into())
            } else {
                Value::String("Malgun Gothic".into())
            };
            faces.insert(role.clone(), replaced);
        }
    }
    let mut tokens = prop(design, "tokens").and_then(Value::as_object).cloned().unwrap_or_default();
    tokens.insert("typography".into(), Value::Object(faces));
    let mut out = design.as_object().cloned().unwrap_or_default();
    out.insert("tokens".into(), Value::Object(tokens));
    Value::Object(out)
}

static KOREAN_LANGUAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^ko(?:-|$)", "i"));

/// What `documentTypography` answers: the design's faces and the East Asian face the document pairs with them.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentTypography {
    typography: Value,
    /// `operation.nameEastAsia || (korean ? 'Malgun Gothic' : '')`, absent when empty.
    east_asia: Option<Value>,
    /// Whether the operation named an East Asian face itself.
    named: bool,
    korean: bool,
}

impl DocumentTypography {
    /// `type.display`, `type.body`, `type.data`: the Latin face of a role, absent when the design has none.
    pub fn face(&self, role: &str) -> Option<&Value> {
        prop(&self.typography, role)
    }

    /// `type.eastAsia`: the face every Korean run takes unless the Latin face beside it is a serif one.
    pub fn east_asia(&self) -> Option<&Value> {
        self.east_asia.as_ref()
    }

    /// `type.eastAsiaFor(latin)`: the East Asian face set beside a Latin one. Unnamed, a Korean document's serif Latin
    /// face takes Batang (Cambria digits beside Malgun Gothic Hangul read as two typefaces in one heading), any other
    /// the document's face. Absent when there is none.
    pub fn east_asia_for(&self, latin: Option<&Value>) -> Option<Value> {
        if !self.named && self.korean && is_serif_face(js_trim(&text(latin))) {
            return Some(Value::String("Batang".into()));
        }
        self.east_asia.clone()
    }
}

/// `documentTypography(operation, typography)`: Font coverage is script-specific, not a choice of document genre.
/// Callers can name the recipient's East Asian font independently of the Latin face.
pub fn document_typography(operation: &Value, typography: Option<&Value>) -> DocumentTypography {
    let listed = Value::Array(["title", "subtitle", "summary", "sections"].iter().map(|key| prop(operation, key).cloned().unwrap_or(Value::Null)).collect());
    let language = text(prop(operation, "language"));
    let korean = KOREAN_LANGUAGE.is_match(&language) || has_hangul(&json_stringify(&listed));
    let named = first_truthy(&[prop(operation, "nameEastAsia")]).cloned();
    let east_asia = match &named {
        Some(face) => Some(face.clone()),
        None if korean => Some(Value::String("Malgun Gothic".into())),
        None => None,
    };
    DocumentTypography { typography: typography.cloned().unwrap_or(Value::Null), east_asia, named: named.is_some(), korean }
}

/// `pairTableEastAsia(output, type)`: pairs the East Asian face with the table faces the presets set by `fontName`
/// alone, so Hangul in a cell takes the same face as the prose, never a stand-in. A face the operation already names
/// for the East Asian script stays.
pub fn pair_table_east_asia(output: &mut [Value], document: &DocumentTypography) {
    for entry in output {
        let is_table = matches!(prop(entry, "op").and_then(Value::as_str), Some("add_table" | "set_table_cell_style"));
        let Some(properties) = entry.get_mut("properties").and_then(Value::as_object_mut) else {
            continue;
        };
        let face = properties.get("fontName").filter(|value| truthy(value)).cloned();
        let Some(face) = face else { continue };
        if properties.get("fontNameEastAsia").is_some_and(truthy) || !is_table {
            continue;
        }
        if let Some(east_asia) = document.east_asia_for(Some(&face)) {
            properties.insert("fontNameEastAsia".into(), east_asia);
        }
    }
}
