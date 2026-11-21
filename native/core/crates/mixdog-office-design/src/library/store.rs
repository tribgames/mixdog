//! `design/library/design-library.mjs`: the library's state on disk and the questions asked of it. A sync reads the
//! cached pack, asks the pack server whether there is a newer signed pack (an `If-None-Match` request, at most every
//! `checkIntervalMs`), verifies and materialises it, and records the outcome in `state.json`. Per-document bindings pin
//! the pack and template version a document was designed with; the composition history keeps the last 48 compositions
//! so the next document differs; `resolve_office_design_library` answers a design request with the pack, the template,
//! the layouts, the recent compositions and the binding to persist; `inspect_office_design_library` reports the state.
//!
//! The one thing taken from outside the library files is the template index: `indexOfficeTemplates` is the port of
//! `design-template-index.mjs` (the templates module), reached through [`TemplateIndexer`]. Reading the index file and
//! writing the state file are here ([`read_template_index`], [`write_state`]) and are the ones the index writer uses.

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_fsio::ReadProof;
use mixdog_fsio::WriteProof;
use mixdog_js::{json_number, json_parse, locale_compare, slice_utf16, to_number_of, v8_json_parse_error, value_to_string};
use mixdog_office_base::values::{clone, plain_object, sha256, truthy};
use serde_json::{Map, Value, json};
use url::Url;

use super::core::{
    Environment, LibraryConfig, LibraryPaths, MAX_COMPOSITION_HISTORY, MAX_MANIFEST_BYTES, SCHEMA_VERSION, canonical_path, compare_office_design_versions,
    is_format, library_paths, load_config, read_json, safe_id, write_json_atomic,
};
use super::pack::{Fetch, FetchRequest, load_cached_pack, materialize_pack, pack_summary, response_bytes, verify_office_design_pack_envelope};
use crate::{opt_prop, prop, text};

/// `indexOfficeTemplates({ dataDir, config })`: walks the template directories of `config`, indexes what changed and
/// writes `template-index.json`; answers the index (with `changed` and `count`).
pub trait TemplateIndexer<P: WriteProof> {
    fn index(&self, lane: &P, env: &Environment, data_dir: &Path, config: &LibraryConfig) -> Result<Value, String>;
}

/// What a library call runs with: the lane its file work happens on, the process environment, the network and the
/// template indexer.
pub struct Context<'a, P: WriteProof> {
    pub lane: &'a P,
    pub env: &'a Environment,
    pub fetch: &'a dyn Fetch,
    pub indexer: &'a dyn TemplateIndexer<P>,
}

fn io_message(error: std::io::Error) -> String {
    error.to_string()
}

/// `new Date(ms).toISOString()`.
pub fn iso_string(ms: f64) -> String {
    let total = ms as i64;
    let (days, rest) = (total.div_euclid(86_400_000), total.rem_euclid(86_400_000));
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

/// `readTemplateIndex(paths)`: the index file, or an empty index.
pub fn read_template_index<P: ReadProof>(proof: &P, paths: &LibraryPaths) -> Value {
    read_json(proof, &paths.template_index, json!({ "schemaVersion": SCHEMA_VERSION, "revision": "", "templates": [] }))
}

/// `writeState(paths, state)`: `state.json` with `schemaVersion` first, then the state's own keys.
pub fn write_state<P: WriteProof>(lane: &P, paths: &LibraryPaths, state: &Map<String, Value>) -> Result<(), String> {
    let mut record = Map::new();
    record.insert("schemaVersion".to_owned(), Value::from(SCHEMA_VERSION));
    for (key, value) in state {
        record.insert(key.clone(), value.clone());
    }
    write_json_atomic(lane, &paths.state, &Value::Object(record))
}

/// How a sync is asked.
pub struct SyncOptions<'a> {
    pub data_dir: &'a Path,
    /// The configuration object to use instead of the config file.
    pub config: Option<&'a Value>,
    pub force: bool,
    pub allow_remote: bool,
    pub index_templates: bool,
}

impl<'a> SyncOptions<'a> {
    /// The defaults of `syncOfficeDesignLibrary`: remote allowed, templates indexed, no force.
    pub fn new(data_dir: &'a Path) -> Self {
        Self { data_dir, config: None, force: false, allow_remote: true, index_templates: true }
    }
}

/// What a sync answers; every exit reports the same library state.
#[derive(Clone, Debug)]
pub struct SyncResult {
    pub ok: bool,
    pub active_pack: Option<Value>,
    pub templates: Value,
    pub checked: bool,
    pub updated: Option<bool>,
    pub warning: String,
}

impl SyncResult {
    /// The object Node returns.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("ok".to_owned(), Value::Bool(self.ok));
        out.insert("activePack".to_owned(), self.active_pack.clone().unwrap_or(Value::Null));
        out.insert("active".to_owned(), pack_summary(self.active_pack.as_ref()));
        out.insert("templates".to_owned(), self.templates.clone());
        out.insert("checked".to_owned(), Value::Bool(self.checked));
        if let Some(updated) = self.updated {
            out.insert("updated".to_owned(), Value::Bool(updated));
        }
        out.insert("warning".to_owned(), Value::String(self.warning.clone()));
        Value::Object(out)
    }
}

fn add_warning(warning: &mut String, message: &str) {
    *warning = [warning.as_str(), message].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join(" ");
}

fn state_map(state: Value) -> Map<String, Value> {
    match state {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<Value, String> {
    let manifest = String::from_utf8_lossy(bytes).into_owned();
    json_parse(&manifest).map_err(|error| v8_json_parse_error(&manifest).unwrap_or_else(|| error.to_string()))
}

/// `syncOfficeDesignLibrary`: refreshes the template index, loads the active cached pack and, when remote checks are
/// allowed, a manifest URL is configured and the check is due (or forced), fetches, verifies and activates a newer
/// pack. A failure of the check is not an error: it is the `warning` of a result with `ok` false.
pub fn sync_office_design_library<P: WriteProof>(cx: &Context<'_, P>, options: &SyncOptions<'_>) -> Result<SyncResult, String> {
    let config = load_config(cx.lane, cx.env, options.data_dir, options.config)?;
    sync_with_config(cx, options.data_dir, &config, options.force, options.allow_remote, options.index_templates)
}

fn sync_with_config<P: WriteProof>(
    cx: &Context<'_, P>,
    data_dir: &Path,
    config: &LibraryConfig,
    force: bool,
    allow_remote: bool,
    index_templates: bool,
) -> Result<SyncResult, String> {
    let paths = library_paths(cx.env, data_dir);
    mixdog_fsio::create_dir_all(cx.lane, &paths.root).map_err(io_message)?;
    let mut warning = String::new();
    let template_index = if index_templates {
        match cx.indexer.index(cx.lane, cx.env, data_dir, config) {
            Ok(index) => index,
            Err(message) => {
                add_warning(&mut warning, &format!("Office template index was not updated: {message}"));
                read_template_index(cx.lane, &paths)
            }
        }
    } else {
        read_template_index(cx.lane, &paths)
    };
    let mut state = state_map(read_json(cx.lane, &paths.state, json!({ "schemaVersion": SCHEMA_VERSION })));
    let active = state.get("active").cloned();
    let mut active_pack = match load_cached_pack(cx.lane, &paths, config, opt_prop(active.as_ref(), "id"), opt_prop(active.as_ref(), "version")) {
        Ok(pack) => pack,
        Err(message) => {
            add_warning(&mut warning, &message);
            None
        }
    };
    let now = cx.env.now();
    let last_checked = to_number_of(state.get("lastCheckedAt"));
    let due = force || last_checked.is_nan() || last_checked == 0.0 || now - last_checked >= config.check_interval_ms;
    if !allow_remote || config.manifest_url.is_empty() || !due {
        return Ok(SyncResult { ok: warning.is_empty(), active_pack, templates: template_index, checked: false, updated: None, warning });
    }
    match check_remote(cx, &paths, config, &mut state, &mut active_pack, now) {
        Ok(updated) => Ok(SyncResult { ok: warning.is_empty(), active_pack, templates: template_index, checked: true, updated: Some(updated), warning }),
        Err(message) => {
            add_warning(&mut warning, &message);
            state.insert("lastCheckedAt".to_owned(), json_number(now));
            state.insert("lastError".to_owned(), Value::String(slice_utf16(&warning, 1_000)));
            let _ = write_state(cx.lane, &paths, &state);
            Ok(SyncResult { ok: false, active_pack, templates: template_index, checked: true, updated: Some(false), warning })
        }
    }
}

/// The manifest check of a sync: answers whether a newer pack was activated.
fn check_remote<P: WriteProof>(
    cx: &Context<'_, P>,
    paths: &LibraryPaths,
    config: &LibraryConfig,
    state: &mut Map<String, Value>,
    active_pack: &mut Option<Value>,
    now: f64,
) -> Result<bool, String> {
    let url = Url::parse(&config.manifest_url).map_err(|_| "Invalid URL".to_owned())?;
    if url.scheme() != "https" {
        return Err("Office design pack manifest requires an HTTPS URL".to_owned());
    }
    let etag = state.get("etag").filter(|tag| truthy(tag)).map(value_to_string);
    let request = FetchRequest { url: url.as_str(), if_none_match: etag.as_deref(), timeout: Duration::from_secs(10), max_bytes: MAX_MANIFEST_BYTES };
    let response = cx.fetch.get(&request)?;
    if response.status == 304 {
        state.insert("lastCheckedAt".to_owned(), json_number(now));
        state.insert("lastError".to_owned(), Value::String(String::new()));
        write_state(cx.lane, paths, state)?;
        return Ok(false);
    }
    let bytes = response_bytes(&response, MAX_MANIFEST_BYTES, "Office design pack manifest")?;
    let envelope = parse_manifest(&bytes)?;
    let verified = verify_office_design_pack_envelope(&envelope, &config.trusted_keys)?;
    let pack_id = text(prop(&verified.pack, "id"));
    let pack_version = text(prop(&verified.pack, "version"));
    let pack_channel = text(prop(&verified.pack, "channel"));
    if !config.pack_id.is_empty() && pack_id != config.pack_id {
        return Err(format!("Office design pack {pack_id} does not match configured pack {}", config.pack_id));
    }
    if !config.channel.is_empty() && pack_channel != config.channel {
        return Err(format!("Office design pack channel {pack_channel} does not match {}", config.channel));
    }
    let should_activate = match active_pack.as_ref() {
        None => true,
        Some(active) => text(prop(active, "id")) != pack_id || compare_office_design_versions(&pack_version, &text(prop(active, "version")))? > 0,
    };
    if should_activate {
        materialize_pack(cx.lane, &verified, paths, cx.fetch)?;
        *active_pack = load_cached_pack(cx.lane, paths, config, Some(&Value::String(pack_id.clone())), Some(&Value::String(pack_version.clone())))?;
    }
    if let Some(active) = active_pack.as_ref() {
        state.insert(
            "active".to_owned(),
            json!({ "id": prop(active, "id").cloned().unwrap_or(Value::Null), "version": prop(active, "version").cloned().unwrap_or(Value::Null) }),
        );
    }
    state.insert("lastCheckedAt".to_owned(), json_number(now));
    if should_activate {
        state.insert("lastActivatedAt".to_owned(), json_number(now));
    }
    let tag = response.etag.clone().filter(|tag| !tag.is_empty()).or_else(|| etag.clone()).unwrap_or_default();
    state.insert("etag".to_owned(), Value::String(tag));
    state.insert("lastError".to_owned(), Value::String(String::new()));
    write_state(cx.lane, paths, state)?;
    Ok(should_activate)
}

/// The type error `path.resolve(value)` throws for a value that is not a string.
fn path_type_error(value: Option<&Value>) -> String {
    let received = match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Number(number)) => format!("type number ({number})"),
        Some(Value::Bool(flag)) => format!("type boolean ({flag})"),
        Some(Value::Array(_)) => "an instance of Array".to_owned(),
        Some(Value::Object(_)) => "an instance of Object".to_owned(),
        Some(Value::String(_)) => "type string".to_owned(),
    };
    format!("The \"path\" argument must be of type string. Received {received}")
}

fn binding_path(env: &Environment, paths: &LibraryPaths, document_path: &str) -> PathBuf {
    paths.bindings.join(format!("{}.json", sha256(canonical_path(env, document_path))))
}

/// `readOfficeDesignBinding`: the binding recorded for a document, only when it names that document.
fn read_office_design_binding<P: ReadProof>(proof: &P, env: &Environment, data_dir: &Path, document_path: &str) -> Result<Option<Value>, String> {
    let paths = library_paths(env, data_dir);
    let binding = read_json(proof, &binding_path(env, &paths, document_path), Value::Null);
    if binding.is_null() {
        return Ok(None);
    }
    match prop(&binding, "documentPath") {
        Some(Value::String(recorded)) if canonical_path(env, recorded) == canonical_path(env, document_path) => Ok(Some(binding)),
        Some(Value::String(_)) => Ok(None),
        other => Err(path_type_error(other)),
    }
}

/// `persistOfficeDesignBinding(dataDir, documentPath, binding)`: the binding pinned to the document, written to
/// `bindings/<sha256 of the canonical path>.json`. Answers the record, or `None` for an empty binding.
pub fn persist_office_design_binding<P: WriteProof>(
    lane: &P,
    env: &Environment,
    data_dir: &Path,
    document_path: &str,
    binding: &Value,
) -> Result<Option<Value>, String> {
    if !truthy(binding) {
        return Ok(None);
    }
    let paths = library_paths(env, data_dir);
    let mut record = Map::new();
    record.insert("schemaVersion".to_owned(), Value::from(SCHEMA_VERSION));
    if let Value::Object(entries) = clone(binding) {
        for (key, value) in entries {
            record.insert(key, value);
        }
    }
    record.insert("documentPath".to_owned(), Value::String(env.resolve(document_path).to_string_lossy().into_owned()));
    record.insert("updatedAt".to_owned(), Value::String(iso_string(env.now())));
    let record = Value::Object(record);
    write_json_atomic(lane, &binding_path(env, &paths, document_path), &record)?;
    Ok(Some(record))
}

/// `normalizedCompositionRecord`.
fn normalized_composition_record(value: &Value) -> Option<Value> {
    if !plain_object(value) {
        return None;
    }
    let fingerprint = text(prop(value, "fingerprint"));
    let format = mixdog_js::js_to_lowercase(&text(prop(value, "format")));
    if fingerprint.is_empty() || !is_format(&format) {
        return None;
    }
    let mut ids: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = prop(value, "compositionIds") {
        for entry in items {
            let id = mixdog_js::js_trim(&text(Some(entry))).to_owned();
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids.truncate(64);
    Some(json!({
        "fingerprint": fingerprint,
        "format": format,
        "profile": text(prop(value, "profile")),
        "purpose": text(prop(value, "purpose")),
        "expressionMode": text(prop(value, "expressionMode")),
        "compositionIds": ids,
        "documentKey": text(prop(value, "documentKey")),
        "createdAt": text(prop(value, "createdAt")),
    }))
}

fn history_records<P: ReadProof>(proof: &P, paths: &LibraryPaths) -> Vec<Value> {
    let store = read_json(proof, &paths.composition_history, json!({ "records": [] }));
    match prop(&store, "records") {
        Some(Value::Array(records)) => records.iter().filter_map(normalized_composition_record).collect(),
        _ => Vec::new(),
    }
}

/// `readOfficeCompositionHistory(dataDir, { format, limit, excludeDocumentPath })`: the recent compositions, newest
/// first, of one format (any when empty), without the given document's own, at most `limit` (24 when `limit` is 0 or not a
/// number; never more than 48).
pub fn read_office_composition_history<P: ReadProof>(
    proof: &P,
    env: &Environment,
    data_dir: &Path,
    format: &str,
    limit: f64,
    exclude_document_path: &str,
) -> Vec<Value> {
    let paths = library_paths(env, data_dir);
    let wanted = mixdog_js::js_to_lowercase(format);
    let excluded = if exclude_document_path.is_empty() { String::new() } else { sha256(canonical_path(env, exclude_document_path)) };
    let mut records: Vec<Value> = history_records(proof, &paths)
        .into_iter()
        .filter(|entry| wanted.is_empty() || text(prop(entry, "format")) == wanted)
        .filter(|entry| excluded.is_empty() || text(prop(entry, "documentKey")) != excluded)
        .collect();
    records.sort_by(|left, right| locale_compare(&text(prop(right, "createdAt")), &text(prop(left, "createdAt"))));
    let limit = if limit.is_nan() || limit == 0.0 { 24.0 } else { limit };
    let keep = 1.0_f64.max(limit.min(MAX_COMPOSITION_HISTORY as f64)) as usize;
    records.truncate(keep);
    records
}

/// What one composition remembers (`recordOfficeCompositionHistory`'s argument).
pub struct CompositionRecord<'a> {
    pub document_path: &'a str,
    pub format: &'a str,
    pub profile: &'a str,
    pub purpose: &'a str,
    pub expression_mode: &'a str,
    pub fingerprint: &'a str,
    /// An array of ids.
    pub composition_ids: &'a Value,
}

/// `recordOfficeCompositionHistory`: the document's record replaces its earlier one, the newest first, 48 kept.
/// Answers the record.
pub fn record_office_composition_history<P: WriteProof>(lane: &P, env: &Environment, data_dir: &Path, input: &CompositionRecord<'_>) -> Result<Value, String> {
    let paths = library_paths(env, data_dir);
    let document_key = sha256(canonical_path(env, input.document_path));
    let candidate = json!({
        "documentKey": document_key,
        "format": input.format,
        "profile": input.profile,
        "purpose": input.purpose,
        "expressionMode": input.expression_mode,
        "fingerprint": input.fingerprint,
        "compositionIds": input.composition_ids,
        "createdAt": iso_string(env.now()),
    });
    let Some(record) = normalized_composition_record(&candidate) else {
        return Err("Office composition history requires a supported format and fingerprint".to_owned());
    };
    let mut records = vec![record.clone()];
    records.extend(history_records(lane, &paths).into_iter().filter(|entry| text(prop(entry, "documentKey")) != document_key));
    records.truncate(MAX_COMPOSITION_HISTORY);
    write_json_atomic(lane, &paths.composition_history, &json!({ "schemaVersion": SCHEMA_VERSION, "records": records }))?;
    Ok(record)
}

/// `findTemplate(templates, selector, format)`: a template of the format by id, or by absolute path.
fn find_template<'a>(env: &Environment, templates: &'a [Value], selector: Option<&Value>, format: &str) -> Option<&'a Value> {
    let selected = text(selector);
    let wanted = mixdog_js::js_trim(&selected);
    if wanted.is_empty() {
        return None;
    }
    let canonical = if Path::new(wanted).is_absolute() || Path::new(wanted).has_root() { canonical_path(env, wanted) } else { String::new() };
    let lowered = mixdog_js::js_to_lowercase(wanted);
    templates.iter().find(|template| {
        prop(template, "format") == Some(&Value::String(format.to_owned()))
            && (text(prop(template, "id")) == lowered || (!canonical.is_empty() && canonical_path(env, &text(prop(template, "path"))) == canonical))
    })
}

fn layout_candidates(pack: Option<&Value>, template: Option<&Value>, format: &str) -> Vec<Value> {
    let templates: Vec<&Value> = opt_prop(pack, "templates").and_then(Value::as_array).into_iter().flatten().collect();
    let mut layouts: Vec<Value> = Vec::new();
    for layout in opt_prop(pack, "layouts").and_then(Value::as_array).into_iter().flatten() {
        let owner = templates.iter().find(|entry| prop(entry, "id") == prop(layout, "templateId") && prop(layout, "templateId").is_some());
        let mut layout = layout.clone();
        if let (Some(owner), Some(map)) = (owner, layout.as_object_mut()) {
            match prop(owner, "path") {
                Some(path) => {
                    map.insert("templatePath".to_owned(), path.clone());
                }
                None => {
                    map.shift_remove("templatePath");
                }
            }
        }
        layouts.push(layout);
    }
    layouts.extend(opt_prop(template, "layouts").and_then(Value::as_array).into_iter().flatten().cloned());
    layouts.into_iter().filter(|layout| prop(layout, "format") == Some(&Value::String(format.to_owned()))).map(|layout| clone(&layout)).collect()
}

/// `value || ''`.
fn or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(given) if truthy(given) => given.clone(),
        _ => Value::String(String::new()),
    }
}

fn binding_for(env: &Environment, pack: Option<&Value>, template: Option<&Value>, format: &str, source: Option<&Value>) -> Value {
    let mut binding = Map::new();
    if let Some(source) = source {
        binding.insert("source".to_owned(), source.clone());
    }
    binding.insert("format".to_owned(), Value::String(format.to_owned()));
    binding.insert("packId".to_owned(), or_empty(opt_prop(pack, "id")));
    binding.insert("packVersion".to_owned(), or_empty(opt_prop(pack, "version")));
    binding.insert("keyId".to_owned(), or_empty(opt_prop(pack, "keyId")));
    binding.insert("templateId".to_owned(), or_empty(opt_prop(template, "id")));
    binding.insert("templateVersion".to_owned(), or_empty(opt_prop(template, "version")));
    binding.insert("templateSource".to_owned(), or_empty(opt_prop(template, "source")));
    binding.insert("pinnedAt".to_owned(), Value::String(iso_string(env.now())));
    Value::Object(binding)
}

/// The answer of a resolution; `to_value` writes it in Node's key order.
struct Resolution {
    source: Option<Value>,
    binding: Value,
    pack: Option<Value>,
    template: Option<Value>,
    layouts: Vec<Value>,
    recent: Vec<Value>,
    index_revision: Value,
    warning: String,
    pinned: bool,
}

impl Resolution {
    fn to_value(self) -> Value {
        let coverage = opt_prop(self.template.as_ref(), "coverage").filter(|coverage| truthy(coverage)).cloned().unwrap_or(Value::Null);
        let mut out = Map::new();
        if let Some(source) = self.source {
            out.insert("source".to_owned(), source);
        }
        out.insert("binding".to_owned(), self.binding);
        out.insert("pack".to_owned(), self.pack.unwrap_or(Value::Null));
        out.insert("template".to_owned(), self.template.unwrap_or(Value::Null));
        out.insert("layouts".to_owned(), Value::Array(self.layouts));
        out.insert("coverage".to_owned(), coverage);
        out.insert("recentCompositions".to_owned(), Value::Array(self.recent));
        out.insert("templateIndexRevision".to_owned(), self.index_revision);
        out.insert("warning".to_owned(), Value::String(self.warning));
        out.insert("pinned".to_owned(), Value::Bool(self.pinned));
        Value::Object(out)
    }
}

/// A bound document keeps its exact pack and template version; when either is gone it falls back to the starter
/// tokens with a warning.
fn resolve_pinned_library<P: WriteProof>(
    cx: &Context<'_, P>,
    paths: &LibraryPaths,
    config: &LibraryConfig,
    binding: Value,
    format: &str,
    recent: Vec<Value>,
) -> Value {
    let mut warning = String::new();
    let exact = if prop(&binding, "packId").is_some_and(truthy) && prop(&binding, "packVersion").is_some_and(truthy) {
        load_cached_pack(cx.lane, paths, config, prop(&binding, "packId"), prop(&binding, "packVersion"))
    } else {
        Ok(None)
    };
    let pack = match exact {
        Ok(pack) => pack,
        Err(message) => {
            warning = format!("Pinned Office design pack is unavailable: {message}");
            None
        }
    };
    let index = read_template_index(cx.lane, paths);
    let mut all: Vec<Value> = opt_prop(pack.as_ref(), "templates").and_then(Value::as_array).cloned().unwrap_or_default();
    all.extend(prop(&index, "templates").and_then(Value::as_array).cloned().unwrap_or_default());
    let template = all.into_iter().find(|entry| {
        prop(entry, "id") == prop(&binding, "templateId")
            && prop(entry, "version") == prop(&binding, "templateVersion")
            && prop(entry, "format") == Some(&Value::String(format.to_owned()))
    });
    if prop(&binding, "templateId").is_some_and(truthy) && template.is_none() && warning.is_empty() {
        warning = "Pinned Office template version changed or is unavailable; the existing document remains unchanged.".to_owned();
    }
    let source = if pack.is_some() { prop(&binding, "source").cloned() } else { Some(Value::String("starter-fallback".to_owned())) };
    let layouts = layout_candidates(pack.as_ref(), template.as_ref(), format);
    Resolution { source, binding: clone(&binding), pack, template, layouts, recent, index_revision: or_empty(prop(&index, "revision")), warning, pinned: true }
        .to_value()
}

/// How a design request is put to the library.
pub struct ResolveRequest<'a> {
    pub data_dir: &'a Path,
    pub document_path: &'a str,
    /// The file the document was made from, whose binding a copy inherits.
    pub source_path: &'a str,
    pub format: &'a str,
    /// A new document (remote check and template indexing allowed).
    pub created: bool,
    /// The tool request (`upgradeLibrary`, `refreshLibrary`, `template`, `packId`, `packVersion`); `Null` for none.
    pub request: &'a Value,
    pub config: Option<&'a Value>,
}

/// The binding of the document, else of the file it was made from.
fn inherited_binding<P: WriteProof>(cx: &Context<'_, P>, input: &ResolveRequest<'_>) -> Result<Option<Value>, String> {
    let own = read_office_design_binding(cx.lane, cx.env, input.data_dir, input.document_path)?;
    if own.is_none() && !input.source_path.is_empty() {
        return read_office_design_binding(cx.lane, cx.env, input.data_dir, input.source_path);
    }
    Ok(own)
}

/// The cached pack a request names with `packId` and `packVersion`; `None` when it names none.
fn requested_pack<P: WriteProof>(cx: &Context<'_, P>, paths: &LibraryPaths, config: &LibraryConfig, request: &Value) -> Result<Option<Value>, String> {
    let (request_pack_id, request_pack_version) = (prop(request, "packId"), prop(request, "packVersion"));
    if !request_pack_id.is_some_and(truthy) && !request_pack_version.is_some_and(truthy) {
        return Ok(None);
    }
    if !request_pack_id.is_some_and(truthy) || !request_pack_version.is_some_and(truthy) {
        return Err("Office design pack selection requires both packId and packVersion".to_owned());
    }
    let wanted = safe_id(request_pack_id, "requested packId")?;
    let version = Value::String(value_to_string(request_pack_version.unwrap_or(&Value::Null)));
    let pack = load_cached_pack(cx.lane, paths, config, Some(&Value::String(wanted)), Some(&version))?;
    if pack.is_none() {
        return Err(format!(
            "Requested Office design pack is not cached: {}@{}",
            request_pack_id.map(value_to_string).unwrap_or_default(),
            request_pack_version.map(value_to_string).unwrap_or_default()
        ));
    }
    Ok(pack)
}

/// `resolveOfficeDesignLibrary`: what a design request is composed from. A document that has a binding (and no
/// upgrade request) keeps the pack and template it was bound to; any other is synced, given the requested or default
/// template, and answered with the binding to persist.
pub fn resolve_office_design_library<P: WriteProof>(cx: &Context<'_, P>, input: &ResolveRequest<'_>) -> Result<Value, String> {
    let format = mixdog_js::js_to_lowercase(input.format);
    if !is_format(&format) {
        return Err(format!("Unsupported Office design library format: {}", input.format));
    }
    let paths = library_paths(cx.env, input.data_dir);
    let recent = read_office_composition_history(cx.lane, cx.env, input.data_dir, &format, 24.0, input.document_path);
    let config = load_config(cx.lane, cx.env, input.data_dir, input.config)?;
    let request = input.request;
    let flag = |name: &str| prop(request, name) == Some(&Value::Bool(true));
    let explicit_upgrade = flag("upgradeLibrary");
    let current_binding = if input.created || explicit_upgrade { None } else { inherited_binding(cx, input)? };
    if let Some(binding) = current_binding {
        return Ok(resolve_pinned_library(cx, &paths, &config, binding, &format, recent));
    }
    let requested_template = prop(request, "template").filter(|template| truthy(template));
    let synced = sync_with_config(
        cx,
        input.data_dir,
        &config,
        flag("refreshLibrary"),
        input.created || explicit_upgrade,
        input.created || explicit_upgrade || requested_template.is_some(),
    )?;
    let pack = requested_pack(cx, &paths, &config, request)?.or_else(|| synced.active_pack.clone());
    let mut all: Vec<Value> = opt_prop(pack.as_ref(), "templates").and_then(Value::as_array).cloned().unwrap_or_default();
    all.extend(prop(&synced.templates, "templates").and_then(Value::as_array).cloned().unwrap_or_default());
    let selector: Option<Value> = match requested_template {
        Some(template) => Some(template.clone()),
        None => config.default_templates.get(&format).filter(|selected| truthy(selected)).cloned(),
    };
    let template = find_template(cx.env, &all, selector.as_ref(), &format).cloned();
    if requested_template.is_some() && template.is_none() {
        return Err(format!(
            "Office design template is not indexed or does not match {format}: {}",
            requested_template.map(value_to_string).unwrap_or_default()
        ));
    }
    let source: Option<Value> = if let Some(template) = &template {
        prop(template, "source").cloned()
    } else if pack.is_some() {
        Some(Value::String("remote-pack".to_owned()))
    } else {
        Some(Value::String("mixdog-starter".to_owned()))
    };
    let binding = binding_for(cx.env, pack.as_ref(), template.as_ref(), &format, source.as_ref());
    let layouts = layout_candidates(pack.as_ref(), template.as_ref(), &format);
    Ok(Resolution {
        source,
        binding,
        pack,
        template,
        layouts,
        recent,
        index_revision: or_empty(prop(&synced.templates, "revision")),
        warning: synced.warning.clone(),
        pinned: false,
    }
    .to_value())
}

/// `inspectOfficeDesignLibrary`: whether a pack server is configured, the active pack, the last check and the template
/// index, with the last error (or the reason the active pack could not be loaded).
pub fn inspect_office_design_library<P: WriteProof>(lane: &P, env: &Environment, data_dir: &Path, config_override: Option<&Value>) -> Result<Value, String> {
    let paths = library_paths(env, data_dir);
    let config = load_config(lane, env, data_dir, config_override)?;
    let state = read_json(lane, &paths.state, Value::Object(Map::new()));
    let index = read_template_index(lane, &paths);
    let active = prop(&state, "active");
    let mut warning = text(prop(&state, "lastError"));
    let active_pack = match load_cached_pack(lane, &paths, &config, opt_prop(active, "id"), opt_prop(active, "version")) {
        Ok(pack) => pack,
        Err(message) => {
            warning = message;
            None
        }
    };
    let last_checked = to_number_of(prop(&state, "lastCheckedAt"));
    let templates = prop(&index, "templates").and_then(Value::as_array).map_or(0, Vec::len);
    Ok(json!({
        "enabled": !config.manifest_url.is_empty(),
        "active": pack_summary(active_pack.as_ref()),
        "lastCheckedAt": json_number(if last_checked.is_nan() { 0.0 } else { last_checked }),
        "templateIndex": {
            "revision": or_empty(prop(&index, "revision")),
            "count": templates,
            "indexedAt": or_empty(prop(&index, "indexedAt")),
        },
        "warning": warning,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_iso_string_is_the_one_date_gives() {
        assert_eq!(iso_string(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_700_000_000_123.0), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_string(951_782_400_000.0), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn warnings_join_with_a_space_and_skip_empties() {
        let mut warning = String::new();
        add_warning(&mut warning, "a");
        add_warning(&mut warning, "");
        add_warning(&mut warning, "b");
        assert_eq!(warning, "a b");
    }

    #[test]
    fn a_composition_record_keeps_its_fields_in_order_and_dedupes_ids() {
        let record = normalized_composition_record(&json!({
            "fingerprint": "f", "format": "PPTX", "compositionIds": [" a ", "a", "", "b"], "documentKey": "k", "createdAt": "t"
        }))
        .unwrap();
        assert_eq!(
            mixdog_js::json_stringify(&record),
            r#"{"fingerprint":"f","format":"pptx","profile":"","purpose":"","expressionMode":"","compositionIds":["a","b"],"documentKey":"k","createdAt":"t"}"#
        );
        assert!(normalized_composition_record(&json!({ "fingerprint": "", "format": "pptx" })).is_none());
        assert!(normalized_composition_record(&json!({ "fingerprint": "f", "format": "png" })).is_none());
    }

    #[test]
    fn a_missing_binding_path_names_the_type_error() {
        assert_eq!(path_type_error(None), "The \"path\" argument must be of type string. Received undefined");
    }
}
