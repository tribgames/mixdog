//! `hooksStatus()`: the hook bus's `status()` of `session-runtime/services/hook-bus.mjs`, with
//! its observer log (`hook-bus/event-log.mjs`): a bounded recent list, per-event counts and the
//! cwd cursor the next config lookup defaults to.
//!
//! [`HookEventLog`] is the `HookObserver` the `HookBus` is built with (`HookBus::new(.., observer)`),
//! and [`HookStatus`] answers the doctor from the same log plus the merged hooks configuration.

use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_js::is_js_space;
use mixdog_js::js_object_keys;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_mcp::hook_bus::HookObserver;
use mixdog_mcp::hook_bus::config::HookConfig;
use mixdog_mcp::hook_bus::config::load_config;
use mixdog_mcp::hooks::HookSources;
use mixdog_mcp::hooks::SourceType;
use mixdog_mcp::hooks::config_entries;
use mixdog_mcp::hooks::config_report;
use mixdog_mcp::hooks::parse_standard;
use mixdog_mcp::hooks::read_trusted_projects;
use mixdog_mcp::plugins::read_registry;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::doctor::HooksStatus;

/// `DEFAULT_EVENTS` (`hook-bus/constants.mjs`).
const DEFAULT_EVENTS: [&str; 16] = [
    "runtime:start",
    "session:create",
    "turn:start",
    "turn:end",
    "turn:error",
    "tool:planned",
    "tool:before",
    "tool:ask",
    "tool:deny",
    "tool:modify",
    "hook:error",
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
];

/// `createStandaloneHookBus({ maxEvents = 80 })`.
const MAX_EVENTS: usize = 80;

/// JavaScript truthiness of a parsed value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|v| !v.is_null())
}

/// `a || b || …`: the first truthy value.
fn first_truthy<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|key| payload.get(*key)).find(|v| truthy(Some(v)))
}

/// `a ?? b ?? …`: the first value that is neither missing nor null.
fn first_present<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|key| payload.get(*key)).find(|v| !v.is_null())
}

/// `compactValue` (`hook-bus/payload.mjs`).
pub fn compact_value(value: &Value) -> Value {
    match value {
        Value::String(text) if utf16_len(text) > 180 => Value::String(format!("{}...", slice_utf16(text, 180))),
        Value::Array(items) => Value::Array(items.iter().take(8).map(compact_value).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, val) in map.iter().take(12) {
                let lower = key.to_lowercase();
                let secret = ["token", "secret", "key", "password"].iter().any(|word| lower.contains(word));
                out.insert(key.clone(), if secret { json!("<redacted>") } else { compact_value(val) });
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// `String(value).slice(0, limit)` with `replace(/\s+/g, ' ')` applied after the slice when asked.
fn clip(value: &Value, limit: usize, collapse: bool) -> String {
    let cut = slice_utf16(&value_to_string(value), limit);
    if !collapse {
        return cut;
    }
    let mut out = String::with_capacity(cut.len());
    let mut in_space = false;
    for c in cut.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `summarizePayload` (`hook-bus/payload.mjs`).
pub fn summarize_payload(payload: &Value) -> String {
    if !payload.is_object() {
        return if payload.is_null() { String::new() } else { value_to_string(payload) };
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(session) = first_truthy(payload, &["sessionId", "session_id"]) {
        parts.push(format!("session={}", value_to_string(session)));
    }
    if let Some(name) = first_truthy(payload, &["name", "tool_name"]) {
        parts.push(format!("name={}", value_to_string(name)));
    }
    let provider = truthy(payload.get("provider"));
    if provider || truthy(payload.get("model")) {
        let named: Vec<String> =
            ["provider", "model"].iter().filter_map(|key| payload.get(*key)).filter(|v| truthy(Some(v))).map(value_to_string).collect();
        parts.push(named.join("/"));
    }
    if let Some(prompt) = payload.get("prompt").filter(|v| truthy(Some(v))) {
        parts.push(format!("prompt={}", clip(prompt, 60, true)));
    }
    if let Some(reason) = payload.get("reason").filter(|v| truthy(Some(v))) {
        parts.push(format!("reason={}", clip(reason, 120, false)));
    }
    if let Some(error) = payload.get("error").filter(|v| truthy(Some(v))) {
        parts.push(format!("error={}", clip(error, 120, false)));
    }
    if let Some(elapsed) = payload.get("elapsedMs").filter(|v| !v.is_null()) {
        parts.push(format!("{}ms", value_to_string(elapsed)));
    }
    parts.join(" · ")
}

/// `new Date().toISOString()` of `ms` since the epoch.
fn iso_utc(ms: i64) -> String {
    let (days, in_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

struct Log {
    recent: VecDeque<Value>,
    /// First-seen order: `Map` iteration order of the Node log.
    counts: Vec<(String, u64)>,
    cwd: PathBuf,
}

/// The observer log every hook event lands in (`createHookEventLog`).
pub struct HookEventLog {
    state: Mutex<Log>,
}

impl HookEventLog {
    /// `cwd` is the process's directory: where the first config lookup starts.
    pub fn new(cwd: PathBuf) -> Arc<Self> {
        let counts = DEFAULT_EVENTS.iter().map(|name| ((*name).to_owned(), 0)).collect();
        Arc::new(Self { state: Mutex::new(Log { recent: VecDeque::new(), counts, cwd }) })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Log> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn cwd(&self) -> PathBuf {
        self.state().cwd.clone()
    }
}

impl HookEventLog {
    /// `emit` at `now_ms` since the epoch (the entry's `ts`).
    pub fn emit_at(&self, event: &str, payload: &Value, now_ms: i64) {
        let name = js_trim(event);
        if name.is_empty() {
            return;
        }
        let mut log = self.state();
        if let Some(cwd) = payload.get("cwd").filter(|v| truthy(Some(v))).and_then(Value::as_str) {
            log.cwd = PathBuf::from(cwd);
        }
        match log.counts.iter_mut().find(|(seen, _)| seen == name) {
            Some((_, count)) => *count += 1,
            None => log.counts.push((name.to_owned(), 1)),
        }
        log.recent.push_back(json!({
            "ts": iso_utc(now_ms),
            "name": name,
            "summary": summarize_payload(payload),
            "payload": compact_value(payload),
        }));
        while log.recent.len() > MAX_EVENTS {
            log.recent.pop_front();
        }
    }
}

impl HookObserver for HookEventLog {
    fn emit(&self, event: &str, payload: Value) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        self.emit_at(event, &payload, now);
    }
}

/// `summarizeRule(rule, index)` (`hook-bus/rules.mjs`).
pub(crate) fn summarize_rule(rule: &Value, index: usize) -> Value {
    let or_null = |keys: &[&str]| first_truthy(rule, keys).cloned().unwrap_or(Value::Null);
    let patch = first_truthy(rule, &["patch", "args"]).map_or(Value::Null, compact_value);
    json!({
        "index": index,
        "enabled": rule.get("enabled") != Some(&Value::Bool(false)),
        "tool": first_present(rule, &["tool", "name", "tools"]).cloned().unwrap_or_else(|| json!("*")),
        "action": first_truthy(rule, &["action", "decision"]).cloned().unwrap_or_else(|| json!("allow")),
        "match": first_present(rule, &["match", "contains"]).cloned().unwrap_or(Value::Null),
        "cwd": or_null(&["cwd"]),
        "reason": or_null(&["reason", "message"]),
        "patch": patch,
    })
}

fn source_type(kind: SourceType) -> &'static str {
    match kind {
        SourceType::Env => "env",
        SourceType::Project => "project",
        SourceType::Data => "data",
        SourceType::Plugin => "plugin",
    }
}

/// `hookStatusNote`.
fn status_note(config: &HookConfig, configured: &[String], rule_count: usize) -> String {
    if config.disabled {
        "Hooks are disabled by disableAllHooks.".to_owned()
    } else if config.standard {
        let events = if configured.is_empty() { "(none)".to_owned() } else { configured.join(", ") };
        format!("Standard Mixdog hooks active for events: {events}.")
    } else if rule_count > 0 {
        "Legacy before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.".to_owned()
    } else {
        "No hook rules configured; lifecycle and tool events are recorded in observer mode.".to_owned()
    }
}

/// A hooks file's document (the files `sources` lists): `None` when it is missing, damaged or
/// `null`.
fn parsed_document(path: &Path) -> Option<Value> {
    let Ok(Some(content)) = mixdog_statefile::read_content(path) else { return None };
    if mixdog_statefile::holds_no_data(&content) {
        return None;
    }
    mixdog_statefile::parse_json_text(&content).ok().filter(|document| !document.is_null())
}

struct Source {
    path: PathBuf,
    kind: SourceType,
    plugin_root: Option<PathBuf>,
}

struct Loaded {
    config: Arc<HookConfig>,
    sources: Vec<Source>,
    /// `Object.keys(cfg.events)`: the events in the order the files merged them.
    configured: Vec<String>,
    rules_path: PathBuf,
}

pub struct HookStatus {
    data_dir: PathBuf,
    maintenance: MaintenanceIo,
    log: Arc<HookEventLog>,
    /// Receives the `hook:error` of a configuration read: the hook bus's own observer, which is
    /// `log` itself in the composition.
    observer: Arc<dyn HookObserver>,
    cache: Mutex<Option<Arc<HookConfig>>>,
}

impl HookStatus {
    pub fn new(data_dir: PathBuf, maintenance: MaintenanceIo, log: Arc<HookEventLog>, observer: Arc<dyn HookObserver>) -> Arc<Self> {
        Arc::new(Self { data_dir, maintenance, log, observer, cache: Mutex::new(None) })
    }

    async fn load(&self, cwd: PathBuf) -> Result<Loaded, String> {
        let previous = self.cache.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let data_dir = self.data_dir.clone();
        let env_file = std::env::var_os("MIXDOG_HOOKS_FILE").map(PathBuf::from);
        let loaded = self
            .maintenance
            .submit(&CancellationToken::new(), move |lane| {
                let loaded = load_config(lane, &data_dir, &cwd, env_file.as_deref(), previous);
                let trusted = read_trusted_projects(lane, &data_dir);
                let plugins = read_registry(lane, &data_dir);
                let entries = config_entries(&HookSources {
                    env_file: env_file.as_deref(),
                    data_dir: &data_dir,
                    project_dir: &cwd,
                    trusted_projects: &trusted,
                    plugins: &plugins,
                });
                let mut sources = Vec::new();
                let mut configured: Vec<String> = Vec::new();
                for entry in &entries {
                    let Some(document) = parsed_document(&entry.path) else { continue };
                    sources.push(Source { path: entry.path.clone(), kind: entry.source_type, plugin_root: entry.plugin_root.clone() });
                    if !config_report(&document).standard {
                        continue;
                    }
                    let kept = parse_standard(&document, &entry.path, entry);
                    for event in document.get("hooks").and_then(Value::as_object).map(js_object_keys).unwrap_or_default() {
                        if kept.contains_key(event.as_str()) && !configured.contains(event) {
                            configured.push(event.clone());
                        }
                    }
                }
                let rules_path = env_file.unwrap_or_else(|| data_dir.join("hooks.json"));
                let rules_path = std::path::absolute(&rules_path).unwrap_or(rules_path);
                (loaded, sources, configured, rules_path)
            })
            .map_err(|_| "the maintenance lane is full".to_owned())?
            .await
            .map_err(|error| format!("{error:?}"))?;
        let (loaded, sources, configured, rules_path) = loaded;
        if loaded.fresh {
            for (file, problem) in &loaded.config.errors {
                self.observer.emit("hook:error", json!({ "error": format!("failed to parse hooks file {}: {problem}", file.display()) }));
            }
        }
        *self.cache.lock().unwrap_or_else(PoisonError::into_inner) = Some(loaded.config.clone());
        Ok(Loaded { config: loaded.config, sources, configured, rules_path })
    }
}

#[async_trait]
impl HooksStatus for HookStatus {
    async fn status(&self) -> Value {
        let (config, sources, configured, rules_path) = match self.load(self.log.cwd()).await {
            Ok(loaded) => (loaded.config, loaded.sources, loaded.configured, Some(loaded.rules_path)),
            Err(error) => {
                self.observer.emit("hook:error", json!({ "error": error }));
                (Arc::new(HookConfig::default()), Vec::new(), Vec::new(), None)
            }
        };
        let rules: Vec<Value> = config.fallback_rules.iter().filter(|rule| rule.is_object()).cloned().collect();
        let listed: Vec<Value> = rules.iter().enumerate().map(|(index, rule)| summarize_rule(rule, index)).collect();
        let (counts, recent) = {
            let log = self.log.state();
            (log.counts.clone(), log.recent.iter().rev().cloned().collect::<Vec<_>>())
        };
        let mut events: Vec<String> = Vec::new();
        let mut seen = BTreeSet::new();
        for name in DEFAULT_EVENTS.iter().map(|name| (*name).to_owned()).chain(counts.iter().map(|(name, _)| name.clone())).chain(configured.iter().cloned()) {
            if seen.insert(name.clone()) {
                events.push(name);
            }
        }
        let mut sorted = counts;
        sorted.sort_by(|a, b| locale_compare(&a.0, &b.0));
        let counts: Map<String, Value> = sorted.into_iter().map(|(name, count)| (name, json!(count))).collect();
        let errors: Vec<Value> =
            config.errors.iter().map(|(file, error)| json!({ "file": file.display().to_string(), "error": error })).collect();
        json!({
            "enabled": !config.disabled,
            "mode": "standalone-standard",
            "configMode": if config.standard { "standard" } else { "legacy" },
            "rulesPath": rules_path.map(|path| path.display().to_string()),
            "configSources": sources.iter().map(|source| source.path.display().to_string()).collect::<Vec<_>>(),
            "configSourceEntries": sources
                .iter()
                .map(|source| json!({
                    "path": source.path.display().to_string(),
                    "sourceType": source_type(source.kind),
                    "pluginRoot": source.plugin_root.as_ref().map(|root| root.display().to_string()),
                }))
                .collect::<Vec<_>>(),
            "ruleCount": listed.len(),
            "rules": listed,
            "configuredEvents": configured,
            "events": events,
            "counts": counts,
            "recent": recent,
            "errors": errors,
            "note": status_note(&config, &configured, rules.len()),
        })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use crate::domain_seams::golden;
    use crate::domain_seams::portable;

    const FROZEN: i64 = 1_700_000_000_000;

    #[test]
    fn payload_summaries_and_compaction_match_nodes() {
        // `compact_value` keeps the first 12 keys in insertion order: the compared text holds the key order.
        for case in golden()["hooks"]["payloads"].as_array().unwrap() {
            let payload = &case["payload"];
            assert_eq!(summarize_payload(payload), case["summary"].as_str().unwrap(), "{payload}");
            assert_eq!(compact_value(payload).to_string(), case["compact"].to_string(), "{payload}");
        }
    }

    #[test]
    fn rule_summaries_match_nodes() {
        for case in golden()["hooks"]["rules"].as_array().unwrap() {
            let index = case["index"].as_u64().unwrap() as usize;
            assert_eq!(summarize_rule(&case["rule"], index), case["summary"], "{}", case["rule"]);
        }
    }

    /// Records the raw `hook:error` payloads of the configuration read and passes everything on.
    struct Tee {
        log: Arc<HookEventLog>,
        errors: Mutex<Vec<Value>>,
    }

    impl HookObserver for Tee {
        fn emit(&self, event: &str, payload: Value) {
            self.errors.lock().unwrap().push(json!({ "name": event, "payload": payload.clone() }));
            self.log.emit(event, payload);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_status_of_each_scenario_matches_nodes() {
        for scenario in golden()["hooks"]["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path();
            std::fs::create_dir_all(base.join("project")).unwrap();
            std::fs::create_dir_all(base.join("data")).unwrap();
            for (rel, text) in scenario["files"].as_object().unwrap() {
                let path = base.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text.as_str().unwrap()).unwrap();
            }
            let log = HookEventLog::new(base.join("project"));
            for event in scenario["events"].as_array().unwrap() {
                log.emit_at(event[0].as_str().unwrap(), &event[1], FROZEN);
            }
            let tee = Arc::new(Tee { log: log.clone(), errors: Mutex::new(Vec::new()) });
            let status = HookStatus::new(base.join("data"), mixdog_rt::testing::tokens().maintenance_io, log, tee.clone()).status().await;
            let mut status = portable(&status, base);
            let recent = status["recent"].as_array().unwrap().clone();
            let names: Vec<&str> = recent.iter().map(|entry| entry["name"].as_str().unwrap()).collect();
            assert_eq!(names, scenario["recentNames"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect::<Vec<_>>(), "{name}");
            let counts: Vec<&String> = status["counts"].as_object().unwrap().keys().collect();
            assert_eq!(counts, scenario["countOrder"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect::<Vec<_>>(), "{name}");
            status["recent"] = Value::Array(recent.into_iter().filter(|entry| entry["name"] != "hook:error").collect());
            assert_eq!(status, scenario["status"], "{name}");
            assert_eq!(portable(&Value::Array(tee.errors.lock().unwrap().clone()), base), scenario["loaderEmits"], "{name}");
        }
    }
}
