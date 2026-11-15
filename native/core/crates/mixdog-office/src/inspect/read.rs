//! `get` and `query` (`core/office-actions-read.mjs`): one element of a document by its path, a text query over the
//! document, and the PDF queries: the text layout (or a search over it), the tables inferred from it and the images the pages
//! paint, the last two written as files when the call names an output folder.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use mixdog_fsio::WriteProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, to_number};
use mixdog_office_base::data_dir::resolve_path;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::{ImageOptions, LayoutOptions, PdfSource, SearchOptions, extract_pdf_images, extract_pdf_text_layout, find_pdf_text, infer_pdf_tables};
use serde_json::{Map, Value, json};

use super::{Facts, InspectContext, count_arg, spread, text_arg};
use crate::session::SessionHandle;
use crate::snapshot::{ComHost, find_by_document_path, query_object, snapshot, snapshot_selection_for_target};

/// The elements read as one item.
static LEAF_TARGET: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\/(?:cell|run|note|comment|comment-thread|revision|footnote|endnote|content-control)\[[^\]]+]$", "i"));
static PARAGRAPH_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\/p\[[^\]]+\]$", "i"));

/// RFC 4180 quoting so a table cell that contains a comma or quote round-trips.
pub fn csv_cell(text: &str) -> String {
    if text.contains(['"', ',', '\r', '\n']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text.to_owned() }
}

/// `get`: the element at `args.target`. A container (a sheet, a slide, a table) is read with its own contents, because asking
/// for the element and getting one of its twelve cells back under `truncated: true` answers a question the caller did not ask.
pub async fn get_office_element<P: WriteProof, H: ComHost>(cx: &InspectContext<'_, P, H>, handle: &SessionHandle, args: &Value) -> Result<Value, String> {
    let facts = Facts::of(handle);
    let target = js_trim(&text_arg(args, "target")).to_owned();
    if target.is_empty() {
        return Err("get requires target".to_owned());
    }
    let mut request = match args {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    spread(&mut request, &snapshot_selection_for_target(&facts.format, &target));
    request.insert("target".to_owned(), json!(target));
    // One leaf is read as one item.
    let leaf = LEAF_TARGET.is_match(&target);
    if leaf {
        request.insert("limit".to_owned(), json!(1));
    }
    request.insert("maxChars".to_owned(), json!(100_000));
    let current = snapshot(&cx.snapshot, handle, &Value::Object(request), false).await?;
    let document = current.get("document").unwrap_or(&Value::Null);
    let Some(element) = find_by_document_path(document, &target) else { return Err(format!("Document element not found: {target}")) };
    let pagination = document.get("pagination");
    // A paragraph is read whole like a leaf: the body's own "more blocks follow" and its cursor (four hundred characters)
    // answered a question about the rest of the document the caller did not ask.
    let single = leaf || PARAGRAPH_TARGET.is_match(&target);
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("target".to_owned(), json!(target));
    answer.insert("element".to_owned(), element.clone());
    // A container too large for one read says how to continue rather than leaving `truncated: true` as the whole answer.
    if let Some(pagination) = pagination
        && pagination.get("hasMore").is_some_and(truthy)
        && !single
    {
        answer.insert("pagination".to_owned(), pagination.clone());
    }
    Ok(Value::Object(answer))
}

fn pages_of(args: &Value) -> Option<Vec<f64>> {
    match args.get("pages") {
        Some(Value::Array(pages)) if !pages.is_empty() => Some(pages.iter().map(to_number).collect()),
        _ => None,
    }
}

/// `fullPath(path, cwd)`: the path as an absolute one, against the call's folder.
fn full_path(path: &str, cwd: &Path) -> PathBuf {
    resolve_path(cwd, Path::new(path))
}

/// The reader's own bookkeeping stays with the marks that use it: the viewport matrix a highlight inverts, the PDF engine's
/// internal face id ("g_d2_f1"), and a left-to-right direction every Latin and Hangul run has. A vertical or reversed run still
/// says so.
fn layout_page_for_caller(page: Value) -> Value {
    let Value::Object(fields) = page else { return page };
    let fields = fields
        .into_iter()
        .filter(|(key, _)| key != "transform")
        .map(|(key, value)| match value {
            Value::Array(items) if key == "items" => (key, Value::Array(items.into_iter().map(item_for_caller).collect())),
            value => (key, value),
        })
        .collect();
    Value::Object(fields)
}

fn item_for_caller(item: Value) -> Value {
    let Value::Object(fields) = item else { return item };
    let direction = fields.get("direction").cloned().filter(|direction| truthy(direction) && direction.as_str() != Some("ltr"));
    let mut kept: Map<String, Value> = fields.into_iter().filter(|(key, _)| key != "font" && key != "direction").collect();
    if let Some(direction) = direction {
        kept.insert("direction".to_owned(), direction);
    }
    Value::Object(kept)
}

fn layout_of<P: WriteProof, H>(
    cx: &InspectContext<'_, P, H>,
    facts: &Facts,
    pages: Option<Vec<f64>>,
    max_items: usize,
    shapes: bool,
) -> Result<mixdog_office_pdf::PdfLayout, String> {
    let options = LayoutOptions { pages, max_items, shapes, cancel: Some(cx.check(facts)) };
    extract_pdf_text_layout(cx.lane(), PdfSource::Path(Path::new(&facts.target)), &options).map_err(|error| error.message)
}

fn query_pdf_layout<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value) -> Result<Value, String> {
    let needle = js_trim(&text_arg(args, "query")).to_owned();
    let searching = !needle.is_empty();
    let layout = layout_of(cx, facts, pages_of(args), if searching { 20_000 } else { count_arg(args, "limit", 10_000.0) }, !searching)?;
    let layout_json = layout.to_json();
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("queryKind".to_owned(), json!("pdf-layout"));
    let pages = layout_json.get("pages").and_then(Value::as_array).cloned().unwrap_or_default();
    if searching {
        // A search answers with the boxes alone: the caller wants where a phrase sits, not every run on the page.
        let found = find_pdf_text(&layout, &needle, &SearchOptions { limit: count_arg(args, "limit", 200.0), whole_word: false, regex: false }).map_err(|error| error.message)?;
        answer.insert("pageCount".to_owned(), layout_json["pageCount"].clone());
        spread(&mut answer, &found.to_json());
        let sizes = pages.iter().map(|page| json!({ "page": page["page"], "width": page["width"], "height": page["height"] })).collect();
        answer.insert("pages".to_owned(), Value::Array(sizes));
    } else {
        spread(&mut answer, &layout_json);
        answer.insert("pages".to_owned(), Value::Array(pages.into_iter().map(layout_page_for_caller).collect()));
    }
    Ok(Value::Object(answer))
}

/// The folder a query writes its files to, made.
fn output_directory<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, args: &Value, cwd: &Path) -> Result<Option<PathBuf>, String> {
    let output = text_arg(args, "output");
    if output.is_empty() {
        return Ok(None);
    }
    let directory = full_path(&output, cwd);
    mixdog_fsio::create_dir_all(cx.lane(), &directory).map_err(|error| error.to_string())?;
    Ok(Some(directory))
}

fn query_pdf_tables<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value, cwd: &Path, note: &dyn WriteNote) -> Result<Value, String> {
    let layout = layout_of(cx, facts, pages_of(args), count_arg(args, "limit", 10_000.0), true)?;
    let inferred = infer_pdf_tables(&layout);
    let mut tables = inferred.to_json();
    if let Some(directory) = output_directory(cx, args, cwd)? {
        // One CSV per table, UTF-8, RFC 4180 quoting: the shape the xlsx and tabular sessions read back.
        let mut counters: Vec<(usize, usize)> = Vec::new();
        for (index, table) in inferred.tables.iter().enumerate() {
            let ordinal = match counters.iter_mut().find(|(page, _)| *page == table.page) {
                Some((_, count)) => {
                    *count += 1;
                    *count
                }
                None => {
                    counters.push((table.page, 1));
                    1
                }
            };
            let file = directory.join(format!("page-{}-table-{ordinal}.csv", table.page));
            note.note_write(&file);
            let lines: Vec<String> = table.rows.iter().map(|row| row.iter().map(|cell| csv_cell(cell)).collect::<Vec<_>>().join(",")).collect();
            mixdog_fsio::write(cx.lane(), &file, format!("{}\r\n", lines.join("\r\n"))).map_err(|error| error.to_string())?;
            if let Some(Value::Object(entry)) = tables.get_mut("tables").and_then(|list| list.get_mut(index)) {
                entry.insert("path".to_owned(), json!(file.display().to_string()));
            }
        }
        if let Value::Object(fields) = &mut tables {
            fields.insert("output".to_owned(), json!(directory.display().to_string()));
        }
    }
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("queryKind".to_owned(), json!("pdf-tables"));
    spread(&mut answer, &tables);
    Ok(Value::Object(answer))
}

fn query_pdf_images<P: WriteProof, H>(cx: &InspectContext<'_, P, H>, facts: &Facts, args: &Value, cwd: &Path, note: &dyn WriteNote) -> Result<Value, String> {
    let options = ImageOptions { pages: pages_of(args), cancel: Some(cx.check(facts)) };
    let extraction = extract_pdf_images(cx.lane(), PdfSource::Path(Path::new(&facts.target)), &options).map_err(|error| error.message)?;
    let mut extracted = extraction.to_json();
    if let Some(directory) = output_directory(cx, args, cwd)? {
        // Files instead of inline pictures: a directory of PNGs the caller can reuse.
        let mut described = Vec::new();
        for image in &extraction.images {
            let file = directory.join(format!("page-{}-image-{}.png", image.page, image.index));
            note.note_write(&file);
            mixdog_fsio::write(cx.lane(), &file, &image.png).map_err(|error| error.to_string())?;
            let mut entry = match image.to_json(false) {
                Value::Object(entry) => entry,
                _ => Map::new(),
            };
            entry.insert("path".to_owned(), json!(file.display().to_string()));
            described.push(Value::Object(entry));
        }
        let mut written = Map::new();
        written.insert("pageCount".to_owned(), json_number(extraction.page_count as f64));
        written.insert("imageCount".to_owned(), json!(extraction.images.len()));
        written.insert("images".to_owned(), Value::Array(described));
        written.insert("output".to_owned(), json!(directory.display().to_string()));
        extracted = Value::Object(written);
    }
    let mut answer = Map::new();
    answer.insert("session".to_owned(), json!(facts.id));
    answer.insert("queryKind".to_owned(), json!("pdf-images"));
    spread(&mut answer, &extracted);
    Ok(Value::Object(answer))
}

/// `query`: a text query over the document, or one of the PDF queries (`pdf-layout`, `pdf-tables`, `pdf-images`). `cwd` is the
/// folder an `output` is resolved against; every file written is reported to `note` first.
pub async fn query_office_document<P: WriteProof, H: ComHost>(
    cx: &InspectContext<'_, P, H>,
    handle: &SessionHandle,
    args: &Value,
    cwd: &Path,
    note: &dyn WriteNote,
) -> Result<Value, String> {
    let facts = Facts::of(handle);
    let kind = match args.get("queryKind") {
        Some(kind) if truthy(kind) => mixdog_js::value_to_string(kind),
        _ => "text".to_owned(),
    };
    let query_kind = js_to_lowercase(&kind);
    if query_kind == "text" {
        let needle = js_to_lowercase(js_trim(&text_arg(args, "query")));
        if needle.is_empty() {
            return Err("query requires non-empty query text".to_owned());
        }
        let mut request = match args {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        request.insert("maxChars".to_owned(), json!(100_000));
        let current = snapshot(&cx.snapshot, handle, &Value::Object(request), true).await?;
        let mut matches = Vec::new();
        query_object(current.get("document").unwrap_or(&Value::Null), &needle, "$", &mut matches);
        return Ok(json!({ "session": facts.id, "query": args.get("query").cloned().unwrap_or(Value::Null), "matches": matches }));
    }
    if facts.format != "pdf" {
        return Err(format!("{query_kind} query is supported for PDF sessions only"));
    }
    match query_kind.as_str() {
        "pdf-layout" => query_pdf_layout(cx, &facts, args),
        "pdf-tables" => query_pdf_tables(cx, &facts, args, cwd, note),
        "pdf-images" => query_pdf_images(cx, &facts, args, cwd, note),
        _ => Err(format!("Unsupported Office queryKind: {query_kind}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cell_with_a_comma_quote_or_line_break_is_quoted() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_cell("two\rlines"), "\"two\rlines\"");
        assert_eq!(csv_cell(""), "");
    }

    #[test]
    fn a_runs_font_and_its_left_to_right_direction_stay_with_the_reader() {
        let page = json!({
            "page": 1, "transform": [1, 0, 0, -1, 0, 792],
            "items": [
                { "text": "a", "x": 1, "direction": "ltr", "font": "g_d2_f1" },
                { "text": "b", "vertical": true, "direction": "ttb", "font": "g_d2_f2" },
            ],
        });
        let kept = layout_page_for_caller(page);
        assert_eq!(
            mixdog_js::json_stringify(&kept),
            r#"{"page":1,"items":[{"text":"a","x":1},{"text":"b","vertical":true,"direction":"ttb"}]}"#
        );
    }
}
