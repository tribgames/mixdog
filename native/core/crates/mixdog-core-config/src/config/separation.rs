//! The defaults-separation pass Node runs when it boots (`ensureDefaultsSeparated`,
//! `shared/defaults-separation.mjs`, with `separateStoredAgent` of `orchestrator/config.mjs`):
//! `mixdog-config.json` holds only what the user changed. A file that has not seen the current
//! `DEFAULTS_VERSION` is backed up, has the values equal to a default (current or historical)
//! removed and its full roster of switched-off agents turned into a delta, and takes the marker.
//! A missing or empty file is born current: its first write stamps the marker (`Shared::update_on`).
//! After this pass every file is in one form, the stored one; there is no unmarked form to read.

use std::path::Path;

use mixdog_js::js_trim;
use mixdog_js::to_number;
use mixdog_js::to_number_of;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Applied;
use super::Config;
use super::ConfigError;
use super::Shared;
use super::agent_routes::separate_roster;
use super::patch::js_deep_equal;
use super::patch::strip_agent_section_defaults;
use super::patch::without_defaults;
use crate::tool_modules::with_grandfathered_builtins;
use crate::workflow::ids::legacy_workflow_mode;
use crate::workflow::ids::truthy;
use crate::workflow::presets::default_maintenance;
use crate::workflow::presets::default_presets;
use crate::workflow::presets::normalize_preset;
use crate::workflow::presets::redundant_generated;

type Doc = Map<String, Value>;

pub(super) const DEFAULTS_VERSION_KEY: &str = "defaultsVersion";
/// `DEFAULTS_VERSION` (`runtime/shared/config.mjs`).
pub(super) const DEFAULTS_VERSION: f64 = 2.0;
/// `DEFAULT_OUTPUT_STYLE`.
const DEFAULT_OUTPUT_STYLE: &str = "simple";
/// `RETIRED_AGENT_IDS`: built-in agents that no longer ship.
const RETIRED_AGENT_IDS: [&str; 5] = ["debugger", "explore", "scheduler-task", "webhook-handler", "web-researcher"];
/// `RETIRED_COMPACTION_FIELDS` (`config-storage.mjs`).
const RETIRED_COMPACTION_FIELDS: [&str; 16] = [
    "type",
    "compactType",
    "compact_type",
    "semantic",
    "semanticModel",
    "prune",
    "tailTurns",
    "recallMemoryTimeoutMs",
    "recallIngestLimit",
    "recallChunkLimit",
    "recallLimit",
    "recallCycle1BatchSize",
    "recallRowsPerSession",
    "recallWindowSize",
    "recallConcurrency",
    "recallCycle1DeadlineMs",
];

/// `Number(root.defaultsVersion) || 0`.
pub(super) fn version_of(root: &Doc) -> f64 {
    let version = to_number_of(root.get(DEFAULTS_VERSION_KEY));
    if version.is_nan() { 0.0 } else { version }
}

/// `needsSeparation(root)`: not empty, and no marker at the current version.
pub(super) fn needs_separation(root: &Doc) -> bool {
    !root.is_empty() && version_of(root) < DEFAULTS_VERSION
}

// ---- the pass -------------------------------------------------------------------------------

/// `stripChannelsDefaults` then `withoutDefaults(…, {})`: the channels section without a default
/// webhook; `None` when nothing is left.
fn stripped_channels(channels: &Doc) -> Option<Value> {
    let mut next = channels.clone();
    if let Some(webhook) = next.get("webhook").cloned() {
        match without_defaults(&webhook, &json!({ "enabled": false, "port": 3333 })) {
            Some(kept) => {
                next.insert("webhook".into(), kept);
            }
            None => {
                next.shift_remove("webhook");
            }
        }
    }
    without_defaults(&Value::Object(next), &json!({}))
}

/// `separateAgentSection`.
fn separate_agent_section(agent: &Doc) -> Doc {
    let mut next = agent.clone();
    // The live config no longer infers a mode from the workflow, so an old explicit non-Solo workflow stays an explicit mode.
    if !next.contains_key("orchestrationMode") && legacy_workflow_mode(next.get("workflow").and_then(|workflow| workflow.get("active"))) == "swarm" {
        next.insert("orchestrationMode".into(), json!("swarm"));
    }
    if next.get("orchestrationMode").and_then(Value::as_str) == Some("none") {
        next.shift_remove("orchestrationMode");
    }
    separate_roster(&mut next);
    let mut stripped = next;
    strip_agent_section_defaults(&mut stripped);
    // A legacy profile without a `builtins` section is grandfathered as having Git/Memory/Office installed; stripping may leave `{}`, which reads as a fresh profile.
    if !agent.get("builtins").is_some_and(Value::is_object) {
        let grandfathered = with_grandfathered_builtins(agent).get("builtins").cloned().unwrap_or(Value::Null);
        let has_keys = match &grandfathered {
            Value::Object(map) => !map.is_empty(),
            Value::Array(list) => !list.is_empty(),
            _ => false,
        };
        if has_keys {
            stripped.insert("builtins".into(), grandfathered);
        }
    }
    stripped
}

/// `removeLegacyKeys` (version 2): keys no current code reads, left behind by retired features. A
/// stored route of a retired built-in agent is dead unless the user keeps an own definition under that id.
fn remove_legacy_keys(root: &Doc, data_dir: &Path) -> Doc {
    let mut next = root.clone();
    let Some(Value::Object(agent)) = next.get("agent") else { return next };
    let mut agent = agent.clone();
    if let Some(Value::Object(builtins)) = agent.get("builtins") {
        let cleaned: Doc = builtins
            .iter()
            .map(|(id, entry)| match entry {
                Value::Object(entry) => {
                    let mut entry = entry.clone();
                    entry.shift_remove("firstUseApproval");
                    (id.clone(), Value::Object(entry))
                }
                other => (id.clone(), other.clone()),
            })
            .collect();
        agent.insert("builtins".into(), Value::Object(cleaned));
    }
    if let Some(Value::Object(routes)) = agent.get("agents") {
        let mut kept = routes.clone();
        for id in RETIRED_AGENT_IDS {
            if kept.contains_key(id) && crate::workflow::pack::definition_from_dir(&data_dir.join("agents").join(id), "AGENT.md", "").is_none() {
                kept.shift_remove(id);
            }
        }
        agent.insert("agents".into(), Value::Object(kept));
    }
    next.insert("agent".into(), Value::Object(agent));
    next
}

/// `configObject`: a copy of a plain object, `{}` for anything else.
fn config_object(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `nonEmptyConfigObject`.
fn non_empty(value: Doc) -> Option<Value> {
    (!value.is_empty()).then_some(Value::Object(value))
}

/// `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `canonicalizeAutoClearStorage`.
fn canonical_auto_clear(value: Option<&Value>) -> Option<Value> {
    let raw = config_object(value);
    let mut next = raw.clone();
    let idle = ["idleMs", "thresholdMs", "idleMillis"].iter().find_map(|key| raw.get(*key).filter(|v| !v.is_null()));
    let idle_ms = to_number_of(idle);
    let source = ["providerIdleMs", "providerDefaults", "providers"].iter().find_map(|key| raw.get(*key).filter(|v| !v.is_null()));
    let mut provider_idle = Doc::new();
    for (key, candidate) in config_object(source) {
        let provider = js_trim(&key).to_lowercase();
        let text = candidate.as_str().map(|text| js_trim(text).to_lowercase());
        let duration = match text.as_deref() {
            Some("unlimited" | "never") => 0.0,
            Some("") => f64::NAN,
            _ => to_number(&candidate),
        };
        if provider.is_empty() || candidate.is_null() || candidate.is_boolean() || !duration.is_finite() || duration < 0.0 {
            continue;
        }
        let stored = if duration == 0.0 { 0.0 } else { js_round(duration).max(60_000.0) };
        provider_idle.insert(provider, mixdog_js::json_number(stored));
    }
    for key in ["thresholdMs", "idleMillis", "providerDefaults", "providers", "custom"] {
        next.shift_remove(key);
    }
    if idle_ms.is_finite() && idle_ms > 0.0 {
        next.insert("idleMs".into(), mixdog_js::json_number(js_round(idle_ms).max(60_000.0)));
    } else {
        next.shift_remove("idleMs");
    }
    if provider_idle.is_empty() {
        next.shift_remove("providerIdleMs");
    } else {
        next.insert("providerIdleMs".into(), Value::Object(provider_idle));
    }
    if let Some(enabled) = raw.get("enabled") {
        next.insert("enabled".into(), Value::Bool(enabled != &Value::Bool(false)));
    }
    if let Some(percent) = raw.get("minContextPercent") {
        let percent = to_number(percent);
        if percent.is_finite() {
            next.insert("minContextPercent".into(), mixdog_js::json_number(js_round(percent).clamp(0.0, 100.0)));
        } else {
            next.shift_remove("minContextPercent");
        }
    }
    non_empty(next)
}

/// `canonicalizeCompactionStorage`.
fn canonical_compaction(value: Option<&Value>) -> Option<Value> {
    let raw = config_object(value);
    let mut next = raw.clone();
    if !truthy(next.get("summaryModel")) && truthy(raw.get("semanticModel")) {
        next.insert("summaryModel".into(), raw["semanticModel"].clone());
    }
    if !truthy(next.get("memoryTimeoutMs")) && truthy(raw.get("recallMemoryTimeoutMs")) {
        next.insert("memoryTimeoutMs".into(), raw["recallMemoryTimeoutMs"].clone());
    }
    if raw.contains_key("auto") || raw.contains_key("enabled") {
        let on = raw.get("auto") != Some(&Value::Bool(false)) && raw.get("enabled") != Some(&Value::Bool(false));
        next.insert("auto".into(), Value::Bool(on));
    }
    for key in RETIRED_COMPACTION_FIELDS {
        next.shift_remove(key);
    }
    next.shift_remove("enabled");
    non_empty(next)
}

/// `canonicalizeModulesStorage`.
fn canonical_modules(value: Option<&Value>) -> Option<Value> {
    let mut modules = config_object(value);
    modules.shift_remove("memory");
    if let Some(raw) = modules.get("webSearch").cloned() {
        let mut stored = config_object(Some(&raw));
        let enabled = match &raw {
            Value::Object(map) => map.get("enabled") != Some(&Value::Bool(false)),
            other => other != &Value::Bool(false),
        };
        stored.insert("enabled".into(), Value::Bool(enabled));
        modules.insert("webSearch".into(), Value::Object(stored));
    }
    non_empty(modules)
}

/// `canonicalizeShellStorage`.
fn canonical_shell(value: Option<&Value>) -> Option<Value> {
    let raw = config_object(value);
    let mut next = raw.clone();
    let command = ["command", "path", "executable", "shell"].iter().find_map(|key| raw.get(*key).filter(|v| !v.is_null())).map(|v| js_trim(&mixdog_js::value_to_string(v)).to_owned()).unwrap_or_default();
    for key in ["path", "executable", "shell"] {
        next.shift_remove(key);
    }
    if command.is_empty() {
        next.shift_remove("command");
    } else {
        next.insert("command".into(), Value::String(command));
    }
    non_empty(next)
}

/// The sections of `canonicalizeAgentStorage` that `separateStoredAgent` also reads: `autoClear`,
/// `compaction`, `shell` and `modules`, each kept only when it still carries something.
pub(super) fn canonicalize_sections(next: &mut Doc) {
    for (key, canonical) in [
        ("autoClear", canonical_auto_clear(next.get("autoClear"))),
        ("compaction", canonical_compaction(next.get("compaction"))),
        ("shell", canonical_shell(next.get("shell"))),
        ("modules", canonical_modules(next.get("modules"))),
    ] {
        match canonical {
            Some(value) => {
                next.insert(key.into(), value);
            }
            None => {
                next.shift_remove(key);
            }
        }
    }
}

/// `presetKey`: a stored preset's id, else its name.
fn preset_key(preset: &Value) -> String {
    ["id", "name"].iter().find_map(|key| preset.get(*key).filter(|v| truthy(Some(*v))).and_then(Value::as_str)).unwrap_or_default().to_owned()
}

/// `resolveNumericDefault`: a numeric `default` is a preset index; store the preset id it points at
/// (an index into the effective list).
pub(super) fn resolve_numeric_default(agent: &Doc) -> Doc {
    let value = agent.get("default");
    let index = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) => text.parse::<f64>().ok(),
        _ => None,
    };
    let Some(index) = index.filter(|index| truthy(value) && index.fract() == 0.0 && *index >= 0.0) else { return agent.clone() };
    let mut presets: Vec<Value> = agent
        .get("presets")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(normalize_preset).filter(|preset| preset.get("id").and_then(Value::as_str) != Some("workflow-search")).collect())
        .unwrap_or_default();
    let present: Vec<String> = presets.iter().map(preset_key).collect();
    presets.extend(default_presets().into_iter().filter(|shipped| !present.contains(&preset_key(shipped))));
    presets.retain(|preset| !redundant_generated(preset, ""));
    let mut next = agent.clone();
    if let Some(id) = presets.get(index as usize).and_then(|preset| preset.get("id")) {
        next.insert("default".into(), id.clone());
    }
    next
}

/// `stripStoredRouteDefaults`: the shipped presets and maintenance routes that equal their default
/// are not stored; the loader restores them.
pub(super) fn strip_stored_route_defaults(agent: &Doc) -> Doc {
    let mut next = agent.clone();
    if next.contains_key("presets") {
        let shipped = default_presets();
        let delta: Vec<Value> = next
            .get("presets")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|preset| {
                        let key = preset_key(preset);
                        match shipped.iter().find(|shipped| shipped.get("id").and_then(Value::as_str) == Some(key.as_str())) {
                            Some(shipped) => !normalize_preset(preset).is_some_and(|stored| js_deep_equal(&stored, shipped)),
                            None => true,
                        }
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if delta.is_empty() {
            next.shift_remove("presets");
        } else {
            next.insert("presets".into(), Value::Array(delta));
        }
    }
    if next.contains_key("maintenance") {
        let defaults = default_maintenance();
        let delta: Doc =
            config_object(next.get("maintenance")).into_iter().filter(|(slot, route)| !defaults.get(slot).is_some_and(|default| js_deep_equal(route, default))).collect();
        if delta.is_empty() {
            next.shift_remove("maintenance");
        } else {
            next.insert("maintenance".into(), Value::Object(delta));
        }
    }
    next
}

/// `separateStoredAgent`: the three sections the storage canonicalizer reshapes, then the numeric
/// default, the section defaults and the route defaults.
fn separate_stored_agent(agent: &Doc) -> Doc {
    let mut next = agent.clone();
    for (key, canonical) in [
        ("autoClear", canonical_auto_clear(agent.get("autoClear"))),
        ("compaction", canonical_compaction(agent.get("compaction"))),
        ("modules", canonical_modules(agent.get("modules"))),
    ] {
        if agent.contains_key(key) {
            match canonical {
                Some(value) => {
                    next.insert(key.into(), value);
                }
                None => {
                    next.shift_remove(key);
                }
            }
        }
    }
    let mut resolved = resolve_numeric_default(&next);
    strip_agent_section_defaults(&mut resolved);
    strip_stored_route_defaults(&resolved)
}

/// `separateDefaultsInConfig`: the config root with default-equal values removed, running only the
/// steps newer than the stored marker. Does not set the marker.
pub(super) fn separate_defaults_in_config(root: &Doc, data_dir: &Path) -> Doc {
    let from = version_of(root);
    let mut next = root.clone();
    if from < 1.0 {
        if let Some(Value::Object(agent)) = next.get("agent") {
            let separated = separate_agent_section(agent);
            next.insert("agent".into(), Value::Object(separated));
        }
        if next.get("outputStyle").and_then(Value::as_str).is_some_and(|style| js_trim(style) == DEFAULT_OUTPUT_STYLE) {
            next.shift_remove("outputStyle");
        }
        if let Some(Value::Object(channels)) = next.get("channels") {
            match stripped_channels(channels) {
                Some(kept) => {
                    next.insert("channels".into(), kept);
                }
                None => {
                    next.shift_remove("channels");
                }
            }
        }
    }
    if from < 2.0 {
        next = remove_legacy_keys(&next, data_dir);
        if let Some(Value::Object(agent)) = next.get("agent") {
            let mut stripped = agent.clone();
            strip_agent_section_defaults(&mut stripped);
            let separated = separate_stored_agent(&stripped);
            next.insert("agent".into(), Value::Object(separated));
        }
    }
    next
}

// ---- the file -------------------------------------------------------------------------------

/// `statSync(path).mode & 0o777`.
#[cfg(unix)]
pub(crate) fn source_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o777
}

/// Where a file has no Unix mode, the new-file default of the publisher.
#[cfg(not(unix))]
pub(crate) fn source_mode(_: &std::fs::Metadata) -> u32 {
    mixdog_statefile::Opts::default().mode
}

/// `backupConfigBeforeDefaultsSeparation`: the file as it is now, copied to
/// `<data>/backups/defaults-separation-<timestamp>[-n]/mixdog-config.json`, in a folder claimed
/// for it alone. Nothing when there is no file.
fn backup(lane: &InLane<DurabilityIo>, source: &Path, data_dir: &Path, now_ms: i64) -> Result<(), ConfigError> {
    let Some(bytes) = mixdog_statefile::read_content(source)? else { return Ok(()) };
    let dir = claim_backup_dir(lane, data_dir, now_ms)?;
    // `writeFileAtomicSync(target, bytes, { mode: statSync(source).mode & 0o777 })`: the copy keeps the file's own mode.
    let opts = mixdog_statefile::Opts { mode: source_mode(&mixdog_statefile::metadata(lane, source)?), ..mixdog_statefile::Opts::default() };
    let written = mixdog_statefile::write_file_stepped(lane, &dir.join("mixdog-config.json"), &bytes, &opts);
    written.map(|_| ()).map_err(ConfigError::Publish)
}

/// A fresh `<data>/backups/defaults-separation-<timestamp>[-n]` folder: the one both separation passes (this one and the
/// `desktop` section's, `desktop_separation.rs`) put their copy of the config in.
pub(super) fn claim_backup_dir(lane: &InLane<DurabilityIo>, data_dir: &Path, now_ms: i64) -> Result<std::path::PathBuf, ConfigError> {
    let parent = data_dir.join("backups");
    mixdog_statefile::create_dir_all(lane, &parent)
        .map_err(|error| ConfigError::Publish(mixdog_statefile::PublishFailure { step: mixdog_statefile::Step::Mkdir(parent.clone()), error }))?;
    let stamp = chrono::DateTime::from_timestamp_millis(now_ms).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
    let stem = format!("defaults-separation-{}", stamp.replace([':', '.'], "-"));
    claim_dir(lane, &parent, &stem)
}

/// The folder named `stem`, or `stem-1`, `stem-2`, ... when that name is taken: each name is tried by creating
/// the folder alone, and a name that exists already (`EEXIST`) moves on to the next, so two claims never get the
/// same folder and an existing backup is never written into (`for (let n = 0; ; n += 1) { try { mkdirSync(dir) }
/// catch (err) { if (err.code === 'EEXIST') continue; throw err } ... }`).
fn claim_dir(lane: &InLane<DurabilityIo>, parent: &Path, stem: &str) -> Result<std::path::PathBuf, ConfigError> {
    let mut n = 0_u32;
    loop {
        let dir = parent.join(if n == 0 { stem.to_owned() } else { format!("{stem}-{n}") });
        match mixdog_statefile::create_dir(lane, &dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(error) => return Err(ConfigError::Publish(mixdog_statefile::PublishFailure { step: mixdog_statefile::Step::Mkdir(dir), error })),
        }
    }
}

impl Shared {
    /// `ensureDefaultsSeparated` and then the canonical storage of the agent section, as `loadConfig` runs
    /// them, under the config transaction. A file that needs the separation is backed up when the pass
    /// changes anything, rewritten, and takes the marker; a stored section that is not canonical is
    /// rewritten once (`storage.rs`).
    pub(super) fn separate_on(&self, lane: &InLane<DurabilityIo>, now_ms: i64) -> Result<Applied, ConfigError> {
        let mut raised = super::lock(&self.writer);
        let current = self.doc.load_full();
        let data_dir = self.path.parent().unwrap_or_else(|| Path::new(""));
        // Node's pass is `updateConfig`: it starts from what `readAllForRmW` settles on.
        let written = self.guard.locked(lane, |baseline| {
            let base = baseline.doc;
            let separating = needs_separation(&base);
            let mut next = if separating { separate_defaults_in_config(&base, data_dir) } else { base.clone() };
            if separating {
                if !js_deep_equal(&Value::Object(next.clone()), &Value::Object(base.clone())) {
                    backup(lane, &self.path, data_dir, now_ms)?;
                }
                next.insert(DEFAULTS_VERSION_KEY.into(), Value::from(2));
            }
            if let Some(Value::Object(agent)) = next.get("agent") {
                let catalog = super::storage::saved_catalog(data_dir).unwrap_or_default();
                if let Some(canonical) = super::storage::migrated_agent(agent, &catalog, now_ms) {
                    next.insert("agent".into(), Value::Object(canonical));
                }
            }
            let next = super::canonical::canonicalize(next);
            if next == *current && !baseline.forced {
                return Ok(None);
            }
            self.guard.write(lane, &next, "post-config-write")?;
            Ok(Some(next))
        })?;
        match written {
            Some(next) if next != *current => Ok(self.install(&mut raised, &current, next)),
            _ => Ok(Applied::default()),
        }
    }
}

#[cfg(test)]
pub(in crate::config) mod tests;

impl Config {
    /// `ensureDefaultsSeparated()`, as Node's boot runs it before any session reads the config.
    /// `now_ms` names the backup folder.
    pub async fn separate_defaults(&self, now_ms: i64) -> Result<(), ConfigError> {
        let shared = self.shared.clone();
        super::on_lane(self.lanes.write, move |lane| shared.separate_on(lane, now_ms)).await??;
        Ok(())
    }
}
