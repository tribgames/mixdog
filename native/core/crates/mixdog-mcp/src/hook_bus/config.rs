//! The merged hooks configuration for a working directory: every hooks file in scope (user
//! data, project, plugins) parsed once per file-stamp set, standard events merged, legacy rules
//! collected, and the parse problems recorded (Node `config-loader.mjs`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;

use super::rules::normalize_rules;
use crate::hooks::HookConfigEntry;
use crate::hooks::HookEvents;
use crate::hooks::HookSources;
use crate::hooks::config_entries;
use crate::hooks::config_report;
use crate::hooks::merge_events;
use crate::hooks::parse_standard;
use crate::hooks::read_trusted_projects;
use crate::plugins::read_registry;

#[derive(Default)]
pub struct HookConfig {
    /// The file stamps this was parsed from; empty when it must not be reused.
    pub key: String,
    pub standard: bool,
    pub disabled: bool,
    pub events: HookEvents,
    pub legacy_rules: Vec<Value>,
    /// `(file, problem)`, reported once when the configuration is (re)parsed.
    pub errors: Vec<(PathBuf, String)>,
    /// The rules the rules file itself holds (its `toolBefore` list), used when no hooks file
    /// supplied legacy rules.
    pub fallback_rules: Vec<Value>,
}

pub struct Loaded {
    pub config: Arc<HookConfig>,
    /// The working directory exists (otherwise commands run in the process directory).
    pub project_exists: bool,
    /// Parsed now rather than served from the previous load.
    pub fresh: bool,
}

#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn stamp(path: &Path) -> Result<Option<String>, ()> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            Ok(Some(format!("{}:{modified}", meta.len())))
        }
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Ok(None),
        Err(_) => Err(()),
    }
}

fn cache_key(entries: &[HookConfigEntry]) -> (String, bool) {
    let mut cacheable = true;
    let parts: Vec<String> = entries
        .iter()
        .map(|e| {
            let stamp = stamp(&e.path).unwrap_or_else(|()| {
                cacheable = false;
                Some("error".to_owned())
            });
            format!(
                "{}|{}|{:?}|{:?}|{:?}|{}",
                e.path.display(),
                stamp.unwrap_or_default(),
                e.source_type,
                e.plugin_root,
                e.plugin_data,
                e.untrusted
            )
        })
        .collect();
    (parts.join("\n"), cacheable)
}

/// Why a hooks file gave no document.
enum Unreadable {
    /// Damaged (empty, NUL-filled or not JSON): reported once, holds no hooks.
    Damaged(String),
    /// A real I/O error: the load is not cached, so it is retried.
    Io(String),
}

/// A hooks file's document: `Ok(None)` when it is missing. A damaged rules file is restored
/// from its valid `.bak` copy.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
fn read_document(path: &Path, restore: bool) -> Result<Option<Value>, Unreadable> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => return Ok(None),
        Err(e) => return Err(Unreadable::Io(e.to_string())),
    };
    let damage = if text.trim_matches(|c: char| c == '\0' || mixdog_js::is_js_space(c)).is_empty() {
        "the file holds no data (empty or NUL-filled)".to_owned()
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => return Ok(Some(value)),
            Err(error) => error.to_string(),
        }
    };
    if restore {
        let backup = PathBuf::from(format!("{}.bak", path.display()));
        if let Some(value) = std::fs::read_to_string(backup).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            return Ok(Some(value));
        }
    }
    Err(Unreadable::Damaged(damage))
}

/// Loads the configuration that applies at `cwd`, reusing `previous` while no file changed.
pub fn load_config(
    lane: &InLane<MaintenanceIo>,
    data_dir: &Path,
    cwd: &Path,
    env_file: Option<&Path>,
    previous: Option<Arc<HookConfig>>,
) -> Loaded {
    let trusted = read_trusted_projects(lane, data_dir);
    let plugins = read_registry(lane, data_dir);
    let entries = config_entries(&HookSources { env_file, data_dir, project_dir: cwd, trusted_projects: &trusted, plugins: &plugins });
    #[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
    let project_exists = cwd.exists();
    let (key, cacheable) = cache_key(&entries);
    if cacheable && let Some(previous) = previous.filter(|p| p.key == key) {
        return Loaded { config: previous, project_exists, fresh: false };
    }
    let rules_path = env_file.map_or_else(|| data_dir.join("hooks.json"), Path::to_path_buf);
    let rules_path = std::path::absolute(&rules_path).unwrap_or(rules_path);
    let mut config = HookConfig::default();
    let mut cacheable = cacheable;
    for entry in &entries {
        let parsed = match read_document(&entry.path, entry.path == rules_path) {
            Ok(Some(parsed)) => parsed,
            Ok(None) => continue,
            Err(Unreadable::Damaged(problem)) => {
                config.errors.push((entry.path.clone(), problem));
                continue;
            }
            Err(Unreadable::Io(problem)) => {
                cacheable = false;
                config.errors.push((entry.path.clone(), problem));
                continue;
            }
        };
        if parsed.get("disableAllHooks").is_some() {
            config.disabled = parsed.get("disableAllHooks") == Some(&Value::Bool(true));
        }
        let report = config_report(&parsed);
        if report.standard {
            if !report.invalid_events.is_empty() {
                config.errors.push((entry.path.clone(), format!("ignored malformed hook event(s): {}", report.invalid_events.join(", "))));
            }
            merge_events(&mut config.events, parse_standard(&parsed, &entry.path, entry));
        } else {
            let rules = normalize_rules(&parsed);
            if rules.is_empty() && !report.invalid_events.is_empty() {
                config.errors.push((
                    entry.path.clone(),
                    format!("no usable hooks: malformed event(s) under \"hooks\": {}", report.invalid_events.join(", ")),
                ));
            }
            config.legacy_rules.extend(rules);
        }
    }
    config.fallback_rules = read_document(&rules_path, true).ok().flatten().map(|d| normalize_rules(&d)).unwrap_or_default();
    config.standard = !config.events.is_empty();
    config.key = if cacheable { key } else { String::new() };
    Loaded { config: Arc::new(config), project_exists, fresh: true }
}
