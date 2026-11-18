//! What a batch runs: the operations the caller sent, expanded by the design, localised to the caller's folder, checked against
//! the contract and given the shared defaults both backends honour (`prepareBatchOperations` and the `with*` functions of
//! `core/office-actions-batch.mjs`).
//!
//! Each `with_*` function is a pure rewrite of the operation list for one format; [`prepare_batch_operations`] runs them in
//! Node's order over a session. The one that needs a machine (a Word chart drawn as a picture) goes through the batch host.

use std::path::{Path, PathBuf};

use mixdog_fsio::WriteProof;
use mixdog_js::{js_to_lowercase, js_trim, json_number, math, to_number, value_to_string};
use mixdog_office_base::column_alignments::figure_column_alignments;
use mixdog_office_base::column_widths::natural_column_widths;
use mixdog_office_base::formats::is_tabular_format;
use mixdog_office_base::korean_particles::korean_particle_replacements;
use mixdog_office_base::page_sizes::page_size_points;
use mixdog_office_base::values::truthy;
use mixdog_office_design::design_system::{ExpandRequest, expand_office_design_operations};
use mixdog_office_design::templates::expand_template_page_operations;
use mixdog_office_quality::document_brief::document_brief;
use mixdog_ooxml::chart::DEFAULT_SERIES_COLORS;
use mixdog_ooxml::opc::{PIXELS_TO_POINTS, image_pixel_size};
use mixdog_ooxml::snapshot::snapshot_portable_ooxml;
use mixdog_ooxml::text_metrics::{FontSpec, TextMeasurer};
use mixdog_ooxml::xlsx_contract::{expand_filled_formulas, quote_unquoted_sheet_references, validate_xlsx_operations};
use mixdog_xlsx_formula::translate_shared_formula;
use serde_json::{Map, Value, json};

use super::{BatchContext, BatchHost};
use crate::contracts::assert_office_operation_contracts;
use crate::session::registry::lock;
use crate::session::{Backend, SessionHandle, merge_office_design_request};
use crate::session::working_copy::{dirname, full_path};
use crate::snapshot::ComHost;

/// PowerPoint's cell margins, left and right together, in points.
const SLIDE_CELL_PADDING: f64 = 14.4;
/// The width a Word chart is drawn at when it names none, in points.
const DOCUMENT_CHART_WIDTH: f64 = 420.0;

/// Operations whose `path` names a file the caller supplied relative to its folder.
const PATH_OPERATIONS: [&str; 9] = ["add_image", "replace_image", "stamp_image", "add_attachment", "merge_pdf", "apply_theme", "import_slides", "use_template_page", "add_media"];
const FONT_PATH_OPERATIONS: [&str; 6] = ["add_text", "watermark", "ocr_pages", "fill_form", "add_form_field", "flatten_form"];
const OUTPUT_PATH_OPERATIONS: [&str; 3] = ["extract_pages", "split_pages", "extract_attachment"];

/// What a batch is made of once it is prepared.
pub struct Prepared {
    /// The operations the backend runs.
    pub operations: Vec<Value>,
    /// `prepared.design`: the design in force for the document.
    pub design: Value,
    /// `prepared.semantic`: what the design planned for each semantic operation.
    pub semantic: Vec<Value>,
    /// The carriers of a template page's data that the fill has not replaced.
    pub template_data: Vec<Value>,
    /// Folders the batch made and removes when it is done.
    pub scratch: Vec<PathBuf>,
}

fn op_of(operation: &Value) -> &str {
    operation.get("op").and_then(Value::as_str).unwrap_or("")
}

fn text_of(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

/// `{ ...operation, key: value }`: the key keeps its place when the operation has it, else it comes last.
fn with_field(operation: &Value, key: &str, value: Value) -> Value {
    let mut fields = operation.as_object().cloned().unwrap_or_default();
    fields.insert(key.to_owned(), value);
    Value::Object(fields)
}

/// `{ ...properties, key: value, ... }` set into an operation's `properties`.
fn with_properties(operation: &Value, change: impl FnOnce(&mut Map<String, Value>)) -> Value {
    let mut properties = operation.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
    change(&mut properties);
    with_field(operation, "properties", Value::Object(properties))
}

fn round_to_hundredths(value: f64) -> Value {
    json_number(math::round(value * 100.0) / 100.0)
}

// ---- the defaults both backends share ---------------------------------------------------------------------------------

/// Excel fills an unstyled series from the workbook theme while the portable writer paints its own hue family, so the same
/// `add_chart` drew two different charts. A chart that names no colours takes the portable palette on both backends; a named
/// palette is kept as written. A deck and a document take the particle rewrites of `fill_template` too.
pub fn with_shared_chart_defaults(format: &str, operations: &[Value]) -> Vec<Value> {
    if format == "pptx" {
        return with_template_particles(&operations.iter().map(with_slide_chart_colors).collect::<Vec<_>>());
    }
    if format != "xlsx" {
        return with_template_particles(operations);
    }
    operations
        .iter()
        .map(|operation| {
            let named = operation.get("seriesColors").and_then(Value::as_array).is_some_and(|colors| !colors.is_empty());
            if op_of(operation) == "add_chart" && !named {
                with_field(operation, "seriesColors", json!(DEFAULT_SERIES_COLORS))
            } else {
                operation.clone()
            }
        })
        .collect()
}

/// PowerPoint fills an unstyled series from the deck theme as Excel does: a slide chart that names no colour takes the portable
/// palette too, a series its colour, a pie or doughnut slice its own.
fn with_slide_chart_colors(operation: &Value) -> Value {
    let Some(series) = operation.get("series").and_then(Value::as_array).filter(|_| op_of(operation) == "add_chart") else { return operation.clone() };
    let palette = DEFAULT_SERIES_COLORS;
    let slices = {
        let kind = js_to_lowercase(js_trim(&text_of(operation.get("chartType"))));
        matches!(kind.as_str(), "pie" | "doughnut" | "donut")
    };
    let coloured: Vec<Value> = series
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if !entry.is_object() {
                return entry.clone();
            }
            if !slices {
                return if entry.get("color").is_some_and(truthy) { entry.clone() } else { with_field(entry, "color", json!(palette[index % palette.len()])) };
            }
            if entry.get("pointColors").and_then(Value::as_array).is_some_and(|colors| !colors.is_empty()) {
                return entry.clone();
            }
            let points = entry.get("values").and_then(Value::as_array).map_or(0, Vec::len);
            with_field(entry, "pointColors", Value::Array((0..points).map(|point| json!(palette[point % palette.len()])).collect()))
        })
        .collect();
    with_field(operation, "series", Value::Array(coloured))
}

/// Word and PowerPoint fill a template with the same particle rewrites the portable writer runs, handed over with the operation
/// so `{{company}}은` lands as 모아페이는 on both.
fn with_template_particles(operations: &[Value]) -> Vec<Value> {
    operations
        .iter()
        .map(|operation| {
            if op_of(operation) != "fill_template" {
                return operation.clone();
            }
            let tokens = operation.get("tokens").cloned().unwrap_or(Value::Null);
            let particles: Vec<Value> = korean_particle_replacements(&tokens).into_iter().map(|each| json!({ "key": each.key, "find": each.find, "replace": each.replace })).collect();
            with_field(operation, "particles", Value::Array(particles))
        })
        .collect()
}

/// A Word page is named the way a PDF page is (`letter`, `a4`, or `[width, height]` in points). The name is resolved here once, so
/// Word and the portable writer receive the same two numbers.
fn with_page_size_points(format: &str, operations: Vec<Value>) -> Result<Vec<Value>, String> {
    if format != "docx" {
        return Ok(operations);
    }
    let mut out = Vec::with_capacity(operations.len());
    for operation in operations {
        let size = operation.get("properties").and_then(|properties| properties.get("pageSize")).filter(|size| !size.is_null());
        if op_of(&operation) != "set_page" || size.is_none() {
            out.push(operation);
            continue;
        }
        let [width, height] = page_size_points(size, "set_page pageSize")?;
        out.push(with_properties(&operation, |properties| {
            properties.shift_remove("pageSize");
            properties.insert("pageWidth".to_owned(), json_number(width));
            properties.insert("pageHeight".to_owned(), json_number(height));
        }));
    }
    Ok(out)
}

/// A Word title set at a size and no leading holds its lines 1.25 × the size apart, exact, as the docx skill's title anatomy writes
/// it and the PDF writer sets its titles. A leading the author gave stays.
fn with_title_leading(format: &str, operations: Vec<Value>) -> Vec<Value> {
    if format != "docx" {
        return operations;
    }
    operations
        .into_iter()
        .map(|operation| {
            let titled = js_to_lowercase(js_trim(&text_of(operation.get("style")))) == "title";
            if op_of(&operation) != "append_text" || !titled {
                return operation;
            }
            let properties = operation.get("properties");
            let size = properties.and_then(|properties| properties.get("size")).map_or(f64::NAN, to_number);
            let spaced = properties.and_then(|properties| properties.get("lineSpacing")).is_some_and(|spacing| !spacing.is_null());
            if !(size > 0.0) || spaced {
                return operation;
            }
            with_properties(&operation, |properties| {
                properties.insert("lineSpacing".to_owned(), json_number(math::round(size * 1.25 * 2.0) / 2.0));
                properties.insert("lineSpacingRule".to_owned(), json!("exact"));
            })
        })
        .collect()
}

/// A table's cell as the text `String(value ?? '')` gives.
fn cell_text(value: &Value) -> String {
    if value.is_null() { String::new() } else { value_to_string(value) }
}

/// A Word table that declares no column alignments sets its columns of figures right, as the PDF writer sets them.
fn with_figure_column_alignments(format: &str, operations: Vec<Value>) -> Vec<Value> {
    if format != "docx" {
        return operations;
    }
    operations
        .into_iter()
        .map(|operation| {
            let Some(values) = operation.get("values").and_then(Value::as_array).filter(|values| op_of(&operation) == "add_table" && values.len() >= 2) else { return operation };
            if operation.get("properties").and_then(|properties| properties.get("columnAlignments")).is_some_and(Value::is_array) {
                return operation;
            }
            let rows: Vec<Vec<String>> = values.iter().map(|row| row.as_array().map_or_else(|| vec![cell_text(row)], |cells| cells.iter().map(cell_text).collect())).collect();
            let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
            let alignments = figure_column_alignments(&rows, columns, &[], true);
            if !alignments.iter().any(|alignment| alignment == "right") {
                return operation;
            }
            with_properties(&operation, |properties| {
                properties.insert("columnAlignments".to_owned(), json!(alignments));
            })
        })
        .collect()
}

/// A picture given one side takes the other from its own proportions, on every backend: the side left out fell to a fixed default
/// and the picture came out stretched. A slide picture given neither side is 240 pt wide at its proportions, a sheet picture keeps
/// its own size; a Word picture given neither is left to the page it lands on.
fn with_image_proportions<P: mixdog_fsio::ReadProof>(proof: &P, format: &str, operations: Vec<Value>) -> Vec<Value> {
    if !matches!(format, "docx" | "xlsx" | "pptx") {
        return operations;
    }
    let side = |operation: &Value, name: &str| {
        let number = operation.get(name).map_or(f64::NAN, to_number);
        if number > 0.0 { number } else { 0.0 }
    };
    operations
        .into_iter()
        .map(|operation| {
            let (width, height) = (side(&operation, "width"), side(&operation, "height"));
            let fit = text_of(operation.get("fit"));
            let stretch = js_to_lowercase(if fit.is_empty() { "stretch" } else { &fit }) == "stretch";
            let path = text_of(operation.get("path"));
            if op_of(&operation) != "add_image" || path.is_empty() || (width != 0.0 && height != 0.0) || !stretch || (format == "docx" && width == 0.0 && height == 0.0) {
                return operation;
            }
            // A file that cannot be read is left to the backend, which names it in its own refusal.
            let Some(pixels) = mixdog_fsio::read(proof, &path).ok().and_then(|data| image_pixel_size(&data)).filter(|size| size.width > 0 && size.height > 0) else { return operation };
            let ratio = f64::from(pixels.height) / f64::from(pixels.width);
            let (out_width, out_height) = if width != 0.0 {
                (width, width * ratio)
            } else if height != 0.0 {
                (height / ratio, height)
            } else if format == "pptx" {
                (240.0, 240.0 * ratio)
            } else {
                (f64::from(pixels.width) * PIXELS_TO_POINTS, f64::from(pixels.height) * PIXELS_TO_POINTS)
            };
            let mut fields = operation.as_object().cloned().unwrap_or_default();
            fields.insert("width".to_owned(), round_to_hundredths(out_width));
            fields.insert("height".to_owned(), round_to_hundredths(out_height));
            Value::Object(fields)
        })
        .collect()
}

/// A built-in Excel table style in the name Excel stores (`TableStyleMedium2`), however the author spaced or cased it. A custom
/// style's name stays as written.
fn table_style_name(style: &Value) -> Option<String> {
    let compact: String = value_to_string(style).chars().filter(|character| !(mixdog_js::is_js_space(*character) || *character == '_' || *character == '-')).collect();
    if compact.is_empty() {
        return Some("none".to_owned());
    }
    let lower = js_to_lowercase(&compact);
    let rest = lower.strip_prefix("tablestyle").unwrap_or(&lower);
    if rest == "none" {
        return Some("none".to_owned());
    }
    for tone in ["light", "medium", "dark"] {
        let Some(digits) = rest.strip_prefix(tone) else { continue };
        if (1..=2).contains(&digits.len()) && digits.bytes().all(|digit| digit.is_ascii_digit()) {
            let number: u32 = digits.parse().ok()?;
            let mut name = tone.to_owned();
            name[..1].make_ascii_uppercase();
            return Some(format!("TableStyle{name}{number}"));
        }
    }
    None
}

fn with_table_style_names(format: &str, operations: Vec<Value>) -> Vec<Value> {
    if format != "xlsx" {
        return operations;
    }
    operations
        .into_iter()
        .map(|operation| match operation.get("style") {
            Some(style) if op_of(&operation) == "add_table" => match table_style_name(style) {
                Some(name) => with_field(&operation, "style", json!(name)),
                None => operation,
            },
            _ => operation,
        })
        .collect()
}

/// A slide table that names no column widths takes the widths its text needs, as a Word, PDF, or kit table does, measured in its own
/// face at its own size (PowerPoint's 18 pt when it names none), the header bold. Both backends receive the same widths.
fn with_slide_table_widths<P: mixdog_fsio::ReadProof>(measurer: &TextMeasurer<'_, P>, format: &str, operations: Vec<Value>) -> Result<Vec<Value>, String> {
    if format != "pptx" {
        return Ok(operations);
    }
    let mut out = Vec::with_capacity(operations.len());
    for operation in operations {
        let Some(values) = operation.get("values").and_then(Value::as_array).filter(|_| op_of(&operation) == "add_table") else {
            out.push(operation);
            continue;
        };
        let properties = operation.get("properties").filter(|properties| properties.is_object());
        if properties.and_then(|properties| properties.get("columnWidths")).is_some_and(Value::is_array) {
            out.push(operation);
            continue;
        }
        let name = text_of(properties.and_then(|properties| properties.get("fontName")));
        let size = properties.and_then(|properties| properties.get("fontSize")).map_or(f64::NAN, to_number);
        let font = FontSpec { font_name: Some(if name.is_empty() { "Calibri".to_owned() } else { name }), font_size: Some(if size > 0.0 { size } else { 18.0 }), bold: false, italic: false };
        let rows: Vec<Vec<String>> = values.iter().filter_map(Value::as_array).map(|row| row.iter().map(cell_text).collect()).collect();
        let available = operation.get("width").map_or(f64::NAN, to_number);
        let mut failure: Option<String> = None;
        let widths = natural_column_widths(
            &rows,
            |text, row, _| {
                let bold = FontSpec { bold: row == 0, ..font.clone() };
                match measurer.measure_text_width(text, &bold) {
                    Ok(width) => width * 1.05 + SLIDE_CELL_PADDING,
                    Err(error) => {
                        failure.get_or_insert_with(|| error.to_string());
                        0.0
                    }
                }
            },
            if available > 0.0 { available } else { 480.0 },
        );
        if let Some(error) = failure {
            return Err(error);
        }
        match widths {
            Some(widths) => out.push(with_properties(&operation, |properties| {
                properties.insert("columnWidths".to_owned(), Value::Array(widths.into_iter().map(round_to_hundredths).collect()));
            })),
            None => out.push(operation),
        }
    }
    Ok(out)
}

/// Every path an operation carries resolves against the caller's folder, not the document's.
fn localize_operation(operation: &Value, base_dir: &str) -> Result<Value, String> {
    let Some(original) = operation.as_object() else { return Ok(operation.clone()) };
    let op = op_of(operation);
    let mut fields = original.clone();
    let resolve = |fields: &mut Map<String, Value>, key: &str| -> Result<(), String> {
        if let Some(path) = operation.get(key).filter(|path| truthy(path)) {
            fields.insert(key.to_owned(), json!(full_path(&value_to_string(path), base_dir)?));
        }
        Ok(())
    };
    if PATH_OPERATIONS.contains(&op) {
        resolve(&mut fields, "path")?;
    }
    if FONT_PATH_OPERATIONS.contains(&op) {
        resolve(&mut fields, "fontPath")?;
    }
    if op == "merge_pdf"
        && let Some(sources) = operation.get("sources").and_then(Value::as_array)
    {
        let mut resolved = Vec::with_capacity(sources.len());
        for entry in sources {
            resolved.push(match entry {
                Value::String(path) => json!(full_path(path, base_dir)?),
                other => match other.get("path").filter(|path| truthy(path)) {
                    Some(path) => with_field(other, "path", json!(full_path(&value_to_string(path), base_dir)?)),
                    None => other.clone(),
                },
            });
        }
        fields.insert("sources".to_owned(), Value::Array(resolved));
    }
    if OUTPUT_PATH_OPERATIONS.contains(&op) {
        resolve(&mut fields, "output")?;
    }
    Ok(Value::Object(fields))
}

/// `Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })`: ICU writes the shortest decimal that reads back as the
/// number, rounds it half away from zero to two fraction digits, groups the integer part by thousands and shows the sign of a
/// negative number that rounds to zero.
fn en_us_number(value: f64) -> String {
    const MAX_FRACTION: usize = 2;
    if value.is_nan() {
        return "NaN".to_owned();
    }
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if value.is_infinite() {
        return format!("{sign}\u{221e}");
    }
    let shortest = format!("{:e}", value.abs());
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let point = exponent.parse::<i64>().unwrap_or(0) + 1;
    let (mut whole, mut fraction) = if point <= 0 {
        ("0".to_owned(), format!("{}{digits}", "0".repeat((-point) as usize)))
    } else if point as usize >= digits.len() {
        (format!("{digits}{}", "0".repeat(point as usize - digits.len())), String::new())
    } else {
        (digits[..point as usize].to_owned(), digits[point as usize..].to_owned())
    };
    if fraction.len() > MAX_FRACTION {
        let round_up = fraction.as_bytes()[MAX_FRACTION] >= b'5';
        fraction.truncate(MAX_FRACTION);
        if round_up {
            let mut all: Vec<u8> = whole.bytes().chain(fraction.bytes()).collect();
            let mut at = all.len();
            loop {
                if at == 0 {
                    all.insert(0, b'1');
                    break;
                }
                at -= 1;
                if all[at] == b'9' {
                    all[at] = b'0';
                } else {
                    all[at] += 1;
                    break;
                }
            }
            let split = all.len() - fraction.len();
            whole = String::from_utf8_lossy(&all[..split]).into_owned();
            fraction = String::from_utf8_lossy(&all[split..]).into_owned();
        }
    }
    while fraction.ends_with('0') {
        fraction.pop();
    }
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if fraction.is_empty() { format!("{sign}{grouped}") } else { format!("{sign}{grouped}.{fraction}") }
}

/// What the chart shows, for a reader who cannot see it: its title and every figure by name.
fn chart_description(block: &Value) -> String {
    let unit = block.get("unit").filter(|unit| !unit.is_null()).map(value_to_string).unwrap_or_default();
    let values = block.get("values").and_then(Value::as_array);
    let figures: Vec<String> = block
        .get("categories")
        .and_then(Value::as_array)
        .map(|categories| {
            categories
                .iter()
                .enumerate()
                .map(|(index, category)| format!("{} {}{unit}", value_to_string(category), en_us_number(values.and_then(|values| values.get(index)).map_or(f64::NAN, to_number))))
                .collect()
        })
        .unwrap_or_default();
    let title = block.get("title").filter(|title| truthy(title)).map(|title| format!("{}: ", value_to_string(title))).unwrap_or_default();
    format!("{title}{}", figures.join(", "))
}

/// PowerPoint's InsertFromFile gives each imported slide the deck's own design and drops the background it had: a template's dark
/// quote and closing pages arrived on the deck's light paper, their white words unreadable, where the portable import keeps them.
/// Each slide imported at a known place takes its source's background again, resolved through its layout and master as the
/// snapshot reads it.
fn with_imported_slide_backgrounds<P: WriteProof, H, B>(cx: &BatchContext<'_, P, H, B>, operations: Vec<Value>) -> Result<Vec<Value>, String> {
    let snapshot = &cx.inspect.snapshot;
    let mut sources: Vec<(String, Vec<Value>)> = Vec::new();
    let mut out = Vec::with_capacity(operations.len());
    for operation in operations {
        let after = operation.get("after").filter(|after| !after.is_null());
        let placed = op_of(&operation) == "import_slides" && after.is_some_and(|after| {
            let number = to_number(after);
            number.is_finite() && number.fract() == 0.0
        });
        out.push(operation.clone());
        if !placed {
            continue;
        }
        let path = text_of(operation.get("path"));
        let held = match sources.iter().position(|(held, _)| *held == path) {
            Some(held) => held,
            None => {
                let read = snapshot_portable_ooxml(snapshot.proof, snapshot.measurer, Path::new(&path), "pptx", &json!({}))?;
                sources.push((path.clone(), read.get("slides").and_then(Value::as_array).cloned().unwrap_or_default()));
                sources.len() - 1
            }
        };
        let slides = &sources[held].1;
        let numbers: Vec<f64> = match operation.get("slides").and_then(Value::as_array).filter(|chosen| !chosen.is_empty()) {
            Some(chosen) => chosen.iter().map(to_number).collect(),
            None => slides.iter().map(|slide| slide.get("index").map_or(f64::NAN, to_number)).collect(),
        };
        let place = after.map_or(0.0, to_number);
        for (offset, number) in numbers.iter().enumerate() {
            let color = slides
                .iter()
                .find(|slide| slide.get("index").map_or(f64::NAN, to_number) == *number)
                .and_then(|slide| slide.get("background"))
                .and_then(|background| background.get("color"))
                .filter(|color| truthy(color));
            if let Some(color) = color {
                out.push(json!({ "op": "set_slide_background", "slide": json_number(place + offset as f64 + 1.0), "color": color }));
            }
        }
    }
    Ok(out)
}

/// What the batch needs of the session, read once under its lock.
struct Facts {
    format: String,
    backend: Backend,
    created: bool,
    snapshot_version: u64,
    target: String,
    design_request: Option<Value>,
    design_library: Option<Value>,
    microsoft_office: bool,
}

impl Facts {
    fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        Self {
            format: session.format.clone(),
            backend: session.backend,
            created: session.created,
            snapshot_version: session.snapshot_version,
            target: session.target.clone(),
            design_request: session.design_request.clone(),
            design_library: session.design_library.clone(),
            microsoft_office: session.is_microsoft_office(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_xlsx_chart_without_colours_takes_the_portable_palette_and_a_named_one_stays() {
        let operations = [json!({ "op": "add_chart" }), json!({ "op": "add_chart", "seriesColors": ["112233"] }), json!({ "op": "add_chart", "seriesColors": [] })];
        let shaped = with_shared_chart_defaults("xlsx", &operations);
        assert_eq!(shaped[0]["seriesColors"], json!(DEFAULT_SERIES_COLORS));
        assert_eq!(shaped[1]["seriesColors"], json!(["112233"]));
        assert_eq!(shaped[2]["seriesColors"], json!(DEFAULT_SERIES_COLORS));
    }

    #[test]
    fn a_slide_chart_colours_a_series_and_a_pie_colours_its_slices() {
        let bars = with_shared_chart_defaults("pptx", &[json!({ "op": "add_chart", "chartType": "bar", "series": [{ "values": [1, 2] }, { "color": "AA0000" }] })]);
        assert_eq!(bars[0]["series"][0]["color"], json!(DEFAULT_SERIES_COLORS[0]));
        assert_eq!(bars[0]["series"][1]["color"], json!("AA0000"));
        let pie = with_shared_chart_defaults("pptx", &[json!({ "op": "add_chart", "chartType": " Pie ", "series": [{ "values": [1, 2, 3] }, { "values": [1], "pointColors": ["FFFFFF"] }] })]);
        assert_eq!(pie[0]["series"][0]["pointColors"], json!(DEFAULT_SERIES_COLORS[..3].to_vec()));
        assert_eq!(pie[0]["series"][1]["pointColors"], json!(["FFFFFF"]));
    }

    #[test]
    fn a_template_fill_carries_the_particle_rewrites_of_its_tokens() {
        let filled = with_shared_chart_defaults("docx", &[json!({ "op": "fill_template", "tokens": { "company": "모아페이" } })]);
        let particles = filled[0]["particles"].as_array().expect("particles");
        assert!(!particles.is_empty());
        assert_eq!(particles[0]["key"], json!("company"));
        assert!(particles.iter().any(|entry| entry["replace"].as_str().is_some_and(|text| text.starts_with("모아페이는"))));
        let plain = with_shared_chart_defaults("docx", &[json!({ "op": "fill_template", "tokens": { "company": "Acme" } })]);
        assert_eq!(plain[0]["particles"], json!([]));
    }

    #[test]
    fn a_page_size_name_becomes_two_numbers() {
        let shaped = with_page_size_points("docx", vec![json!({ "op": "set_page", "properties": { "pageSize": "letter", "margin": 1 } })]).expect("sized");
        assert_eq!(shaped[0]["properties"], json!({ "margin": 1, "pageWidth": 612, "pageHeight": 792 }));
        assert!(with_page_size_points("docx", vec![json!({ "op": "set_page", "properties": { "pageSize": "poster" } })]).is_err());
        let sheet = vec![json!({ "op": "set_page", "properties": { "pageSize": "poster" } })];
        assert_eq!(with_page_size_points("xlsx", sheet.clone()).expect("untouched"), sheet);
    }

    #[test]
    fn a_title_without_leading_holds_its_lines_one_and_a_quarter_times_its_size_apart() {
        let shaped = with_title_leading("docx", vec![
            json!({ "op": "append_text", "style": " Title ", "properties": { "size": 25 } }),
            json!({ "op": "append_text", "style": "Title", "properties": { "size": 20, "lineSpacing": 30 } }),
            json!({ "op": "append_text", "style": "Heading1", "properties": { "size": 20 } }),
        ]);
        assert_eq!(shaped[0]["properties"], json!({ "size": 25, "lineSpacing": 31.5, "lineSpacingRule": "exact" }));
        assert_eq!(shaped[1]["properties"], json!({ "size": 20, "lineSpacing": 30 }));
        assert_eq!(shaped[2]["properties"], json!({ "size": 20 }));
    }

    #[test]
    fn a_word_table_of_figures_sets_its_figure_columns_right_unless_it_declares_them() {
        let table = json!({ "op": "add_table", "values": [["Name", "Amount"], ["A", "184,200"], ["B", "2,000"]] });
        let shaped = with_figure_column_alignments("docx", vec![table.clone()]);
        assert_eq!(shaped[0]["properties"]["columnAlignments"], json!(["left", "right"]));
        let declared = json!({ "op": "add_table", "values": [["a"], ["1"]], "properties": { "columnAlignments": ["left"] } });
        assert_eq!(with_figure_column_alignments("docx", vec![declared.clone()])[0], declared);
        assert_eq!(with_figure_column_alignments("pptx", vec![table.clone()])[0], table);
    }

    #[test]
    fn a_table_style_is_written_the_way_excel_stores_it() {
        let name = |style: &str| table_style_name(&json!(style));
        assert_eq!(name("Table Style Medium 2").as_deref(), Some("TableStyleMedium2"));
        assert_eq!(name("medium 02").as_deref(), Some("TableStyleMedium2"));
        assert_eq!(name("light-9").as_deref(), Some("TableStyleLight9"));
        assert_eq!(name("TableStyleDark11").as_deref(), Some("TableStyleDark11"));
        assert_eq!(name("TableStyleNone").as_deref(), Some("none"));
        assert_eq!(name("  ").as_deref(), Some("none"));
        assert_eq!(name("Brand Style"), None);
        assert_eq!(name("medium 123"), None);
        let shaped = with_table_style_names("xlsx", vec![json!({ "op": "add_table", "style": "dark 3" }), json!({ "op": "add_table" })]);
        assert_eq!(shaped[0]["style"], json!("TableStyleDark3"));
        assert!(shaped[1].get("style").is_none());
    }

    #[test]
    fn figures_are_written_the_way_the_en_us_locale_does() {
        assert_eq!(en_us_number(1234567.891), "1,234,567.89");
        assert_eq!(en_us_number(0.005), "0.01");
        assert_eq!(en_us_number(-0.001), "-0");
        assert_eq!(en_us_number(f64::NAN), "NaN");
        assert_eq!(en_us_number(1000.0), "1,000");
    }

    #[test]
    fn a_chart_is_described_by_its_title_and_every_figure_by_name() {
        let block = json!({ "title": "Sales", "categories": ["Q1", "Q2"], "values": [1200.5, 3], "unit": "M" });
        assert_eq!(chart_description(&block), "Sales: Q1 1,200.5M, Q2 3M");
        assert_eq!(chart_description(&json!({ "categories": ["A"], "values": [] })), "A NaN");
    }

    #[test]
    fn json_numbers_of_widths_are_rounded_to_hundredths() {
        assert_eq!(round_to_hundredths(12.3456), json!(12.35));
        assert_eq!(round_to_hundredths(3.0), json!(3));
    }


    #[test]
    fn paths_resolve_against_the_callers_folder() {
        let base = std::env::temp_dir().to_string_lossy().into_owned();
        let at = |name: &str| full_path(name, &base).expect("path");
        let localised = localize_operation(&json!({ "op": "merge_pdf", "path": "a.pdf", "sources": ["b.pdf", { "path": "c.pdf" }, { "label": "x" }] }), &base).expect("localised");
        assert_eq!(localised["path"], json!(at("a.pdf")));
        assert_eq!(localised["sources"], json!([at("b.pdf"), { "path": at("c.pdf") }, { "label": "x" }]));
        let output = localize_operation(&json!({ "op": "split_pages", "output": "out" }), &base).expect("localised");
        assert_eq!(output["output"], json!(at("out")));
        let other = json!({ "op": "set_cell", "path": "stay" });
        assert_eq!(localize_operation(&other, &base).expect("kept"), other);
    }
}


/// A Word document's chart is the picture the PDF writer draws for the same block: Word draws no chart without Excel behind it,
/// and a report's figure had come in as a hand-made picture with no names or values on it. `add_chart` turns into `add_image` of
/// that picture before either backend sees it, so both place the same one. The pictures are written into a scratch folder the
/// batch removes once it is done.
async fn with_document_charts<P: WriteProof, H, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, format: &str, operations: Vec<Value>, scratch: &mut Vec<PathBuf>) -> Result<Vec<Value>, String> {
    if format != "docx" || !operations.iter().any(|operation| op_of(operation) == "add_chart") {
        return Ok(operations);
    }
    let directory = std::env::temp_dir().join(format!("mixdog-docx-chart-{}", &crate::transactions::unique_token()[..6]));
    mixdog_fsio::create_dir_all(cx.lane(), &directory).map_err(|error| error.to_string())?;
    scratch.push(directory.clone());
    let mut out = Vec::with_capacity(operations.len());
    for (index, operation) in operations.iter().enumerate() {
        if op_of(operation) != "add_chart" {
            out.push(operation.clone());
            continue;
        }
        let mut block = operation.as_object().cloned().unwrap_or_default();
        for key in ["op", "paragraph", "width", "altText", "properties"] {
            block.shift_remove(key);
        }
        let block = Value::Object(block);
        let wide = operation.get("width").map_or(f64::NAN, to_number);
        let points_wide = if wide > 0.0 { wide } else { DOCUMENT_CHART_WIDTH };
        let pdf = directory.join(format!("chart-{}.pdf", index + 1));
        let image = cx.host.chart_picture(&block, points_wide, &pdf).await?;
        let alt = js_trim(&text_of(operation.get("altText"))).to_owned();
        let mut picture = Map::new();
        picture.insert("op".to_owned(), json!("add_image"));
        picture.insert("path".to_owned(), json!(image));
        picture.insert("width".to_owned(), json_number(points_wide));
        picture.insert("altText".to_owned(), json!(if alt.is_empty() { chart_description(&block) } else { alt }));
        for key in ["paragraph", "properties"] {
            if let Some(value) = operation.get(key).filter(|value| truthy(value)) {
                picture.insert(key.to_owned(), value.clone());
            }
        }
        out.push(Value::Object(picture));
    }
    Ok(out)
}
/// `prepareBatchOperations(session, args)`: the design-expanded, cwd-localised, contract-checked operation list and the design plan
/// it came from. The session takes the merged design request, the design in force and, for a Word document or workbook written to a
/// brief, that brief.
pub async fn prepare_batch_operations<P: WriteProof, H: ComHost, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, handle: &SessionHandle, args: &Value) -> Result<Prepared, String> {
    let facts = Facts::of(handle);
    let design_request = merge_office_design_request(facts.design_request.as_ref(), args.get("design"));
    let mut requested: Vec<Value> = args.get("operations").and_then(Value::as_array).cloned().unwrap_or_default();
    assert_office_operation_contracts(&facts.format, facts.backend.as_str(), &mut requested)?;
    let requested = Value::Array(requested);
    let expanded = expand_office_design_operations(&ExpandRequest {
        format: &facts.format,
        operations: &requested,
        design: &design_request,
        library: facts.design_library.as_ref(),
        created: facts.created,
        snapshot_version: facts.snapshot_version as f64,
    })?;
    let design = expanded.get("design").cloned().unwrap_or(Value::Null);
    {
        let mut session = lock(handle);
        session.design_request = Some(design_request);
        session.design = Some(design.clone());
    }
    // A Word document or workbook written to a brief (design.brief, the deck's key: value lines) is held to it as an authored deck is:
    // its figures against the facts, and a scored page review at finalize.
    if matches!(facts.format.as_str(), "docx" | "xlsx")
        && let Some(text) = args.get("design").and_then(|design| design.get("brief")).and_then(Value::as_str)
        && let Some(brief) = document_brief(cx.host.brief_readings(), text)
    {
        lock(handle).authored.brief = Some(brief);
    }
    let cwd = text_of(args.get("__cwd"));
    let base_dir = if cwd.is_empty() { dirname(&facts.target) } else { cwd };
    let semantic: Vec<Value> = expanded.get("semantic").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut operations: Vec<Value> = Vec::new();
    for operation in expanded.get("operations").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        operations.push(localize_operation(operation, &base_dir)?);
    }
    if operations.is_empty() {
        return Err("batch requires at least one operation".to_owned());
    }
    if facts.format == "pptx" && operations.iter().any(|operation| op_of(operation) == "import_slides") && operations.iter().any(|operation| op_of(operation) == "keep_slides") {
        return Err("Run keep_slides in a later batch after import_slides has been saved".to_owned());
    }
    assert_office_operation_contracts(&facts.format, facts.backend.as_str(), &mut operations)?;
    let mut scratch: Vec<PathBuf> = Vec::new();
    match finish_operations(cx, &facts, operations, &mut scratch).await {
        Ok((operations, template_data)) => Ok(Prepared { operations, design, semantic, template_data, scratch }),
        Err(error) => {
            for directory in &scratch {
                let _ = mixdog_fsio::remove_dir_all(cx.lane(), directory);
            }
            Err(error)
        }
    }
}
/// The rest of the preparation, after the contract: template pages, imported backgrounds, Word charts, filled formulas, the sheet
/// contract and the shared defaults.
async fn finish_operations<P: WriteProof, H: ComHost, B: BatchHost>(cx: &BatchContext<'_, P, H, B>, facts: &Facts, operations: Vec<Value>, scratch: &mut Vec<PathBuf>) -> Result<(Vec<Value>, Vec<Value>), String> {
    let snapshot = &cx.inspect.snapshot;
    let proof: &P = snapshot.proof;
    // A template page is chosen and filled before any backend sees the batch: it arrives as the import of that one page and the writes
    // into its own slots, which both backends already perform.
    let mut template_data: Vec<Value> = Vec::new();
    let mut operations = expand_template_page_operations(proof, &facts.format, &operations, &mut template_data, &mut |path: &str| {
        snapshot_portable_ooxml(proof, snapshot.measurer, Path::new(path), "pptx", &json!({}))
    })?;
    if facts.format == "pptx" && facts.microsoft_office && operations.iter().any(|operation| op_of(operation) == "import_slides") {
        operations = with_imported_slide_backgrounds(cx, operations)?;
    }
    operations = with_document_charts(cx, &facts.format, operations, scratch).await?;
    // set_formula over a range is written cell by cell, each formula moved as Excel's fill moves it, before either backend sees it: both
    // then write cells they already write.
    if facts.format == "xlsx" {
        let failure: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
        let translate = |formula: &str, rows: i64, columns: i64| match translate_shared_formula(formula, rows, columns) {
            Ok(moved) => moved,
            Err(error) => {
                failure.borrow_mut().get_or_insert(error.to_string());
                formula.to_owned()
            }
        };
        operations = expand_filled_formulas(&operations, &translate)?;
        if let Some(error) = failure.into_inner() {
            return Err(error);
        }
    }
    if facts.format == "xlsx" || is_tabular_format(&facts.format) {
        validate_xlsx_operations(&mut operations)?;
    }
    // Excel rejects `My Sheet!A1` outright; the portable writer quotes it from the sheet list, and an Excel session gets the same courtesy
    // here.
    if facts.format == "xlsx" && facts.microsoft_office {
        for operation in &mut operations {
            if op_of(operation) != "set_formula" {
                continue;
            }
            if let Some(formula) = operation.get("formula").and_then(Value::as_str).map(quote_unquoted_sheet_references)
                && let Some(fields) = operation.as_object_mut()
            {
                fields.insert("formula".to_owned(), json!(formula));
            }
        }
    }
    let operations = with_page_size_points(&facts.format, operations)?;
    let operations = with_title_leading(&facts.format, operations);
    let operations = with_figure_column_alignments(&facts.format, operations);
    let operations = with_slide_table_widths(snapshot.measurer, &facts.format, operations)?;
    let operations = with_table_style_names(&facts.format, operations);
    Ok((with_image_proportions(proof, &facts.format, operations), template_data))
}
