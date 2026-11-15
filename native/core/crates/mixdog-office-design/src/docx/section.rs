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

/// What a section can carry. A field outside this list would vanish: a plan written as `roadmap:[…]` would reach the
/// page as a heading with nothing under it, and the composer would report success.
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
    // A section that names steps draws them. Reaching the page only with kind:'roadmap' would land a plan section as
    // a heading with nothing under it, and the audit would report the orphan heading the composer had just written.
    let steps = array_of(prop(section, "steps")).cloned().unwrap_or_default();
    let source = if steps.is_empty() { Value::Array(bullets.iter().cloned().map(Value::String).collect()) } else { Value::Array(steps.clone()) };
    let drew_steps = (kind == "roadmap" || !steps.is_empty()) && add_docx_roadmap(&mut w.output, w.state, &source, w.design);
    if !steps.is_empty() && !drew_steps {
        return Err(format!(
            "compose_document section \"{}\" has steps this writer cannot read; a step is {{ title, detail }} or a 'Label: text' string.",
            first_text(&[prop(section, "heading")])
        ));
    }
    // The roadmap carries the section's list.
    if drew_steps {
        return Ok(());
    }
    // A table or callout takes no space above itself, so the list's last item leaves the paragraph gap: at the items'
    // own 3 pt the table's header sat on the last bullet. A short list keeps together and a long one keeps its first
    // two and last two items together, as the PDF writer breaks a list: a three-item list left its first bullet alone
    // at the foot of a page.
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

/// The section's source, in the muted caption a table carries in the native anatomy: every number needs one, and the
/// preset had nowhere to say it, so a report written through it lost the table's 자료 line.
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
    let table = compose_table_rows(prop(section, "table"), &format!("compose_document sections[{}].table", section_index + 1), true)?;
    let quote = prop(section, "quote").filter(|value| truthy(value));
    let callout = prop(section, "callout").filter(|value| truthy(value));
    write_section_list(w, section, &kind, quote.is_none() && (!table.is_empty() || callout.is_some()))?;
    if let Some(quote) = quote {
        let quote_by = prop(section, "quoteBy").filter(|value| truthy(value));
        let properties = Props::new()
            .opt("name", w.ty.face("display").cloned())
            .num("size", body + if w.editorial_report { 2.0 } else { 1.0 })
            // Hangul, kana, and Han have no italic, only a synthetic slant; a CJK quote is set apart by the accent alone.
            .set("italic", !value_to_string(quote).chars().any(is_cjk))
            .opt("color", w.color("accent"))
            .num("spacingBefore", 5.0)
            .num("spacingAfter", if quote_by.is_some() { 3.0 } else { 9.0 })
            .num("lineSpacing", (body + 1.0) * 1.35)
            // The inset is the composer's, not the Quote style's: a Korean Word's own Quote has none, so the same
            // quote sat flush with the body in Word and 36 pt in from both edges in the portable file.
            .num("indentLeft", 36.0)
            .num("indentRight", 36.0)
            .set("keepWithNext", quote_by.is_some());
        w.append(Some(value_to_string(quote)), "Quote", properties);
        // Who said it, under the quote in the caption's muted type: a quote had no speaker in the preset.
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
    if !table.is_empty() {
        // The operation names the table style: a section's own `tableStyle` is not a field it may carry.
        let named = text(w.table_style);
        add_docx_section_table(&mut w.output, w.state, &table, w.design, &kind, &named);
        if prop(section, "source").is_some_and(truthy) {
            // The table keeps with its source line, as a native table keeps with its caption.
            if let Some(entry) = w.output.iter_mut().rev().find(|entry| prop(entry, "op").and_then(Value::as_str) == Some("add_table")) {
                set_property(entry, "keepWithNext", Value::Bool(true));
            }
            write_section_source(w, section);
        } else if callout.is_some() {
            // A callout is a box of its own. Straight under the table, the table's 2 pt spacer set the box on its last
            // rule as one slab; the spacer leaves the gap a callout keeps below itself.
            let is_spacer = |entry: &Value| {
                prop(entry, "op").and_then(Value::as_str) == Some("append_text") && prop(entry, "text").and_then(Value::as_str) == Some("\u{00A0}")
            };
            if let Some(entry) = w.output.iter_mut().rev().find(|entry| is_spacer(entry)) {
                set_property(entry, "spacingAfter", num(10.0));
            }
        }
    }
    if let Some(callout) = callout {
        let label = prop(section, "calloutLabel").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
        let tone = text(prop(section, "calloutTone"));
        let options = CalloutOptions {
            label: &label,
            emphasis: if STATE_ROLES.contains(&tone.as_str()) { &tone } else { "accent" },
            east_asia: w.ty.east_asia_for(w.ty.face("display")),
        };
        add_docx_decision_callout(&mut w.output, w.state, &value_to_string(callout), w.design, &options);
    }
    // A section without a table ends on its source.
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
}
