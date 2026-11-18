//! The docx design (`design/docx/`): a `compose_document` operation expanded into the portable docx operations the
//! docx writer consumes. The front matter (page setup, document font, eyebrow, title, subtitle, meta lines, summary,
//! metric strip), one block per section (heading, paragraphs, roadmap or list, quote, table, callout, source) and the
//! page numbers or footer, in the order and with the properties Node's `expandDocxDocument` writes them, so the lists
//! are equal as JSON text.
//!
//! * [`components`]: the boxed carriers (decision callout, metric strip, roadmap) and the section tables.
//! * [`front_matter`] and [`section`]: the two halves of a document's body.
//! * [`writer`]: the paragraph writer both share.
//! * [`typography`]: the Korean faces paired with a design's Latin ones.

pub mod components;
pub mod front_matter;
pub mod section;
pub mod typography;
pub mod writer;

use mixdog_js::{json_number, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::{array_of, prop};
use typography::pair_table_east_asia;
use writer::DocxWriter;

/// `{ paragraph, table }`: how many paragraphs and tables the operations written so far hold, across the documents of
/// one design request. The writer numbers its tables by it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocxState {
    pub paragraph: u64,
    pub table: u64,
}

/// A JavaScript number as the JSON value it prints as.
pub(crate) fn num(number: f64) -> Value {
    json_number(number)
}

/// An object literal whose keys keep the order they are written in. A key written twice keeps its first place and
/// takes the last value (`{ ...a, ...b }`); a key whose value is absent (`undefined`) is left out, as `JSON.stringify`
/// leaves it.
#[derive(Debug, Clone, Default)]
pub(crate) struct Props(Map<String, Value>);

impl Props {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.into(), value.into());
        self
    }

    pub(crate) fn num(self, key: &str, value: f64) -> Self {
        self.set(key, num(value))
    }

    /// The key with its value, when there is one.
    pub(crate) fn opt(mut self, key: &str, value: Option<Value>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.into(), value);
        }
        self
    }

    /// `{ ...this, ...other }`.
    pub(crate) fn spread(mut self, other: Props) -> Self {
        for (key, value) in other.0 {
            self.0.insert(key, value);
        }
        self
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub(crate) fn into_value(self) -> Value {
        Value::Object(self.0)
    }
}

/// `design.tokens.colors`, an empty object where the design has none.
pub(crate) fn colors_of(design: &Value) -> &Value {
    static EMPTY: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| Value::Object(Map::new()));
    crate::opt_prop(prop(design, "tokens"), "colors").unwrap_or(&EMPTY)
}

/// `design.tokens.typography.<role>`: the Latin face of a role.
pub(crate) fn face_of(design: &Value, role: &str) -> Option<Value> {
    crate::opt_prop(crate::opt_prop(prop(design, "tokens"), "typography"), role).cloned()
}

/// A colour of the design: `colors[key]`.
pub(crate) fn color(design: &Value, key: &str) -> Option<Value> {
    prop(colors_of(design), key).cloned()
}

/// `a || b` over two colours of the design: the first one that is truthy.
pub(crate) fn color_or(design: &Value, keys: &[&str]) -> Option<Value> {
    let colors = colors_of(design);
    keys.iter().filter_map(|key| prop(colors, key)).find(|value| truthy(value)).cloned()
}

/// `design.format.body` and its siblings, as a number (`NaN` when the design has none).
pub(crate) fn format_of(design: &Value, key: &str) -> f64 {
    mixdog_js::to_number_of(crate::opt_prop(prop(design, "format"), key))
}

/// `String(value ?? '')`.
pub(crate) fn nullish_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(inner) => value_to_string(inner),
    }
}

/// `writeDocxFooter`: page numbers (with the footer text as their prefix) or the footer alone.
fn write_docx_footer(output: &mut Vec<Value>, operation: &Value) {
    if prop(operation, "pageNumbers") == Some(&Value::Bool(true)) {
        let footer = prop(operation, "footer").filter(|value| truthy(value));
        let prefix = footer.map_or_else(String::new, |value| format!("{} · ", value_to_string(value)));
        output.push(json!({
            "op": "add_page_numbers",
            "includeTotal": true,
            "alignment": "center",
            "prefix": prefix,
            "separator": " / ",
        }));
    } else if let Some(footer) = prop(operation, "footer").filter(|value| truthy(value)) {
        output.push(json!({ "op": "set_header_footer", "header": false, "text": value_to_string(footer) }));
    }
}


/// `expandDocxDocument(operation, sourceDesign, state, composition)`: the operations of one `compose_document`. The
/// design's Latin faces are written as given; Korean text takes a face of the Latin face's class beside it
/// (`nameEastAsia` on runs, `fontNameEastAsia` on tables) only where no East Asian face was named. `composition` is
/// the plan of the composition system (only its `id` is read; absent it is the decision brief). A section the writer
/// cannot draw is refused with the text Node throws.
pub fn expand_docx_document<'a>(
    operation: &'a Value,
    source_design: &'a Value,
    state: &'a mut DocxState,
    composition: Option<&Value>,
) -> Result<Vec<Value>, String> {
    let mut writer = DocxWriter::new(operation, source_design, state, composition);
    front_matter::write_docx_front_matter(&mut writer, operation)?;
    let sections = array_of(prop(operation, "sections")).cloned().unwrap_or_default();
    for (index, section) in sections.iter().enumerate() {
        section::write_docx_section(&mut writer, section, index)?;
    }
    write_docx_footer(&mut writer.output, operation);
    let DocxWriter { mut output, ty, .. } = writer;
    pair_table_east_asia(&mut output, &ty);
    Ok(output)
}
