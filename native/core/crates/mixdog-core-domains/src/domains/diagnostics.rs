//! The `diagnostics` domain: `diagnostics/runDoctor`, today's `runDoctor` session action
//! (`src/tui/app/doctor.mjs`): read-only health checks that run side by side, each under one
//! deadline, and report names, counts and flags only. A missing status is a warning, never a
//! healthy default; a failed or stalled check cannot stop the others.
//!
//! What each check reads is behind [`DoctorSources`], one method per status contract of the
//! runtime (`mcpStatus`, `getProviderSetup`, …) answering the same JSON; the verdicts, the
//! sentences and the row order are the Node ones.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::DiagnosticsRunDoctorParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::wrong_method;
use super::update::compare_semver;

const DOMAIN: &str = "diagnostics";
/// Far above the cap of the channel worker's pruning of per-process logs means it is not running.
const LOG_FILE_WARN: usize = 300;
const LISTED_SKIPS: usize = 5;

/// A status reader that failed; the row says so without the error, which can carry URLs or
/// credentials.
#[derive(Clone, Copy, Debug)]
pub struct ProbeFailed;

/// `Ok(None)`: the runtime has no such status (the optional call of the Node check was absent).
pub type Probe = Result<Option<Value>, ProbeFailed>;

/// The status contracts the checks read; each answers what the same-named runtime call of
/// the 1.4.5 daemon answers.
#[async_trait]
pub trait DoctorSources: Send + Sync {
    /// `checkForUpdate({})`: `{currentVersion, latestVersion, updateAvailable, …}`.
    async fn update(&self) -> Probe;
    /// The JS runtime: `{version, engines}` (`process.versions.node`, `package.json` engines).
    async fn node_runtime(&self) -> Probe;
    /// `getProviderSetup()`.
    async fn provider_setup(&self) -> Probe;
    /// The route provider of the session state (`getState().provider`).
    fn active_provider(&self) -> Option<String>;
    /// `mcpStatus()` of the runtime serving the check: the session `thread` names, else the runtime's own.
    async fn mcp_status(&self, thread: Option<&ThreadId>) -> Probe;
    /// `getToolModuleSettings()`.
    async fn tool_module_settings(&self) -> Probe;
    async fn recap_settings(&self) -> Probe;
    async fn voice_status(&self) -> Probe;
    /// `getChannelSettings({includeStatus: true})`.
    async fn channel_settings(&self) -> Probe;
    async fn channel_worker_status(&self) -> Probe;
    async fn channel_setup(&self) -> Probe;
    async fn skills_status(&self) -> Probe;
    async fn plugins_status(&self) -> Probe;
    async fn hooks_status(&self) -> Probe;
    /// The json → log session migration:
    /// `{complete, started, logs, pending, skipped: [{id, reason}]}` or `{unreadable: true}`.
    async fn session_log_migration(&self) -> Probe;
    /// `builtinFeatureActive(undefined, id)` for `browser` and `computer`.
    fn bridge_active(&self, id: &str) -> bool;
    /// The text report as a notice of `thread` (`options.notice`, asked by the TUI only).
    async fn notice(&self, thread: Option<&ThreadId>, text: &str);
}

pub struct DoctorConfig {
    pub data_dir: PathBuf,
    /// The installed package's version, shown where the update check names none.
    pub package_version: Option<String>,
    /// The deadline of one check (8 s).
    pub check_timeout: Duration,
}

impl DoctorConfig {
    pub const CHECK_TIMEOUT: Duration = Duration::from_millis(8000);
}

#[derive(Clone, Copy, PartialEq)]
enum Level {
    Ok,
    Warn,
    Fail,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Fail => "fail",
        }
    }
}

enum Fix {
    Command(String),
    Hint(String),
}

struct Verdict {
    level: Level,
    detail: String,
    fix: Option<Fix>,
}

fn verdict(level: Level, detail: impl Into<String>) -> Option<Verdict> {
    Some(Verdict {
        level,
        detail: detail.into(),
        fix: None,
    })
}

fn with_command(level: Level, detail: impl Into<String>, command: &str) -> Option<Verdict> {
    Some(Verdict {
        level,
        detail: detail.into(),
        fix: Some(Fix::Command(command.into())),
    })
}

fn with_hint(level: Level, detail: impl Into<String>, hint: &str) -> Option<Verdict> {
    Some(Verdict {
        level,
        detail: detail.into(),
        fix: Some(Fix::Hint(hint.into())),
    })
}

fn unavailable() -> Option<Verdict> {
    verdict(Level::Warn, "status unavailable")
}

type Reported = Result<Option<Verdict>, ProbeFailed>;

// --- JavaScript value semantics the reports rely on -------------------------------------

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `${value}`.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_text(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

fn array(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

fn name_of(entry: &Value) -> String {
    let named = entry.get("name").filter(|_| truthy(entry.get("name")));
    js_text(named.or(entry.get("id")))
}

// --- The reports ------------------------------------------------------------------------

fn report_update(package_version: Option<&str>, update: &Value) -> Option<Verdict> {
    let current = if truthy(update.get("currentVersion")) {
        js_text(update.get("currentVersion"))
    } else {
        package_version
            .filter(|v| !v.is_empty())
            .unwrap_or("unknown")
            .to_owned()
    };
    if !truthy(update.get("latestVersion")) {
        return verdict(
            Level::Warn,
            format!("v{current} · update check skipped (registry unreachable)"),
        );
    }
    let latest = js_text(update.get("latestVersion"));
    if truthy(update.get("updateAvailable")) {
        with_command(
            Level::Warn,
            format!("v{current} · update available → v{latest}"),
            "/update",
        )
    } else {
        verdict(Level::Ok, format!("v{current} · up to date"))
    }
}

/// `nodeEngineSupport`: only the stable `^major.minor.patch` and `>=major.minor.patch`
/// alternatives are understood; anything else is unverified, never supported.
fn node_engine_support(version: &str, range: Option<&str>) -> Option<bool> {
    let range = range?;
    let alternative =
        Regex::new(r"^(\^|>=)([1-9][0-9]*\.[0-9]+\.[0-9]+)$").expect("static pattern");
    let alternatives: Option<Vec<(String, String)>> = range
        .split("||")
        .map(|part| {
            let caps = alternative.captures(part.trim_matches(mixdog_core_base::support::is_js_space))?;
            Some((caps[1].to_owned(), caps[2].to_owned()))
        })
        .collect();
    let alternatives = alternatives?;
    if !Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9_.-]+)?$")
        .expect("static pattern")
        .is_match(version)
    {
        return None;
    }
    if version.contains('-') {
        return Some(false);
    }
    Some(alternatives.iter().any(|(operator, minimum)| {
        if compare_semver(version, minimum) == Ordering::Less {
            return false;
        }
        operator == ">=" || version.split('.').next() == minimum.split('.').next()
    }))
}

fn report_node(node: &Value) -> Option<Verdict> {
    let version = js_text(node.get("version"));
    let engines = node.get("engines").and_then(Value::as_str);
    match node_engine_support(&version, engines) {
        None => {
            let requirement = match engines {
                Some(engines) if !engines.is_empty() => format!("\"{engines}\" unverified"),
                _ => "unavailable".into(),
            };
            verdict(
                Level::Warn,
                format!("v{version} · engine requirement {requirement}"),
            )
        }
        Some(true) => verdict(
            Level::Ok,
            format!("v{version} · requires node {}", engines.unwrap_or_default()),
        ),
        Some(false) => {
            let engines = engines.unwrap_or_default();
            with_hint(
                Level::Fail,
                format!("v{version} · requires node {engines}"),
                &format!("install Node.js {engines}"),
            )
        }
    }
}

/// `providerRowUsable`: `usable` is authoritative when present; an API-key row has none, so
/// only a credential counts; a row that needs sign-in again is never usable.
fn provider_usable(row: &Value) -> bool {
    if !truthy(Some(row)) || row.get("reauthRequired") == Some(&Value::Bool(true)) {
        return false;
    }
    match row.get("usable") {
        Some(Value::Null) | None => row.get("authenticated") == Some(&Value::Bool(true)),
        Some(usable) => usable == &Value::Bool(true),
    }
}

fn provider_unusable_reason(entry: &Value) -> String {
    if truthy(entry.get("configError")) {
        return format!(
            "has an invalid configuration ({})",
            js_text(entry.get("configError"))
        );
    }
    if truthy(entry.get("reauthRequired")) {
        return "requires sign-in again".into();
    }
    if entry.get("enabled") == Some(&Value::Bool(false)) {
        return "is disabled".into();
    }
    if entry.get("type").and_then(Value::as_str) == Some("local") && !truthy(entry.get("detected"))
    {
        return "has no installed runtime/model".into();
    }
    if !truthy(entry.get("authenticated")) {
        return "has no auth".into();
    }
    "is not usable".into()
}

fn report_providers(active: &str, setup: &Value) -> Option<Verdict> {
    if setup.get("pendingSecrets") == Some(&Value::Bool(true)) {
        let route = if active.is_empty() { "unknown" } else { active };
        return verdict(
            Level::Warn,
            format!("credentials still loading · route {route} · run /doctor again when ready"),
        );
    }
    let (Some(api), Some(oauth), Some(local)) = (
        array(setup.get("api")),
        array(setup.get("oauth")),
        array(setup.get("local")),
    ) else {
        return unavailable();
    };
    let lists: Vec<&Value> = api.iter().chain(oauth).chain(local).collect();
    let ready = lists.iter().filter(|row| provider_usable(row)).count();
    let entry = (!active.is_empty())
        .then(|| {
            lists
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(active))
        })
        .flatten();
    if let Some(entry) = entry
        && !provider_usable(entry)
    {
        return with_command(
            Level::Fail,
            format!(
                "route {active} {} · {ready} ready",
                provider_unusable_reason(entry)
            ),
            "/providers",
        );
    }
    if !active.is_empty() && entry.is_none() {
        return with_command(
            Level::Warn,
            format!("{ready} ready · route {active} (not listed)"),
            "/providers",
        );
    }
    if !active.is_empty() {
        verdict(Level::Ok, format!("{ready} ready · route {active}"))
    } else {
        with_command(
            Level::Warn,
            format!("{ready} ready · route unknown"),
            "/providers",
        )
    }
}

/// The entries active in this project, and the disabled / out-of-project counts both
/// registries append before their own breakage markers.
fn scoped(entries: &[Value]) -> (Vec<&Value>, String) {
    let enabled = |e: &Value| e.get("enabled") != Some(&Value::Bool(false));
    let here = |e: &Value| e.get("activeHere") != Some(&Value::Bool(false));
    let active: Vec<&Value> = entries.iter().filter(|e| enabled(e) && here(e)).collect();
    let disabled = entries.iter().filter(|e| !enabled(e)).count();
    let outside = entries.iter().filter(|e| enabled(e) && !here(e)).count();
    let mut detail = String::new();
    if disabled > 0 {
        detail.push_str(&format!(" · {disabled} disabled"));
    }
    if outside > 0 {
        detail.push_str(&format!(" · {outside} outside this project"));
    }
    (active, detail)
}

fn report_mcp(status: &Value) -> Option<Verdict> {
    let Some(servers) = array(status.get("servers")) else {
        return unavailable();
    };
    let configured = status
        .get("configuredCount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if servers.is_empty() && configured > 0.0 {
        return unavailable();
    }
    if servers.is_empty() {
        return verdict(Level::Ok, "no servers configured");
    }
    let (active, scope) = scoped(servers);
    let connected = active
        .iter()
        .filter(|s| s.get("connected") == Some(&Value::Bool(true)))
        .count();
    let is_failed = |s: &&Value| {
        truthy(s.get("error")) || s.get("status").and_then(Value::as_str) == Some("failed")
    };
    let failed: Vec<&Value> = active.iter().copied().filter(|s| is_failed(s)).collect();
    let pending: Vec<&Value> = active
        .iter()
        .copied()
        .filter(|s| s.get("connected") != Some(&Value::Bool(true)) && !is_failed(s))
        .collect();
    let mut detail = format!("{connected}/{} connected{scope}", active.len());
    let names = |list: &[&Value]| {
        list.iter()
            .map(|s| js_text(s.get("name")))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if !failed.is_empty() {
        detail.push_str(&format!(" · failed: {}", names(&failed)));
    }
    if !pending.is_empty() {
        detail.push_str(&format!(" · disconnected: {}", names(&pending)));
    }
    if !failed.is_empty() || !pending.is_empty() {
        with_command(Level::Warn, detail, "/mcp")
    } else {
        verdict(Level::Ok, detail)
    }
}

fn is_bool(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(_)))
}

fn report_memory(memory: &Value, recap: Option<&Value>) -> Option<Verdict> {
    if !is_bool(memory.get("installed")) || !is_bool(memory.get("enabled")) {
        return unavailable();
    }
    let (installed, enabled) = (memory["installed"] == true, memory["enabled"] == true);
    if !installed || !enabled {
        return verdict(
            Level::Ok,
            if installed {
                "installed · disabled"
            } else {
                "not installed"
            },
        );
    }
    match recap.and_then(|recap| recap.get("enabled")) {
        Some(Value::Bool(recap)) => verdict(
            Level::Ok,
            format!(
                "installed · enabled · recap {}",
                if *recap { "enabled" } else { "disabled" }
            ),
        ),
        _ => verdict(
            Level::Warn,
            "installed · enabled · recap status unavailable",
        ),
    }
}

/// `hasEnabledAutomation`: an enabled schedule that has not finished, or an enabled webhook.
fn has_enabled_automation(setup: &Value) -> bool {
    let live = |entry: &Value, finished: bool| {
        entry.get("enabled") != Some(&Value::Bool(false))
            && !(finished && entry.get("status").and_then(Value::as_str) == Some("done"))
    };
    array(setup.get("schedules")).is_some_and(|all| all.iter().any(|e| live(e, true)))
        || array(setup.get("webhooks")).is_some_and(|all| all.iter().any(|e| live(e, false)))
}

fn report_channels(worker: Option<&Value>, setup: Option<&Value>) -> Option<Verdict> {
    let Some(running) = worker
        .and_then(|w| w.get("running"))
        .and_then(Value::as_bool)
    else {
        return verdict(Level::Warn, "worker status unavailable");
    };
    if running {
        return verdict(Level::Ok, "worker running");
    }
    // The worker boots only for enabled schedules or webhooks, so without them a stopped
    // worker is idle, not a fault.
    if let Some(setup) = setup.filter(|s| truthy(Some(s)))
        && !has_enabled_automation(setup)
    {
        return verdict(Level::Ok, "idle (no active schedules or webhooks)");
    }
    with_hint(
        Level::Warn,
        if setup.is_some_and(|s| truthy(Some(s))) {
            "worker stopped with active automation"
        } else {
            "worker stopped"
        },
        "enabled schedules and webhooks are not running",
    )
}

fn report_registry(label: &str, status: &Value) -> Option<Verdict> {
    let Some(entries) = array(status.get(label)) else {
        return unavailable();
    };
    let (active, scope) = scoped(entries);
    let broken: Vec<&Value> = active
        .iter()
        .copied()
        .filter(|e| {
            truthy(e.get("broken"))
                || truthy(e.get("error"))
                || truthy(e.get("invalid"))
                || array(e.get("dependencyIssues")).is_some_and(|issues| !issues.is_empty())
        })
        .collect();
    let missing: Vec<&Value> = array(status.get("missing"))
        .map(|all| {
            all.iter()
                .filter(|e| e.get("enabled") != Some(&Value::Bool(false)))
                .collect()
        })
        .unwrap_or_default();
    let detail = format!("{}/{} active{scope}", active.len(), entries.len());
    let issues: Vec<&Value> = broken
        .into_iter()
        .chain(if label == "plugins" {
            missing
        } else {
            Vec::new()
        })
        .collect();
    if issues.is_empty() {
        return verdict(Level::Ok, detail);
    }
    let names: Vec<String> = issues.iter().map(|e| name_of(e)).collect();
    with_command(
        Level::Warn,
        format!("{detail} · issues: {}", names.join(", ")),
        &format!("/{label}"),
    )
}

fn report_local_provider(local: &Value) -> Option<Verdict> {
    if !is_bool(local.get("installed")) {
        return unavailable();
    }
    if local["installed"] != true {
        return verdict(Level::Ok, "not installed");
    }
    if local.get("enabled") != Some(&Value::Bool(true)) {
        return verdict(Level::Ok, "installed · disabled");
    }
    let models = array(local.get("models")).map_or(0, |models| {
        models
            .iter()
            .filter(|m| m.get("installed") == Some(&Value::Bool(true)))
            .count()
    });
    let jobs: &[Value] = array(local.get("installations")).map_or(&[], Vec::as_slice);
    let updated = |job: &Value| job.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0);
    // `reduce((a, b) => (a && a.updatedAt > b.updatedAt ? a : b), null)`: the latest, later on ties.
    let latest = jobs.iter().fold(None::<&Value>, |a, b| match a {
        Some(a) if updated(a) > updated(b) => Some(a),
        _ => Some(b),
    });
    if latest
        .and_then(|job| job.get("state"))
        .and_then(Value::as_str)
        == Some("failed")
    {
        with_command(
            Level::Warn,
            format!("installed · enabled · {models} models · latest installation failed"),
            "/providers",
        )
    } else if models == 0 {
        with_command(
            Level::Warn,
            "installed · enabled · no model installed",
            "/providers",
        )
    } else {
        verdict(
            Level::Ok,
            format!("installed · enabled · {models} models installed"),
        )
    }
}

fn report_builtins(settings: &Value, bridge: &dyn Fn(&str) -> bool) -> Option<Verdict> {
    let mut groups: [(&str, Vec<&str>); 3] = [
        ("enabled", vec![]),
        ("disabled", vec![]),
        ("not installed", vec![]),
    ];
    for id in ["git", "office", "tidy"] {
        let entry = settings.get(id).filter(|e| truthy(Some(e)));
        let Some(installed) = entry
            .and_then(|e| e.get("installed"))
            .and_then(Value::as_bool)
        else {
            return unavailable();
        };
        let group = if !installed {
            2
        } else if entry.and_then(|e| e.get("enabled")) == Some(&Value::Bool(false)) {
            1
        } else {
            0
        };
        groups[group].1.push(id);
    }
    let parts: Vec<String> = groups
        .iter()
        .filter(|(_, ids)| !ids.is_empty())
        .map(|(state, ids)| format!("{state}: {}", ids.join(", ")))
        .collect();
    let bridge_text = |id: &str| {
        if bridge(id) {
            "bridge active"
        } else {
            "no bridge"
        }
    };
    verdict(
        Level::Ok,
        format!(
            "{} · browser use {} · computer use {}",
            parts.join(" · "),
            bridge_text("browser"),
            bridge_text("computer")
        ),
    )
}

fn report_voice(voice: &Value) -> Option<Verdict> {
    let Some(enabled) = voice.get("enabled").and_then(Value::as_bool) else {
        return unavailable();
    };
    if !enabled {
        return verdict(Level::Ok, "disabled");
    }
    let model_missing =
        voice.get("components").and_then(|c| c.get("model")) == Some(&Value::Bool(false));
    if voice.get("installed") != Some(&Value::Bool(true)) || model_missing {
        return with_hint(
            Level::Warn,
            "enabled · runtime or model not installed",
            "reinstall voice from Extensions",
        );
    }
    verdict(Level::Ok, "enabled · runtime and model installed")
}

fn report_hooks(hooks: &Value) -> Option<Verdict> {
    let rules = hooks
        .get("ruleCount")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite());
    let (Some(enabled), Some(events), Some(rules)) = (
        hooks.get("enabled").and_then(Value::as_bool),
        array(hooks.get("configuredEvents")),
        rules,
    ) else {
        return unavailable();
    };
    let errors = array(hooks.get("errors")).map_or(0, Vec::len);
    let mut detail = format!(
        "{} · {rules} rules · {} configured events",
        if enabled { "enabled" } else { "disabled" },
        events.len()
    );
    if errors > 0 {
        detail.push_str(&format!(" · {errors} configuration errors"));
    }
    verdict(if errors > 0 { Level::Warn } else { Level::Ok }, detail)
}

fn report_session_log(status: &Value) -> Option<Verdict> {
    if truthy(status.get("unreadable")) {
        return with_hint(
            Level::Warn,
            "progress file unreadable",
            "remove session-log-migration.json to restart the migration",
        );
    }
    let started = truthy(status.get("started"));
    let logs = status.get("logs").and_then(Value::as_u64).unwrap_or(0);
    let pending = status.get("pending").and_then(Value::as_u64).unwrap_or(0);
    let skipped = array(status.get("skipped")).cloned().unwrap_or_default();
    // A legacy session added after the recorded completion is still pending.
    let complete = truthy(status.get("complete")) && pending == 0;
    let mut parts = Vec::new();
    if complete {
        parts.push(format!(
            "complete · {logs} session {}",
            if logs == 1 { "log" } else { "logs" }
        ));
    } else if !started {
        parts.push(format!("not started · {pending} pending"));
    } else {
        parts.push(format!("in progress · {pending} pending"));
    }
    if !skipped.is_empty() {
        let shown: Vec<String> = skipped
            .iter()
            .take(LISTED_SKIPS)
            .map(|skip| {
                format!(
                    "{} ({})",
                    js_text(skip.get("id")),
                    js_text(skip.get("reason"))
                )
            })
            .collect();
        let more = if skipped.len() > shown.len() {
            format!(" +{} more", skipped.len() - shown.len())
        } else {
            String::new()
        };
        parts.push(format!(
            "{} skipped: {}{more}",
            skipped.len(),
            shown.join(", ")
        ));
    }
    let detail = parts.join(" · ");
    if complete && skipped.is_empty() {
        verdict(Level::Ok, detail)
    } else if !complete && !started && pending == 0 {
        verdict(Level::Ok, "nothing to migrate")
    } else if !complete {
        with_hint(
            Level::Warn,
            detail,
            "pending sessions are migrated at startup",
        )
    } else {
        with_hint(
            Level::Warn,
            detail,
            "skipped sessions stay in the old format and are retried when their file changes",
        )
    }
}

// --- Local installation state -----------------------------------------------------------

#[allow(clippy::disallowed_methods, reason = "body of the interactive-io lane job in `run_check`")]
fn data_folder(dir: &std::path::Path) -> Option<Verdict> {
    let shown = dir.to_string_lossy();
    match std::fs::metadata(dir) {
        Ok(meta) if !meta.permissions().readonly() => {
            verdict(Level::Ok, format!("writable · {shown}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => with_hint(
            Level::Fail,
            format!("not found · {shown}"),
            "create the folder or point MIXDOG_DATA_DIR at an existing one",
        ),
        _ => with_hint(
            Level::Fail,
            format!("not writable · {shown}"),
            "check the folder permissions",
        ),
    }
}

#[allow(clippy::disallowed_methods, reason = "body of the interactive-io lane job in `run_check`")]
fn config_file(dir: &std::path::Path) -> Reported {
    let raw = match std::fs::read_to_string(dir.join("mixdog-config.json")) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(verdict(
                Level::Ok,
                "mixdog-config.json not created yet · defaults in use",
            ));
        }
        Err(_) => return Err(ProbeFailed),
    };
    let valid = matches!(serde_json::from_str::<Value>(&raw), Ok(Value::Object(_)));
    Ok(if valid {
        verdict(Level::Ok, "mixdog-config.json is valid")
    } else {
        with_hint(
            Level::Fail,
            "mixdog-config.json is not a valid JSON object",
            "fix the JSON syntax in the config file",
        )
    })
}

#[allow(clippy::disallowed_methods, reason = "body of the interactive-io lane job in `run_check`")]
fn log_files(dir: &std::path::Path) -> Reported {
    let entries = std::fs::read_dir(dir).map_err(|_| ProbeFailed)?;
    let count = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && e.file_name().to_string_lossy().ends_with(".log")
        })
        .count();
    let detail = format!("{count} log files in the data folder");
    Ok(if count > LOG_FILE_WARN {
        with_hint(
            Level::Warn,
            format!("{detail} (over {LOG_FILE_WARN})"),
            "old per-process logs are not being pruned",
        )
    } else {
        verdict(Level::Ok, detail)
    })
}

// --- The checks -------------------------------------------------------------------------

/// A status that is an object (not an array): anything else leaves the default row.
fn object(probe: Probe) -> Result<Option<Value>, ProbeFailed> {
    Ok(probe?.filter(Value::is_object))
}

async fn run_check(
    id: &str,
    thread: Option<&ThreadId>,
    sources: &dyn DoctorSources,
    config: &DoctorConfig,
    cancel: &CancellationToken,
    interactive: InteractiveIo,
) -> Reported {
    match id {
        "mixdog" => Ok(object(sources.update().await)?
            .and_then(|u| report_update(config.package_version.as_deref(), &u))),
        "node" => Ok(object(sources.node_runtime().await)?.and_then(|n| report_node(&n))),
        "providers" => {
            let active = sources.active_provider().unwrap_or_default();
            Ok(object(sources.provider_setup().await)?.and_then(|s| report_providers(&active, &s)))
        }
        "mcp" => Ok(object(sources.mcp_status(thread).await)?.and_then(|s| report_mcp(&s))),
        "memory" => {
            let memory = object(sources.tool_module_settings().await)?
                .and_then(|s| s.get("memory").cloned());
            let Some(memory) = memory.filter(Value::is_object) else {
                return Ok(None);
            };
            if is_bool(memory.get("installed"))
                && is_bool(memory.get("enabled"))
                && memory["installed"] == true
                && memory["enabled"] == true
            {
                let recap = sources.recap_settings().await?;
                return Ok(report_memory(&memory, recap.as_ref()));
            }
            Ok(report_memory(&memory, None))
        }
        "localProvider" => {
            let local = object(sources.tool_module_settings().await)?
                .and_then(|s| s.get("localProvider").cloned());
            Ok(local
                .filter(Value::is_object)
                .and_then(|l| report_local_provider(&l)))
        }
        "builtins" => Ok(object(sources.tool_module_settings().await)?
            .and_then(|s| report_builtins(&s, &|id| sources.bridge_active(id)))),
        "voice" => Ok(object(sources.voice_status().await)?.and_then(|v| report_voice(&v))),
        "automation" => {
            let Some(settings) = object(sources.channel_settings().await)? else {
                return Ok(None);
            };
            let worker = match settings.get("status").filter(|s| truthy(Some(s))) {
                Some(status) => Some(status.clone()),
                None => sources.channel_worker_status().await?,
            };
            let running = worker
                .as_ref()
                .and_then(|w| w.get("running"))
                .and_then(Value::as_bool);
            let setup = if running == Some(false) {
                sources.channel_setup().await?
            } else {
                None
            };
            Ok(report_channels(worker.as_ref(), setup.as_ref()))
        }
        "skills" => {
            Ok(object(sources.skills_status().await)?.and_then(|s| report_registry("skills", &s)))
        }
        "plugins" => Ok(
            object(sources.plugins_status().await)?.and_then(|s| report_registry("plugins", &s))
        ),
        "hooks" => Ok(object(sources.hooks_status().await)?.and_then(|h| report_hooks(&h))),
        "data" => {
            let dir = config.data_dir.clone();
            Ok(on_lane(interactive, cancel, move |_| data_folder(&dir))
                .await
                .map_err(|_| ProbeFailed)?)
        }
        "config" => {
            let dir = config.data_dir.clone();
            on_lane(interactive, cancel, move |_| config_file(&dir))
                .await
                .map_err(|_| ProbeFailed)?
        }
        "logs" => {
            let dir = config.data_dir.clone();
            on_lane(interactive, cancel, move |_| log_files(&dir))
                .await
                .map_err(|_| ProbeFailed)?
        }
        "sessionLog" => {
            Ok(object(sources.session_log_migration().await)?.and_then(|s| report_session_log(&s)))
        }
        _ => Ok(None),
    }
}

/// `[id, label]` in report order.
const CHECKS: [(&str, &str); 16] = [
    ("mixdog", "mixdog"),
    ("node", "node"),
    ("providers", "providers"),
    ("mcp", "mcp"),
    ("memory", "memory"),
    ("localProvider", "local provider"),
    ("builtins", "built-ins"),
    ("voice", "voice"),
    ("automation", "automation"),
    ("skills", "skills"),
    ("plugins", "plugins"),
    ("hooks", "hooks"),
    ("data", "data folder"),
    ("config", "config"),
    ("logs", "logs"),
    ("sessionLog", "session log"),
];

fn row_json(id: &str, label: &str, verdict: &Verdict) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), json!(id));
    row.insert("label".into(), json!(label));
    row.insert("level".into(), json!(verdict.level.name()));
    row.insert("detail".into(), json!(verdict.detail));
    match &verdict.fix {
        Some(Fix::Command(command)) => {
            row.insert("fix".into(), json!({ "command": command }));
        }
        Some(Fix::Hint(hint)) => {
            row.insert("fix".into(), json!({ "hint": hint }));
        }
        None => {}
    }
    Value::Object(row)
}

/// One check under its deadline: any failure is a redacted row, a stalled check is reported as
/// such and its late verdict dropped.
async fn doctor_check(
    id: &'static str,
    thread: Option<ThreadId>,
    label: &'static str,
    sources: Arc<dyn DoctorSources>,
    config: Arc<DoctorConfig>,
    cancel: CancellationToken,
    interactive: InteractiveIo,
) -> Value {
    let work = run_check(id, thread.as_ref(), &*sources, &config, &cancel, interactive);
    let verdict = match tokio::time::timeout(config.check_timeout, work).await {
        Err(_) => Verdict {
            level: Level::Warn,
            detail: format!(
                "no response within {}s",
                (config.check_timeout.as_millis() as f64 / 1000.0).round()
            ),
            fix: None,
        },
        Ok(Err(ProbeFailed)) => Verdict {
            level: Level::Fail,
            detail: "check failed (error details omitted)".into(),
            fix: None,
        },
        Ok(Ok(Some(verdict))) => verdict,
        Ok(Ok(None)) => Verdict {
            level: Level::Warn,
            detail: "status unavailable".into(),
            fix: None,
        },
    };
    row_json(id, label, &verdict)
}

/// `formatDoctorReport`: the rows as the TUI's text report.
pub fn format_report(result: &Value) -> String {
    let glyph = |level: &str| match level {
        "ok" => "✓",
        "fail" => "✗",
        _ => "⚠",
    };
    let mut lines = vec!["mixdog doctor — installation health".to_owned()];
    for check in result["checks"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{} {}: {}",
            glyph(check["level"].as_str().unwrap_or("")),
            check["label"].as_str().unwrap_or(""),
            check["detail"].as_str().unwrap_or("")
        ));
        if let Some(command) = check["fix"]["command"].as_str().filter(|c| !c.is_empty()) {
            lines.push(format!("    → run {command}"));
        } else if let Some(hint) = check["fix"]["hint"].as_str().filter(|h| !h.is_empty()) {
            lines.push(format!("    → {hint}"));
        }
    }
    let summary = &result["summary"];
    lines.push(format!(
        "{} ok · {} warnings · {} failed",
        summary["ok"], summary["warn"], summary["fail"]
    ));
    lines.join("\n")
}

pub struct DiagnosticsService {
    sources: Arc<dyn DoctorSources>,
    config: Arc<DoctorConfig>,
    ops: OpScopes,
    interactive: InteractiveIo,
    running: AtomicBool,
}

/// Clears the running flag however the run ends.
struct Running<'a>(&'a AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, AtomicOrdering::SeqCst);
    }
}

impl DiagnosticsService {
    pub fn new(
        sources: Arc<dyn DoctorSources>,
        config: DoctorConfig,
        ops: OpScopes,
        tokens: &LaneTokens,
    ) -> Arc<Self> {
        Arc::new(Self {
            sources,
            config: Arc::new(config),
            ops,
            interactive: tokens.interactive_io,
            running: AtomicBool::new(false),
        })
    }

    /// `runDoctorChecks`: every check at once, under one deadline each.
    async fn run_checks(&self, thread: Option<&ThreadId>, cancel: &CancellationToken) -> Value {
        let mut set = tokio::task::JoinSet::new();
        for (index, (id, label)) in CHECKS.into_iter().enumerate() {
            let (sources, config, cancel) =
                (self.sources.clone(), self.config.clone(), cancel.clone());
            let interactive = self.interactive;
            let thread = thread.cloned();
            set.spawn(async move {
                (
                    index,
                    doctor_check(id, thread, label, sources, config, cancel, interactive).await,
                )
            });
        }
        let mut rows: Vec<Option<Value>> = vec![None; CHECKS.len()];
        while let Some(done) = set.join_next().await {
            if let Ok((index, row)) = done {
                rows[index] = Some(row);
            }
        }
        let checks: Vec<Value> = rows
            .into_iter()
            .zip(CHECKS)
            .map(|(row, (id, label))| {
                // A check task that panicked has no row of its own: it is a failed check.
                row.unwrap_or_else(|| {
                    row_json(
                        id,
                        label,
                        &Verdict {
                            level: Level::Fail,
                            detail: "check failed (error details omitted)".into(),
                            fix: None,
                        },
                    )
                })
            })
            .collect();
        let count = |level: &str| checks.iter().filter(|c| c["level"] == level).count();
        let checked_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        json!({
            "checkedAt": checked_at,
            "summary": { "ok": count("ok"), "warn": count("warn"), "fail": count("fail") },
            "checks": checks,
        })
    }

    async fn run_doctor(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: DiagnosticsRunDoctorParams = decode(req)?;
        let notice = params
            .options
            .as_ref()
            .and_then(|o| o.get("notice"))
            .is_some_and(|n| truthy(Some(n)));
        let thread = params.thread_id.clone();
        let reply = self
            .ops
            .run(
                req,
                None,
                || async {
                    if self.running.swap(true, AtomicOrdering::SeqCst) {
                        return Ok(json!({ "busy": true }));
                    }
                    let _running = Running(&self.running);
                    let result = self.run_checks(thread.as_ref(), &req.ctx.cancel).await;
                    if notice {
                        self.sources
                            .notice(thread.as_ref(), &format_report(&result))
                            .await;
                    }
                    Ok(result)
                },
                || async { Ok(json!({ "busy": true })) },
            )
            .await?;
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(CoreError::Internal {
                incident_id: "diagnostics-subscribe".into(),
            }),
        }
    }
}

#[async_trait]
impl DomainService for DiagnosticsService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "diagnostics/runDoctor" => Ok(Reply::Value(self.run_doctor(&req).await?)),
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["diagnostics/runDoctor"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
