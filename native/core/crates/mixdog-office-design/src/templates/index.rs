//! `design-template-index.mjs`: the inspection of a template file and the template index. The index is cached by file: an
//! entry is reused while the file, its sidecar (`<template>.mixdog.json`) and the inspector version are unchanged.
//! [`OfficeTemplateIndexer`] is the [`TemplateIndexer`] the design library calls (`indexOfficeTemplates`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::{js_to_lowercase, json_number, json_stringify, locale_compare, to_number_of, value_to_string};
use mixdog_office_base::values::{sha256, truthy};
use mixdog_ooxml::xml::{compiled, xml_decode};
use serde_json::{Map, Value, json};

use super::induct::{induce_pptx_sample_roles, role_key};
use super::inspect::{
    direct_pptx_shape_blocks, extname, fs_message, infer_pptx_sample_kind, number_from_path, office_template_coverage, pptx_sample_capacity,
    pptx_shape_metadata, pptx_slide_entries, pptx_slot, walk_template_directory, xml_attribute,
};
use crate::library::{
    Environment, LibraryConfig, SCHEMA_VERSION, TEMPLATE_INSPECTOR_VERSION, TemplateIndexer, canonical_path, library_paths, normalize_layouts,
    normalize_local_samples, read_json, safe_id, sha256_file, template_format, write_json_atomic,
};
use crate::{opt_prop, prop, text};

fn slide_density(text_chars: usize, shape_count: usize) -> &'static str {
    if text_chars > 340 || shape_count > 16 {
        "dense"
    } else if text_chars > 120 || shape_count > 8 {
        "balanced"
    } else {
        "light"
    }
}

fn shape_slots(shapes: &[Value]) -> Vec<Value> {
    shapes.iter().filter_map(|shape| prop(shape, "slot").filter(|slot| truthy(slot)).cloned()).collect()
}

fn shape_list(sample: &Value) -> &[Value] {
    prop(sample, "shapes").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
}

fn slot_role_is_title(shape: &Value) -> bool {
    opt_prop(prop(shape, "slot"), "role") == Some(&Value::String("title".to_owned()))
}

fn pptx_sample_slide(slide: usize, part: f64, xml: &str) -> Value {
    let shapes: Vec<Value> = direct_pptx_shape_blocks(xml).iter().enumerate().map(|(index, block)| pptx_shape_metadata(block, index + 1)).collect();
    let text_chars: usize = shapes.iter().map(|shape| text(prop(shape, "text")).encode_utf16().count()).sum();
    let title = shapes
        .iter()
        .find(|shape| matches!(text(prop(shape, "placeholderType")).as_str(), "title" | "ctrTitle"))
        .map(|shape| text(prop(shape, "text")))
        .filter(|title| !title.is_empty())
        .or_else(|| shapes.iter().find(|shape| slot_role_is_title(shape)).map(|shape| text(prop(shape, "text"))))
        .unwrap_or_default();
    let mut capabilities: Vec<Value> = Vec::new();
    for shape in &shapes {
        let kind = prop(shape, "type").cloned().unwrap_or(Value::Null);
        if kind != "text" && !capabilities.contains(&kind) {
            capabilities.push(kind);
        }
    }
    let slots = shape_slots(&shapes);
    let density = slide_density(text_chars, shapes.len());
    json!({
        "slide": slide,
        "part": json_number(part),
        "title": title,
        "textChars": text_chars,
        "density": density,
        "shapes": shapes,
        "slots": slots,
        "capabilities": capabilities,
    })
}

// A drawn page answers with geometry where it has no placeholder to answer with; a role the file states itself always
// wins over the induced one.
fn refine_pptx_sample(sample: &mut Value, canvas: Option<(f64, f64)>, sample_count: usize) {
    let induced = induce_pptx_sample_roles(sample, canvas);
    let body = compiled(r"^body-\d+$", "");
    if let Some(shapes) = sample.get_mut("shapes").and_then(Value::as_array_mut) {
        for shape in shapes.iter_mut() {
            let Some(role) = induced.get(&role_key(to_number_of(prop(shape, "shape")))) else { continue };
            if prop(shape, "slot").is_some_and(truthy) && !body.is_match(&text(opt_prop(prop(shape, "slot"), "role"))) {
                continue;
            }
            let slot = pptx_slot(shape, role);
            shape["slot"] = slot;
        }
    }
    sample["slots"] = Value::Array(shape_slots(shape_list(sample)));
    if !prop(sample, "title").is_some_and(truthy) {
        let title = shape_list(sample).iter().find(|shape| slot_role_is_title(shape)).map(|shape| text(prop(shape, "text"))).unwrap_or_default();
        sample["title"] = Value::String(title);
    }
    sample["kind"] = Value::String(infer_pptx_sample_kind(sample, sample_count as f64));
    sample["capacity"] = pptx_sample_capacity(sample);
}

fn pptx_native_layout(name: &str, xml: &str) -> Value {
    let first = |pattern: &str| compiled(pattern, "i").find(xml).map(|range| &xml[range]).unwrap_or("");
    let root = first(r"<p:sldLayout\b[^>]*>");
    let common = first(r"<p:cSld\b[^>]*>");
    let shapes: Vec<Value> = direct_pptx_shape_blocks(xml).iter().enumerate().map(|(index, block)| pptx_shape_metadata(block, index + 1)).collect();
    json!({
        "layout": json_number(number_from_path(name)),
        "name": xml_attribute(common, "name"),
        "type": xml_attribute(root, "type"),
        "slots": shape_slots(&shapes),
    })
}

fn pptx_theme_summary(xml: &str) -> Value {
    let root = compiled(r"<a:theme\b[^>]*>", "i").find(xml).map(|range| &xml[range]).unwrap_or("");
    let mut fonts: Vec<String> = Vec::new();
    for found in compiled(r#"<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]*)""#, "gi").captures_iter(xml) {
        let face = xml_decode(found.get(1).unwrap_or(""));
        if !face.is_empty() && !fonts.contains(&face) {
            fonts.push(face);
        }
    }
    json!({ "name": xml_attribute(root, "name"), "fonts": fonts })
}

/// `inspectOfficeTemplate(path, { format })`: the sample slides (shape blocks, slots, kind, density, capacity), the
/// native layouts and the theme of a template; a format other than pptx has none of them. An empty `format` is taken
/// from the extension.
pub fn inspect_office_template<P: ReadProof>(proof: &P, path: &str, format: &str) -> Result<Value, String> {
    let normalized = if format.is_empty() { template_format(&js_to_lowercase(&extname(path))).unwrap_or("") } else { format };
    if normalized != "pptx" {
        return Ok(json!({ "sampleSlides": [], "nativeLayouts": [], "theme": null }));
    }
    let bytes = mixdog_fsio::read(proof, path).map_err(|error| fs_message(&error, "open", Path::new(path)))?;
    let zip = super::load_zip(&bytes)?;
    let names = zip.names();
    let entries = pptx_slide_entries(&zip);
    let mut sample_slides: Vec<Value> = entries.iter().map(|entry| pptx_sample_slide(entry.slide, entry.part, &zip.text(&entry.name))).collect();
    let canvas = compiled(r#"<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#, "i")
        .captures(&zip.text("ppt/presentation.xml"))
        .map(|found| (mixdog_js::string_to_number(found.get(1).unwrap_or("")), mixdog_js::string_to_number(found.get(2).unwrap_or(""))));
    let count = sample_slides.len();
    for sample in &mut sample_slides {
        refine_pptx_sample(sample, canvas, count);
    }
    let layout_name = compiled(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$", "i");
    let mut layout_names: Vec<&String> = names.iter().filter(|name| layout_name.is_match(name)).collect();
    layout_names.sort_by(|left, right| number_from_path(left).partial_cmp(&number_from_path(right)).unwrap_or(std::cmp::Ordering::Equal));
    let native_layouts: Vec<Value> = layout_names.iter().map(|name| pptx_native_layout(name, &zip.text(name))).collect();
    let theme_name = compiled(r"^ppt\/theme\/theme\d+\.xml$", "i");
    let theme = names.iter().find(|name| theme_name.is_match(name)).map_or(Value::Null, |name| pptx_theme_summary(&zip.text(name)));
    let coverage = office_template_coverage(&sample_slides);
    Ok(json!({ "sampleSlides": sample_slides, "nativeLayouts": native_layouts, "theme": theme, "coverage": coverage }))
}

/// `normalizeLocalMetadata(value, path)`: what a template's sidecar says: id, label, profile, version, layouts and
/// samples, each checked.
fn normalize_local_metadata(value: &Value, path: &str) -> Result<Value, String> {
    let mut metadata = Map::new();
    if let Some(id) = prop(value, "id").filter(|id| truthy(id)) {
        metadata.insert("id".to_owned(), Value::String(safe_id(Some(id), "local template id")?));
    }
    metadata.insert("label".to_owned(), Value::String(text(prop(value, "label"))));
    let profile = match prop(value, "profile").filter(|profile| truthy(profile)) {
        Some(profile) => safe_id(Some(profile), "local template profile")?,
        None => String::new(),
    };
    metadata.insert("profile".to_owned(), Value::String(profile));
    metadata.insert("version".to_owned(), Value::String(text(prop(value, "version"))));
    metadata.insert("layouts".to_owned(), normalize_layouts(prop(value, "layouts").filter(|layouts| truthy(layouts)), path)?);
    metadata.insert("samples".to_owned(), normalize_local_samples(prop(value, "samples").filter(|samples| truthy(samples)))?);
    Ok(Value::Object(metadata))
}

/// `Number(value || 0)`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    value.filter(|value| truthy(value)).map_or(0.0, |value| to_number_of(Some(value)))
}

/// What `stat` says of a file that the index keeps.
struct Details {
    size: f64,
    mtime_ms: f64,
}

fn stat<P: ReadProof>(proof: &P, path: &Path) -> std::io::Result<Details> {
    let meta = mixdog_fsio::metadata(proof, path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6);
    Ok(Details { size: meta.len() as f64, mtime_ms })
}

// A previous index entry still describes the file when neither the file, its sidecar, nor the inspector changed.
fn template_entry_unchanged(previous: &Value, details: &Details, sidecar: Option<&Details>) -> bool {
    to_number_of(prop(previous, "bytes")) == details.size
        && to_number_of(prop(previous, "mtimeMs")) == details.mtime_ms
        && number_or_zero(prop(previous, "sidecarMtimeMs")) == sidecar.map_or(0.0, |sidecar| sidecar.mtime_ms)
        && number_or_zero(prop(previous, "inspectionVersion")) == TEMPLATE_INSPECTOR_VERSION as f64
}

/// `a === b` of two parsed JSON numbers.
fn same_number(left: Option<&Value>, right: Option<&Value>) -> bool {
    matches!((left.and_then(Value::as_f64), right.and_then(Value::as_f64)), (Some(a), Some(b)) if a == b)
}

// Sidecar role assignments name the slots by shape index; without them the inspected slots stand.
fn sample_slots(sample: &Value, metadata: Option<&Value>) -> Result<Vec<Value>, String> {
    let roles = metadata.and_then(|metadata| prop(metadata, "roles")).and_then(Value::as_object).filter(|roles| !roles.is_empty());
    let Some(roles) = roles else { return Ok(prop(sample, "slots").and_then(Value::as_array).cloned().unwrap_or_default()) };
    let mut slots = Vec::new();
    for (shape_index, role) in roles {
        let wanted = mixdog_js::string_to_number(shape_index);
        let shape = shape_list(sample).iter().find(|shape| prop(shape, "shape").and_then(Value::as_f64) == Some(wanted));
        let Some(shape) = shape else {
            return Err(format!(
                "Office local template sample {} references missing shape {shape_index}",
                value_to_string(prop(sample, "slide").unwrap_or(&Value::Null))
            ));
        };
        slots.push(pptx_slot(shape, &text(Some(role))));
    }
    Ok(slots)
}

/// `a || b`: the sidecar's value where it is truthy.
fn declared(metadata: Option<&Value>, key: &str, fallback: Value) -> Value {
    metadata.and_then(|metadata| prop(metadata, key)).filter(|value| truthy(value)).cloned().unwrap_or(fallback)
}

// One layout per inspected sample slide, overlaid with its sidecar sample.
fn sample_layouts(inspected: &Value, metadata: &Value, id: &str, path: &str) -> Result<Vec<Value>, String> {
    let samples = prop(metadata, "samples").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut layouts = Vec::new();
    for sample in prop(inspected, "sampleSlides").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        let sample_metadata = samples.iter().find(|entry| same_number(prop(entry, "slide"), prop(sample, "slide")));
        let slide = value_to_string(prop(sample, "slide").unwrap_or(&Value::Null));
        let mut capacity = prop(sample, "capacity").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Some(extra) = sample_metadata.and_then(|metadata| prop(metadata, "capacity")).and_then(Value::as_object) {
            for (key, value) in extra {
                capacity.insert(key.clone(), value.clone());
            }
        }
        layouts.push(json!({
            "id": declared(sample_metadata, "id", Value::String(format!("{id}-slide-{slide}"))),
            "format": "pptx",
            "kind": declared(sample_metadata, "kind", prop(sample, "kind").cloned().unwrap_or(Value::Null)),
            "profile": prop(metadata, "profile").cloned().unwrap_or(Value::Null),
            "density": declared(sample_metadata, "density", prop(sample, "density").cloned().unwrap_or(Value::Null)),
            "variant": declared(sample_metadata, "variant", json!("native")),
            "purposes": declared(sample_metadata, "purposes", json!([])),
            "expressionModes": declared(sample_metadata, "expressionModes", json!([])),
            "templateId": id,
            "templatePath": path,
            "sourceSlide": prop(sample, "slide").cloned().unwrap_or(Value::Null),
            "sourceLayout": 0,
            "slots": sample_slots(sample, sample_metadata)?,
            "capacity": capacity,
            "capabilities": prop(sample, "capabilities").cloned().unwrap_or(Value::Null),
            "priority": declared(sample_metadata, "priority", json!(0)),
            "strict": declared(sample_metadata, "strict", json!(false)),
            "defaults": declared(sample_metadata, "defaults", json!({})),
        }));
    }
    Ok(layouts)
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value.and_then(Value::as_array).is_some_and(|items| !items.is_empty())
}

// Sidecar-declared layouts, filled from their source slide where they leave slots, capacity or capabilities unspecified.
fn declared_layouts(metadata: &Value, inspected: &Value, id: &str, path: &str) -> Vec<Value> {
    let samples = prop(inspected, "sampleSlides").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    prop(metadata, "layouts")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|layout| {
            let sample = samples.iter().find(|entry| same_number(prop(entry, "slide"), prop(layout, "sourceSlide")));
            let mut out = layout.as_object().cloned().unwrap_or_default();
            let template_id = prop(layout, "templateId").filter(|value| truthy(value)).cloned().unwrap_or_else(|| Value::String(id.to_owned()));
            out.insert("templateId".to_owned(), template_id);
            out.insert("templatePath".to_owned(), Value::String(path.to_owned()));
            let from_sample = |key: &str, empty: Value| sample.and_then(|sample| prop(sample, key)).filter(|v| truthy(v)).cloned().unwrap_or(empty);
            let slots = if non_empty_array(prop(layout, "slots")) { layout["slots"].clone() } else { from_sample("slots", json!([])) };
            let has_capacity = prop(layout, "capacity").and_then(Value::as_object).is_some_and(|capacity| !capacity.is_empty());
            let capacity = if has_capacity { layout["capacity"].clone() } else { from_sample("capacity", json!({})) };
            let capabilities =
                if non_empty_array(prop(layout, "capabilities")) { layout["capabilities"].clone() } else { from_sample("capabilities", json!([])) };
            out.insert("slots".to_owned(), slots);
            out.insert("capacity".to_owned(), capacity);
            out.insert("capabilities".to_owned(), capabilities);
            Value::Object(out)
        })
        .collect()
}

fn indexed_sample_slides(inspected: &Value, layouts: &[Value]) -> Vec<Value> {
    prop(inspected, "sampleSlides")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|sample| {
            let layout = layouts.iter().find(|entry| same_number(prop(entry, "sourceSlide"), prop(sample, "slide")));
            let layout_slots = layout.and_then(|layout| prop(layout, "slots")).and_then(Value::as_array);
            let title_shape = shape_list(sample).iter().find(|shape| {
                layout_slots.is_some_and(|slots| {
                    slots
                        .iter()
                        .any(|slot| prop(slot, "role") == Some(&Value::String("title".to_owned())) && same_number(prop(slot, "shape"), prop(shape, "shape")))
                })
            });
            let mut out = sample.as_object().cloned().unwrap_or_default();
            let title = text(prop(sample, "title"));
            let title = if title.is_empty() { title_shape.map(|shape| text(prop(shape, "text"))).unwrap_or_default() } else { title };
            let from_layout = |key: &str, fallback: Option<&Value>| {
                layout.and_then(|layout| prop(layout, key)).filter(|v| truthy(v)).or(fallback).cloned().unwrap_or(Value::Null)
            };
            out.insert("title".to_owned(), Value::String(title));
            out.insert("kind".to_owned(), from_layout("kind", prop(sample, "kind")));
            out.insert("density".to_owned(), from_layout("density", prop(sample, "density")));
            out.insert("purposes".to_owned(), layout.and_then(|layout| prop(layout, "purposes")).filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!([])));
            out.insert(
                "expressionModes".to_owned(),
                layout.and_then(|layout| prop(layout, "expressionModes")).filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!([])),
            );
            out.insert("slots".to_owned(), from_layout("slots", prop(sample, "slots")));
            out.insert("capacity".to_owned(), from_layout("capacity", prop(sample, "capacity")));
            Value::Object(out)
        })
        .collect()
}

fn inspect_template_file<P: ReadProof>(proof: &P, path: &str, format: &str) -> (Value, String) {
    match inspect_office_template(proof, path, format) {
        Ok(inspected) => (inspected, String::new()),
        Err(message) => (json!({ "sampleSlides": [], "nativeLayouts": [], "theme": null, "coverage": office_template_coverage(&[]) }), message),
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn index_template_file<P: ReadProof>(
    proof: &P,
    env: &Environment,
    path: &Path,
    details: &Details,
    sidecar_path: &Path,
    sidecar: Option<&Details>,
) -> Result<Value, String> {
    let path_text = path.to_string_lossy().into_owned();
    let canonical = canonical_path(env, &path_text);
    let digest = sha256_file(proof, path).map_err(|error| fs_message(&error, "open", path))?;
    let metadata = normalize_local_metadata(&read_json(proof, sidecar_path, json!({})), &path_text)?;
    let id = match prop(&metadata, "id").filter(|id| truthy(id)) {
        Some(id) => text(Some(id)),
        None => format!("local-{}", &sha256(&canonical)[..16]),
    };
    let extension = js_to_lowercase(&extname(&path_text));
    let format = template_format(&extension).unwrap_or("");
    let (inspected, warning) = inspect_template_file(proof, &path_text, format);
    let has_layouts = non_empty_array(prop(&metadata, "layouts"));
    let layouts = if has_layouts { declared_layouts(&metadata, &inspected, &id, &path_text) } else { sample_layouts(&inspected, &metadata, &id, &path_text)? };
    let sample_slides = indexed_sample_slides(&inspected, &layouts);
    let label = text(prop(&metadata, "label"));
    let version = text(prop(&metadata, "version"));
    let coverage = office_template_coverage(&sample_slides);
    Ok(json!({
        "id": id,
        "label": if label.is_empty() { file_name(&path_text).to_owned() } else { label },
        "format": format,
        "fileKind": js_to_lowercase(extension.trim_start_matches('.')),
        "path": env.resolve(&path_text).to_string_lossy(),
        "source": "local-template",
        "bytes": json_number(details.size),
        "mtimeMs": json_number(details.mtime_ms),
        "sidecarMtimeMs": json_number(sidecar.map_or(0.0, |sidecar| sidecar.mtime_ms)),
        "inspectionVersion": TEMPLATE_INSPECTOR_VERSION,
        "inspectionWarning": warning,
        "sha256": digest,
        "version": if version.is_empty() { digest[..16].to_owned() } else { format!("{version}+{}", &digest[..12]) },
        "profile": prop(&metadata, "profile").cloned().unwrap_or(Value::Null),
        "layouts": layouts,
        "sampleSlides": sample_slides,
        "coverage": coverage,
        "nativeLayouts": prop(&inspected, "nativeLayouts").cloned().unwrap_or(Value::Null),
        "theme": prop(&inspected, "theme").cloned().unwrap_or(Value::Null),
    }))
}

/// The message Node gives for a `path` argument that is not a string.
fn path_type_error(value: Option<&Value>) -> String {
    let received = match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => format!("type boolean ({flag})"),
        Some(Value::Number(number)) => format!("type number ({})", value_to_string(&Value::Number(number.clone()))),
        Some(Value::Array(_)) => "an instance of Array".to_owned(),
        Some(_) => "an instance of Object".to_owned(),
    };
    format!("The \"path\" argument must be of type string. Received {received}")
}

fn previous_entries_by_path<'a>(env: &Environment, previous: &'a Value) -> Result<HashMap<String, &'a Value>, String> {
    let entries: &[Value] = match prop(previous, "templates").filter(|templates| truthy(templates)) {
        None => &[],
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("(previous.templates || []).map is not a function".to_owned()),
    };
    let mut by_path: HashMap<String, &Value> = HashMap::new();
    for entry in entries {
        match prop(entry, "path") {
            Some(Value::String(path)) => by_path.insert(canonical_path(env, path), entry),
            other => return Err(path_type_error(other)),
        };
    }
    Ok(by_path)
}

fn index_template_files<P: ReadProof>(
    lane: &P,
    env: &Environment,
    files: &[PathBuf],
    previous_by_path: &HashMap<String, &Value>,
) -> Result<Vec<Value>, String> {
    let mut templates: Vec<Value> = Vec::new();
    for path in files {
        let details = stat(lane, path).map_err(|error| fs_message(&error, "stat", path))?;
        let sidecar_path = PathBuf::from(format!("{}.mixdog.json", path.to_string_lossy()));
        let sidecar = stat(lane, &sidecar_path).ok();
        let canonical = canonical_path(env, &path.to_string_lossy());
        if let Some(entry) = previous_by_path.get(&canonical).filter(|entry| template_entry_unchanged(entry, &details, sidecar.as_ref())) {
            templates.push((*entry).clone());
            continue;
        }
        templates.push(index_template_file(lane, env, path, &details, &sidecar_path, sidecar.as_ref())?);
    }
    templates.sort_by(|left, right| {
        locale_compare(&text(prop(left, "id")), &text(prop(right, "id"))).then_with(|| locale_compare(&text(prop(left, "path")), &text(prop(right, "path"))))
    });
    Ok(templates)
}

fn templates_revision(templates: &[Value]) -> String {
    let digest_rows: Vec<Value> = templates
        .iter()
        .map(|entry| Value::Array(["id", "path", "sha256", "sidecarMtimeMs"].iter().map(|key| prop(entry, key).cloned().unwrap_or(Value::Null)).collect()))
        .collect();
    sha256(json_stringify(&Value::Array(digest_rows)))
}

/// `indexOfficeTemplates({ dataDir, config })`: walks the template directories of `config`, indexes what changed and
/// writes `template-index.json`; answers the index (with `changed` and `count`).
pub fn index_office_templates<P: WriteProof>(lane: &P, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String> {
    let paths = library_paths(env, data_dir);
    mixdog_fsio::create_dir_all(lane, &paths.templates).map_err(|error| fs_message(&error, "mkdir", &paths.templates))?;
    let previous = read_json(lane, &paths.template_index, json!({ "templates": [] }));
    let previous_by_path = previous_entries_by_path(env, &previous)?;
    let mut files: Vec<PathBuf> = Vec::new();
    for directory in &config.template_directories {
        walk_template_directory(lane, Path::new(directory), &mut files, 0);
    }
    let templates = index_template_files(lane, env, &files, &previous_by_path)?;
    let revision = templates_revision(&templates);
    let changed = prop(&previous, "revision") != Some(&Value::String(revision.clone()));
    let index = json!({
        "schemaVersion": SCHEMA_VERSION,
        "indexedAt": crate::library::iso_string(env.now()),
        "revision": revision,
        "directories": config.template_directories,
        "templates": templates,
    });
    if changed || !prop(&previous, "revision").is_some_and(truthy) {
        write_json_atomic(lane, &paths.template_index, &index)?;
    }
    let mut answer = index;
    answer["changed"] = Value::Bool(changed);
    answer["count"] = Value::from(files.len());
    Ok(answer)
}

/// The template indexer of the design library: `indexOfficeTemplates` on the lane the library call runs on.
pub struct OfficeTemplateIndexer;

impl<P: WriteProof> TemplateIndexer<P> for OfficeTemplateIndexer {
    fn index(&self, lane: &P, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String> {
        index_office_templates(lane, env, data_dir, config)
    }
}
