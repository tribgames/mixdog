//! `design/docx/design-docx/front-matter.mjs`: page setup and the document's opening block: eyebrow, title, subtitle,
//! meta line, the summary (as a decision callout for brief compositions) and the metric strip.

use mixdog_js::{math, to_number_of, value_to_string};
use serde_json::{Value, json};

use super::components::{CalloutOptions, add_docx_decision_callout, add_docx_metric_strip};
use super::writer::{DocxWriter, paragraph_text};
use super::{Props, num};
use crate::tokens::strings;
use crate::prop;
use mixdog_office_base::values::truthy;

/// `writeDocxFrontMatter(w, operation)`.
pub fn write_docx_front_matter(w: &mut DocxWriter, operation: &Value) -> Result<(), String> {
    let body_size = w.body_size;
    let compact = w.compact_memo;
    if prop(operation, "page") != Some(&Value::Bool(false)) {
        let orientation = prop(operation, "orientation").filter(|value| truthy(value)).cloned().unwrap_or_else(|| Value::String("portrait".into()));
        let margin = num(w.page_margin);
        w.output.push(json!({
            "op": "set_page",
            "properties": {
                "orientation": orientation,
                "topMargin": margin,
                "bottomMargin": margin,
                "leftMargin": margin,
                "rightMargin": margin,
            },
        }));
    }
    // The document's own face and size are the body's: set per paragraph alone, a paragraph added later (by
    // append_text or by hand in Word) came out in Calibri 11 pt beside a Malgun Gothic 10.5 pt body.
    let body_face = w.ty.face("body").cloned();
    let east_asia = w.ty.east_asia_for(body_face.as_ref());
    let font = Props::new().opt("name", body_face.clone()).opt("nameEastAsia", east_asia).num("size", body_size).opt("color", w.color("ink"));
    w.output.push(json!({ "op": "set_document_font", "properties": font.into_value() }));
    let (data, display) = (w.ty.face("data").cloned(), w.ty.face("display").cloned());
    if let Some(eyebrow) = prop(operation, "eyebrow").filter(|value| truthy(value)) {
        let properties = Props::new()
            .opt("name", data)
            .num("size", 8.5)
            .set("bold", true)
            .opt("color", w.color("accent"))
            .num("spacingBefore", 0.0)
            .num("spacingAfter", 6.0)
            .set("keepWithNext", true);
        w.append(paragraph_text(Some(eyebrow)), "Normal", properties);
    }
    // A title that wraps reads as one block at an exact 1.25 x its size: on the face's own line (Malgun Gothic's is
    // nearly twice the size) its two lines stood apart like two paragraphs.
    let named_size = to_number_of(prop(operation, "titleSize"));
    let title_size = if named_size == 0.0 || named_size.is_nan() { math::min(24.0, w.format("title")) } else { named_size };
    let spacing_after = w.spacing(12.0, 5.0, 8.0);
    let title = Props::new()
        .opt("name", display.clone())
        .num("size", title_size)
        .set("bold", true)
        .opt("color", w.color("ink"))
        .num("spacingBefore", 0.0)
        .num("spacingAfter", spacing_after)
        .num("lineSpacing", math::round(title_size * 1.25 * 2.0) / 2.0)
        .set("lineSpacingRule", "exact")
        .set("keepWithNext", true);
    w.append(paragraph_text(prop(operation, "title")), "Title", title);
    let subtitle = Props::new()
        .opt("name", body_face.clone())
        .num("size", body_size)
        .opt("color", w.color("muted"))
        .num("spacingBefore", 0.0)
        .num("spacingAfter", if compact { 7.0 } else { 12.0 })
        .num("lineSpacing", body_size * 1.35);
    w.append(paragraph_text(prop(operation, "subtitle")), "Normal", subtitle);
    let meta = strings(prop(operation, "meta"));
    // One meta item per line: a joined string invents a separator the author never chose.
    for (index, item) in meta.iter().enumerate() {
        let last = index == meta.len() - 1;
        let properties = Props::new()
            .opt("name", body_face.clone())
            .num("size", math::max(8.5, body_size - 1.0))
            .opt("color", w.color("muted"))
            .num("spacingBefore", 0.0)
            .num("spacingAfter", if last { if compact { 8.0 } else { 14.0 } } else { 0.0 })
            .set("keepWithNext", !last);
        w.append(Some(item.clone()), "Normal", properties);
    }
    if let Some(summary) = prop(operation, "summary").filter(|value| truthy(value)) {
        let joined = strings(Some(summary)).join(" ");
        // A label the author gave is drawn whatever the composition reads the document as: labels are opt-in, and
        // dropped without a word it left a report's "결론" as a plain bold paragraph.
        if let Some(label) = prop(operation, "summaryLabel").filter(|value| truthy(value)) {
            let label = value_to_string(label);
            let options = CalloutOptions {
                label: &label,
                emphasis: if w.decision_brief { "inverse" } else { "accent" },
                east_asia: w.ty.east_asia_for(display.as_ref()),
            };
            add_docx_decision_callout(&mut w.output, w.state, &joined, w.design, &options);
        } else {
            let spacing_after = w.spacing(18.0, 9.0, 14.0);
            let properties = Props::new()
                .opt("name", display)
                .num("size", body_size + 1.0)
                .set("bold", true)
                .opt("color", w.color("ink"))
                .num("spacingBefore", if compact { 2.0 } else { 4.0 })
                .num("spacingAfter", spacing_after)
                .num("lineSpacing", (body_size + 1.0) * 1.35)
                .set("keepWithNext", true);
            w.append(Some(joined), "Normal", properties);
        }
    }
    if let Some(metrics) = prop(operation, "metrics").filter(|value| value.as_array().is_some_and(|list| !list.is_empty())) {
        add_docx_metric_strip(&mut w.output, w.state, metrics, w.design)?;
    }
    Ok(())
}
