//! Plugin registry edits (Node `services/plugin-admin.mjs`): `<data>/plugins/registry.json`, the
//! managed Git installs under `<data>/plugins/installed/`, and the rows the status panels show.
//! Every function is blocking file work, so each takes the proof of a maintenance-lane job.
//! Process spawning is not this crate's: `git clone` goes through [`GitRunner`].
#![allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha1::Digest;
use sha1::Sha1;

use crate::plugins::manifest;
use crate::scopes::resolve_path;
use crate::state_file::read_json_state;

const REGISTRY_VERSION: u64 = 1;
const MUTATION_LOCK_TIMEOUT: Duration = Duration::from_millis(130_000);
const REGISTRY_LOCK_TIMEOUT: Duration = Duration::from_millis(2_000);

/// A refusal or failure, worded as Node words it.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{0}")]
pub struct PluginAdminError(pub String);

type Result<T> = std::result::Result<T, PluginAdminError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(PluginAdminError(message.into()))
}

fn io(error: std::io::Error) -> PluginAdminError {
    PluginAdminError(error.to_string())
}

/// Runs `git` (the host owns process spawning): its trimmed stdout, or the failure text Node
/// builds from stderr, stdout, or `git <args> failed`.
pub trait GitRunner: Send + Sync {
    fn run(&self, args: &[String], timeout: Duration) -> std::result::Result<String, String>;
}

pub struct PluginAdmin {
    data_dir: PathBuf,
    git: Arc<dyn GitRunner>,
    /// Tells the other processes the registry changed (`announceStoredStateChange('plugins')`).
    announce: Arc<dyn Fn() + Send + Sync>,
}

/// `clean(value)`: `String(value ?? '').trim()`.
pub(crate) fn clean(value: &Value) -> String {
    if value.is_null() { String::new() } else { js_trim(&value_to_string(value)).to_owned() }
}

fn clean_field(entry: &Value, key: &str) -> String {
    entry.get(key).map(clean).unwrap_or_default()
}

fn clean_string_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).map(|s| js_trim(s).to_owned()).unwrap_or_default()
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, millis) = (since.as_secs() as i64, since.subsec_millis());
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

fn display_name_from_url(url: &str) -> String {
    let value = clean(&json!(url)).replace('\\', "/");
    let value = value.trim_end_matches('/');
    let last = value.split('/').rfind(|part| !part.is_empty()).unwrap_or("plugin");
    let stripped = JsRegex::new_static("\\.git$", "i").find(last).map_or(last, |r| &last[..r.start]);
    if stripped.is_empty() { "plugin".to_owned() } else { stripped.to_owned() }
}

fn normalize_plugin_id(value: &str) -> String {
    let lower = js_trim(value).to_lowercase();
    let replaced = JsRegex::new_static("[^a-z0-9_.-]+", "").replace_all_with(&lower, |_| "-".to_owned());
    let trimmed = replaced.trim_matches('-');
    trimmed.chars().take(80).collect()
}

fn stable_id_for_source(source: &str) -> String {
    let name = normalize_plugin_id(&display_name_from_url(source));
    let digest = Sha1::digest(js_trim(source).as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}", if name.is_empty() { "plugin" } else { &name }, &hash[..8])
}

/// Where a plugin comes from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Source {
    pub local: bool,
    /// Git URL (git sources).
    pub url: Option<String>,
    /// Absolute path (local sources).
    pub path: Option<PathBuf>,
    pub display_source: String,
}

fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

pub fn normalize_source(_lane: &InLane<MaintenanceIo>, input: &Value) -> Result<Source> {
    let source = clean(input);
    if source.is_empty() {
        return fail("plugin URL/path is required");
    }
    if JsRegex::new_static("^[\\w.-]+\\/[\\w.-]+$", "").is_match(&source) {
        return Ok(Source { local: false, url: Some(format!("https://github.com/{source}.git")), path: None, display_source: source });
    }
    let git_url = JsRegex::new_static("^(https?:\\/\\/|git@|ssh:\\/\\/).+\\.git(?:#.+)?$", "i");
    let github = JsRegex::new_static("^https:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/?$", "i");
    if git_url.is_match(&source) || github.is_match(&source) {
        if JsRegex::new_static("^http:\\/\\/", "i").is_match(&source) {
            return fail("plugin Git URLs must use HTTPS or SSH");
        }
        if JsRegex::new_static("^(https|ssh):\\/\\/", "i").is_match(&source) {
            let Ok(parsed) = url::Url::parse(&source) else { return fail("plugin Git URL is invalid") };
            if parsed.password().is_some() || (parsed.scheme() == "https" && !parsed.username().is_empty()) {
                return fail("plugin Git URLs must not contain credentials");
            }
        }
        let no_slash = source.strip_suffix('/').unwrap_or(&source);
        let url = JsRegex::new_static("^(https:\\/\\/github\\.com\\/[^/]+\\/[^/.]+)$", "i")
            .replace_all_with(no_slash, |caps| format!("{}.git", caps.get(1).unwrap_or_default()));
        return Ok(Source { local: false, url: Some(url), path: None, display_source: source });
    }
    let expanded = match source.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{}{rest}", home_dir().display()),
        _ => source.clone(),
    };
    let resolved = resolve_path(&expanded).map(PathBuf::from).unwrap_or_default();
    if resolved.exists() {
        let shown = resolved.to_string_lossy().into_owned();
        return Ok(Source { local: true, url: None, path: Some(resolved), display_source: shown });
    }
    fail("plugin source must be a Git URL, owner/repo, or existing local path")
}

/// `pluginMetadata(manifest)`: display-only fields; malformed values stay empty.
fn plugin_metadata(manifest: &Value) -> Vec<(&'static str, Value)> {
    let object = |v: Option<&Value>| v.filter(|v| v.is_object()).cloned().unwrap_or(Value::Null);
    let author = match manifest.get("author") {
        Some(Value::String(s)) => js_trim(s).to_owned(),
        other => {
            let author = object(other);
            let email = clean_string_field(&author, "email");
            [clean_string_field(&author, "name"), if email.is_empty() { String::new() } else { format!("<{email}>") }, clean_string_field(&author, "url")]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        }
    };
    let first = |a: String, b: String| if a.is_empty() { b } else { a };
    let keywords: Vec<Value> = match manifest.get("keywords") {
        Some(Value::Array(list)) => list.iter().map(|v| v.as_str().map(|s| js_trim(s).to_owned()).unwrap_or_default()).collect(),
        Some(single) => vec![single.as_str().map(|s| js_trim(s).to_owned()).unwrap_or_default()],
        None => vec![String::new()],
    }
    .into_iter()
    .filter(|k| !k.is_empty())
    .map(Value::from)
    .collect();
    let repository = object(manifest.get("repository"));
    let license = object(manifest.get("license"));
    vec![
        ("author", author.into()),
        ("homepage", clean_string_field(manifest, "homepage").into()),
        ("repository", first(clean_string_field(manifest, "repository"), clean_string_field(&repository, "url")).into()),
        ("license", first(clean_string_field(manifest, "license"), clean_string_field(&license, "type")).into()),
        ("keywords", Value::Array(keywords)),
    ]
}

impl PluginAdmin {
    pub fn new(data_dir: PathBuf, git: Arc<dyn GitRunner>, announce: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { data_dir, git, announce }
    }

    fn base_dir(&self) -> PathBuf {
        self.data_dir.join("plugins")
    }

    pub fn registry_path(&self) -> PathBuf {
        self.base_dir().join("registry.json")
    }

    pub fn install_root(&self) -> PathBuf {
        self.base_dir().join("installed")
    }

    /// The registry; a damaged one is handled as [`crate::state_file`] describes and a missing or
    /// unrecoverable one starts empty. I/O errors are errors.
    fn load_registry(&self, lane: &InLane<MaintenanceIo>) -> Result<Vec<Value>> {
        let has_list = |v: &Value| if v.get("plugins").is_some_and(Value::is_array) { Ok(()) } else { Err("plugin registry has no plugin list".to_owned()) };
        let value = read_json_state(lane, &self.registry_path(), &has_list).map_err(io)?;
        Ok(value.and_then(|v| v.get("plugins").and_then(Value::as_array).cloned()).unwrap_or_default())
    }

    /// Runs `mutate` on the registry under its lock and writes the result (with a `.bak` of the
    /// replaced version when that still parses).
    fn mutate_registry<T>(&self, lane: &InLane<MaintenanceIo>, mutate: impl FnOnce(&mut Vec<Value>) -> Result<T>) -> Result<T> {
        let path = self.registry_path();
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(io)?;
        let result = with_lock(&lock_path(&path), REGISTRY_LOCK_TIMEOUT, || {
            let mut plugins = self.load_registry(lane)?;
            let result = mutate(&mut plugins)?;
            let text = serde_json::to_string_pretty(&json!({"version": REGISTRY_VERSION, "plugins": plugins})).map_err(|e| PluginAdminError(e.to_string()))?;
            write_json_atomic(&path, format!("{text}\n").as_bytes()).map_err(io)?;
            Ok(result)
        })?;
        (self.announce)();
        Ok(result)
    }

    fn with_plugin_mutation<T>(&self, id: &str, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let root = self.install_root();
        std::fs::create_dir_all(&root).map_err(io)?;
        let name = normalize_plugin_id(id);
        with_lock(&root.join(format!(".{}.mutation.lock", if name.is_empty() { "plugin" } else { &name })), MUTATION_LOCK_TIMEOUT, operation)
    }

    fn enrich_entry(&self, lane: &InLane<MaintenanceIo>, entry: &Value) -> Value {
        let root = clean_field(entry, "root");
        let exists = !root.is_empty() && Path::new(&root).exists();
        let manifest_value = if exists { manifest(lane, Path::new(&root)).1 } else { Value::Object(Map::new()) };
        let pick = |keys: &[&str], from_entry: &[&str], fallback: String| -> String {
            keys.iter()
                .map(|k| clean_field(&manifest_value, k))
                .chain(from_entry.iter().map(|k| clean_field(entry, k)))
                .find(|s| !s.is_empty())
                .unwrap_or(fallback)
        };
        let name = pick(&["name", "id"], &["name"], display_name_from_url(&clean_field(entry, "source")));
        let title = pick(&["title", "displayName"], &["title"], name.clone());
        let version = pick(&["version"], &["version"], String::new());
        let description = pick(&["description"], &["description"], String::new());
        let mut out = entry.as_object().cloned().unwrap_or_default();
        out.insert("enabled".into(), Value::Bool(entry.get("enabled") != Some(&Value::Bool(false))));
        out.insert("name".into(), name.into());
        out.insert("title".into(), title.into());
        out.insert("version".into(), if version.is_empty() { Value::Null } else { version.into() });
        out.insert("description".into(), description.into());
        for (key, value) in plugin_metadata(&manifest_value) {
            out.insert(key.into(), value);
        }
        out.insert("exists".into(), Value::Bool(exists));
        Value::Object(out)
    }

    pub fn list_registered_plugins(&self, lane: &InLane<MaintenanceIo>) -> Result<Vec<Value>> {
        Ok(self.load_registry(lane)?.iter().map(|entry| self.enrich_entry(lane, entry)).collect())
    }

    pub fn status(&self, lane: &InLane<MaintenanceIo>) -> Result<Value> {
        Ok(json!({
            "registryPath": self.registry_path().to_string_lossy(),
            "installRoot": self.install_root().to_string_lossy(),
            "plugins": self.list_registered_plugins(lane)?,
        }))
    }

    fn run_git(&self, args: &[&str]) -> Result<String> {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        self.git.run(&args, Duration::from_millis(120_000)).map_err(PluginAdminError)
    }

    fn materialize(&self, source: &Source, id: &str) -> Result<(PathBuf, bool)> {
        if source.local {
            return Ok((source.path.clone().unwrap_or_default(), false));
        }
        let root = self.install_root().join(id);
        std::fs::create_dir_all(root.parent().unwrap_or(Path::new("."))).map_err(io)?;
        recover_managed_root(&root).map_err(io)?;
        cleanup_partials(&root);
        let mut temp = root.as_os_str().to_owned();
        temp.push(format!(".tmp-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let temp = PathBuf::from(temp);
        let url = source.url.clone().unwrap_or_default();
        let outcome = self
            .run_git(&["clone", "--depth", "1", &url, &temp.to_string_lossy()])
            .and_then(|_| publish_managed_root(&root, &temp));
        if outcome.is_err() {
            let _ = remove_tree(&temp);
        }
        cleanup_partials(&root);
        outcome.map(|()| (root, true))
    }

    /// `addPlugin(source, { name })`: registers a plugin (installing a Git one); an already
    /// registered source is updated instead.
    pub fn add_plugin(&self, lane: &InLane<MaintenanceIo>, source_input: &Value, name: Option<&Value>) -> Result<Value> {
        let source = normalize_source(lane, source_input)?;
        let identity = if source.display_source.is_empty() { source.url.clone().or_else(|| source.path.as_ref().map(|p| p.to_string_lossy().into_owned())).unwrap_or_default() } else { source.display_source.clone() };
        let id = stable_id_for_source(&identity);
        let matches = |plugin: &Value| plugin.get("id").and_then(Value::as_str) == Some(id.as_str()) || clean_field(plugin, "source") == js_trim(&source.display_source);
        let initial = self.load_registry(lane)?;
        let lock_id = initial.iter().find(|p| matches(p)).and_then(|p| p.get("id")).map(clean).filter(|s| !s.is_empty()).unwrap_or_else(|| id.clone());
        self.with_plugin_mutation(&lock_id, || {
            if let Some(existing) = self.load_registry(lane)?.into_iter().find(|p| matches(p)) {
                return self.update_locked(lane, &existing);
            }
            let (root, managed) = self.materialize(&source, &id)?;
            let manifest_value = manifest(lane, &root).1;
            let given = name.map(clean).unwrap_or_default();
            let display = display_name_from_url(&source.display_source);
            let first = |parts: Vec<String>| parts.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
            let version = clean_field(&manifest_value, "version");
            let now = now_iso();
            let mut entry = json!({
                "id": id,
                "source": source.display_source,
                "url": source.url,
                "sourceType": if source.local { "local" } else { "git" },
                "root": root.to_string_lossy(),
                "managed": managed,
                "name": first(vec![given.clone(), clean_field(&manifest_value, "name"), clean_field(&manifest_value, "id"), display.clone()]),
                "title": first(vec![clean_field(&manifest_value, "title"), clean_field(&manifest_value, "displayName"), given, display]),
                "version": if version.is_empty() { Value::Null } else { version.into() },
                "description": clean_field(&manifest_value, "description"),
                "enabled": true,
                "installedAt": now,
                "updatedAt": now,
            });
            self.mutate_registry(lane, |plugins| {
                if let Some(index) = plugins.iter().position(|p| matches(p)) {
                    if let Some(installed) = plugins[index].get("installedAt").filter(|v| truthy(v)) {
                        entry["installedAt"] = installed.clone();
                    }
                    plugins[index] = entry.clone();
                } else {
                    plugins.push(entry.clone());
                }
                Ok(self.enrich_entry(lane, &entry))
            })
        })
    }

    fn update_locked(&self, lane: &InLane<MaintenanceIo>, current: &Value) -> Result<Value> {
        let id = clean_field(current, "id");
        let position = |plugins: &[Value]| plugins.iter().position(|p| p.get("id") == current.get("id")).ok_or_else(|| PluginAdminError(format!("plugin not registered: {id}")));
        if current.get("sourceType").and_then(Value::as_str) == Some("local") || current.get("managed") == Some(&Value::Bool(false)) {
            return self.mutate_registry(lane, |plugins| {
                let index = position(plugins)?;
                let mut next = self.enrich_entry(lane, &plugins[index]);
                next["updatedAt"] = now_iso().into();
                plugins[index] = next.clone();
                Ok(next)
            });
        }
        let from = ["url", "source"].iter().map(|k| current.get(*k)).find(|v| v.is_some_and(truthy)).flatten().unwrap_or(&Value::Null);
        let source = normalize_source(lane, from)?;
        let (root, managed) = self.materialize(&source, &id)?;
        self.mutate_registry(lane, |plugins| {
            let index = position(plugins)?;
            let mut entry = plugins[index].clone();
            entry["root"] = root.to_string_lossy().into();
            entry["managed"] = managed.into();
            entry["updatedAt"] = now_iso().into();
            let next = self.enrich_entry(lane, &entry);
            plugins[index] = next.clone();
            Ok(next)
        })
    }

    fn require_key(id_or_name: &Value) -> Result<String> {
        let key = clean(id_or_name);
        if key.is_empty() { fail("plugin id/name is required") } else { Ok(key) }
    }

    pub fn update_plugin(&self, lane: &InLane<MaintenanceIo>, id_or_name: &Value) -> Result<Value> {
        let key = Self::require_key(id_or_name)?;
        let initial = self.load_registry(lane)?;
        let id = plugin_index(&initial, &key).map(|i| initial[i]["id"].clone()).ok_or_else(|| PluginAdminError(format!("plugin not registered: {key}")))?;
        self.with_plugin_mutation(&clean(&id), || {
            let registry = self.load_registry(lane)?;
            let current = registry.iter().find(|p| p.get("id") == Some(&id)).ok_or_else(|| PluginAdminError(format!("plugin not registered: {key}")))?;
            self.update_locked(lane, current)
        })
    }

    pub fn set_plugin_enabled(&self, lane: &InLane<MaintenanceIo>, id_or_name: &Value, enabled: &Value) -> Result<Value> {
        let key = Self::require_key(id_or_name)?;
        self.mutate_registry(lane, |plugins| {
            let index = plugin_index(plugins, &key).ok_or_else(|| PluginAdminError(format!("plugin not registered: {key}")))?;
            plugins[index]["enabled"] = Value::Bool(enabled != &Value::Bool(false));
            let next = plugins[index].clone();
            Ok(self.enrich_entry(lane, &next))
        })
    }

    pub fn remove_plugin(&self, lane: &InLane<MaintenanceIo>, id_or_name: &Value) -> Result<Value> {
        let key = Self::require_key(id_or_name)?;
        let initial = self.load_registry(lane)?;
        let id = plugin_index(&initial, &key).map(|i| initial[i]["id"].clone()).ok_or_else(|| PluginAdminError(format!("plugin not registered: {key}")))?;
        self.with_plugin_mutation(&clean(&id), || {
            let mut entry = self.mutate_registry(lane, |plugins| {
                let index = plugins.iter().position(|p| p.get("id") == Some(&id)).ok_or_else(|| PluginAdminError(format!("plugin not registered: {key}")))?;
                Ok(plugins.remove(index))
            })?;
            let root = clean_field(&entry, "root");
            if entry.get("managed") != Some(&Value::Bool(false)) && !root.is_empty() {
                ensure_inside(&self.install_root(), &root)?;
                remove_tree(Path::new(&root)).map_err(io)?;
                remove_tree(Path::new(&format!("{root}.backup"))).map_err(io)?;
                cleanup_partials(Path::new(&root));
            }
            entry["removed"] = Value::Bool(true);
            Ok(entry)
        })
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Which registered plugin a key means: by id, name or title.
fn plugin_index(plugins: &[Value], key: &str) -> Option<usize> {
    plugins.iter().position(|p| ["id", "name", "title"].iter().any(|f| p.get(*f).and_then(Value::as_str) == Some(key)))
}

fn lock_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".lock");
    PathBuf::from(p)
}

/// Runs `body` holding the exclusive lock of `lock`, polling until `timeout`.
fn with_lock<T>(lock: &Path, timeout: Duration, body: impl FnOnce() -> Result<T>) -> Result<T> {
    let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock).map_err(io)?;
    let deadline = Instant::now() + timeout;
    let mut wait = 25;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(wait));
                wait = (wait * 2).min(200);
            }
            Err(std::fs::TryLockError::WouldBlock) => return fail(format!("lock timeout: {}", lock.display())),
            Err(std::fs::TryLockError::Error(error)) => return Err(io(error)),
        }
    }
    let result = body();
    let _ = file.unlock();
    result
}

/// `writeJsonAtomicSync(..., { secret, fsyncDir, backup })`: a temp file renamed over the target,
/// the replaced version kept as `<file>.bak` while it still parses.
fn write_json_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Ok(previous) = std::fs::read(path) {
        let text = String::from_utf8_lossy(&previous);
        if serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).is_ok() {
            let mut backup = path.as_os_str().to_owned();
            backup.push(".bak");
            publish(Path::new(&backup), &previous)?;
        }
    }
    publish(path, bytes)?;
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        let _ = std::fs::File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

fn publish(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut name = path.file_name().map(|n| n.to_owned()).unwrap_or_default();
    name.push(format!(".mixdog-tmp-{:016x}", rand::random::<u64>()));
    let temp = path.with_file_name(name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn ensure_inside(parent: &Path, child: &str) -> Result<()> {
    let (p, c) = (resolve_path(&parent.to_string_lossy()).unwrap_or_default(), resolve_path(child).unwrap_or_default());
    if c != p && !c.starts_with(&format!("{p}\\")) && !c.starts_with(&format!("{p}/")) {
        return fail(format!("refusing to modify plugin path outside registry root: {child}"));
    }
    Ok(())
}

/// Detaches every link in the tree before it is deleted, never following one; every entry is
/// looked at right before it is acted on.
fn walk_tree(dir: &Path, on_file: &mut dyn FnMut(&Path, &std::fs::Metadata)) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let full = entry?.path();
        let Ok(meta) = std::fs::symlink_metadata(&full) else { continue };
        if meta.file_type().is_symlink() {
            detach(&full)?;
        } else if meta.is_dir() {
            walk_tree(&full, on_file)?;
        } else {
            on_file(&full, &meta);
        }
    }
    Ok(())
}

fn detach(link: &Path) -> std::io::Result<()> {
    std::fs::remove_file(link).or_else(|_| std::fs::remove_dir(link))
}

fn clear_read_only(path: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        let mut permissions = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false, reason = "Windows read-only bit on git pack files")]
        permissions.set_readonly(false);
        let _ = std::fs::set_permissions(path, permissions);
    }
}

pub(crate) fn remove_tree(path: &Path) -> std::io::Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(()) };
    if meta.file_type().is_symlink() {
        return detach(path);
    }
    if meta.is_dir() {
        walk_tree(path, &mut |_, _| {})?;
    }
    let remove = || if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    match remove() {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            if meta.is_dir() {
                walk_tree(path, &mut |file, stat| {
                    if link_count(stat) == 1 {
                        clear_read_only(file);
                    }
                })?;
            } else {
                clear_read_only(path);
            }
            remove()
        }
        other => other,
    }
}

#[cfg(unix)]
fn link_count(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::nlink(meta)
}

#[cfg(not(unix))]
fn link_count(_: &std::fs::Metadata) -> u64 {
    1
}

fn cleanup_partials(root: &Path) {
    let (Some(parent), Some(name)) = (root.parent(), root.file_name()) else { return };
    let prefix = format!("{}.tmp-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = remove_tree(&entry.path());
        }
    }
}

fn backup_of(root: &Path) -> PathBuf {
    let mut p = root.as_os_str().to_owned();
    p.push(".backup");
    PathBuf::from(p)
}

fn recover_managed_root(root: &Path) -> std::io::Result<PathBuf> {
    let backup = backup_of(root);
    if !root.exists() && backup.exists() {
        std::fs::rename(&backup, root)?;
    } else if root.exists() && backup.exists() {
        remove_tree(&backup)?;
    }
    Ok(backup)
}

/// Swaps a freshly cloned `temp` in for `root`, putting the previous install back if the swap fails.
pub(crate) fn publish_managed_root(root: &Path, temp: &Path) -> Result<()> {
    let backup = recover_managed_root(root).map_err(io)?;
    let mut previous_moved = false;
    let swap = (|| {
        if root.exists() {
            std::fs::rename(root, &backup)?;
            previous_moved = true;
        }
        std::fs::rename(temp, root)
    })();
    if let Err(error) = swap {
        if !root.exists() && previous_moved && backup.exists() && std::fs::rename(&backup, root).is_err() {
            return fail(format!("plugin publish and rollback both failed for {}", root.display()));
        }
        return Err(io(error));
    }
    let _ = remove_tree(&backup);
    Ok(())
}
