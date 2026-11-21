//! `design/docx/design-docx/section.mjs`: one `compose_document` section: eyebrow + heading, paragraphs, the roadmap or
//! bullet list, quote, table, and callout.

use mixdog_js::{js_object_keys, js_to_lowercase, js_trim, to_number_of, utf16_len, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::Value;

use super::components::{CalloutOptions, add_docx_decision_callout, add_docx_roadmap, add_docx_section_table, is_cjk};
use super::writer::{DocxWriter, paragraph_text};
use super::{Props, num};
use crate::discipline::STATE_ROLES;
use crate::table_input::compose_table_rows;
use crate::tokens::strings;
use crate::{array_of, first_text, prop, text};

const SECTION_FIELDS: [&str; 18] = [
    "heading",
    "title",
    "eyebrow",
    "level",
    "pageBreak",
    "accent",
    "kind",
    "paragraphs",
    "body",
    "bullets",
    "steps",
    "quote",
    "quoteBy",
    "table",
    "source",
    "callout",
    "calloutLabel",
    "calloutTone",
];

/// `Object.keys(section || {})`: an object's own keys, the indices of a list or a text, none for the rest.
fn own_keys(section: &Value) -> Vec<String> {
    match section {
        Value::Object(map) => js_object_keys(map).into_iter().cloned().collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        Value::String(written) => (0..utf16_len(written)).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `section[first] || section[second]`: the first when it is truthy, else the second as it is written (a falsy `0` or
/// `false` there is still a value: `String(0)` is a paragraph).
fn either<'a>(section: &'a Value, first: &str, second: &str) -> Option<&'a Value> {
    prop(section, first).filter(|value| truthy(value)).or_else(|| prop(section, second))
}

fn write_section_heading(w: &mut DocxWriter, section: &Value) {
    let compact = w.compact_memo;
    let spread_break = prop(section, "pageBreak") == Some(&Value::Bool(true));
    let eyebrow = prop(section, "eyebrow").filter(|value| truthy(value));
    if let Some(eyebrow) = eyebrow {
        let properties = Props::new()
            .opt("name", w.ty.face("data").cloned())
            .num("size", 8.0)
            .set("bold", true)
            .opt("color", w.color("muted"))
            .num("spacingBefore", if compact { 5.0 } else { 10.0 })
            .num("spacingAfter", 2.0)
            .set("keepWithNext", true)
            .set("pageBreakBefore", spread_break);
        w.append(Some(value_to_string(eyebrow)), "Normal", properties);
    }
    let sub_level = to_number_of(prop(section, "level")) == 2.0;
    let mut before = if sub_level { 9.0 } else { 14.0 };
    if eyebrow.is_some() {
        before = 0.0;
    } else if compact {
        before = if sub_level { 6.0 } else { 10.0 };
    }
    let accent = prop(section, "accent") == Some(&Value::Bool(true));
    let properties = Props::new()
        .opt("name", w.ty.face("display").cloned())
        .num("size", w.format(if sub_level { "heading2" } else { "heading1" }))
        .set("bold", true)
        .opt("color", w.color(if accent { "accent" } else { "ink" }))
        .num("spacingBefore", before)
        .num("spacingAfter", if w.editorial_report { 7.0 } else { 5.0 })
        .set("keepWithNext", true)
        .set("pageBreakBefore", spread_break && eyebrow.is_none());
    w.append(paragraph_text(either(section, "heading", "title")), if sub_level { "Heading 2" } else { "Heading 1" }, properties);
}

fn write_section_list(w: &mut DocxWriter, section: &Value, kind: &str, block_follows: bool) -> Result<(), String> {
    let bullets = strings(prop(section, "bullets"));
    let steps = array_of(prop(section, "steps")).cloned().unwrap_or_default();
    let source = if steps.is_empty() { Value::Array(bullets.iter().cloned().map(Value::String).collect()) } else { Value::Array(steps.clone()) };
    let drew_steps = (kind == "roadmap" || !steps.is_empty()) && add_docx_roadmap(&mut w.output, w.state, &source, w.design);
    if !steps.is_empty() && !drew_steps {
        return Err(format!(
            "compose_document section \"{}\" has steps this writer cannot read; a step is {{ title, detail }} or a 'Label: text' string.",
            first_text(&[prop(section, "heading")])
        ));
    }
    if drew_steps {
        return Ok(());
    }
    let count = bullets.len();
    let body = w.body_size;
    for (index, bullet) in bullets.iter().enumerate() {
        let last = index + 1 == count;
        let after = if last && block_follows { w.spacing(8.0, 4.0, 6.0) } else { 3.0 };
        let properties = Props::new()
            .opt("name", w.ty.face("body").cloned())
            .num("size", body)
            .opt("color", w.color("ink"))
            .num("spacingBefore", 0.0)
            .num("spacingAfter", after)
            .num("lineSpacing", body * 1.35)
            .set("listKind", "bullet")
            .num("listLevel", 0.0)
            .set("keepWithNext", if count <= 6 { !last } else { index == 0 || index + 2 == count });
        w.append(Some(bullet.clone()), "Normal", properties);
    }
    Ok(())
}

fn write_section_source(w: &mut DocxWriter, section: &Value) {
    let Some(source) = prop(section, "source").filter(|value| truthy(value)) else { return };
    let body = w.body_size;
    let properties = Props::new()
        .opt("name", w.ty.face("body").cloned())
        .num("size", mixdog_js::math::max(8.5, body - 1.5))
        .opt("color", w.color("muted"))
        .num("spacingBefore", 4.0)
        .num("spacingAfter", w.spacing(12.0, 8.0, 10.0));
    w.append(Some(value_to_string(source)), "Normal", properties);
}

/// `entry.properties = { ...entry.properties, key: value }`.
fn set_property(entry: &mut Value, key: &str, value: Value) {
    let Some(properties) = entry.get_mut("properties").and_then(Value::as_object_mut) else { return };
    properties.insert(key.into(), value);
}

fn write_section_paragraphs(w: &mut DocxWriter, section: &Value) {
    let body = w.body_size;
    for paragraph in strings(either(section, "paragraphs", "body")) {
        let properties = Props::new()
            .opt("name", w.ty.face("body").cloned())
            .num("size", body)
            .opt("color", w.color("ink"))
            .num("spacingBefore", 0.0)
            .num("spacingAfter", w.spacing(8.0, 4.0, 6.0))
            .num("lineSpacing", body * if w.compact_memo { 1.32 } else { 1.4 });
        w.append(Some(paragraph), "Normal", properties);
    }
}

fn write_section_quote(w: &mut DocxWriter, quote: &Value, quote_by: Option<&Value>) {
    let body = w.body_size;
    let properties = Props::new()
        .opt("name", w.ty.face("display").cloned())
        .num("size", body + if w.editorial_report { 2.0 } else { 1.0 })
        // Hangul, kana, and Han have no italic, only a synthetic slant; a CJK quote is set apart by the accent alone.
        .set("italic", !value_to_string(quote).chars().any(is_cjk))
        .opt("color", w.color("accent"))
        .num("spacingBefore", 5.0)
        .num("spacingAfter", if quote_by.is_some() { 3.0 } else { 9.0 })
        .num("lineSpacing", (body + 1.0) * 1.35)
        .num("indentLeft", 36.0)
        .num("indentRight", 36.0)
        .set("keepWithNext", quote_by.is_some());
    w.append(Some(value_to_string(quote)), "Quote", properties);
    if let Some(by) = quote_by {
        let written = value_to_string(by);
        let name = written.trim_start_matches(|c: char| mixdog_js::is_js_space(c) || matches!(c, '—' | '–' | '-'));
        let properties = Props::new()
            .opt("name", w.ty.face("body").cloned())
            .num("size", mixdog_js::math::max(8.5, body - 1.5))
            .opt("color", w.color("muted"))
            .num("spacingBefore", 0.0)
            .num("spacingAfter", 9.0)
            .num("indentLeft", 36.0);
        w.append(Some(format!("— {name}")), "Normal", properties);
    }
}

fn write_section_table(w: &mut DocxWriter, section: &Value, table: &[Value], kind: &str, callout_follows: bool) {
    let named = text(w.table_style);
    add_docx_section_table(&mut w.output, w.state, table, w.design, kind, &named);
    if prop(section, "source").is_some_and(truthy) {
        if let Some(entry) = w.output.iter_mut().rev().find(|entry| prop(entry, "op").and_then(Value::as_str) == Some("add_table")) {
            set_property(entry, "keepWithNext", Value::Bool(true));
        }
        write_section_source(w, section);
    } else if callout_follows {
        let is_spacer =
            |entry: &Value| prop(entry, "op").and_then(Value::as_str) == Some("append_text") && prop(entry, "text").and_then(Value::as_str) == Some("\u{00A0}");
        if let Some(entry) = w.output.iter_mut().rev().find(|entry| is_spacer(entry)) {
            set_property(entry, "spacingAfter", num(10.0));
        }
    }
}

fn write_section_callout(w: &mut DocxWriter, section: &Value, callout: &Value) {
    let label = prop(section, "calloutLabel").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
    let tone = text(prop(section, "calloutTone"));
    let options = CalloutOptions {
        label: &label,
        emphasis: if STATE_ROLES.contains(&tone.as_str()) { &tone } else { "accent" },
        east_asia: w.ty.east_asia_for(w.ty.face("display")),
    };
    add_docx_decision_callout(&mut w.output, w.state, &value_to_string(callout), w.design, &options);
}

/// `writeDocxSection(w, section, sectionIndex)`: a field the writer cannot draw is refused, and so is a step list it
/// cannot read or a table of a shape nobody can write.
pub fn write_docx_section(w: &mut DocxWriter, section: &Value, section_index: usize) -> Result<(), String> {
    let unknown: Vec<String> = own_keys(section).into_iter().filter(|field| !SECTION_FIELDS.contains(&field.as_str())).collect();
    if !unknown.is_empty() {
        return Err(format!(
            "compose_document sections[{}] has field(s) it cannot draw: {}. A section takes {}; a plan is steps:[{{ title, detail }}].",
            section_index + 1,
            unknown.join(", "),
            SECTION_FIELDS.join(", ")
        ));
    }
    if section.is_null() {
        return Err("Cannot read properties of null (reading 'kind')".into());
    }
    let kind = js_to_lowercase(js_trim(&text(prop(section, "kind"))));
    write_section_heading(w, section);
    write_section_paragraphs(w, section);
    let table = compose_table_rows(prop(section, "table"), &format!("compose_document sections[{}].table", section_index + 1), true)?;
    let quote = prop(section, "quote").filter(|value| truthy(value));
    let callout = prop(section, "callout").filter(|value| truthy(value));
    write_section_list(w, section, &kind, quote.is_none() && (!table.is_empty() || callout.is_some()))?;
    if let Some(quote) = quote {
        write_section_quote(w, quote, prop(section, "quoteBy").filter(|value| truthy(value)));
    }
    if !table.is_empty() {
        write_section_table(w, section, &table, &kind, callout.is_some());
    }
    if let Some(callout) = callout {
        write_section_callout(w, section, callout);
    }
    if table.is_empty() {
        write_section_source(w, section);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_falsy_first_field_gives_way_to_the_second_as_written() {
        let section = json!({ "heading": "", "title": 0, "paragraphs": false, "body": false });
        assert_eq!(either(&section, "heading", "title"), Some(&json!(0)));
        assert_eq!(strings(either(&section, "paragraphs", "body")), vec!["false".to_owned()]);
        assert_eq!(either(&json!({ "heading": "H", "title": "T" }), "heading", "title"), Some(&json!("H")));
        assert_eq!(either(&json!({}), "heading", "title"), None);
    }

    fn expand_section(section: Value) -> Result<Vec<Value>, String> {
        let operations = json!([{ "op": "compose_document", "sections": [section] }]);
        let request = crate::design_system::ExpandRequest {
            format: "docx",
            operations: &operations,
            design: &json!({}),
            library: None,
            created: true,
            snapshot_version: 0.0,
        };
        let result = crate::design_system::expand_office_design_operations(&request)?;
        Ok(result["operations"].as_array().cloned().unwrap_or_default())
    }

    fn paragraph<'a>(operations: &'a [Value], written: &str) -> &'a Value {
        operations.iter().find(|entry| entry["op"] == "append_text" && entry["text"] == written).unwrap_or_else(|| panic!("no paragraph {written}"))
    }

    #[test]
    fn a_section_writes_its_heading_paragraphs_list_quote_and_source_in_order() {
        let operations = expand_section(json!({
            "heading": "H", "paragraphs": ["P"], "bullets": ["a", "b"], "quote": "Q", "quoteBy": "- Who", "table": [["Name", "Qty"], ["x", "1"]], "source": "S"
        }))
        .expect("a section");
        let texts: Vec<&str> = operations.iter().filter(|entry| entry["op"] == "append_text").filter_map(|entry| entry["text"].as_str()).collect();
        let position = |written: &str| texts.iter().position(|entry| *entry == written).unwrap_or_else(|| panic!("no {written}"));
        assert!(
            position("H") < position("P")
                && position("P") < position("a")
                && position("b") < position("Q")
                && position("Q") < position("— Who")
                && position("— Who") < position("S")
        );
        assert_eq!(paragraph(&operations, "H")["style"], "Heading 1");
        assert_eq!(paragraph(&operations, "a")["properties"]["listKind"], "bullet");
        assert_eq!(paragraph(&operations, "a")["properties"]["keepWithNext"], true);
        assert_eq!(paragraph(&operations, "b")["properties"]["keepWithNext"], false);
        let quote = paragraph(&operations, "Q");
        assert_eq!(quote["style"], "Quote");
        assert_eq!(quote["properties"]["indentLeft"], 36);
        assert_eq!(quote["properties"]["indentRight"], 36);
        assert_eq!(quote["properties"]["keepWithNext"], true);
        assert_eq!(paragraph(&operations, "— Who")["properties"]["indentLeft"], 36);
        let table = operations.iter().find(|entry| entry["op"] == "add_table").expect("a table");
        assert_eq!(table["properties"]["keepWithNext"], true);
    }

    #[test]
    fn a_field_the_writer_cannot_draw_is_refused_by_name() {
        let refused = expand_section(json!({ "heading": "H", "roadmap": [] })).expect_err("refused");
        assert!(refused.starts_with("compose_document sections[1] has field(s) it cannot draw: roadmap."), "{refused}");
    }
}
