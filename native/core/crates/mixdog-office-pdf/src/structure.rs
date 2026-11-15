//! `pdf/pdf-batch-structure.mjs`: the batch operations on the document's structure: page order and rotation,
//! extraction and splitting, merging, bookmarks, metadata, attachments and re-serialization. The document is one value
//! held in memory for the whole batch; an operation that writes a file of its own (an extraction, a split, an
//! extracted attachment) reports `documentChanged: false` and leaves the document whole.

use std::path::Path;
use std::sync::Arc;

use mixdog_fsio::WriteProof;
use mixdog_js::{js_trim, json_number, to_number, value_to_string};
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::attachments::AttachmentOptions;
use mixdog_pdf::write::outline::OutlineEntry;
use mixdog_pdf::write::{PdfDocument, Rect, SaveOptions};
use serde_json::{Map, Value, json};

use crate::adapter::{BatchState, OperationSet};
use crate::analysis::round2;
use crate::document::AnalysisError;
use crate::edit_document::{
    edit_error, js_string, load_pdf, present, read_file, resolve_beside, selected_edit_pages, truthy, write_sibling,
};

/// The operations this module runs.
const OPERATIONS: [&str; 12] = [
    "rotate_pages",
    "crop_pages",
    "delete_pages",
    "extract_pages",
    "split_pages",
    "move_page",
    "merge_pdf",
    "add_bookmark",
    "set_metadata",
    "add_attachment",
    "extract_attachment",
    "compress",
];

/// `STRUCTURE_OPERATIONS`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StructureOperations;

impl<P: WriteProof> OperationSet<P> for StructureOperations {
    fn supports(&self, op: &str) -> bool {
        OPERATIONS.contains(&op)
    }

    fn run(&self, state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
        match js_string(operation.get("op")).as_str() {
            "rotate_pages" => rotate_pages(state, operation),
            "crop_pages" => crop_pages(state, operation),
            "delete_pages" => delete_pages(state, operation),
            "extract_pages" => extract_pages(state, operation),
            "split_pages" => split_pages(state, operation),
            "move_page" => move_page(state, operation),
            "merge_pdf" => merge_pdf(state, operation),
            "add_bookmark" => add_bookmark(state, operation),
            "set_metadata" => set_metadata(state, operation),
            "add_attachment" => add_attachment(state, operation),
            "extract_attachment" => extract_attachment(state, operation),
            "compress" => Ok(compress(state, operation)),
            other => Err(AnalysisError::plain(format!("PDF backend does not support operation: {other}"))),
        }
    }
}

fn op_name(operation: &Value) -> Value {
    Value::from(js_string(operation.get("op")))
}

/// `Number(value)` as a JSON number.
fn num(value: f64) -> Value {
    json_number(value)
}

fn rotate_pages<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let delta = match operation.get("rotation") {
        Some(value) if !value.is_null() => to_number(value),
        _ => 90.0,
    };
    if !delta.is_finite() || delta.fract() != 0.0 || delta % 90.0 != 0.0 {
        return Err(AnalysisError::plain(format!(
            "PDF rotation must be a multiple of 90 degrees: {}",
            js_string(operation.get("rotation"))
        )));
    }
    let absolute = operation.get("absolute").is_some_and(truthy);
    let mut pages = Vec::new();
    for selected in selected_edit_pages(&state.document, operation)? {
        let current = state.document.rotation(selected.page).map_err(edit_error)?;
        let next = (((if absolute { delta } else { current + delta }) % 360.0) + 360.0) % 360.0;
        state.document.set_rotation(selected.page, next).map_err(edit_error)?;
        pages.push((selected.index + 1, current, next));
    }
    let changed = pages.iter().any(|(_, from, rotation)| from != rotation);
    let pages: Vec<Value> = pages
        .into_iter()
        .map(|(page, from, rotation)| json!({ "page": page, "from": num(from), "rotation": num(rotation) }))
        .collect();
    Ok(json!({ "op": op_name(operation), "changed": changed, "pages": pages }))
}

const LEFT: usize = 0;
const RIGHT: usize = 1;
const TOP: usize = 2;
const BOTTOM: usize = 3;
const CROP_SIDES: [(&str, usize); 4] = [("left", LEFT), ("right", RIGHT), ("top", TOP), ("bottom", BOTTOM)];

/// `DISPLAYED_SIDES[rotation]`: which side of the unrotated page each side a reader sees falls on (a page turned 90
/// degrees clockwise shows its own left edge at the top); indexed by the displayed side. A rotation that is not a
/// quarter turn is read as none.
fn displayed_sides(rotation: f64) -> [usize; 4] {
    if rotation == 90.0 {
        [BOTTOM, TOP, LEFT, RIGHT]
    } else if rotation == 180.0 {
        [RIGHT, LEFT, BOTTOM, TOP]
    } else if rotation == 270.0 {
        [TOP, BOTTOM, RIGHT, LEFT]
    } else {
        [LEFT, RIGHT, TOP, BOTTOM]
    }
}

/// Trims each selected page by points from the sides as displayed. The media box follows the crop box, so the
/// snapshot's width, height and origin keep describing the page a reader sees. The trimmed content stays in the file.
fn crop_pages<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let mut trims = [0.0f64; 4];
    for (name, side) in CROP_SIDES {
        let value = [operation.get(name), operation.get("margin")]
            .into_iter()
            .find(|value| present(*value))
            .flatten();
        trims[side] = value.map_or(0.0, to_number);
    }
    if !trims.iter().all(|trim| trim.is_finite() && *trim >= 0.0) {
        return Err(AnalysisError::plain("crop_pages left, right, top, bottom, and margin are points of zero or more"));
    }
    if trims.iter().all(|trim| *trim == 0.0) {
        return Err(AnalysisError::plain("crop_pages needs left, right, top, bottom, or margin in points"));
    }
    let mut pages = Vec::new();
    for selected in selected_edit_pages(&state.document, operation)? {
        let angle = state.document.rotation(selected.page).map_err(edit_error)?;
        let rotation = ((angle % 360.0) + 360.0) % 360.0;
        let sides = displayed_sides(rotation);
        let mut cut = [0.0f64; 4];
        for (_, side) in CROP_SIDES {
            cut[sides[side]] = trims[side];
        }
        let region = state.document.crop_box(selected.page).map_err(edit_error)?;
        let width = region.width - cut[LEFT] - cut[RIGHT];
        let height = region.height - cut[BOTTOM] - cut[TOP];
        if width < 1.0 || height < 1.0 {
            return Err(AnalysisError::plain(format!(
                "crop_pages would leave page {} empty: it is {} x {} pt before trimming",
                selected.index + 1,
                mixdog_js::number_to_string(round2(region.width)),
                mixdog_js::number_to_string(round2(region.height)),
            )));
        }
        let trimmed = Rect { x: region.x + cut[LEFT], y: region.y + cut[BOTTOM], width, height };
        state.document.set_media_box(selected.page, trimmed).map_err(edit_error)?;
        state.document.set_crop_box(selected.page, trimmed).map_err(edit_error)?;
        pages.push(json!({
            "page": selected.index + 1,
            "from": { "width": num(round2(region.width)), "height": num(round2(region.height)) },
            "to": { "width": num(round2(width)), "height": num(round2(height)) },
        }));
    }
    Ok(json!({ "op": op_name(operation), "changed": true, "pages": pages }))
}

fn delete_pages<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let mut indexes: Vec<usize> = selected_edit_pages(&state.document, operation)?.iter().map(|page| page.index).collect();
    indexes.sort_by(|a, b| b.cmp(a));
    if indexes.len() >= state.document.page_count() {
        return Err(AnalysisError::plain("delete_pages cannot remove every page; use extract_pages or delete fewer pages"));
    }
    for index in &indexes {
        state.document.remove_page(*index).map_err(edit_error)?;
    }
    state.document.drop_fields_off_the_pages().map_err(edit_error)?;
    Ok(json!({
        "op": op_name(operation),
        "changed": !indexes.is_empty(),
        "count": indexes.len(),
        "pageCount": state.document.page_count(),
    }))
}

fn page_indexes<P: WriteProof>(state: &BatchState<'_, P>, operation: &Value) -> Result<Vec<usize>, AnalysisError> {
    Ok(selected_edit_pages(&state.document, operation)?.iter().map(|page| page.index).collect())
}

fn save_bytes(document: &PdfDocument) -> Vec<u8> {
    document.save(SaveOptions::default())
}

fn extract_pages<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let indexes = page_indexes(state, operation)?;
    let pages: Vec<usize> = indexes.iter().map(|index| index + 1).collect();
    if let Some(target) = operation.get("output").filter(|output| truthy(output)) {
        // With an output the session document stays whole; the subset is a new file.
        let next = state.document.copy_to_new_document(&indexes).map_err(edit_error)?;
        let output = write_sibling(state.proof, state.note, state.path, &value_to_string(target), &save_bytes(&next))?;
        return Ok(json!({
            "op": op_name(operation),
            "changed": true,
            "documentChanged": false,
            "output": output.to_string_lossy(),
            "count": indexes.len(),
            "pages": pages,
        }));
    }
    state.document.keep_pages_in_order(&indexes).map_err(edit_error)?;
    Ok(json!({ "op": op_name(operation), "changed": true, "count": indexes.len(), "pages": pages }))
}

fn split_pages<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let asked = operation.get("every").map_or(f64::NAN, to_number);
    let every = (if asked.is_nan() || asked == 0.0 { 1.0 } else { asked.floor() }).max(1.0);
    let indexes = page_indexes(state, operation)?;
    // Past the last page one group holds the rest.
    let group_size = if every >= indexes.len() as f64 { indexes.len().max(1) } else { every as usize };
    let stem = state.path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let directory = match operation.get("output") {
        Some(target) if truthy(target) => value_to_string(target),
        _ => ".".to_owned(),
    };
    let directory = resolve_beside(state.path, &directory);
    let mut files = Vec::new();
    for group in indexes.chunks(group_size) {
        let part = state.document.copy_to_new_document(group).map_err(edit_error)?;
        let first = format!("{:03}", group[0] + 1);
        let label = if group.len() == 1 {
            first
        } else {
            format!("{first}-{:03}", group[group.len() - 1] + 1)
        };
        let target = directory.join(format!("{stem}-{label}.pdf"));
        let output = write_sibling(state.proof, state.note, state.path, &target.to_string_lossy(), &save_bytes(&part))?;
        files.push(json!({
            "output": output.to_string_lossy(),
            "pages": group.iter().map(|index| index + 1).collect::<Vec<_>>(),
        }));
    }
    Ok(json!({
        "op": op_name(operation),
        "changed": !files.is_empty(),
        "documentChanged": false,
        "count": files.len(),
        "files": files,
    }))
}

fn move_page<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let from = operation.get("page").map_or(f64::NAN, to_number) - 1.0;
    let to = operation.get("index").map_or(f64::NAN, to_number) - 1.0;
    let count = state.document.page_count();
    let whole = |value: f64| value.is_finite() && value.fract() == 0.0 && value >= 0.0 && value < count as f64;
    if !whole(from) {
        return Err(AnalysisError::plain(format!("PDF page out of range: {}", js_string(operation.get("page")))));
    }
    if !whole(to) {
        return Err(AnalysisError::plain(format!(
            "PDF destination page out of range: {}",
            js_string(operation.get("index"))
        )));
    }
    let (from, to) = (from as usize, to as usize);
    let mut order: Vec<usize> = (0..count).collect();
    let moved = order.remove(from);
    order.insert(to, moved);
    state.document.keep_pages_in_order(&order).map_err(edit_error)?;
    Ok(json!({ "op": op_name(operation), "changed": from != to, "from": from + 1, "to": to + 1 }))
}

/// `mergeSources(operation)`: `sources` when it is a non-empty array, else `path`.
fn merge_sources(operation: &Value) -> Result<Vec<Value>, AnalysisError> {
    match operation.get("sources") {
        Some(Value::Array(sources)) if !sources.is_empty() => return Ok(sources.clone()),
        _ => {}
    }
    match operation.get("path") {
        Some(path) if truthy(path) => Ok(vec![path.clone()]),
        _ => Err(AnalysisError::plain("merge_pdf needs sources:[path | { path, pages }] or path")),
    }
}

/// The file stem the bookmark of a merged source is titled with.
fn stem_of(path: &Path) -> String {
    path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default()
}

fn merge_pdf<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let sources = merge_sources(operation)?;
    let mut insert_at: Option<usize> = None;
    if present(operation.get("index")) {
        let index = to_number(&operation["index"]) - 1.0;
        if !index.is_finite() || index.fract() != 0.0 || index < 0.0 || index > state.document.page_count() as f64 {
            return Err(AnalysisError::plain(format!(
                "PDF insertion index out of range: {}",
                js_string(operation.get("index"))
            )));
        }
        insert_at = Some(index as usize);
    }
    struct Merged {
        path: String,
        pages: Vec<usize>,
        added: usize,
        form_fields: usize,
        at: usize,
        title: String,
    }
    let mut merged: Vec<Merged> = Vec::new();
    for entry in &sources {
        let named = match entry {
            Value::String(text) => text.clone(),
            other => other.get("path").filter(|path| truthy(path)).map_or_else(String::new, value_to_string),
        };
        let source_path = resolve_beside(state.path, &named);
        let other = load_pdf(&read_file(state.proof, &source_path)?, false)?;
        let selection = match entry {
            Value::String(_) => json!({}),
            other_entry => json!({
                "pages": other_entry.get("pages").cloned().unwrap_or(Value::Null),
                "page": other_entry.get("page").cloned().unwrap_or(Value::Null),
            }),
        };
        let indexes: Vec<usize> = selected_edit_pages(&other, &selection)?.iter().map(|page| page.index).collect();
        let copied = state.document.copy_pages(&other, &indexes).map_err(edit_error)?;
        let first_page = insert_at.unwrap_or_else(|| state.document.page_count());
        for page in &copied {
            match insert_at {
                None => state.document.append_page(*page).map_err(edit_error)?,
                Some(at) => {
                    state.document.insert_page(at, *page).map_err(edit_error)?;
                    insert_at = Some(at + 1);
                }
            }
        }
        let form_fields = state.document.register_copied_fields(&copied).map_err(edit_error)?;
        let title = match entry {
            Value::String(_) => String::new(),
            other_entry => other_entry.get("title").filter(|title| truthy(title)).map_or_else(String::new, value_to_string),
        };
        merged.push(Merged {
            path: source_path.to_string_lossy().into_owned(),
            pages: indexes.iter().map(|index| index + 1).collect(),
            added: copied.len(),
            form_fields,
            at: first_page + 1,
            title,
        });
    }
    let pages_added: usize = merged.iter().map(|entry| entry.added).sum();
    let bookmarks_asked = operation.get("bookmarks") == Some(&Value::Bool(true));
    let bookmarks = if bookmarks_asked {
        let entries: Vec<OutlineEntry> = merged
            .iter()
            .filter(|entry| entry.added > 0)
            .map(|entry| OutlineEntry {
                title: if entry.title.is_empty() { stem_of(Path::new(&entry.path)) } else { entry.title.clone() },
                page_index: entry.at - 1,
            })
            .collect();
        state.document.add_outline_entries(&entries).map_err(edit_error)?
    } else {
        0
    };
    let sources_json: Vec<Value> = merged
        .iter()
        .map(|entry| {
            let mut source = Map::new();
            source.insert("path".to_owned(), json!(entry.path));
            source.insert("pages".to_owned(), json!(entry.pages));
            source.insert("pagesAdded".to_owned(), json!(entry.added));
            if entry.form_fields > 0 {
                source.insert("formFields".to_owned(), json!(entry.form_fields));
            }
            source.insert("at".to_owned(), json!(entry.at));
            source.insert("title".to_owned(), json!(entry.title));
            Value::Object(source)
        })
        .collect();
    let mut result = Map::new();
    result.insert("op".to_owned(), op_name(operation));
    result.insert("changed".to_owned(), json!(pages_added > 0));
    result.insert("pagesAdded".to_owned(), json!(pages_added));
    result.insert("sources".to_owned(), Value::Array(sources_json));
    result.insert("pageCount".to_owned(), json!(state.document.page_count()));
    if bookmarks_asked {
        result.insert("bookmarks".to_owned(), json!(bookmarks));
    }
    Ok(Value::Object(result))
}

fn add_bookmark<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let title = match operation.get("title") {
        Some(title) if !title.is_null() => js_trim(&value_to_string(title)).to_owned(),
        _ => String::new(),
    };
    if title.is_empty() {
        return Err(AnalysisError::plain("add_bookmark needs title"));
    }
    let page = match operation.get("page") {
        Some(page) if truthy(page) => page.clone(),
        _ => return Err(AnalysisError::plain("add_bookmark needs page")),
    };
    let selected = selected_edit_pages(&state.document, &json!({ "page": page }))?;
    let index = selected[0].index;
    state
        .document
        .add_outline_entries(&[OutlineEntry { title: title.clone(), page_index: index }])
        .map_err(edit_error)?;
    Ok(json!({ "op": op_name(operation), "changed": true, "title": title, "page": index + 1 }))
}

fn set_metadata<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let properties = match operation.get("properties") {
        Some(properties) if truthy(properties) => properties.clone(),
        _ => json!({}),
    };
    let mut applied: Vec<&str> = Vec::new();
    for key in ["title", "author", "subject", "creator", "keywords"] {
        let Some(value) = properties.get(key) else {
            continue;
        };
        match key {
            "title" => state.document.set_title(&value_to_string(value)),
            "author" => state.document.set_author(&value_to_string(value)),
            "subject" => state.document.set_subject(&value_to_string(value)),
            "creator" => state.document.set_creator(&value_to_string(value)),
            _ => {
                let words: Vec<String> = match value {
                    Value::Array(items) => items.iter().map(value_to_string).collect(),
                    other => vec![value_to_string(other)],
                };
                state.document.set_keywords(&words);
            }
        }
        applied.push(key);
    }
    Ok(json!({ "op": op_name(operation), "changed": !applied.is_empty(), "applied": applied }))
}

fn add_attachment<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let named = operation.get("path").filter(|path| truthy(path)).map_or_else(String::new, value_to_string);
    let attachment_path = resolve_beside(state.path, &named);
    let name = match operation.get("name") {
        Some(name) if truthy(name) => value_to_string(name),
        _ => attachment_path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    let text_of = |key: &str, fallback: &str| match operation.get(key) {
        Some(value) if truthy(value) => value_to_string(value),
        _ => fallback.to_owned(),
    };
    let options = AttachmentOptions {
        mime_type: Some(text_of("mimeType", "application/octet-stream")),
        description: Some(text_of("description", "")),
        ..AttachmentOptions::default()
    };
    let bytes = read_file(state.proof, &attachment_path)?;
    state.document.attach(&bytes, &name, &options).map_err(edit_error)?;
    Ok(json!({ "op": op_name(operation), "changed": true, "name": name }))
}

fn extract_attachment<P: WriteProof>(state: &mut BatchState<'_, P>, operation: &Value) -> Result<Value, AnalysisError> {
    let entries = state.document.attachments();
    let wanted_name = operation.get("name").filter(|name| !name.is_null()).map(value_to_string);
    let wanted_index = operation.get("index").filter(|index| !index.is_null()).map(to_number);
    let Some(wanted) = entries.iter().find(|entry| {
        wanted_name.as_deref() == Some(entry.name.as_str()) || wanted_index == Some(entry.index as f64)
    }) else {
        let named = wanted_name.clone().or_else(|| operation.get("index").filter(|index| !index.is_null()).map(value_to_string));
        let listed = entries.iter().map(|entry| entry.name.clone()).collect::<Vec<_>>().join(", ");
        return Err(AnalysisError::plain(format!(
            "PDF has no attachment {}; attachments: {}",
            named.unwrap_or_default(),
            if listed.is_empty() { "(none)" } else { listed.as_str() }
        )));
    };
    let filters = CodecFilters;
    let guard: Arc<Guard> = Guard::unbounded();
    let bytes = state
        .document
        .attachment_bytes(&wanted.spec, &filters, &guard)
        .map_err(edit_error)?
        .ok_or_else(|| AnalysisError::plain(format!("Attachment {} has no embedded file stream", wanted.name)))?;
    let target = match operation.get("output") {
        Some(output) if truthy(output) => value_to_string(output),
        _ if !wanted.name.is_empty() => wanted.name.clone(),
        _ => format!("attachment-{}", wanted.index),
    };
    let output = write_sibling(state.proof, state.note, state.path, &target, &bytes)?;
    Ok(json!({
        "op": op_name(operation),
        "changed": true,
        "documentChanged": false,
        "name": wanted.name,
        "output": output.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

/// The batch's final save fills in `bytesAfter`, `changed` and `note`.
fn compress<P: WriteProof>(state: &BatchState<'_, P>, operation: &Value) -> Value {
    json!({
        "op": op_name(operation),
        "changed": true,
        "method": "object-streams",
        "bytesBefore": state.source.len(),
    })
}
