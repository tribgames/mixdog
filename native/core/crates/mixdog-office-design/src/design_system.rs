//! `design/design-system.mjs`: what a design request makes of an operation list. [`expand_office_design_operations`]
//! turns the semantic operations of a document or workbook (`compose_document`, `compose_sheet`) into the portable
//! operations the writers consume, through the docx and xlsx expansions and the composition planner; a native request
//! (no profile, no composer) leaves the operations as the author wrote them. [`apply_pdf_design`] gives the blocks of a
//! PDF the preset's sizes and colours. [`resolve_office_design`] is the design in force for a request.

use std::collections::HashSet;

use mixdog_js::{js_to_lowercase, json_number, math, to_number_of};
use mixdog_office_base::values::{clone, plain_object};
use serde_json::{Map, Value, json};

use crate::composition::{CompositionUsage, plan_office_composition, resolve_office_composition_context, summarize_office_compositions};
use crate::content_model::{bind_office_content, summarize_office_content_model};
use crate::creative_director::{apply_office_creative_brief, direct_office_story};
use crate::docx::{DocxState, expand_docx_document};
use crate::native_design::{native_design_receipt, native_office_design, uses_native_office_design};
use crate::tokens::{self, compact_design};
use crate::xlsx::expand_xlsx_sheet;
use crate::{array_of, first_text, first_truthy, opt_prop, prop, text};

pub use crate::tokens::office_design_catalog;

/// `resolveOfficeDesign(format, request, { library })`: the design in force for a request (a profile name or a request
/// object), with the composition context the request implies. The errors are the texts of the ones Node throws.
pub fn resolve_office_design(format: &str, request: &Value, library: Option<&Value>) -> Result<Value, String> {
    let profile_request;
    let input = match request {
        Value::String(name) => {
            profile_request = json!({ "profile": name });
            &profile_request
        }
        object if plain_object(object) => object,
        _ => {
            profile_request = Value::Object(Map::new());
            &profile_request
        }
    };
    let context = resolve_office_composition_context(format, input, opt_prop(library, "recentCompositions"));
    tokens::resolve_office_design(format, request, library, &context)
}

/// What [`expand_office_design_operations`] takes: `{ format, operations, design, library, created, snapshotVersion }`.
#[derive(Debug, Clone, Copy)]
pub struct ExpandRequest<'a> {
    pub format: &'a str,
    /// The operation list (an array; anything else is an empty list).
    pub operations: &'a Value,
    /// The design request: a profile name, a request object, or nothing.
    pub design: &'a Value,
    pub library: Option<&'a Value>,
    /// Whether the document was just created (a fresh workbook carries one default sheet).
    pub created: bool,
    pub snapshot_version: f64,
}

/// One semantic entry of the result: the operation, what it was planned as and the binding of its content.
fn semantic_entry(name: &str, detail: (&str, Value), composition: Value, binding: Option<Value>) -> Value {
    let mut entry = Map::new();
    entry.insert("op".into(), json!(name));
    entry.insert(detail.0.into(), detail.1);
    entry.insert("composition".into(), composition);
    if let Some(binding) = binding {
        entry.insert("contentBinding".into(), binding);
    }
    Value::Object(entry)
}

/// `expandOfficeDesignOperations(request)`: `{ operations, semantic, design, content, composition }`. The errors are
/// the texts of the ones Node throws.
pub fn expand_office_design_operations(request: &ExpandRequest<'_>) -> Result<Value, String> {
    let format = js_to_lowercase(request.format);
    let operations: &[Value] = array_of(Some(request.operations)).map_or(&[], Vec::as_slice);
    if uses_native_office_design(&format, request.design, operations) {
        let design = native_office_design(&format, request.design)?;
        let content = prop(&design, "content");
        let mut bound = Vec::with_capacity(operations.len());
        for operation in operations {
            bound.push(bind_office_content(operation, content)?.operation);
        }
        return Ok(json!({
            "operations": bound,
            "semantic": [],
            "design": native_design_receipt(&design),
            "content": summarize_office_content_model(content),
            "composition": summarize_office_compositions(&format, None),
        }));
    }
    let resolved = resolve_office_design(&format, request.design, request.library)?;
    let creative = direct_office_story(&format, request.operations, &resolved);
    let mut design = resolved;
    design.as_object_mut().expect("a resolved design is an object").insert("creative".into(), creative.clone());
    let mut output: Vec<Value> = Vec::new();
    let mut semantic: Vec<Value> = Vec::new();
    let mut docx_state = DocxState::default();
    let mut composed_sheets: HashSet<String> = HashSet::new();
    let mut usage = CompositionUsage::new();
    let fresh_workbook = request.created && request.snapshot_version == 0.0;
    for (index, operation) in operations.iter().enumerate() {
        let directed = apply_office_creative_brief(operation, Some(&creative), index);
        let bound = bind_office_content(&directed, prop(&design, "content"))?;
        let content_operation = bound.operation;
        let name = text(prop(&content_operation, "op"));
        // Decks are designed by the author, not composed by the runtime: a slide is written as a pptxgenjs script
        // (action:author, pptx skill) and an existing deck is edited with the slide and shape operations.
        if format == "pptx" && name == "compose_slide" {
            return Err("compose_slide is no longer supported: author a new deck with action:author (pptx skill) and edit an existing deck with add_slide, add_textbox, add_chart, set_text, and the other slide operations.".into());
        }
        if format == "docx" && name == "compose_document" {
            let composition = plan_office_composition(&format, &content_operation, &design, &mut usage);
            output.extend(expand_docx_document(&content_operation, &design, &mut docx_state, Some(&composition))?);
            let sections = json!(array_of(prop(&content_operation, "sections")).map_or(0, Vec::len));
            semantic.push(semantic_entry(&name, ("sections", sections), composition, bound.binding));
            continue;
        }
        if format == "xlsx" && name == "compose_sheet" {
            let composition = plan_office_composition(&format, &content_operation, &design, &mut usage);
            // A fresh workbook only carries one locale-named default sheet, so the first composed sheet claims it by
            // name and later sheets are created.
            let sheet_name = first_text(&[prop(&content_operation, "sheet"), Some(&json!("Sheet1"))]);
            if fresh_workbook {
                let key = js_to_lowercase(&sheet_name);
                if composed_sheets.is_empty() {
                    output.push(json!({ "op": "rename_sheet", "name": sheet_name }));
                } else if !composed_sheets.contains(&key) {
                    output.push(json!({ "op": "add_sheet", "name": sheet_name }));
                }
                composed_sheets.insert(key);
            }
            output.extend(expand_xlsx_sheet(&content_operation, &design, Some(&composition))?);
            semantic.push(semantic_entry(&name, ("sheet", json!(sheet_name)), composition, bound.binding));
            continue;
        }
        output.push(content_operation);
    }
    let composition = summarize_office_compositions(&format, Some(&Value::Array(semantic.clone())));
    Ok(json!({
        "operations": output,
        "semantic": semantic,
        "design": compact_design(&design),
        "content": summarize_office_content_model(prop(&design, "content")),
        "composition": composition,
    }))
}

/// `{ ...block }`: the fields of a block written as an object (nothing for any other value).
fn spread(block: &Value) -> Map<String, Value> {
    block.as_object().cloned().unwrap_or_default()
}

/// Sets a field; a value that is absent (`undefined`) leaves the field out, as `JSON.stringify` does.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(written) => {
            map.insert(key.to_owned(), written);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// `block[key] || fallback`.
fn or_else(block: &Value, key: &str, fallback: Option<&Value>) -> Option<Value> {
    first_truthy(&[prop(block, key)]).or(fallback).cloned()
}

/// `block[key] ?? fallback`.
fn nullish_or(block: &Value, key: &str, fallback: Value) -> Value {
    prop(block, key).filter(|written| !written.is_null()).cloned().unwrap_or(fallback)
}

/// `applyPdfDesign(blocks, designRequest, { library })`: `{ blocks, properties, design }`. A native request
/// (no profile) gets the blocks as written and no properties.
pub fn apply_pdf_design(blocks: &[Value], design_request: &Value, library: Option<&Value>) -> Result<Value, String> {
    if uses_native_office_design("pdf", design_request, &[]) {
        return Ok(json!({
            "blocks": blocks.iter().map(clone).collect::<Vec<_>>(),
            "properties": {},
            "design": native_design_receipt(&native_office_design("pdf", design_request)?),
        }));
    }
    let design = resolve_office_design("pdf", design_request, library)?;
    let colors = opt_prop(prop(&design, "tokens"), "colors");
    let color = |key: &str| opt_prop(colors, key);
    let type_tokens = opt_prop(prop(&design, "tokens"), "typography");
    let format = prop(&design, "format");
    let size_of = |key: &str| opt_prop(format, key);
    let mut heading_index = 0u32;
    let styled: Vec<Value> = blocks
        .iter()
        .map(|block| {
            // `String(block?.type || 'paragraph').toLowerCase()`: not trimmed, so a type written with spaces is no
            // block type the preset styles.
            let type_name = js_to_lowercase(&first_text(&[prop(block, "type"), Some(&json!("paragraph"))]));
            match type_name.as_str() {
                "heading" => {
                    heading_index += 1;
                    let written_level = to_number_of(prop(block, "level"));
                    let level = if written_level.is_nan() { 0.0 } else { written_level };
                    let title = level == 1.0 || (level == 0.0 && heading_index == 1);
                    let heading_size = if title {
                        size_of("title").cloned()
                    } else if level >= 3.0 {
                        Some(json_number(math::round(to_number_of(size_of("heading")) * 0.85 * 2.0) / 2.0))
                    } else {
                        size_of("heading").cloned()
                    };
                    let mut styled = spread(block);
                    put(&mut styled, "size", or_else(block, "size", heading_size.as_ref()));
                    // Only the document title is set apart; counted by position, the first of two level-2 headings
                    // under a cover came out in ink and the second in accent.
                    put(&mut styled, "color", or_else(block, "color", if title { color("ink") } else { color("accent") }));
                    styled.insert("after".into(), nullish_or(block, "after", json!(if title { 18 } else { 10 })));
                    Value::Object(styled)
                }
                "paragraph" => {
                    let mut styled = spread(block);
                    put(&mut styled, "size", or_else(block, "size", size_of("body")));
                    put(&mut styled, "color", or_else(block, "color", color("ink")));
                    put(&mut styled, "lineHeight", or_else(block, "lineHeight", Some(&json_number(to_number_of(size_of("body")) * 1.5))));
                    styled.insert("after".into(), nullish_or(block, "after", json!(8)));
                    Value::Object(styled)
                }
                "table" => {
                    let mut styled = spread(block);
                    put(&mut styled, "color", or_else(block, "color", color("ink")));
                    put(&mut styled, "headerFill", or_else(block, "headerFill", color("inverse")));
                    put(&mut styled, "headerColor", or_else(block, "headerColor", color("onInverse")));
                    put(&mut styled, "zebraFill", or_else(block, "zebraFill", color("surface")));
                    put(&mut styled, "borderColor", or_else(block, "borderColor", color("surface2")));
                    Value::Object(styled)
                }
                // The anatomy blocks carry the preset's accent too: left to the writer's default they drew a teal
                // cover rule and teal figures under the preset's green headings.
                "cover" | "stats" | "quote" => {
                    let mut styled = spread(block);
                    put(&mut styled, "accent", or_else(block, "accent", color("accent")));
                    Value::Object(styled)
                }
                "callout" => {
                    let mut styled = spread(block);
                    put(&mut styled, "labelColor", or_else(block, "labelColor", color("accent")));
                    put(&mut styled, "fill", or_else(block, "fill", color("surface")));
                    Value::Object(styled)
                }
                _ => block.clone(),
            }
        })
        .collect();
    let mut properties = Map::new();
    put(&mut properties, "margin", size_of("margin").cloned());
    put(&mut properties, "background", color("canvas").cloned());
    put(&mut properties, "fontName", opt_prop(type_tokens, "body").cloned());
    if let Value::Object(compact) = compact_design(&design) {
        properties.extend(compact);
    }
    Ok(json!({
        "blocks": styled,
        "properties": properties,
        "design": compact_design(&design),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(format: &str, operations: Value, design: Value, created: bool) -> Result<Value, String> {
        expand_office_design_operations(&ExpandRequest { format, operations: &operations, design: &design, library: None, created, snapshot_version: 0.0 })
    }

    #[test]
    fn a_native_request_keeps_its_operations() {
        let result = expand("docx", json!([{ "op": "add_paragraph", "text": "x" }]), json!({}), true).expect("expanded");
        assert_eq!(result["operations"], json!([{ "op": "add_paragraph", "text": "x" }]));
        assert_eq!(result["semantic"], json!([]));
        assert_eq!(result["design"]["authoring"], "native");
        assert_eq!(result["composition"]["count"], 0);
    }

    #[test]
    fn a_composer_expands_through_the_preset() {
        let operations = json!([
            { "op": "compose_sheet", "sheet": "Data", "headers": ["a"], "rows": [[1]] },
            { "op": "compose_sheet", "sheet": "Other", "headers": ["a"], "rows": [[1]] },
        ]);
        let result = expand("xlsx", operations, json!({}), true).expect("expanded");
        let all = result["operations"].as_array().expect("operations");
        assert_eq!(all[0], json!({ "op": "rename_sheet", "name": "Data" }));
        assert!(all.iter().any(|operation| operation == &json!({ "op": "add_sheet", "name": "Other" })));
        assert_eq!(result["semantic"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["composition"]["count"], 2);
        assert_eq!(result["semantic"][1]["sheet"], "Other");
    }

    #[test]
    fn a_deck_composer_is_refused_and_an_unknown_profile_is_named() {
        let refused = expand("pptx", json!([{ "op": "compose_slide" }]), json!({}), false).expect_err("refused");
        assert!(refused.starts_with("compose_slide is no longer supported"));
        let unknown = expand("docx", json!([]), json!({ "profile": "nope" }), false).expect_err("unknown");
        assert!(unknown.starts_with("Unknown Office design profile \"nope\". Use one of: "));
    }

    #[test]
    fn pdf_blocks_take_the_presets_sizes_and_colours() {
        let blocks = [json!({ "type": "heading", "text": "T" }), json!({ "type": "Heading", "level": 3, "after": 0 }), json!({ "text": "p", "size": 9 }), json!({ "type": "image" })];
        let native = apply_pdf_design(&blocks, &json!({}), None).expect("native");
        assert_eq!(native["blocks"], json!(blocks));
        assert_eq!(native["properties"], json!({}));
        let styled = apply_pdf_design(&blocks, &json!({ "profile": "data" }), None).expect("styled");
        assert_eq!(styled["blocks"][0]["after"], 18);
        assert_eq!(styled["blocks"][1]["after"], 0);
        assert_eq!(styled["blocks"][2]["size"], 9);
        assert_eq!(styled["blocks"][3], json!({ "type": "image" }));
        assert!(styled["properties"]["fontName"].is_string());
        assert_eq!(styled["properties"]["profile"], "data");
    }
}
