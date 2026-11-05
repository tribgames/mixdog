//! WORKFLOW.md packs: discovery of one pack (user copy first, then the shipped one, then the
//! shipped default), the editor reads and writes, and the "equal to the shipped pack keeps no
//! copy" rule (`runtime-core/workflow/packs.mjs`, `workflow-agents-api/workflow-packs.mjs`,
//! `shared/markdown-frontmatter.mjs`, `shared/shipped-definitions.mjs`).
//!
//! Everything here is synchronous file work; the service runs it as lane jobs.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on io lanes")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::CoreError;
use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

use super::ids::DEFAULT_WORKFLOW_ID;
use super::ids::available_workflow_id;
use super::ids::clean;
use super::ids::one_line;
use super::ids::truthy;
use super::ids::wanted_workflow_id;
use super::ids::workflow_id;
use super::ids::workflow_id_from_name;
use super::ids::workflow_id_of;
use crate::domains::support::failed;
use crate::domains::support::io_failure;
use crate::domains::support::path_lock;
use crate::domains::support::write_atomic;

const DOMAIN: &str = "config";
const ENTRY: &str = "WORKFLOW.md";

/// Where the packs live: the install root (shipped `workflows/`) and the data dir (user
/// `workflows/`).
#[derive(Clone, Debug)]
pub struct WorkflowPaths {
    pub root: PathBuf,
    pub data: PathBuf,
}

impl WorkflowPaths {
    fn user_dir(&self, id: &str) -> PathBuf {
        self.data.join("workflows").join(id)
    }
}

/// A pack as the loader reads it.
pub(crate) struct Pack {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub source: &'static str,
}

fn none_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0' || is_js_space(c))
}

/// `readTextSafe`: the trimmed text, empty when unreadable or holding no data.
fn read_text_safe(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            if none_data(&text) { String::new() } else { js_trim(&text).to_owned() }
        }
        Err(_) => String::new(),
    }
}

/// `readFileSync(path, 'utf8')` as the editor's pack reader sees it: the raw text or nothing.
fn read_raw(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn frontmatter_pattern() -> &'static JsRegex {
    static RE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    RE.get_or_init(|| JsRegex::new_static(r"^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)", ""))
}

fn key_value_pattern() -> &'static JsRegex {
    static RE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    RE.get_or_init(|| JsRegex::new_static(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", ""))
}

/// `unquote`: one leading and one trailing quote go, then trim.
fn unquote(value: &str) -> String {
    let text = js_trim(value);
    let text = text.strip_prefix(['\'', '"']).unwrap_or(text);
    let text = text.strip_suffix(['\'', '"']).unwrap_or(text);
    js_trim(text).to_owned()
}

/// `readMarkdownDocument`: the `key: value` front matter and the trimmed body.
pub(crate) fn read_document(markdown: &str) -> (Map<String, Value>, String) {
    let mut meta = Map::new();
    let Some(found) = frontmatter_pattern().captures(markdown) else {
        return (meta, js_trim(markdown).to_owned());
    };
    let lines: Vec<&str> = found.get(1).unwrap_or_default().split('\n').collect();
    for (index, line) in lines.iter().enumerate() {
        let line = if index + 1 < lines.len() { line.strip_suffix('\r').unwrap_or(line) } else { line };
        if let Some(pair) = key_value_pattern().captures(line) {
            meta.insert(pair.get(1).unwrap_or_default().to_owned(), Value::String(unquote(pair.get(2).unwrap_or_default())));
        }
    }
    let range = found.range();
    let body = format!("{}{}", &markdown[..range.start], &markdown[range.end..]);
    (meta, js_trim(&body).to_owned())
}

/// `serializeFrontmatterDoc`.
fn serialize_document(meta: &[(&str, &str)], body: &str) -> String {
    let mut lines = vec!["---".to_owned()];
    lines.extend(meta.iter().map(|(key, value)| format!("{key}: {value}")));
    lines.push("---".into());
    lines.push(String::new());
    format!("{}\n{}\n", lines.join("\n"), js_trim(body))
}

fn parse_pack(text: &str, source: &'static str, dir_name: &str) -> Option<Pack> {
    let (meta, body) = read_document(text);
    if body.is_empty() {
        return None;
    }
    let declared = clean(meta.get("id"));
    let id = workflow_id(if declared.is_empty() { dir_name } else { &declared })?;
    let name = clean(meta.get("name"));
    Some(Pack {
        name: if name.is_empty() { id.clone() } else { name },
        description: clean(meta.get("description")),
        id,
        body,
        source,
    })
}

/// `loadWorkflowPack(dir, id)`: the user copy, then the shipped one, then the shipped default.
pub(crate) fn load_pack(paths: &WorkflowPaths, id: &str) -> Option<Pack> {
    let wanted = wanted_workflow_id(id);
    let user = paths.data.join("workflows").join(&wanted).join(ENTRY);
    let shipped = paths.root.join("workflows").join(&wanted).join(ENTRY);
    parse_pack(&read_text_safe(&user), "user", &wanted)
        .or_else(|| parse_pack(&read_text_safe(&shipped), "built-in", &wanted))
        .or_else(|| {
            let default = paths.root.join("workflows").join(DEFAULT_WORKFLOW_ID).join(ENTRY);
            parse_pack(&read_text_safe(&default), "built-in", DEFAULT_WORKFLOW_ID)
        })
}

pub(crate) fn pack_exists(paths: &WorkflowPaths, id: &str) -> bool {
    load_pack(paths, id).is_some_and(|pack| pack.id == id)
}

/// `getWorkflowPack(workflowId)`.
pub(crate) fn get_pack(paths: &WorkflowPaths, requested: &str) -> Result<Value, CoreError> {
    let Some(id) = workflow_id(requested) else {
        return Err(failed(DOMAIN, format!("unknown workflow \"{requested}\"")));
    };
    let pack = load_pack(paths, &id)
        .filter(|pack| pack.id == id)
        .ok_or_else(|| failed(DOMAIN, format!("workflow \"{requested}\" not found")))?;
    let file = paths.user_dir(&id).join(ENTRY);
    let user_override = file.exists();
    let mut view = json!({
        "id": pack.id,
        "name": pack.name,
        "description": pack.description,
        "source": pack.source,
        "body": pack.body,
        "userOverride": user_override,
    });
    if user_override {
        view["path"] = Value::String(file.to_string_lossy().into_owned());
    }
    Ok(view)
}

/// `payload.<key>` of a request payload: a `null` payload throws as JavaScript does.
fn property<'a>(payload: &'a Value, key: &str) -> Result<Option<&'a Value>, CoreError> {
    match payload {
        Value::Null => Err(failed(DOMAIN, format!("Cannot read properties of null (reading '{key}')"))),
        Value::Object(map) => Ok(map.get(key)),
        _ => Ok(None),
    }
}

/// `saveWorkflowPack(payload)`.
pub(crate) fn save_pack(paths: &WorkflowPaths, payload: &Value, now: &dyn Fn() -> String) -> Result<Value, CoreError> {
    let Some(id) = workflow_id_of(property(payload, "id")?) else {
        return Err(failed(DOMAIN, "workflow id must contain letters/numbers (dashes and dots allowed)"));
    };
    let body = match property(payload, "body")? {
        Some(value) if truthy(Some(value)) => js_trim(&value_to_string(value)).to_owned(),
        _ => String::new(),
    };
    if body.is_empty() {
        return Err(failed(DOMAIN, "WORKFLOW.md body must not be empty"));
    }
    let name = one_line(property(payload, "name")?);
    let name = if name.is_empty() { id.clone() } else { name };
    let description = one_line(property(payload, "description")?);
    let dir = paths.user_dir(&id);
    let lock = path_lock(&dir);
    let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let definition = Definition { name: name.clone(), description: description.clone(), body: body.clone(), fields: Vec::new() };
    if !absorb_equal_to_shipped(paths, &id, &definition, now)? {
        let mut meta = vec![("id", id.as_str()), ("name", name.as_str())];
        if !description.is_empty() {
            meta.push(("description", description.as_str()));
        }
        let text = serialize_document(&meta, &body);
        write_atomic(&dir.join(ENTRY), text.as_bytes(), true).map_err(|failure| io_failure(DOMAIN, &failure))?;
    }
    get_pack(paths, &id)
}

/// `createWorkflow(payload)`.
pub(crate) fn create_pack(paths: &WorkflowPaths, payload: &Value, now: &dyn Fn() -> String) -> Result<Value, CoreError> {
    let name = one_line(property(payload, "name")?);
    if name.is_empty() {
        return Err(failed(DOMAIN, "workflow name must not be empty"));
    }
    let lock = path_lock(&paths.data.join("workflows"));
    let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut next = payload.as_object().cloned().unwrap_or_default();
    let id = match workflow_id_of(property(payload, "id")?) {
        Some(requested) => {
            if pack_exists(paths, &requested) {
                return Err(failed(DOMAIN, format!("workflow \"{requested}\" already exists")));
            }
            requested
        }
        None => available_workflow_id(&workflow_id_from_name(&name), |candidate| pack_exists(paths, candidate)),
    };
    next.insert("id".into(), Value::String(id));
    next.insert("name".into(), Value::String(name));
    save_pack(paths, &Value::Object(next), now)
}

/// The id `createWorkflow` gave the pack: the requested one, else the first slug candidate that
/// holds a user pack of this name.
pub(crate) fn created_id(paths: &WorkflowPaths, payload: &Value) -> Option<String> {
    let name = one_line(payload.get("name"));
    if let Some(requested) = workflow_id_of(payload.get("id")) {
        return Some(requested);
    }
    let base = workflow_id_from_name(&name);
    let mut candidates = vec![base.clone()];
    candidates.extend((2..).take(64).map(|n| format!("{base}-{n}")));
    candidates.into_iter().find(|id| {
        load_pack(paths, id).is_some_and(|pack| pack.id == *id && pack.source == "user" && pack.name == name)
    })
}

/// The file half of `deleteWorkflow`: removes the user copy; answers whether a shipped pack of
/// the id shows through.
pub(crate) fn delete_pack(paths: &WorkflowPaths, requested: &str) -> Result<(String, bool), CoreError> {
    let Some(id) = workflow_id(requested) else {
        return Err(failed(DOMAIN, format!("unknown workflow \"{requested}\"")));
    };
    let dir = paths.user_dir(&id);
    let lock = path_lock(&dir);
    let _held = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !pack_exists(paths, &id) {
        return Err(failed(DOMAIN, format!("workflow \"{id}\" not found")));
    }
    if !dir.join(ENTRY).exists() {
        return Err(failed(DOMAIN, format!("workflow \"{id}\" is built-in and cannot be deleted")));
    }
    match std::fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failed(DOMAIN, error.to_string())),
        _ => {}
    }
    let reverted = pack_exists(paths, &id);
    Ok((id, reverted))
}

// --- shipped definitions ---

/// The editable surface of a pack plus the loader-visible fields the editor cannot express.
struct Definition {
    name: String,
    description: String,
    body: String,
    fields: Vec<(String, String)>,
}

/// `normalizeText`: CRLF to LF, trailing blanks of every line and of the text dropped.
fn normalize_text(value: &str) -> String {
    static RE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    let trailing = RE.get_or_init(|| JsRegex::new_static(r"[^\S\n]+$", "gm"));
    let unix = value.replace("\r\n", "\n");
    js_trim_end(&trailing.replace_all_with(&unix, |_| String::new())).to_owned()
}

/// `sha256(text)` as hex.
fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `fieldsKey`: the fields sorted by key, as JSON.
fn fields_key(fields: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = fields.iter().collect();
    sorted.sort_by_key(|(key, _)| key.encode_utf16().collect::<Vec<u16>>());
    mixdog_js::json_stringify(&Value::Array(sorted.iter().map(|(key, value)| json!([key, value])).collect()))
}

/// `hashDefinition(definition, { surfaceOnly: true })`.
fn surface_hash(definition: &Definition) -> String {
    let surface = json!([one_line(Some(&Value::String(definition.name.clone()))), one_line(Some(&Value::String(definition.description.clone()))), normalize_text(&definition.body), ""]);
    digest(&mixdog_js::json_stringify(&surface))[..32].to_owned()
}

fn same_id(value: &Value, id: &str) -> bool {
    js_trim(&value_to_string(value)).to_lowercase() == id.to_lowercase()
}

/// `packDefinitionFromDir(dir, entry, id)`.
fn definition_from_dir(dir: &Path, entry: &str, id: &str) -> Option<Definition> {
    let manifest = read_raw(&dir.join("agent.json"))
        .filter(|text| !text.is_empty())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let named = one_line(manifest.get("entry"));
    let entry_name = if named.is_empty() { entry.to_owned() } else { named };
    let (meta, body) = read_document(&read_raw(&dir.join(&entry_name)).unwrap_or_default());
    let body = normalize_text(&body);
    if body.is_empty() {
        return None;
    }
    let mut fields = Vec::new();
    for (key, value) in &meta {
        if key == "name" || key == "description" || (key == "id" && same_id(value, id)) {
            continue;
        }
        fields.push((format!("frontmatter.{key}"), js_trim(&value_to_string(value)).to_owned()));
    }
    for (key, value) in &manifest {
        if key == "name" || key == "description" || (key == "id" && same_id(value, id)) {
            continue;
        }
        if key == "entry" {
            let text = one_line(Some(value));
            if text == entry || text.is_empty() {
                continue;
            }
        }
        fields.push((format!("manifest.{key}"), mixdog_js::json_stringify(value)));
    }
    let pick = |key: &str| {
        let chosen = manifest.get(key).filter(|value| truthy(Some(*value))).or_else(|| meta.get(key));
        one_line(chosen)
    };
    Some(Definition { name: pick("name"), description: pick("description"), body, fields })
}

fn is_stray(name: &str) -> bool {
    let lowered = name.to_lowercase();
    [".bak", ".orig", ".tmp", "~"].iter().any(|suffix| lowered.ends_with(suffix))
}

/// `absorbSaveEqualToShipped`: a save equal to the shipped pack keeps no user copy, so the pack
/// keeps following the shipped version; an existing copy moves into a backup. `false` means
/// the caller writes the copy.
fn absorb_equal_to_shipped(
    paths: &WorkflowPaths,
    id: &str,
    definition: &Definition,
    now: &dyn Fn() -> String,
) -> Result<bool, CoreError> {
    let Some(shipped) = definition_from_dir(&paths.root.join("workflows").join(id), ENTRY, id) else {
        return Ok(false);
    };
    if surface_hash(definition) != surface_hash(&shipped) {
        return Ok(false);
    }
    let copy = paths.user_dir(id);
    if !copy.exists() {
        return Ok(true);
    }
    if !copy.is_dir() {
        return Err(failed(DOMAIN, format!("ENOTDIR: not a directory, scandir '{}'", copy.display())));
    }
    let entries = std::fs::read_dir(&copy).map_err(|error| failed(DOMAIN, error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if !(is_file && (name == ENTRY || name == ".deleted" || is_stray(&name))) {
            return Ok(false);
        }
    }
    if let Some(existing) = definition_from_dir(&copy, ENTRY, id)
        && fields_key(&existing.fields) != fields_key(&shipped.fields)
    {
        return Ok(false);
    }
    Ok(move_to_backup(&paths.data, &copy, now))
}

/// `makeBackup(dataDir).move(target)`: the target moves into a fresh
/// `backups/defaults-separation-<time>` folder keeping its data-dir relative path; `false`
/// when it could not be moved.
fn move_to_backup(data: &Path, target: &Path, now: &dyn Fn() -> String) -> bool {
    if !target.exists() {
        return true;
    }
    let attempt = || -> std::io::Result<()> {
        let stamp = now().replace([':', '.'], "-");
        let backups = data.join("backups");
        std::fs::create_dir_all(&backups)?;
        let base = format!("defaults-separation-{stamp}");
        let mut n = 1;
        let root = loop {
            let candidate = if n == 1 { backups.join(&base) } else { backups.join(format!("{base}-{n}")) };
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                Err(error) => return Err(error),
            }
        };
        let relative = target.strip_prefix(data).unwrap_or(target);
        let wanted = root.join(relative);
        let mut dest = wanted.clone();
        let mut suffix = 2;
        while dest.exists() {
            let mut name = wanted.as_os_str().to_owned();
            name.push(format!(".{suffix}"));
            dest = PathBuf::from(name);
            suffix += 1;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if std::fs::rename(target, &dest).is_err() {
            std::fs::create_dir_all(&dest)?;
            for entry in std::fs::read_dir(target)? {
                let entry = entry?;
                std::fs::copy(entry.path(), dest.join(entry.file_name()))?;
            }
            std::fs::remove_dir_all(target)?;
        }
        Ok(())
    };
    attempt().is_ok()
}
