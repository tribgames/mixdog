//! The user-registered project registry: `<MIXDOG_HOME>/projects.json`, a Node-exact port of
//! `src/runtime/shared/projects.mjs`. Shape `{projects:[{name, path, addedAt, lastSelectedAt?}]}`,
//! listed most recently selected first (then by name, then by path).
//!
//! This is the list a user builds ("Add project"), not the desktop project preferences in
//! `state/core.sqlite` (`SqliteStore::projects`: alias, hidden, last used). The file stays a file
//! (`projectsRegistry`, preserve contract), so Node and the Rust core read the same bytes.
//!
//! Reads, damage handling and writes are `mixdog-statefile`'s port of `atomic-file.mjs`: an
//! unparsable file is moved aside to `<file>.corrupt-<ms>` and the last good `<file>.bak` is
//! restored; every write keeps the replaced, still-parsable version as `<file>.bak`. Writers
//! of this process queue on an in-process lock first, so they do not wait on the file lock.
//!
//! Every method is the body of a lane job: it takes the lane proof of a writing lane.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every std::fs call here is the body of a lane job (lane proof arguments)")]

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use mixdog_rt::InLane;
use mixdog_statefile::{Opts, StateError, holds_no_data, read_json, update_json, write_file};
use serde::Serialize;
use serde_json::{Number, Value};

use crate::fsio::WriteLane;

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

fn state_error(error: StateError<io::Error>) -> io::Error {
    match error {
        StateError::Io(error) | StateError::Mutator(error) => error,
        StateError::Lock(error) => io::Error::other(error),
    }
}

fn state_error_plain(error: StateError) -> io::Error {
    match error {
        StateError::Io(error) => error,
        StateError::Lock(error) => io::Error::other(error),
        StateError::Mutator(never) => match never {},
    }
}

impl Registry {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// `<home>/projects.json`.
    pub fn in_home(home: &Path) -> Self {
        Self::new(home.join("projects.json"))
    }

    fn sorted(mut entries: Vec<ProjectEntry>) -> Vec<ProjectEntry> {
        entries.sort_by(compare);
        entries
    }

    fn list_body<L: WriteLane>(&self, lane: &InLane<L>, strict: bool) -> io::Result<Vec<ProjectEntry>> {
        let _held = self.lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // `readStore`: a tolerant read swallows any failure, a strict one rethrows it.
        let read = read_json(lane, &self.path, None, &Opts::default()).and_then(|state| match state {
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
    pub fn list<L: WriteLane>(&self, lane: &InLane<L>) -> Vec<ProjectEntry> {
        self.list_body(lane, false).unwrap_or_default()
    }

    /// `listProjectsStrict`: an I/O failure is an error, not an empty registry.
    pub fn list_strict<L: WriteLane>(&self, lane: &InLane<L>) -> io::Result<Vec<ProjectEntry>> {
        self.list_body(lane, true)
    }

    /// `mutateStore`: read (recovering a damaged file), mutate, and write only when changed. The
    /// replaced version is kept as `.bak` when it still parses.
    fn mutate<L: WriteLane, T>(
        &self,
        lane: &InLane<L>,
        mutator: impl FnOnce(&mut Vec<ProjectEntry>) -> (T, bool),
    ) -> io::Result<T> {
        let _held = self.lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut outcome = None;
        let opts = Opts { backup: true, ..Opts::default() };
        update_json(
            lane,
            &self.path,
            |current| {
                let mut entries = match current.as_ref() {
                    Some(doc) => normalize(doc, true)?,
                    None => Vec::new(),
                };
                let (value, changed) = mutator(&mut entries);
                outcome = Some(value);
                if !changed {
                    return Ok(None);
                }
                serde_json::to_value(Document { projects: &entries }).map(Some).map_err(io::Error::other)
            },
            &opts,
        )
        .map_err(state_error)?;
        Ok(outcome.expect("the mutator ran"))
    }

    /// `addProject`: registers `raw_path` (resolved against `cwd`), or returns the entry already
    /// there. Writes the project-id marker beside it, best effort.
    pub fn add<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        self.add_body(lane, cwd, raw_path)
    }

    fn add_body<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        let entry = self.mutate(lane, |entries| {
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
        ensure_project_id_marker(lane, &abs, &entry.name);
        Ok(Some(entry))
    }

    /// `touchProjectSelected`: stamps `lastSelectedAt` on a registered project.
    pub fn touch_selected<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        self.touch_body(lane, cwd, raw_path)
    }

    fn touch_body<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        let entry = self.mutate(lane, |entries| {
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
            ensure_project_id_marker(lane, &abs, &entry.name);
        }
        Ok(entry)
    }

    /// `removeProject`: unregisters the project; the directory is untouched.
    pub fn remove<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<bool> {
        self.remove_body(lane, cwd, raw_path)
    }

    fn remove_body<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str) -> io::Result<bool> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(false);
        }
        self.mutate(lane, |entries| {
            let key = normalize_key(&abs);
            let before = entries.len();
            entries.retain(|e| normalize_key(&e.path) != key);
            let removed = entries.len() != before;
            (removed, removed)
        })
    }

    /// `renameProject`: the display name only; a blank name resets it to the folder's name.
    pub fn rename<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str, next_name: &str) -> io::Result<Option<ProjectEntry>> {
        self.rename_body(lane, cwd, raw_path, next_name)
    }

    fn rename_body<L: WriteLane>(&self, lane: &InLane<L>, cwd: &Path, raw_path: &str, next_name: &str) -> io::Result<Option<ProjectEntry>> {
        let abs = to_absolute(cwd, raw_path);
        if abs.is_empty() {
            return Ok(None);
        }
        self.mutate(lane, |entries| {
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
/// for a missing folder, an empty name or `common`. Best effort: a failure is swallowed. Shared by
/// [`Registry`] and the core's project catalog (`project/create`, `project/touch`).
pub fn ensure_project_id_marker<L: WriteLane>(lane: &InLane<L>, abs: &str, name: &str) {
    let _ = try_marker(lane, abs, name);
}

fn try_marker<L: WriteLane>(lane: &InLane<L>, abs: &str, name: &str) -> io::Result<()> {
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
        write_file(lane, &marker, bytes.as_bytes(), &Opts::default()).map(drop).map_err(state_error_plain)
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

    /// Runs `job` as a durability-lane job.
    fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
        use mixdog_rt::LaneToken;
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            mixdog_rt::testing::tokens()
                .durability_io
                .submit(&mixdog_rt::CancellationToken::new(), job)
                .expect("lane")
                .await
                .expect("job ran")
        })
    }

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
                fs::write(base.join("projects.json.bak"), text.replace("<ABS>", escaped)).unwrap();
            }
            let start = now_ms();
            let results = on_lane({
                let (ops, base, base_text, file) = (case["ops"].clone(), base.clone(), base_text.clone(), file.clone());
                move |lane| {
                    let registry = Registry::new(file);
                    let mut results = Vec::new();
                    for op in ops.as_array().unwrap() {
                        let path = op["path"].as_str().unwrap_or("").replace("<ABS>", &base_text);
                        let one = |entry: io::Result<Option<ProjectEntry>>| {
                            entry.map(|e| e.map(|e| entry_value(&e)).unwrap_or(Value::Null))
                        };
                        let list = |strict| {
                            registry.list_body(lane, strict).map(|all| Value::Array(all.iter().map(entry_value).collect()))
                        };
                        let value = match op["op"].as_str().unwrap() {
                            "list" => list(false),
                            "listStrict" => list(true),
                            "add" => one(registry.add_body(lane, &base, &path)),
                            "touch" => one(registry.touch_body(lane, &base, &path)),
                            "remove" => registry.remove_body(lane, &base, &path).map(|removed| json!(removed)),
                            _ => one(registry.rename_body(lane, &base, &path, op["name"].as_str().unwrap())),
                        };
                        results.push(match value {
                            Ok(value) => json!({ "ok": mask(&stamp(value, start), &base_text) }),
                            Err(_) => json!({ "thrown": true }),
                        });
                    }
                    results
                }
            });
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
                "backup": parsed(&base.join("projects.json.bak")),
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
