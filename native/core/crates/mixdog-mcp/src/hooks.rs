//! The hooks catalog: which `hooks.json` files apply, how a standard hooks document parses into
//! event groups, and which groups fire for an event. Running handlers belongs to the tool and
//! session pipelines; this module only answers "what is configured".
//!
//! Project hook files run executable handlers only for projects the user trusts; for any other
//! project the files still load (context and prompt hooks work) and every handler is marked
//! untrusted.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;

use crate::plugins::RegisteredPlugin;

pub const DEFAULT_EVENTS: [&str; 16] = [
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

/// Events whose groups carry no `matcher`.
pub const NO_MATCHER_EVENTS: [&str; 10] = [
    "UserPromptSubmit",
    "PostToolBatch",
    "Stop",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "WorktreeCreate",
    "WorktreeRemove",
    "CwdChanged",
    "MessageDisplay",
];

pub const SUPPORTED_HANDLER_TYPES: [&str; 4] = ["command", "http", "mcp_tool", "prompt"];

/// The payload field a group's `matcher` is tested against; any other matchable event matches
/// on the tool name.
fn match_field_name(event: &str) -> &'static str {
    match event {
        "SessionStart" => "source",
        "Setup" => "trigger",
        "SessionEnd" => "reason",
        "SubagentStart" | "SubagentStop" => "agent_type",
        "PreCompact" | "PostCompact" => "trigger",
        "ConfigChange" => "source",
        "InstructionsLoaded" => "load_reason",
        "UserPromptExpansion" => "command_name",
        "StopFailure" => "error_type",
        _ => "tool_name",
    }
}

/// The value a group's matcher is tested against, or `None` for events without matchers.
pub fn match_field<'a>(event: &str, payload: &'a Value) -> Option<&'a str> {
    if NO_MATCHER_EVENTS.contains(&event) {
        return None;
    }
    let field = if event == "Notification" {
        payload.get("notification_type").or_else(|| payload.get("type"))
    } else {
        payload.get(match_field_name(event))
    };
    Some(field.and_then(Value::as_str).unwrap_or_default())
}

/// `sessionStartSource(reason)` (`session-start-hook.mjs`): the `SessionStart` payload's `source`
/// for the reason a session was created.
pub fn session_start_source(reason: &str) -> &'static str {
    let reason = reason.to_ascii_lowercase();
    if reason.contains("resume") {
        "resume"
    } else if reason.contains("clear") {
        "clear"
    } else {
        "startup"
    }
}

/// `sessionEndReason(reason)` (`teardown/session-close.mjs`): the `SessionEnd` payload's `reason`
/// for the reason a runtime closed (`clear` / `exit` where they apply, else `other`).
pub fn session_end_reason(reason: &str) -> &'static str {
    let reason = reason.to_lowercase();
    if reason.contains("clear") {
        "clear"
    } else if ["exit", "quit", "shutdown", "sigint", "sigterm"].iter().any(|word| reason.contains(word)) {
        "exit"
    } else {
        "other"
    }
}

/// `stopFailureType(message)` (`turn-settle.mjs`): the `StopFailure` payload's `error_type`, read
/// from the failure's message (lower-cased here, as its caller does).
pub fn stop_failure_type(message: &str) -> &'static str {
    use std::sync::LazyLock;

    use regex::Regex;
    // JavaScript's `\b` and `\d` are ASCII.
    static CLASSES: LazyLock<[(Regex, &str); 4]> = LazyLock::new(|| {
        let class = |pattern: &str, name: &'static str| (Regex::new(pattern).expect("a StopFailure class pattern"), name);
        [
            class(r"rate.?limit|(?-u:\b)429(?-u:\b)|too many requests", "rate_limit"),
            class(r"overloaded|(?-u:\b)529(?-u:\b)", "overloaded"),
            class(r"authenticat|unauthorized|(?-u:\b)401(?-u:\b)|invalid.*api.?key", "authentication_failed"),
            class(r"server.?error|(?-u:\b)5[0-9][0-9](?-u:\b)|internal error", "server_error"),
        ]
    });
    let message = message.to_lowercase();
    CLASSES.iter().find(|(pattern, _)| pattern.is_match(&message)).map_or("unknown", |(_, name)| name)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceType {
    Env,
    Project,
    Data,
    Plugin,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct HookConfigEntry {
    pub path: PathBuf,
    pub source_type: SourceType,
    pub untrusted: bool,
    pub plugin_root: Option<PathBuf>,
    pub plugin_data: Option<PathBuf>,
}

fn entry(path: PathBuf, source_type: SourceType) -> HookConfigEntry {
    HookConfigEntry { path, source_type, untrusted: false, plugin_root: None, plugin_data: None }
}

/// Comparison key for a path: Windows paths are case-insensitive.
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

fn clean_hook_id(value: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in js_trim(value).to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// Projects the user approved to run executable handlers from their own `.mixdog/hooks.json`:
/// `trustedProjects` (or `hooks.trustedProjects`) in `config.json` / `settings.json`. A
/// malformed file contributes nothing: the project stays untrusted.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn read_trusted_projects(_lane: &InLane<MaintenanceIo>, data_dir: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    for name in ["config.json", "settings.json"] {
        let Ok(text) = std::fs::read_to_string(data_dir.join(name)) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
        let list = parsed.get("trustedProjects").or_else(|| parsed.pointer("/hooks/trustedProjects"));
        for item in list.and_then(Value::as_array).into_iter().flatten() {
            let raw = js_trim(item.as_str().unwrap_or_default());
            if raw.is_empty() {
                continue;
            }
            if let Ok(absolute) = std::path::absolute(raw) {
                out.insert(path_key(&absolute));
            }
        }
    }
    out
}

/// The hooks files a plugin root is loaded from (`hook-bus/config.mjs`), relative to the root; the
/// plugin status row's `hooks` flag asks for the same files.
pub const PLUGIN_HOOK_FILES: [&str; 2] = ["hooks/hooks.json", ".mixdog/hooks.json"];

pub struct HookSources<'a> {
    /// `MIXDOG_HOOKS_FILE`: when set it is the only source.
    pub env_file: Option<&'a Path>,
    pub data_dir: &'a Path,
    pub project_dir: &'a Path,
    pub trusted_projects: &'a HashSet<String>,
    pub plugins: &'a [RegisteredPlugin],
}

/// The hooks files that apply, in precedence order, without duplicates.
pub fn config_entries(sources: &HookSources<'_>) -> Vec<HookConfigEntry> {
    let mut all: Vec<HookConfigEntry> = Vec::new();
    if let Some(file) = sources.env_file {
        all.push(entry(file.to_path_buf(), SourceType::Env));
    } else {
        let project = std::path::absolute(sources.project_dir).unwrap_or_else(|_| sources.project_dir.to_path_buf());
        let untrusted = !sources.trusted_projects.contains(&path_key(&project));
        for relative in [".mixdog/hooks.json", ".mixdog/hooks/hooks.json"] {
            let mut e = entry(project.join(relative), SourceType::Project);
            e.untrusted = untrusted;
            all.push(e);
        }
        all.push(entry(sources.data_dir.join("hooks.json"), SourceType::Data));
        all.push(entry(sources.data_dir.join("hooks").join("hooks.json"), SourceType::Data));
        for plugin in sources.plugins.iter().filter(|p| p.enabled) {
            let id = clean_hook_id(&plugin.id);
            let data = sources.data_dir.join("plugins").join("data").join(if id.is_empty() { "plugin" } else { &id });
            for relative in PLUGIN_HOOK_FILES {
                let mut e = entry(plugin.root.join(relative), SourceType::Plugin);
                e.plugin_root = Some(plugin.root.clone());
                e.plugin_data = Some(data.clone());
                all.push(e);
            }
        }
    }
    let mut seen = HashSet::new();
    all.into_iter()
        .filter_map(|mut e| {
            e.path = std::path::absolute(&e.path).ok()?;
            seen.insert(path_key(&e.path)).then_some(e)
        })
        .collect()
}

/// A hooks document that has at least one well-formed event stays standard; malformed event
/// keys are reported so the caller can surface them instead of dropping them in silence.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ConfigReport {
    pub standard: bool,
    pub valid_events: Vec<String>,
    pub invalid_events: Vec<String>,
}

pub fn config_report(parsed: &Value) -> ConfigReport {
    let Some(hooks) = parsed.get("hooks").and_then(Value::as_object).filter(|h| !h.is_empty()) else {
        return ConfigReport::default();
    };
    let mut report = ConfigReport::default();
    for (event, groups) in hooks {
        let well_formed = groups
            .as_array()
            .is_some_and(|g| g.iter().all(|group| group.get("hooks").is_some_and(Value::is_array)));
        if well_formed {
            report.valid_events.push(event.clone());
        } else {
            report.invalid_events.push(event.clone());
        }
    }
    report.standard = !report.valid_events.is_empty();
    report
}

/// A group's `matcher`. A simple matcher is a `|`/`,` separated list of exact names; anything
/// else is a regular expression.
#[derive(Clone)]
pub enum Matcher {
    Any,
    Names(Vec<String>),
    Pattern(Arc<JsRegex>),
    /// Not a valid regular expression: the group fires for every value, as it always has, and
    /// the problem is reported by [`HookGroup::matcher_problem`].
    Invalid,
}

impl std::fmt::Debug for Matcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Any => f.write_str("Any"),
            Self::Names(names) => f.debug_tuple("Names").field(names).finish(),
            Self::Pattern(_) => f.write_str("Pattern(..)"),
            Self::Invalid => f.write_str("Invalid"),
        }
    }
}

impl Matcher {
    pub fn parse(matcher: Option<&str>) -> Self {
        let Some(text) = matcher.map(js_trim).filter(|t| !t.is_empty() && *t != "*") else {
            return Self::Any;
        };
        if text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | ',' | '|')) {
            let names: Vec<String> =
                text.split(['|', ',']).map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
            return if names.is_empty() { Self::Any } else { Self::Names(names) };
        }
        JsRegex::new(text, "").map_or(Self::Invalid, |re| Self::Pattern(Arc::new(re)))
    }

    pub fn fires(&self, field: &str) -> bool {
        match self {
            Self::Any | Self::Invalid => true,
            Self::Names(names) => names.iter().any(|n| n == field),
            Self::Pattern(re) => re.is_match(field),
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct HookHandler {
    /// The handler object as written (`type`, `command`, `timeout`, …).
    pub raw: Value,
    pub source: PathBuf,
    pub plugin_root: Option<PathBuf>,
    pub plugin_data: Option<PathBuf>,
    /// From an untrusted project: executable types must not run.
    pub untrusted: bool,
}

#[derive(Clone, Debug)]
pub struct HookGroup {
    pub matcher_text: Option<String>,
    pub matcher: Matcher,
    pub handlers: Vec<HookHandler>,
}

impl HookGroup {
    pub fn matcher_problem(&self) -> bool {
        matches!(self.matcher, Matcher::Invalid)
    }
}

pub type HookEvents = BTreeMap<String, Vec<HookGroup>>;

/// Parses a standard hooks document. Groups without any typed handler are dropped.
pub fn parse_standard(parsed: &Value, source: &Path, origin: &HookConfigEntry) -> HookEvents {
    let mut events = HookEvents::new();
    let Some(hooks) = parsed.get("hooks").and_then(Value::as_object) else { return events };
    for (event, groups) in hooks {
        let Some(groups) = groups.as_array() else { continue };
        let mut kept = Vec::new();
        for group in groups.iter().filter(|g| g.is_object()) {
            let handlers: Vec<HookHandler> = group
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|h| h.is_object() && h.get("type").is_some_and(|t| !t.is_null()))
                .map(|h| HookHandler {
                    raw: h.clone(),
                    source: source.to_path_buf(),
                    plugin_root: origin.plugin_root.clone(),
                    plugin_data: origin.plugin_data.clone(),
                    untrusted: origin.untrusted,
                })
                .collect();
            if handlers.is_empty() {
                continue;
            }
            let text = group.get("matcher").and_then(Value::as_str);
            kept.push(HookGroup { matcher_text: text.map(str::to_owned), matcher: Matcher::parse(text), handlers });
        }
        if !kept.is_empty() {
            events.insert(event.clone(), kept);
        }
    }
    events
}

/// Appends `source`'s groups to `target`, event by event.
pub fn merge_events(target: &mut HookEvents, source: HookEvents) {
    for (event, groups) in source {
        target.entry(event).or_default().extend(groups);
    }
}

/// Reads every applicable hooks file and merges the standard ones. Files that are missing or
/// not standard are skipped; the report of each readable file is returned beside the events.
#[allow(clippy::disallowed_methods, reason = "runs as a maintenance-lane job (InLane proof)")]
pub fn load_catalog(
    _lane: &InLane<MaintenanceIo>,
    entries: &[HookConfigEntry],
) -> (HookEvents, Vec<(PathBuf, ConfigReport)>) {
    let mut events = HookEvents::new();
    let mut reports = Vec::new();
    for entry in entries {
        let Ok(text) = std::fs::read_to_string(&entry.path) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
        let report = config_report(&parsed);
        if report.standard {
            merge_events(&mut events, parse_standard(&parsed, &entry.path, entry));
        }
        reports.push((entry.path.clone(), report));
    }
    (events, reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matcher_forms() {
        assert!(Matcher::parse(None).fires("x"));
        assert!(Matcher::parse(Some("*")).fires("x"));
        let names = Matcher::parse(Some("read, edit | shell"));
        assert!(names.fires("edit") && !names.fires("grep"));
        let re = Matcher::parse(Some("^mcp__.*"));
        assert!(re.fires("mcp__a__b") && !re.fires("read"));
        assert!(matches!(Matcher::parse(Some("(")), Matcher::Invalid));
    }

    #[test]
    fn report_names_malformed_events_without_demoting_the_file() {
        let report = config_report(&json!({"hooks": {"PreToolUse": [{"hooks": []}], "Stop": "bad"}}));
        assert!(report.standard);
        assert_eq!(report.valid_events, vec!["PreToolUse"]);
        assert_eq!(report.invalid_events, vec!["Stop"]);
        assert!(!config_report(&json!({"hooks": {}})).standard);
    }

    #[test]
    fn project_files_are_untrusted_unless_listed_and_env_overrides_everything() {
        let data = PathBuf::from("/data");
        let project = std::path::absolute("/proj").unwrap();
        let mut trusted = HashSet::new();
        let none = config_entries(&HookSources {
            env_file: None,
            data_dir: &data,
            project_dir: &project,
            trusted_projects: &trusted,
            plugins: &[],
        });
        assert!(none.iter().filter(|e| e.source_type == SourceType::Project).all(|e| e.untrusted));
        assert_eq!(none.len(), 4);
        trusted.insert(path_key(&project));
        let some = config_entries(&HookSources {
            env_file: None,
            data_dir: &data,
            project_dir: &project,
            trusted_projects: &trusted,
            plugins: &[],
        });
        assert!(some.iter().all(|e| !e.untrusted));
        let env = config_entries(&HookSources {
            env_file: Some(Path::new("/h.json")),
            data_dir: &data,
            project_dir: &project,
            trusted_projects: &trusted,
            plugins: &[],
        });
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn standard_documents_parse_into_tagged_handlers() {
        let origin = HookConfigEntry { untrusted: true, ..entry(PathBuf::from("/p/hooks.json"), SourceType::Project) };
        let doc = json!({"hooks": {"PreToolUse": [
            {"matcher": "shell", "hooks": [{"type": "command", "command": "x"}, {"command": "no type"}]},
            {"hooks": [{"no": "type"}]}
        ]}});
        let events = parse_standard(&doc, &origin.path, &origin);
        let groups = &events["PreToolUse"];
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].handlers.len(), 1);
        assert!(groups[0].handlers[0].untrusted);
        assert_eq!(match_field("PreToolUse", &json!({"tool_name": "shell"})), Some("shell"));
        assert_eq!(match_field("Stop", &json!({})), None);
    }

    /// Node's `sessionStartSource`, `sessionEndReason` and `stopFailureType` over the reasons and
    /// messages the runtime passes them.
    #[test]
    fn lifecycle_payload_fields_are_classified_as_node_classifies_them() {
        for (reason, source) in [("turn", "startup"), ("reservation", "startup"), ("", "startup"), ("desktop-Resume", "resume"), ("cli-clear", "clear")] {
            assert_eq!(session_start_source(reason), source, "{reason}");
        }
        for (reason, end) in [("cli-exit", "exit"), ("daemon shutdown: SIGTERM", "exit"), ("quit", "exit"), ("context-clear", "clear"), ("idle and unwatched", "other"), ("", "other")] {
            assert_eq!(session_end_reason(reason), end, "{reason}");
        }
        for (message, class) in [
            ("Rate limit exceeded", "rate_limit"),
            ("HTTP 429", "rate_limit"),
            ("Too Many Requests", "rate_limit"),
            ("Overloaded", "overloaded"),
            ("status 529 from upstream", "overloaded"),
            ("authentication failed", "authentication_failed"),
            ("401 Unauthorized", "authentication_failed"),
            ("Invalid x-api-key", "authentication_failed"),
            ("Internal Server Error", "server_error"),
            ("upstream said 503", "server_error"),
            ("code 1503 is no status", "unknown"),
            ("prompt blocked by hook: no", "unknown"),
            ("", "unknown"),
        ] {
            assert_eq!(stop_failure_type(message), class, "{message}");
        }
    }
}
