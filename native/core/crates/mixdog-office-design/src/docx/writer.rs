//! `design/docx/design-docx/writer.mjs`: the paragraph writer one `compose_document` expansion shares: the output
//! operation list, the composition flags that drive spacing and sizes, and `append`, which stamps every paragraph
//! with the document typography.

use mixdog_js::{math, value_to_string};
use serde_json::{Value, json};

use super::typography::{DocumentTypography, document_typography};
use super::{DocxState, Props, color, format_of};
use crate::{opt_prop, prop, text};

pub struct DocxWriter<'a> {
    pub output: Vec<Value>,
    pub state: &'a mut DocxState,
    pub design: &'a Value,
    pub ty: DocumentTypography,
    pub compact_memo: bool,
    pub editorial_report: bool,
    pub decision_brief: bool,
    /// `operation.tableStyle`, as the operation wrote it.
    pub table_style: Option<&'a Value>,
    pub page_margin: f64,
    pub body_size: f64,
}

/// The text a paragraph is written with: nothing for `null`, `undefined` and the empty text (`text == null || text === ''`),
/// `String(text)` for anything else.
pub fn paragraph_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(written)) if written.is_empty() => None,
        Some(other) => Some(value_to_string(other)),
    }
}

impl<'a> DocxWriter<'a> {
    /// `createDocxWriter({ operation, design, state, composition })`.
    pub fn new(operation: &'a Value, design: &'a Value, state: &'a mut DocxState, composition: Option<&Value>) -> Self {
        let ty = document_typography(operation, opt_prop(prop(design, "tokens"), "typography"));
        let written = text(composition.and_then(|plan| prop(plan, "id")));
        let composition_id = if written.is_empty() { "decision-brief".to_owned() } else { written };
        let compact_memo = composition_id == "compact-memo";
        let editorial_report = composition_id == "editorial-report";
        let margin = format_of(design, "margin");
        let page_margin = if compact_memo {
            math::max(46.8, margin * 0.84)
        } else if editorial_report {
            margin * 1.08
        } else {
            margin
        };
        let body = format_of(design, "body");
        let body_size = if compact_memo { math::max(9.5, body - 0.5) } else { body };
        Self {
            output: Vec::new(),
            state,
            design,
            ty,
            compact_memo,
            editorial_report,
            decision_brief: composition_id == "decision-brief",
            table_style: prop(operation, "tableStyle"),
            page_margin,
            body_size,
        }
    }

    /// Composition-specific spacing: the editorial report breathes, the compact memo tightens.
    pub fn spacing(&self, editorial: f64, compact: f64, standard: f64) -> f64 {
        if self.editorial_report {
            editorial
        } else if self.compact_memo {
            compact
        } else {
            standard
        }
    }

    /// `colors[key]`.
    pub fn color(&self, key: &str) -> Option<Value> {
        color(self.design, key)
    }

    /// `format[key]` of the design (`title`, `margin`, `body`, `heading1`, `heading2`).
    pub fn format(&self, key: &str) -> f64 {
        format_of(self.design, key)
    }

    /// `append(text, style, properties)`: one paragraph, stamped with the East Asian face beside the face it names.
    pub(crate) fn append(&mut self, written: Option<String>, style: &str, properties: Props) {
        let Some(written) = written.filter(|inner| !inner.is_empty()) else { return };
        self.state.paragraph += 1;
        let east_asia = self.ty.east_asia_for(properties.get("name"));
        let stamped =
            Props::new().set("alignment", "left").set("keepWithNext", false).set("widowControl", true).opt("nameEastAsia", east_asia).spread(properties);
        self.output.push(json!({ "op": "append_text", "text": written, "style": style, "properties": stamped.into_value() }));
    }
}
