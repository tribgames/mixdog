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
use mixdog_core_base::support::failed;
use mixdog_core_base::support::io_failure;
use mixdog_core_base::support::path_lock;
use mixdog_core_base::support::write_atomic;

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
pub struct Pack {
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
pub fn read_text_safe(path: &Path) -> String {
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
pub fn read_document(markdown: &str) -> (Map<String, Value>, String) {
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

/// `workflowSummary(pack, { hasAgents })` of `runtime-core/workflow/context.mjs`: the row a session
/// records. No pack (not even the shipped default could be read) is the default workflow's row.
pub fn workflow_summary(pack: Option<&Pack>, has_agents: bool) -> Map<String, Value> {
    let id = pack.map_or(DEFAULT_WORKFLOW_ID, |pack| pack.id.as_str());
    let name = js_trim(pack.map_or("", |pack| pack.name.as_str()));
    let mut summary = Map::new();
    summary.insert("id".into(), json!(id));
    summary.insert("name".into(), json!(if !name.is_empty() { name } else if id == DEFAULT_WORKFLOW_ID { "Default" } else { id }));
    summary.insert("description".into(), json!(js_trim(pack.map_or("", |pack| pack.description.as_str()))));
    summary.insert("source".into(), json!(js_trim(pack.map_or("", |pack| pack.source))));
    // Effective session capability, not an editable workflow property.
    summary.insert("delegatesAgents".into(), json!(has_agents));
    summary
}

/// `loadWorkflowPack(dir, id)`: the user copy, then the shipped one, then the shipped default.
pub fn load_pack(paths: &WorkflowPaths, id: &str) -> Option<Pack> {
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

/// A pack of the catalog listing.
pub(crate) struct Listed {
    pub pack: Pack,
    /// A user copy of a shipped pack.
    pub overrides_built_in: bool,
}

/// `listWorkflowPacks(dir)`: shipped packs, then user packs (a user copy shadows the shipped one),
/// hidden ones left out, the default pack first and the rest by name.
pub(crate) fn list_packs(paths: &WorkflowPaths) -> Vec<Listed> {
    let mut found: Vec<Listed> = Vec::new();
    for (root, source) in [(paths.root.join("workflows"), "built-in"), (paths.data.join("workflows"), "user")] {
        let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(&root)
            .map(|entries| entries.filter_map(Result::ok).filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())).map(|entry| entry.file_name()).collect())
            .unwrap_or_default();
        names.sort();
        for name in names {
            let entry = root.join(&name).join(ENTRY);
            if !entry.exists() {
                continue;
            }
            let text = read_text_safe(&entry);
            let (meta, _) = read_document(&text);
            let hidden = js_trim(&meta.get("hidden").map(value_to_string).unwrap_or_default()).to_lowercase() == "true";
            let Some(pack) = parse_pack(&text, source, &name.to_string_lossy()) else { continue };
            if hidden {
                continue;
            }
            match found.iter().position(|seen| seen.pack.id == pack.id) {
                Some(at) => {
                    let overrides_built_in = source == "user" && found[at].pack.source == "built-in";
                    found[at] = Listed { pack, overrides_built_in };
                }
                None => found.push(Listed { pack, overrides_built_in: false }),
            }
        }
    }
    let weight = |listed: &Listed| u8::from(listed.pack.id != DEFAULT_WORKFLOW_ID);
    found.sort_by(|a, b| weight(a).cmp(&weight(b)).then_with(|| mixdog_js::locale_compare(&a.pack.name, &b.pack.name)));
    found
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
pub(crate) fn save_pack(
    lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
    paths: &WorkflowPaths,
    payload: &Value,
    now: &dyn Fn() -> String,
) -> Result<Value, CoreError> {
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
        write_atomic(lane, &dir.join(ENTRY), text.as_bytes(), true).map_err(|failure| io_failure(DOMAIN, &failure))?;
    }
    get_pack(paths, &id)
}

/// `createWorkflow(payload)`.
pub(crate) fn create_pack(
    lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
    paths: &WorkflowPaths,
    payload: &Value,
    now: &dyn Fn() -> String,
) -> Result<Value, CoreError> {
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
    save_pack(lane, paths, &Value::Object(next), now)
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
pub struct Definition {
    pub name: String,
    pub description: String,
    pub body: String,
    pub fields: Vec<(String, String)>,
}

/// Where a kind of definition lives: the folder under the install and data roots, its entry
/// file, and the files its editor writes (`absorbSaveEqualToShipped`'s `dir`, `entry`, `files`).
pub struct ShippedKind<'a> {
    pub dir: &'a str,
    pub entry: &'a str,
    pub files: &'a [&'a str],
}

/// `normalizeText`: CRLF to LF, trailing blanks of every line and of the text dropped.
pub(crate) fn normalize_text(value: &str) -> String {
    static RE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    let trailing = RE.get_or_init(|| JsRegex::new_static(r"[^\S\n]+$", "gm"));
    let unix = value.replace("\r\n", "\n");
    js_trim_end(&trailing.replace_all_with(&unix, |_| String::new())).to_owned()
}

/// `sha256(text)` as hex.
fn digest(text: &str) -> String {
    digest_bytes(text.as_bytes())
}

/// `sha256(bytes)` as hex.
pub(crate) fn digest_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
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

/// `hashDefinition(definition)`: every loader-visible field counts.
fn definition_hash(definition: &Definition) -> String {
    let full = json!([one_line(Some(&Value::String(definition.name.clone()))), one_line(Some(&Value::String(definition.description.clone()))), normalize_text(&definition.body), fields_key(&definition.fields)]);
    digest(&mixdog_js::json_stringify(&full))[..32].to_owned()
}

/// `packHashFromDir(dir, entry, id)`: `None` for a pack with no body.
pub(crate) fn pack_hash_from_dir(dir: &Path, entry: &str, id: &str) -> Option<String> {
    definition_from_dir(dir, entry, id).map(|definition| definition_hash(&definition))
}

fn same_id(value: &Value, id: &str) -> bool {
    js_trim(&value_to_string(value)).to_lowercase() == id.to_lowercase()
}

/// `packDefinitionFromDir(dir, entry, id)`.
pub(crate) fn definition_from_dir(dir: &Path, entry: &str, id: &str) -> Option<Definition> {
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

/// `isIgnorableStray`: `/(\.(bak|orig|tmp)|~)$/i`. The flag folds ASCII letters only (no `u` flag), so the Kelvin sign is not a `k`.
pub(crate) fn is_stray(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
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
    let kind = ShippedKind { dir: "workflows", entry: ENTRY, files: &[ENTRY] };
    absorb_kind_equal_to_shipped(&paths.root, &paths.data, &kind, id, definition, now)
}

/// [`absorb_equal_to_shipped`] for any kind of definition.
pub fn absorb_kind_equal_to_shipped(
    root: &Path,
    data: &Path,
    kind: &ShippedKind<'_>,
    id: &str,
    definition: &Definition,
    now: &dyn Fn() -> String,
) -> Result<bool, CoreError> {
    let Some(shipped) = definition_from_dir(&root.join(kind.dir).join(id), kind.entry, id) else {
        return Ok(false);
    };
    if surface_hash(definition) != surface_hash(&shipped) {
        return Ok(false);
    }
    let copy = data.join(kind.dir).join(id);
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
        if !(is_file && (kind.files.contains(&name.as_str()) || name == ".deleted" || is_stray(&name))) {
            return Ok(false);
        }
    }
    if let Some(existing) = definition_from_dir(&copy, kind.entry, id)
        && fields_key(&existing.fields) != fields_key(&shipped.fields)
    {
        return Ok(false);
    }
    Ok(Backup::new(data, now).move_target(&copy))
}

/// `cpSync(from, to, { recursive: true, force: false, errorOnExist: true })`: `dereference` and `verbatimSymlinks` stay off, so a
/// symbolic link is created again at `to` pointing at its target resolved to an absolute path. A Windows junction is not a symlink
/// to Node's copy: it is followed and copied as the folder it shows (recorded: `skill-with-junction`, `cross-volume-skill-with-junction`).
/// The first error stops the copy and whatever was copied stays; a source that cannot be opened leaves no file behind.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    if std::fs::symlink_metadata(from)?.is_symlink() {
        let target = std::fs::read_link(from)?;
        let resolved = if target.is_absolute() { target } else { from.parent().unwrap_or(Path::new("")).join(target) };
        return std::os::unix::fs::symlink(resolved, to);
    }
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    let mut source = std::fs::File::open(from)?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    std::io::copy(&mut source, &mut file).map(drop)
}

/// `makeBackup(dataDir)`: the lazily claimed `backups/defaults-separation-<time>` folder that moved
/// entries go into, keeping their data-dir relative path. Nothing is deleted.
pub(crate) struct Backup<'a> {
    data: &'a Path,
    now: &'a dyn Fn() -> String,
    root: Option<PathBuf>,
    /// Moves that failed.
    pub failures: u32,
}

impl<'a> Backup<'a> {
    pub fn new(data: &'a Path, now: &'a dyn Fn() -> String) -> Self {
        Self { data, now, root: None, failures: 0 }
    }

    /// `claimRoot`: an existing backup folder is never reused.
    fn claim_root(&self) -> std::io::Result<PathBuf> {
        let stamp = (self.now)().replace([':', '.'], "-");
        let backups = self.data.join("backups");
        let base = format!("defaults-separation-{stamp}");
        std::fs::create_dir_all(&backups)?;
        let mut n = 1;
        loop {
            let candidate = if n == 1 { backups.join(&base) } else { backups.join(format!("{base}-{n}")) };
            match std::fs::create_dir(&candidate) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                Err(error) => return Err(error),
            }
        }
    }

    /// `move(target)`: the target moves into the backup; `false` when it could not be moved (counted in `failures`).
    pub fn move_target(&mut self, target: &Path) -> bool {
        if !target.exists() {
            return true;
        }
        let attempt = |this: &mut Self| -> std::io::Result<()> {
            let root = match this.root.clone() {
                Some(root) => root,
                None => {
                    let claimed = this.claim_root()?;
                    this.root = Some(claimed.clone());
                    claimed
                }
            };
            let relative = target.strip_prefix(this.data).unwrap_or(target);
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
                copy_tree(target, &dest)?;
                if target.is_dir() { std::fs::remove_dir_all(target)? } else { std::fs::remove_file(target)? }
            }
            Ok(())
        };
        let moved = attempt(self).is_ok();
        if !moved {
            self.failures += 1;
        }
        moved
    }
}
