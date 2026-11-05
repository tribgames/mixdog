//! The user-registered project registry: `<MIXDOG_HOME>/projects.json`, a Node-exact port of
//! `src/runtime/shared/projects.mjs`. Shape `{projects:[{name, path, addedAt, lastSelectedAt?}]}`,
//! listed most recently selected first (then by name, then by path).
//!
//! This is the list a user builds ("Add project"), not the desktop project preferences in
//! `state/core.sqlite` (`SqliteStore::projects`: alias, hidden, last used). The file stays a file
//! (`projectsRegistry`, preserve contract), so Node and the Rust core read the same bytes.
//!
//! Damage handling follows `atomic-file.mjs`: an unparsable file is moved aside to
//! `<file>.corrupt-<ms>` and the last good `<file>.bak` is restored; every write keeps the
//! replaced, still-parsable version as `<file>.bak`. One core owns the data dir, so writers
//! serialise on an in-process lock instead of Node's cross-process lock file.
//!
//! Every method is the body of a lane job: it takes the lane proof of a writing lane.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every std::fs call here is the body of a lane job (lane proof arguments)")]

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use mixdog_rt::InLane;
use serde::Serialize;
use serde_json::{Number, Value};

use crate::fsio::{Access, WriteLane, publish_file_with};

/// One registered project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "addedAt")]
    pub added_at: Number,
    #[serde(rename = "lastSelectedAt", skip_serializing_if = "Option::is_none")]
    pub last_selected_at: Option<Number>,
}

#[derive(Serialize)]
struct Document<'a> {
    projects: &'a [ProjectEntry],
}

/// The registry file and the lock its writers share.
pub struct Registry {
    path: PathBuf,
    lock: Mutex<()>,
}

/// `Number(x)` kept as the JSON number Node would write back (an integer when it is one).
fn number(value: f64) -> Number {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Number::from(value as i64)
    } else {
        Number::from_f64(value).unwrap_or_else(|| Number::from(0))
    }
}

/// Node `path.basename`: the last segment, trailing separators ignored; both separators on
/// Windows (a verbatim `\\?\` path does not make `/` an ordinary character there).
fn base_name(path: &str) -> String {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let trimmed = path.trim_end_matches(separators);
    trimmed.rsplit(separators).next().unwrap_or_default().to_owned()
}

/// Node `path.isAbsolute`: on Windows a rooted path (`\x`, `//x`) and a drive path (`C:\x`).
fn is_absolute_text(text: &str) -> bool {
    if !cfg!(windows) {
        return text.starts_with('/');
    }
    let bytes = text.as_bytes();
    matches!(bytes.first(), Some(b'/' | b'\\'))
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

/// `path.resolve(cwd, text)`: lexical, no filesystem access.
fn resolve(cwd: &Path, text: &str) -> PathBuf {
    let given = Path::new(text);
    let joined = if given.is_absolute() {
        given.to_path_buf()
    } else if given.has_root() {
        let mut rooted = PathBuf::new();
        if let Some(Component::Prefix(prefix)) = cwd.components().next() {
            rooted.push(prefix.as_os_str());
        }
        rooted.push(given);
        rooted
    } else {
        cwd.join(given)
    };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::Prefix(_) | Component::RootDir => out.push(part.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if out.parent().is_some() && out.file_name().is_some() {
                    out.pop();
                }
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

fn to_absolute(cwd: &Path, raw: &str) -> String {
    let text = mixdog_js::js_trim(raw);
    if text.is_empty() {
        return String::new();
    }
    resolve(cwd, text).to_string_lossy().into_owned()
}

/// Dedupe key: trailing separators dropped, lowercase on Windows.
fn normalize_key(path: &str) -> String {
    let text = path.trim_end_matches(['/', '\\']);
    if cfg!(windows) { text.to_lowercase() } else { path.trim_end_matches('/').to_owned() }
}

fn recency(entry: &ProjectEntry) -> f64 {
    match entry.last_selected_at.as_ref().and_then(Number::as_f64) {
        Some(last) if last.is_finite() && last > 0.0 => last,
        _ => entry.added_at.as_f64().unwrap_or(0.0),
    }
}

fn compare(a: &ProjectEntry, b: &ProjectEntry) -> Ordering {
    let by_recency = recency(b) - recency(a);
    if by_recency != 0.0 {
        return if by_recency < 0.0 { Ordering::Less } else { Ordering::Greater };
    }
    mixdog_js::locale_compare(&a.name, &b.name).then_with(|| mixdog_js::locale_compare(&a.path, &b.path))
}

/// Whether `String(value)` throws for a JSON value. An object with an own `toString` (which JSON
/// can only make a non-function) has no usable `toString`, and `Object.prototype.valueOf` does not
/// return a primitive, so the conversion is a `TypeError`; an array converts its elements one by
/// one, so one such object anywhere in it throws too.
fn string_conversion_throws(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.contains_key("toString"),
        Value::Array(items) => items.iter().any(string_conversion_throws),
        _ => false,
    }
}

/// `normalizeStore`: entries without a path are dropped; a strict read also drops relative paths.
/// A name that cannot be converted to a string fails the whole read, as it does in Node.
fn normalize(parsed: &Value, strict: bool) -> io::Result<Vec<ProjectEntry>> {
    let Some(list) = parsed.get("projects").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in list {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        if mixdog_js::js_trim(path).is_empty() || (strict && !is_absolute_text(path)) {
            continue;
        }
        let name = match entry.get("name") {
            Some(Value::String(name)) if !name.is_empty() => name.clone(),
            Some(other) if is_truthy(other) => {
                if string_conversion_throws(other) {
                    return Err(io::Error::other("TypeError: Cannot convert object to primitive value"));
                }
                mixdog_js::value_to_string(other)
            }
            _ => {
                let base = base_name(path);
                if base.is_empty() { path.to_owned() } else { base }
            }
        };
        let added = entry.get("addedAt").map(mixdog_js::to_number).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(0.0);
        let last = entry.get("lastSelectedAt").map(mixdog_js::to_number).filter(|n| *n > 0.0);
        out.push(ProjectEntry { name, path: path.to_owned(), added_at: number(added), last_selected_at: last.map(number) });
    }
    Ok(out)
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

enum Parsed {
    Absent,
    Ok(Value, Vec<u8>),
    Damaged,
}

fn parse(content: Option<Vec<u8>>) -> Parsed {
    let Some(content) = content else {
        return Parsed::Absent;
    };
    let text = content.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&content);
    match serde_json::from_slice::<Value>(text) {
        Ok(value) => Parsed::Ok(value, content),
        Err(_) => Parsed::Damaged,
    }
}

fn read_content(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn publish(path: &Path, bytes: &[u8]) -> io::Result<()> {
    publish_file_with(path, bytes, Access::Inherit).map_err(io::Error::other)
}

/// `holdsNoData`: nothing but NUL and white space, what a crash leaves of unsynced data.
fn holds_no_data(content: &[u8]) -> bool {
    content.iter().all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

impl Registry {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// `<home>/projects.json`.
    pub fn in_home(home: &Path) -> Self {
        Self::new(home.join("projects.json"))
    }

    fn quarantine(&self) -> PathBuf {
        let mut stamp = now_ms();
        while sibling(&self.path, &format!(".corrupt-{stamp}")).exists() {
            stamp += 1;
        }
        sibling(&self.path, &format!(".corrupt-{stamp}"))
    }

    /// `recoverDamagedSync`: the damaged file is kept aside and the last good copy restored.
    fn recover(&self) -> io::Result<Parsed> {
        let current = parse(read_content(&self.path)?);
        if !matches!(current, Parsed::Damaged) {
            return Ok(current);
        }
        let backup = parse(read_content(&sibling(&self.path, ".bak"))?);
        fs::rename(&self.path, self.quarantine())?;
        match backup {
            Parsed::Ok(value, bytes) => {
                publish(&self.path, &bytes)?;
                Ok(Parsed::Ok(value, bytes))
            }
            _ => Ok(Parsed::Absent),
        }
    }

    /// `readJsonStateSync`: the stored document, or none when missing or damaged without a copy.
    fn read_state(&self) -> io::Result<Option<Value>> {
        match parse(read_content(&self.path)?) {
            Parsed::Ok(value, _) => Ok(Some(value)),
            Parsed::Absent => Ok(None),
            Parsed::Damaged => Ok(match self.recover()? {
                Parsed::Ok(value, _) => Some(value),
                _ => None,
            }),
        }
    }

    fn sorted(mut entries: Vec<ProjectEntry>) -> Vec<ProjectEntry> {
        entries.sort_by(compare);
        entries
    }

    fn list_body(&self, strict: bool) -> io::Result<Vec<ProjectEntry>> {
        let _held = self.lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // `readStore`: a tolerant read swallows any failure, a strict one rethrows it.
        let read = self.read_state().and_then(|state| match state {
            Some(doc) => normalize(&doc, strict),
            None => Ok(Vec::new()),
        });
        match read {
            Ok(entries) => Ok(Self::sorted(entries)),
            Err(e) if strict => Err(e),
            Err(_) => Ok(Vec::new()),
        }
    }

    /// `listProjects`: tolerant. An unreadable registry lists as empty.
    pub fn list<L: WriteLane>(&self, _lane: &InLane<L>) -> Vec<ProjectEntry> {
        self.list_body(false).unwrap_or_default()
    }

    /// `listProjectsStrict`: an I/O failure is an error, not an empty registry.
    pub fn list_strict<L: WriteLane>(&self, _lane: &InLane<L>) -> io::Result<Vec<ProjectEntry>> {
        self.list_body(true)
    }

    /// `mutateStore`: read (recovering a damaged file), mutate, and write only when changed. The
    /// replaced version is kept as `.bak` when it still parses.
    fn mutate<T>(&self, mutator: impl FnOnce(&mut Vec<ProjectEntry>) -> (T, bool)) -> io::Result<T> {
        let _held = self.lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = match parse(read_content(&self.path)?) {
            Parsed::Ok(value, _) => Some(value),
            Parsed::Absent => None,
            Parsed::Damaged => match self.recover()? {
                Parsed::Ok(value, _) => Some(value),
                _ => None,
            },
        };
        let mut entries = match current.as_ref() {
            Some(doc) => normalize(doc, true)?,
            None => Vec::new(),
        };
        let (value, changed) = mutator(&mut entries);
        if changed {
            // The file as it stands now (a recovery may have replaced it) is what gets backed up.
            let on_disk = read_content(&self.path)?;
            if let Some(bytes) = on_disk.filter(|b| !holds_no_data(b) && matches!(parse(Some(b.clone())), Parsed::Ok(..))) {
                publish(&sibling(&self.path, ".bak"), &bytes)?;
            }
            let mut text = serde_json::to_vec_pretty(&Document { projects: &entries }).map_err(io::Error::other)?;
            text.push(b'\n');
            publish(&self.path, &text)?;
        }
        Ok(value)
    }

    /// `addProject`: registers `raw_path` (resolved against `cwd`), or returns the entry already
    /// there. Writes the project-id marker beside it, best effort.
    pub fn add<L: WriteLane>(&self, _lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        self.add_body(cwd, raw_path)
    }

    fn add_body(&self, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        let entry = self.mutate(|entries| {
            let key = normalize_key(&abs);
            if let Some(existing) = entries.iter().find(|e| normalize_key(&e.path) == key) {
                return (existing.clone(), false);
            }
            let name = match base_name(&abs) {
                name if name.is_empty() => abs.clone(),
                name => name,
            };
            let added = ProjectEntry { name, path: abs.clone(), added_at: number(now_ms() as f64), last_selected_at: None };
            entries.push(added.clone());
            (added, true)
        })?;
        ensure_project_id_marker(&abs, &entry.name);
        Ok(Some(entry))
    }

    /// `touchProjectSelected`: stamps `lastSelectedAt` on a registered project.
    pub fn touch_selected<L: WriteLane>(&self, _lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        self.touch_body(cwd, raw_path)
    }

    fn touch_body(&self, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        let entry = self.mutate(|entries| {
            let key = normalize_key(&abs);
            match entries.iter_mut().find(|e| normalize_key(&e.path) == key) {
                Some(selected) => {
                    selected.last_selected_at = Some(number(now_ms() as f64));
                    (Some(selected.clone()), true)
                }
                None => (None, false),
            }
        })?;
        if let Some(entry) = &entry {
            ensure_project_id_marker(&abs, &entry.name);
        }
        Ok(entry)
    }

    /// `removeProject`: unregisters the project; the directory is untouched.
    pub fn remove<L: WriteLane>(&self, _lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<bool> {
        self.remove_body(cwd, raw_path)
    }

    fn remove_body(&self, cwd: &Path, raw_path: &str) -> io::Result<bool> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(false);
        }
        self.mutate(|entries| {
            let key = normalize_key(&abs);
            let before = entries.len();
            entries.retain(|e| normalize_key(&e.path) != key);
            let removed = entries.len() != before;
            (removed, removed)
        })
    }

    /// `renameProject`: the display name only; a blank name resets it to the folder's name.
    pub fn rename<L: WriteLane>(&self, _lane: &InLane<L>, cwd: &Path, raw_path: &str, next_name: &str) -> io::Result<Option<ProjectEntry>> {
        self.rename_body(cwd, raw_path, next_name)
    }

    fn rename_body(&self, cwd: &Path, raw_path: &str, next_name: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        self.mutate(|entries| {
            let key = normalize_key(&abs);
            match entries.iter_mut().find(|e| normalize_key(&e.path) == key) {
                Some(entry) => {
                    let trimmed = mixdog_js::js_trim(next_name);
                    entry.name = if !trimmed.is_empty() {
                        trimmed.to_owned()
                    } else if !base_name(&abs).is_empty() {
                        base_name(&abs)
                    } else {
                        abs.clone()
                    };
                    (Some(entry.clone()), true)
                }
                None => (None, false),
            }
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `ensureProjectIdMarker`: `<project>/.mixdog/project.id` holds the project's id so the registry
/// and memory classification agree. An existing marker with data is kept; nothing is created
/// for a missing folder, an empty name or `common`. Best effort: a failure is swallowed.
fn ensure_project_id_marker(abs: &str, name: &str) {
    let _ = try_marker(abs, name);
}

fn try_marker(abs: &str, name: &str) -> io::Result<()> {
    if std::env::var("MIXDOG_DISABLE_PROJECT_MARKERS").as_deref() == Ok("1") || abs.is_empty() {
        return Ok(());
    }
    let dir = Path::new(abs);
    if !dir.is_dir() {
        return Ok(());
    }
    let marker = dir.join(".mixdog").join("project.id");
    let present = marker.exists();
    if present && !holds_no_data(&fs::read(&marker)?) {
        return Ok(());
    }
    let value = match mixdog_js::js_trim(name) {
        "" => base_name(abs),
        trimmed => trimmed.to_owned(),
    };
    let value = mixdog_js::js_trim(&value);
    if value.is_empty() || value.to_lowercase() == "common" {
        return Ok(());
    }
    let bytes = format!("{value}\n");
    if present {
        publish(&marker, bytes.as_bytes())
    } else {
        // Created only if still missing: a concurrent creator's marker wins.
        fs::create_dir_all(marker.parent().unwrap_or(dir))?;
        match fs::OpenOptions::new().write(true).create_new(true).open(&marker) {
            Ok(mut file) => io::Write::write_all(&mut file, bytes.as_bytes()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/store/registry/projects-registry.json")).expect("golden")
    }

    /// `<ABS>`-masked text with the recorded separators.
    fn mask(value: &Value, base: &str) -> Value {
        match value {
            Value::String(s) => {
                let text = s.replace(base, "<ABS>");
                Value::String(if text.contains("<ABS>") { text.replace('\\', "/") } else { text })
            }
            Value::Array(a) => Value::Array(a.iter().map(|v| mask(v, base)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), mask(v, base))).collect()),
            other => other.clone(),
        }
    }

    /// Timestamps the module stamped are `<now>`; the recorded ones are kept.
    fn stamp(value: Value, start: i64) -> Value {
        match value {
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .map(|(k, v)| {
                        let fresh = matches!(k.as_str(), "addedAt" | "lastSelectedAt") && v.as_i64().is_some_and(|n| n >= start);
                        (k.clone(), if fresh { json!("<now>") } else { stamp(v, start) })
                    })
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| stamp(v, start)).collect()),
            other => other,
        }
    }

    fn entry_value(entry: &ProjectEntry) -> Value {
        serde_json::to_value(entry).unwrap()
    }

    #[test]
    fn the_registry_matches_nodes_projects_module() {
        let golden = fixture();
        let mut failures = Vec::new();
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().canonicalize().unwrap().join("work");
            fs::create_dir_all(&base).unwrap();
            let base_text = base.to_string_lossy().into_owned();
            let escaped = serde_json::to_string(&base_text).unwrap();
            let escaped = &escaped[1..escaped.len() - 1];
            let file = base.join("projects.json");
            for sub in case["dirs"].as_array().unwrap() {
                fs::create_dir_all(base.join(sub.as_str().unwrap())).unwrap();
            }
            for (rel, text) in case["preset"].as_object().unwrap() {
                fs::write(base.join(rel), text.as_str().unwrap()).unwrap();
            }
            if let Some(text) = case["file"].as_str() {
                fs::write(&file, text.replace("<ABS>", escaped)).unwrap();
            }
            if let Some(text) = case["bak"].as_str() {
                fs::write(sibling(&file, ".bak"), text.replace("<ABS>", escaped)).unwrap();
            }
            let registry = Registry::new(file.clone());
            let start = now_ms();
            let mut results = Vec::new();
            for op in case["ops"].as_array().unwrap() {
                let path = op["path"].as_str().unwrap_or("").replace("<ABS>", &base_text);
                let one = |entry: io::Result<Option<ProjectEntry>>| {
                    entry.map(|e| e.map(|e| entry_value(&e)).unwrap_or(Value::Null))
                };
                let list = |strict| registry.list_body(strict).map(|all| Value::Array(all.iter().map(entry_value).collect()));
                let value = match op["op"].as_str().unwrap() {
                    "list" => list(false),
                    "listStrict" => list(true),
                    "add" => one(registry.add_body(&base, &path)),
                    "touch" => one(registry.touch_body(&base, &path)),
                    "remove" => registry.remove_body(&base, &path).map(|removed| json!(removed)),
                    _ => one(registry.rename_body(&base, &path, op["name"].as_str().unwrap())),
                };
                results.push(match value {
                    Ok(value) => json!({ "ok": mask(&stamp(value, start), &base_text) }),
                    Err(_) => json!({ "thrown": true }),
                });
            }
            let parsed = |p: &Path| -> Value {
                match fs::read(p) {
                    Ok(bytes) => {
                        let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
                        mask(&stamp(serde_json::from_slice(text).unwrap(), start), &base_text)
                    }
                    Err(_) => Value::Null,
                }
            };
            let aside = fs::read_dir(&base)
                .unwrap()
                .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".corrupt-"))
                .count();
            let mut markers = serde_json::Map::new();
            for sub in case["markers"].as_object().unwrap().keys() {
                let text = fs::read_to_string(base.join(sub).join(".mixdog").join("project.id")).unwrap_or_default();
                markers.insert(sub.clone(), json!(text));
            }
            let got = json!({
                "results": results,
                "after": parsed(&file),
                "backup": parsed(&sibling(&file, ".bak")),
                "aside": aside,
                "markers": Value::Object(markers),
            });
            let want = json!({
                "results": case["results"].clone(),
                "after": case["after"].clone(),
                "backup": case["backup"].clone(),
                "aside": case["aside"].clone(),
                "markers": case["markers"].clone(),
            });
            if got != want {
                failures.push(format!("{name}\n  want: {want}\n  got:  {got}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
