#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible)")]
//! Editor-side files the workspace owns (ports of `editor-backups.ts` and
//! `workspace-config.ts`): unsaved-edit backups, `.code-workspace` files, the scoped
//! editor settings read for a file, and the task workspace folder.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use regex::RegexBuilder;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::error::WsError;
use crate::error::WsResult;
use crate::pathguard::canonical;
use crate::pathguard::comparable;
use crate::pathguard::lexical;

const MAX_WORKSPACE_FOLDERS: usize = 64;

// ---- language of a path (the generated `editor-languages.ts` tables) ---------------------------

struct Languages {
    extensions: std::collections::HashMap<String, String>,
    names: std::collections::HashMap<String, String>,
    patterns: Vec<(bool, String, regex::Regex)>,
}

fn languages() -> &'static Languages {
    static TABLE: OnceLock<Languages> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw: Value = serde_json::from_str(include_str!("editor_languages.json")).expect("embedded language table");
        let map = |key: &str| -> std::collections::HashMap<String, String> {
            raw[key].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()).unwrap_or_default()
        };
        let patterns = raw["patterns"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let regex = RegexBuilder::new(p["source"].as_str()?).case_insensitive(p["flags"].as_str()?.contains('i')).build().ok()?;
                        Some((p["scope"] == "path", p["languageId"].as_str()?.to_owned(), regex))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Languages { extensions: map("extensions"), names: map("names"), patterns }
    })
}

/// `editorLanguageIdForPath`.
pub fn language_id_for_path(path: &str) -> String {
    let normalized = path.replace('\\', "/").to_lowercase();
    let base = normalized.rsplit('/').next().unwrap_or(&normalized).to_owned();
    let table = languages();
    if let Some(named) = table.names.get(&base) {
        return named.clone();
    }
    for (path_scope, language, regex) in &table.patterns {
        if regex.is_match(if *path_scope { &normalized } else { &base }) {
            return language.clone();
        }
    }
    let parts: Vec<&str> = base.split('.').collect();
    for index in 0..parts.len() {
        let suffix = parts[index..].join(".");
        if let Some(language) = table.extensions.get(suffix.strip_prefix('.').unwrap_or(&suffix)) {
            return language.clone();
        }
    }
    "plaintext".to_owned()
}

// ---- JSONC ------------------------------------------------------------------------------------

fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let (mut out, mut quoted, mut escaped, mut i) = (String::new(), false, false, 0);
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            out.push(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            out.push('\n');
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 1;
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn strip_trailing_commas(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let (mut out, mut quoted, mut escaped) = (String::new(), false, false);
    for (i, &c) in chars.iter().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|n| !n.is_whitespace());
            if matches!(next, Some('}' | ']')) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

pub fn parse_jsonc(source: &str) -> WsResult<Value> {
    if source.encode_utf16().count() > 2_000_000 {
        return Err(WsError::invalid("JSON configuration is too large."));
    }
    serde_json::from_str(&strip_trailing_commas(&strip_comments(source))).map_err(|e| WsError::invalid(e.to_string()))
}

fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0' || c.is_whitespace())
}

/// The object a JSONC file holds; `None` when missing, empty or NUL-filled.
fn read_jsonc_file(path: &Path) -> WsResult<Option<Map<String, Value>>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if holds_no_data(&text) {
        return Ok(None);
    }
    Ok(parse_jsonc(&text)?.as_object().cloned())
}

// ---- workspace files --------------------------------------------------------------------------

fn workspace_name(path: &Path) -> String {
    let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = if base.to_lowercase().ends_with(".code-workspace") { base[..base.len() - ".code-workspace".len()].to_owned() } else { base };
    if stem.is_empty() { "Workspace".into() } else { stem }
}

fn resolve_against(base: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    lexical(&if path.is_absolute() { path.to_path_buf() } else { base.join(path) })
}

fn unique_folders(folders: Vec<(PathBuf, Option<String>)>) -> Vec<(PathBuf, Option<String>)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (path, name) in folders {
        if !seen.insert(comparable(&path)) {
            continue;
        }
        out.push((path, name));
        if out.len() >= MAX_WORKSPACE_FOLDERS {
            break;
        }
    }
    out
}

fn workspace_json(file: &Path, folders: &[(PathBuf, Option<String>)]) -> Value {
    let folders: Vec<Value> = folders
        .iter()
        .map(|(path, name)| {
            let mut folder = Map::new();
            folder.insert("path".into(), json!(path.to_string_lossy()));
            if let Some(name) = name {
                folder.insert("name".into(), json!(name));
            }
            Value::Object(folder)
        })
        .collect();
    json!({ "kind": "workspace", "name": workspace_name(file), "workspaceFile": file.to_string_lossy(), "folders": folders })
}

pub fn read_workspace_file(workspace_file: &Path) -> WsResult<Value> {
    let file = lexical(workspace_file);
    if file.extension().map(|e| e.to_string_lossy().to_lowercase()) != Some("code-workspace".into()) {
        return Err(WsError::invalid("Workspace file must use the .code-workspace extension."));
    }
    let config = parse_jsonc(&std::fs::read_to_string(&file)?)?;
    let config = config.as_object().ok_or_else(|| WsError::invalid("Workspace configuration must be an object."))?;
    let base = file.parent().unwrap_or(Path::new("")).to_path_buf();
    let folders = config
        .get("folders")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    let raw = f.get("path")?.as_str()?.trim();
                    if raw.is_empty() || raw.encode_utf16().count() > 16_384 {
                        return None;
                    }
                    let name = f.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(200).collect());
                    Some((resolve_against(&base, raw), name))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(workspace_json(&file, &unique_folders(folders)))
}

/// `path.relative(from, to)`; the absolute `to` when they share no root.
fn relative(from: &Path, to: &Path) -> String {
    let (a, b): (Vec<_>, Vec<_>) = (from.components().collect(), to.components().collect());
    let same = |x: &Component, y: &Component| comparable(Path::new(x.as_os_str())) == comparable(Path::new(y.as_os_str()));
    let common = a.iter().zip(&b).take_while(|(x, y)| same(x, y)).count();
    if common == 0 {
        return to.to_string_lossy().into_owned();
    }
    let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

pub fn write_workspace_file(workspace_file: &Path, folders: &Value) -> WsResult<Value> {
    let mut file = lexical(workspace_file);
    if !file.to_string_lossy().to_lowercase().ends_with(".code-workspace") {
        file = PathBuf::from(format!("{}.code-workspace", file.display()));
    }
    let existing = read_jsonc_file(&file)?.unwrap_or_default();
    let listed: Vec<(PathBuf, Option<String>)> = folders
        .as_array()
        .ok_or_else(|| WsError::invalid("folders is invalid."))?
        .iter()
        .filter_map(|f| {
            let path = f.get("path")?.as_str()?;
            // The returned workspace keeps the name as given (Node spreads the folder); only the
            // saved file drops an empty one.
            let name = f.get("name").and_then(Value::as_str).map(str::to_owned);
            Some((lexical(Path::new(path)), name))
        })
        .collect();
    let normalized = unique_folders(listed);
    let base = file.parent().unwrap_or(Path::new("")).to_path_buf();
    let serialized: Vec<Value> = normalized
        .iter()
        .map(|(path, name)| {
            let rel = relative(&base, path);
            // Node keeps the absolute path when the relative one is empty or absolute (the workspace
            // folder itself, another drive); `.` only if even that is empty.
            let text = if rel.is_empty() || Path::new(&rel).is_absolute() { path.to_string_lossy().into_owned() } else { rel };
            let text = if text.is_empty() { ".".to_owned() } else { text };
            let mut folder = Map::new();
            folder.insert("path".into(), json!(text));
            if let Some(name) = name.as_ref().filter(|n| !n.is_empty()) {
                folder.insert("name".into(), json!(name));
            }
            Value::Object(folder)
        })
        .collect();
    let mut config = existing;
    config.insert("folders".into(), Value::Array(serialized));
    let mut text = serde_json::to_string_pretty(&Value::Object(config)).expect("workspace json");
    text.push('\n');
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = file.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, &file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(workspace_json(&file, &normalized))
}

// ---- scoped editor settings -------------------------------------------------------------------

const LEGACY_MARKDOWN_VIEW: &str = "mixdog.markdown.defaultView";

fn read_user_settings(user_data: &Path) -> WsResult<Option<Map<String, Value>>> {
    read_jsonc_file(&user_data.join("User").join("settings.json"))
}

/// Only the unscoped user preference can become the desktop-wide default.
pub fn legacy_markdown_view(user_data: &Path) -> Option<&'static str> {
    let settings = read_user_settings(user_data).ok().flatten()?;
    match setting_in_scope(&settings, LEGACY_MARKDOWN_VIEW)?.as_str() {
        Some("rich") => Some("rich"),
        Some("source") => Some("source"),
        Some("preview") => Some("preview"),
        _ => None,
    }
}

fn language_settings(source: &Map<String, Value>, language: &str) -> Map<String, Value> {
    let mut result = source.clone();
    for (key, value) in source {
        if !(key.starts_with('[') && key.ends_with(']')) {
            continue;
        }
        let listed = key.split('[').skip(1).filter_map(|s| s.split(']').next()).any(|l| l == language);
        if listed
            && let Some(object) = value.as_object() {
            result.extend(object.clone());
        }
    }
    result
}

fn setting_in_scope(source: &Map<String, Value>, key: &str) -> Option<Value> {
    if let Some(v) = source.get(key) {
        return Some(v.clone());
    }
    let (group, rest) = key.split_once('.')?;
    setting_in_scope(source.get(group)?.as_object()?, rest)
}

fn setting(scopes: &[Map<String, Value>], key: &str) -> Option<Value> {
    scopes.iter().rev().find_map(|s| setting_in_scope(s, key))
}

use mixdog_js::to_number as js_number;

fn finite(value: Option<Value>, fallback: f64, min: f64, max: f64) -> f64 {
    let n = value.as_ref().map_or(f64::NAN, js_number);
    if n.is_finite() && n >= min && n <= max { n } else { fallback }
}

fn boolean(value: Option<Value>, fallback: bool) -> bool {
    value.and_then(|v| v.as_bool()).unwrap_or(fallback)
}

use mixdog_js::json_number as number_json;

fn editor_settings(scopes: Vec<Value>, language: &str) -> Value {
    let merged: Vec<Map<String, Value>> = scopes.iter().filter_map(Value::as_object).map(|o| language_settings(o, language)).collect();
    let get = |key: &str| setting(&merged, key);
    let text = |v: Option<Value>| v.and_then(|v| v.as_str().map(str::to_owned));
    let word_wrap = text(get("editor.wordWrap"));
    let whitespace = text(get("editor.renderWhitespace"));
    let inlay = get("editor.inlayHints.enabled");
    let guides = get("editor.guides.bracketPairs");
    let font = text(get("editor.fontFamily")).map(|f| f.trim().to_owned()).filter(|f| !f.is_empty());
    json!({
        "fontFamily": font.map_or_else(|| "\"JetBrains Mono Variable\", \"Cascadia Code\", Consolas, monospace".to_owned(), |f| f.chars().take(500).collect()),
        "fontSize": number_json(finite(get("editor.fontSize"), 14.0, 6.0, 100.0)),
        "lineHeight": number_json(finite(get("editor.lineHeight"), 21.0, 8.0, 200.0)),
        "wordWrap": word_wrap.as_deref().filter(|w| matches!(*w, "on" | "wordWrapColumn" | "bounded")).unwrap_or("off"),
        "wordWrapColumn": number_json(finite(get("editor.wordWrapColumn"), 80.0, 1.0, 1000.0).round()),
        "renderWhitespace": whitespace.as_deref().filter(|w| matches!(*w, "none" | "boundary" | "trailing" | "all")).unwrap_or("selection"),
        "minimapEnabled": boolean(get("editor.minimap.enabled"), true),
        "stickyScrollEnabled": boolean(get("editor.stickyScroll.enabled"), true),
        "bracketPairColorization": boolean(get("editor.bracketPairColorization.enabled"), true),
        "bracketPairGuides": match &guides { Some(Value::Bool(b)) => json!(b), Some(Value::String(s)) if s == "active" => json!("active"), _ => json!(false) },
        "inlayHintsEnabled": match &inlay {
            Some(Value::Bool(false)) => "off",
            Some(Value::String(s)) if s == "off" => "off",
            Some(Value::String(s)) if s == "offUnlessPressed" => "offUnlessPressed",
            Some(Value::String(s)) if s == "onUnlessPressed" => "onUnlessPressed",
            _ => "on",
        },
        "formatOnSave": boolean(get("editor.formatOnSave"), false),
        "formatOnPaste": boolean(get("editor.formatOnPaste"), false),
        "formatOnType": boolean(get("editor.formatOnType"), false),
        "markdownDefaultView": get(LEGACY_MARKDOWN_VIEW).as_ref().and_then(Value::as_str).filter(|v| matches!(*v, "rich" | "source")).unwrap_or("preview"),
        "tabSize": number_json(finite(get("editor.tabSize"), 4.0, 1.0, 16.0).round()),
        "insertSpaces": boolean(get("editor.insertSpaces"), true),
        "detectIndentation": boolean(get("editor.detectIndentation"), true),
    })
}

/// `readScopedEditorSettings`: user settings, then the workspace file's, then the folder's.
/// `user_markdown_view` is the user's Markdown default view as this core stores it (the config key
/// `desktop.editor.markdownDefaultView`, where Node keeps `mixdog.markdown.defaultView` in the user settings file):
/// the user scope carries it, so a workspace or folder setting still wins over it, as in Node.
pub fn read_editor_settings(user_data: &Path, folder: &Path, rel: &str, workspace_file: Option<&Path>, user_markdown_view: Option<String>) -> WsResult<Value> {
    let scope = |path: PathBuf| -> WsResult<Value> { Ok(Value::Object(read_jsonc_file(&path)?.unwrap_or_default())) };
    let mut user = read_user_settings(user_data)?.unwrap_or_default();
    if let Some(view) = user_markdown_view {
        user.insert(LEGACY_MARKDOWN_VIEW.to_owned(), Value::String(view));
    }
    let workspace = match workspace_file {
        Some(file) => scope(lexical(file))?.get("settings").filter(|s| s.is_object()).cloned().unwrap_or_else(|| json!({})),
        None => json!({}),
    };
    let folder_scope = scope(lexical(folder).join(".vscode").join("settings.json"))?;
    Ok(editor_settings(vec![Value::Object(user), workspace, folder_scope], &language_id_for_path(rel)))
}

// ---- editor backups ---------------------------------------------------------------------------

const MAX_BACKUP_CONTENT: usize = 4_194_304;
const MAX_BACKUP_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKUP_FILES: usize = 100;

/// Where the profile migration put the backups before it moved them under the user-data folder, relative to the data dir.
const MIGRATED_BACKUPS: &str = "desktop/editor-backups";

pub struct Backups {
    dir: PathBuf,
}

/// The app's internal "no project" working folder, created on demand.
pub fn task_workspace(user_data: &Path) -> WsResult<PathBuf> {
    let path = user_data.join("workspace").join("unclassified");
    std::fs::create_dir_all(&path)?;
    canonical(&path).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_ids_follow_names_patterns_then_longest_extension() {
        assert_eq!(language_id_for_path("src/a.ts"), "typescript");
        assert_eq!(language_id_for_path("Dockerfile"), "dockerfile");
        assert_eq!(language_id_for_path("x.unknownext"), "plaintext");
    }

    #[test]
    fn settings_merge_scopes_languages_and_clamp() {
        let user = json!({ "editor.fontSize": 18, "[typescript]": { "editor.tabSize": 2 }, "editor.wordWrap": "on" });
        let folder = json!({ "editor": { "fontSize": "20", "tabSize": 99 }, "editor.minimap.enabled": false });
        let out = editor_settings(vec![user, json!({}), folder], "typescript");
        assert_eq!(out["fontSize"], 20);
        assert_eq!(out["tabSize"], 4);
        assert_eq!(out["wordWrap"], "on");
        assert_eq!(out["minimapEnabled"], false);
    }

    #[test]
    fn jsonc_comments_and_trailing_commas() {
        let v = parse_jsonc("{ // c\n \"a\": [1, 2,], /* x */ \"b\": \"//no\", }").unwrap();
        assert_eq!(v, json!({ "a": [1, 2], "b": "//no" }));
    }

    #[test]
    fn workspace_file_round_trips_relative_folders_and_keeps_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        let file = base.join("w");
        std::fs::write(base.join("w.code-workspace"), r#"{ "settings": { "a": 1 } }"#).unwrap();
        let folders = json!([{ "path": base.join("one").to_string_lossy() }, { "path": base.join("two").to_string_lossy(), "name": "Two" }]);
        let written = write_workspace_file(&file, &folders).unwrap();
        assert_eq!(written["name"], "w");
        let text = std::fs::read_to_string(base.join("w.code-workspace")).unwrap();
        assert!(text.contains("\"path\": \"one\"") && text.contains("\"settings\""));
        let read = read_workspace_file(&base.join("w.code-workspace")).unwrap();
        assert_eq!(read["folders"][1]["name"], "Two");
    }

    #[test]
    fn backups_round_trip_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path());
        let source = dir.path().join("file.txt").to_string_lossy().into_owned();
        assert_eq!(backups.read(&source).unwrap(), Value::Null);
        backups.write(&source, "mine", "disk").unwrap();
        assert_eq!(backups.read(&source).unwrap()["content"], "mine");
        backups.delete(&source).unwrap();
        assert_eq!(backups.read(&source).unwrap(), Value::Null);
    }

    /// The user-level settings file is read where the migration puts it (`<data>/userdata/User/settings.json`).
    #[test]
    fn the_migrated_user_settings_file_applies_to_every_file() {
        let data = tempfile::tempdir().unwrap();
        let user_data = data.path().join("userdata");
        std::fs::create_dir_all(user_data.join("User")).unwrap();
        std::fs::write(user_data.join("User").join("settings.json"), "{
  // mine
  \"editor.tabSize\": 2,
}
").unwrap();
        let folder = data.path().join("project");
        std::fs::create_dir_all(&folder).unwrap();
        let settings = read_editor_settings(&user_data, &folder, "a.ts", None, None).unwrap();
        assert_eq!(settings["tabSize"], 2);
    }

    /// A data dir the first migration pass already filled holds the old app's drafts under `desktop/editor-backups`: the backups
    /// the core reads take them in, keep what is already there, and leave no copy behind.
    #[test]
    fn backups_an_earlier_migration_left_under_desktop_are_offered_from_the_user_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let (mine, theirs) = (data.path().join("mine.txt").to_string_lossy().into_owned(), data.path().join("theirs.txt").to_string_lossy().into_owned());
        let probe = Backups::new(&data.path().join("probe"));
        let name_of = |source: &str| probe.path_of(source).unwrap().file_name().unwrap().to_owned();
        let draft = |content: &str| json!({ "content": content, "expectedContent": "disk", "updatedAt": now_ms() }).to_string();
        let left = data.path().join("desktop").join("editor-backups");
        std::fs::create_dir_all(&left).unwrap();
        std::fs::write(left.join(name_of(&mine)), draft("old draft")).unwrap();
        std::fs::write(left.join(name_of(&theirs)), draft("stale copy")).unwrap();
        let user_data = data.path().join("userdata");
        std::fs::create_dir_all(user_data.join("editor-backups")).unwrap();
        std::fs::write(user_data.join("editor-backups").join(name_of(&theirs)), draft("newer draft")).unwrap();

        let backups = Backups::new(&user_data);
        assert_eq!(backups.read(&mine).unwrap()["content"], "old draft");
        assert_eq!(backups.read(&theirs).unwrap()["content"], "newer draft", "a draft written since stays");
        backups.delete(&theirs).unwrap();
        assert!(Backups::new(&user_data).read(&theirs).unwrap().is_null(), "deleted draft stays deleted");
        let archives = data.path().join("desktop/editor-backups-superseded");
        let slot = std::fs::read_dir(archives).unwrap().next().unwrap().unwrap().path();
        let preserved: Value = serde_json::from_slice(&std::fs::read(slot.join(name_of(&theirs))).unwrap()).unwrap();
        assert_eq!(preserved["content"], "stale copy", "the conflict is preserved outside adoption");
        assert!(!data.path().join("desktop").join("editor-backups").join(name_of(&mine)).exists());
    }
    #[test]
    fn archive_obstruction_blocks_backup_deletion_until_old_copy_is_preserved() {
        let data = tempfile::tempdir().unwrap();
        let source = data.path().join("a.txt").to_string_lossy().into_owned();
        let backups = Backups::new(&data.path().join("userdata"));
        backups.write(&source, "current", "disk").unwrap();
        let name = backups.path_of(&source).unwrap().file_name().unwrap().to_owned();
        let legacy = data.path().join("desktop/editor-backups");
        std::fs::create_dir_all(&legacy).unwrap();
        let stale = json!({"content":"stale", "expectedContent":"disk", "updatedAt":now_ms()}).to_string();
        std::fs::write(legacy.join(&name), &stale).unwrap();
        let archive = data.path().join("desktop/editor-backups-superseded");
        std::fs::write(&archive, "obstruction").unwrap();
        assert!(backups.delete(&source).is_err());
        assert!(backups.read(&source).is_err());
        assert!(legacy.join(&name).exists());
        std::fs::remove_file(&archive).unwrap();
        assert_eq!(backups.read(&source).unwrap()["content"], "current");
        backups.delete(&source).unwrap();
        assert!(Backups::new(&data.path().join("userdata")).read(&source).unwrap().is_null());
        let slot = std::fs::read_dir(archive).unwrap().next().unwrap().unwrap().path();
        assert_eq!(std::fs::read_to_string(slot.join(name)).unwrap(), stale);
    }



    /// A draft backed up holding half of an emoji (a lone surrogate escape) is read back with U+FFFD in its place and is not deleted.
    #[test]
    fn a_backup_holding_half_an_emoji_is_read_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path());
        let source = dir.path().join("notes.md").to_string_lossy().into_owned();
        let path = backups.path_of(&source).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"content":"Draft reply \ud83d","expectedContent":"Draft reply\n","updatedAt":1794355203000}"#).unwrap();
        let read = backups.read(&source).unwrap();
        assert_eq!((read["content"].as_str(), read["expectedContent"].as_str()), (Some("Draft reply \u{fffd}"), Some("Draft reply\n")));
        assert!(path.exists());
    }

    /// Saving a workspace file adds the `.code-workspace` extension, names the workspace after the file, drops a folder listed twice
    /// (however it is spelled) and keeps a folder's name (an empty one is kept in the answer, left out of the file).
    #[test]
    fn a_workspace_file_is_named_after_its_file_and_lists_each_folder_once() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        let folder = |rel: &str| {
            let mut path = base.clone();
            path.extend(rel.split('/'));
            path.to_string_lossy().into_owned()
        };
        let folders = json!([
            { "path": folder("proj/a") },
            { "name": "B", "path": folder("proj/b") },
            { "path": folder("proj/a/../a") },
            { "name": "", "path": folder("proj/d") },
            { "path": folder("proj") },
        ]);
        let written = write_workspace_file(&base.join("proj").join("team"), &folders).unwrap();
        assert_eq!((written["kind"].as_str(), written["name"].as_str()), (Some("workspace"), Some("team")));
        let names: Vec<(String, Option<String>)> = written["folders"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_owned(), f["name"].as_str().map(str::to_owned))).collect();
        assert_eq!(names, [(folder("proj/a"), None), (folder("proj/b"), Some("B".into())), (folder("proj/d"), Some(String::new())), (folder("proj"), None)]);
        let text = std::fs::read_to_string(base.join("proj").join("team.code-workspace")).unwrap();
        let saved: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(saved["folders"], json!([{ "path": "a" }, { "name": "B", "path": "b" }, { "path": "d" }, { "path": folder("proj") }]));
        let read = read_workspace_file(&base.join("proj").join("team.code-workspace")).unwrap();
        assert_eq!(read["folders"].as_array().unwrap().len(), 4);
        assert!(read_workspace_file(&base.join("proj").join("team.json")).is_err(), "the extension is required");
    }

    /// A workspace file may carry comments and trailing commas (`parse_jsonc` strips both, and nothing else); its folders are
    /// resolved against its own folder, and a file that is not an object is refused.
    #[test]
    fn a_commented_workspace_file_is_read_and_its_folders_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        std::fs::create_dir_all(base.join("proj")).unwrap();
        std::fs::write(base.join("proj/commented.code-workspace"), "{\n // c\n \"folders\": [ {\"path\": \"sub\"}, {\"path\": \"../up\", \"name\": \"Up\"}, ],\n}").unwrap();
        let read = read_workspace_file(&base.join("proj/commented.code-workspace")).unwrap();
        let paths: Vec<String> = read["folders"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
        assert_eq!(paths, [base.join("proj").join("sub").to_string_lossy().into_owned(), base.join("up").to_string_lossy().into_owned()]);
        std::fs::write(base.join("proj/bad.code-workspace"), "{ nope").unwrap();
        assert!(read_workspace_file(&base.join("proj/bad.code-workspace")).is_err());
        std::fs::write(base.join("proj/arr.code-workspace"), "[1]").unwrap();
        assert!(read_workspace_file(&base.join("proj/arr.code-workspace")).is_err());
    }

    /// Editor settings with nothing configured are the defaults; the user's file, then the workspace's `settings`, then the
    /// folder's `.vscode/settings.json` each override the one before; an unreadable or NUL-filled file is as if absent; values out of
    /// range fall back to the default.
    #[test]
    fn editor_settings_are_the_defaults_then_user_workspace_and_folder_in_that_order() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        let (user_data, folder) = (base.join("userData"), base.join("folder"));
        std::fs::create_dir_all(user_data.join("User")).unwrap();
        std::fs::create_dir_all(folder.join(".vscode")).unwrap();
        let defaults = read_editor_settings(&user_data, &folder, "a.ts", None, None).unwrap();
        assert_eq!(
            (defaults["fontSize"].clone(), defaults["lineHeight"].clone(), defaults["tabSize"].clone(), defaults["wordWrap"].clone(), defaults["renderWhitespace"].clone(), defaults["markdownDefaultView"].clone()),
            (json!(14), json!(21), json!(4), json!("off"), json!("selection"), json!("preview"))
        );
        assert_eq!((defaults["minimapEnabled"].clone(), defaults["formatOnSave"].clone(), defaults["insertSpaces"].clone(), defaults["inlayHintsEnabled"].clone()), (json!(true), json!(false), json!(true), json!("on")));
        std::fs::write(user_data.join("User/settings.json"), r#"{ "editor.fontSize": 18, "editor.tabSize": 2, "editor.wordWrap": "on" }"#).unwrap();
        let workspace = base.join("w.code-workspace");
        std::fs::write(&workspace, r#"{ "settings": { "editor.fontSize": 16, "editor.wordWrap": "bounded", "editor.lineHeight": 2 } }"#).unwrap();
        std::fs::write(folder.join(".vscode/settings.json"), r#"{ "editor.fontSize": 12 }"#).unwrap();
        let merged = read_editor_settings(&user_data, &folder, "a.ts", Some(&workspace), Some("rich".into())).unwrap();
        // The folder wins the font size, the workspace the wrap, the user the tab size; a line height below 8 is out of range.
        assert_eq!((merged["fontSize"].clone(), merged["wordWrap"].clone(), merged["tabSize"].clone(), merged["lineHeight"].clone(), merged["markdownDefaultView"].clone()), (json!(12), json!("bounded"), json!(2), json!(21), json!("rich")));
        std::fs::write(folder.join(".vscode/settings.json"), "\0\0").unwrap();
        assert_eq!(read_editor_settings(&user_data, &folder, "a.ts", None, None).unwrap()["fontSize"], 18, "a NUL-filled file is absent");
        std::fs::write(folder.join(".vscode/settings.json"), r#"{ "editor.fontSize": "#).unwrap();
        assert!(read_editor_settings(&user_data, &folder, "a.ts", None, None).is_err(), "a file that does not parse is an error");
    }

    /// A backup needs an absolute source path and content within 4 MiB (counted in UTF-16 units); a file that does not parse, is
    /// older than 30 days or has the wrong shape reads as none and is removed; at most 100 backup files are kept, the oldest go.
    #[test]
    fn backups_refuse_bad_input_drop_unusable_files_and_keep_the_newest_hundred() {
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path());
        let source = |name: &str| dir.path().join("p").join(name).to_string_lossy().into_owned();
        assert_eq!(backups.write("relative/file.txt", "a", "b").unwrap_err().message, "Editor backup path is invalid.");
        assert_eq!(backups.read("relative/file.txt").unwrap_err().message, "Editor backup path is invalid.");
        assert_eq!(backups.write(&source("big.txt"), &"x".repeat(4_194_305), "").unwrap_err().message, "Editor backup content is invalid.");
        assert!(backups.write(&source("max.txt"), &"x".repeat(4_194_304), "").is_ok());
        assert_eq!(backups.write(&source("emoji.txt"), &"😀".repeat(2_097_152), "").map(|v| v["content"].as_str().map(|s| s.encode_utf16().count())).unwrap(), Some(4_194_304));
        let planted = |name: &str, text: &str| {
            let path = backups.path_of(&source(name)).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        };
        let bad = planted("bad.txt", "{ not json");
        assert_eq!(backups.read(&source("bad.txt")).unwrap(), Value::Null);
        assert!(!bad.exists());
        let old = planted("old.txt", &json!({ "content": "c", "expectedContent": "e", "updatedAt": now_ms() - 31 * 24 * 60 * 60 * 1000 }).to_string());
        assert_eq!(backups.read(&source("old.txt")).unwrap(), Value::Null);
        assert!(!old.exists());
        planted("shape.txt", &json!({ "content": 5, "expectedContent": "e", "updatedAt": now_ms() }).to_string());
        assert_eq!(backups.read(&source("shape.txt")).unwrap(), Value::Null);
        backups.write(&source("file.txt"), "mine", "disk").unwrap();
        backups.delete(&source("file.txt")).unwrap();
        backups.delete(&source("file.txt")).unwrap();
        assert_eq!(backups.read(&source("file.txt")).unwrap(), Value::Null);

        let _ = std::fs::remove_dir_all(dir.path().join("editor-backups"));
        let now = SystemTime::now();
        for number in 0..105u64 {
            let path = backups.path_of(&source(&format!("n{number}.txt"))).unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, json!({ "content": "c", "expectedContent": "e", "updatedAt": now_ms() }).to_string()).unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(now - std::time::Duration::from_secs(1000 - number)).unwrap();
        }
        backups.write(&source("newest.txt"), "n", "").unwrap();
        let kept = std::fs::read_dir(dir.path().join("editor-backups")).unwrap().count();
        assert_eq!(kept, 101, "the hundred newest of the old ones are pruned to 100 before the new one is added");
        assert_eq!(backups.read(&source("n0.txt")).unwrap(), Value::Null, "the oldest is gone");
        assert_eq!(backups.read(&source("n104.txt")).unwrap()["content"], "c");
    }
}


/// The backup clock. A debug build (never a release one) reads `MIXDOG_FIXED_NOW_MS` as a pinned instant, so a replay can give the
/// core the same virtual clock the Node recording ran on.
pub fn now_ms() -> i64 {
    #[cfg(debug_assertions)]
    if let Some(pinned) = std::env::var("MIXDOG_FIXED_NOW_MS").ok().and_then(|raw| raw.parse::<i64>().ok()) {
        return pinned;
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
impl Backups {
    /// The backups of `user_data` (`<data>/userdata`). Read, write and delete adopt
    /// `<data>/desktop/editor-backups` first; construction and path lookup perform no I/O.
    pub fn new(user_data: &Path) -> Self {
        let dir = user_data.join("editor-backups");
        Self { dir }
    }

    fn adopt(&self) -> WsResult<()> {
        if let Some(data) = self.dir.parent().and_then(Path::parent) {
            crate::recovery::adopt_missing(&data.join(MIGRATED_BACKUPS), &self.dir)?;
        }
        Ok(())
    }

    /// The backup file of a source path (for serializing operations on it, without I/O).
    pub fn path_of(&self, source: &str) -> WsResult<PathBuf> {
        let source = Path::new(source);
        if !source.is_absolute() {
            return Err(WsError::invalid("Editor backup path is invalid."));
        }
        let key = comparable(&lexical(source)).to_string_lossy().into_owned();
        let digest: String = Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        Ok(self.dir.join(format!("{digest}.json")))
    }

    fn valid(value: &Value) -> bool {
        let text = |k: &str| value.get(k).and_then(Value::as_str).is_some_and(|s| s.encode_utf16().count() <= MAX_BACKUP_CONTENT);
        text("content") && text("expectedContent") && value.get("updatedAt").and_then(Value::as_f64).is_some_and(|n| n > 0.0)
    }

    pub fn read(&self, source: &str) -> WsResult<Value> {
        let path = self.path_of(source)?;
        self.adopt()?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
            Err(e) => return Err(e.into()),
        };
        // A draft Node saved with half of an emoji holds `\ud83d`: read as U+FFFD, never deleted as unparsable.
        match serde_json::from_slice::<Value>(&mixdog_js::json_well_formed(&bytes)) {
            Ok(v) if Self::valid(&v) && now_ms() - v["updatedAt"].as_f64().unwrap_or(0.0) as i64 <= MAX_BACKUP_AGE_MS => Ok(v),
            _ => {
                let _ = std::fs::remove_file(&path);
                Ok(Value::Null)
            }
        }
    }

    fn prune(&self) {
        let Ok(read) = std::fs::read_dir(&self.dir) else { return };
        let now = SystemTime::now();
        let mut rows: Vec<(PathBuf, SystemTime)> = read
            .filter_map(Result::ok)
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.len() == 69 && n.ends_with(".json") && n[..64].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
            .collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.1));
        for (index, (path, modified)) in rows.iter().enumerate() {
            let old = now.duration_since(*modified).is_ok_and(|d| d.as_millis() as i64 > MAX_BACKUP_AGE_MS);
            if index >= MAX_BACKUP_FILES || old {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    pub fn write(&self, source: &str, content: &str, expected: &str) -> WsResult<Value> {
        if content.encode_utf16().count() > MAX_BACKUP_CONTENT || expected.encode_utf16().count() > MAX_BACKUP_CONTENT {
            return Err(WsError::invalid("Editor backup content is invalid."));
        }
        let path = self.path_of(source)?;
        self.adopt()?;
        let backup = json!({ "content": content, "expectedContent": expected, "updatedAt": now_ms() });
        std::fs::create_dir_all(&self.dir)?;
        self.prune();
        let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
        let outcome = (|| -> WsResult<()> {
            let mut out = std::fs::File::create(&temp)?;
            std::io::Write::write_all(&mut out, backup.to_string().as_bytes())?;
            out.sync_all()?;
            std::fs::rename(&temp, &path)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        outcome.map(|()| backup)
    }

    pub fn delete(&self, source: &str) -> WsResult<()> {
        let path = self.path_of(source)?;
        self.adopt()?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
