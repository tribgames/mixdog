//! The Computer Use run history and failure bundles (`session/run-log.ts`, `session/failure-diagnostics.ts`,
//! `session/log-privacy.ts`): one JSONL line per executed command under `<data>/computer-runs`, and the bounded failure bundles
//! under `<data>/computer-failures`, written in the formats the Node host wrote so the files it left stay readable.
//! Actions, targets, timings and verdicts only: typed text, clipboard contents, titles and pixels never reach either, and a
//! history write never decides whether a command succeeds.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;

use mixdog_core_api::domain::computer::ComputerError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::computer_recovery::lead_code;

const RUN_LOG_DIRECTORY: &str = "computer-runs";
const FAILURE_DIRECTORY: &str = "computer-failures";
const RUN_LOG_MAX_BYTES: u64 = 256 * 1_024;
const RUN_LOG_MAX_FILES: usize = 20;
/// The records one `list kind="history"` reply carries at most (`MAX_HISTORY_RECORDS`, `host/command-observation-routes.ts`).
pub const MAX_HISTORY_RECORDS: usize = 60;
const MAX_BUNDLES: usize = 20;
const MAX_SESSIONS: usize = 32;
const MAX_RECORDS: usize = 40;
const MAX_BYTES: usize = 128 * 1024;

// ---------------------------------------------------------------- log-privacy.ts

/// `computerLogTarget`: a web address keeps its scheme and host, any other scheme is blanked, a path keeps its last segment.
pub fn log_target(value: &str) -> String {
    let target = mixdog_js::js_trim(value);
    let bytes = target.as_bytes();
    let has_scheme = bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && target.find(':').is_some_and(|end| target[..end].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')));
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    if has_scheme && !drive {
        return match url::Url::parse(target) {
            Ok(url) if matches!(url.scheme(), "http" | "https") => {
                let host = url.host_str().unwrap_or_default();
                match url.port() {
                    Some(port) => format!("{}://{host}:{port}/", url.scheme()),
                    None => format!("{}://{host}/", url.scheme()),
                }
            }
            Ok(url) => format!("{}:[redacted]", url.scheme()),
            Err(_) => "[redacted-url]".to_owned(),
        };
    }
    target.rsplit(['\\', '/']).next().unwrap_or_default().chars().take(128).collect()
}

/// `computerLogError`: only the error's category, never its text.
pub fn log_error(message: &str) -> String {
    let code = lead_code(message);
    if code.is_empty() { "computer_command_failed".to_owned() } else { code }
}

/// The privacy boundary of one record about to be persisted: its `app` is reduced to [`log_target`].
pub fn redact_for_log(value: &mut Value) {
    if let Some(app) = value.get_mut("app")
        && let Some(text) = app.as_str()
    {
        *app = Value::String(log_target(text));
    }
}

// ---------------------------------------------------------------- shared/*.ts boundaries

/// `diagnosticCategory`: a bounded snake_case word, anything else could carry provider or user text.
fn category(value: Option<&Value>) -> Option<&str> {
    let text = value?.as_str()?;
    let bytes = text.as_bytes();
    let ok = !bytes.is_empty()
        && bytes.len() <= 80
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_');
    ok.then_some(text)
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `a ?? b`: `b` when `a` is absent or null.
fn first<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|v| !v.is_null()).or(b)
}

/// `booleanEvidence`: a boolean, or null for `delivery_accepted` only.
fn boolean_evidence(key: &str, value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.is_boolean() || (key == "delivery_accepted" && v.is_null()))
}

fn duration(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|d| d.is_finite() && d >= 0.0)
}

/// `computerTimings`: numeric durations of the known phases only.
fn timings(value: Option<&Value>) -> Map<String, Value> {
    const KEYS: [&str; 16] = [
        "total_ms",
        "execution_ms",
        "steps_ms",
        "delivery_ms",
        "before_windows_ms",
        "after_windows_ms",
        "settle_ms",
        "post_capture_ms",
        "recovery_ms",
        "target_resolution_ms",
        "accessibility_ms",
        "screenshot_ms",
        "ocr_ms",
        "backend_ms",
        "backend_roundtrip_ms",
        "settle_credit_ms",
    ];
    let Some(source) = value.and_then(Value::as_object) else { return Map::new() };
    KEYS.iter().filter(|key| duration(source.get(**key))).map(|key| ((*key).to_owned(), source[*key].clone())).collect()
}

/// `computerStepTimings`: the first six rows that ran, with their uncertain delivery and never their details.
fn step_timings(value: Option<&Value>) -> Vec<Value> {
    let Some(rows) = value.and_then(Value::as_array) else { return Vec::new() };
    rows.iter()
        .take(6)
        .enumerate()
        .filter_map(|(index, row)| {
            let status = row.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "succeeded" | "failed" | "uncertain"))?;
            let mut out = Map::new();
            out.insert("index".into(), json!(index + 1));
            out.insert("status".into(), json!(status));
            if let Some(code) = category(row.get("code")) {
                out.insert("code".into(), json!(code));
            }
            if let Some(accepted) = row.get("delivery_accepted").filter(|v| v.is_boolean() || v.is_null()) {
                out.insert("delivery_accepted".into(), accepted.clone());
            }
            if let Some(executed) = row.get("input_may_have_executed").filter(|v| v.is_boolean()) {
                out.insert("input_may_have_executed".into(), executed.clone());
            }
            out.insert("timings_ms".into(), Value::Object(timings(row.get("timings_ms"))));
            Some(Value::Object(out))
        })
        .collect()
}

/// `computerCursorFeedback`: only its boolean facts; none when none remain.
fn cursor_feedback(value: Option<&Value>) -> Option<Value> {
    let given = value?.as_object()?;
    let kept: Map<String, Value> = ["system_theme_applied", "system_theme_restored", "pointer_moved", "focus_masked"]
        .into_iter()
        .filter_map(|key| given.get(key).filter(|v| v.is_boolean()).map(|v| (key.to_owned(), v.clone())))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

/// `captureAttempts`: at most eight rows of bounded categories and timings, never an image or a message.
fn capture_attempts(value: Option<&Value>) -> Vec<Value> {
    let Some(rows) = value.and_then(Value::as_array) else { return Vec::new() };
    let text = |row: &Value, key: &str, allowed: &[&str]| row.get(key).and_then(Value::as_str).filter(|s| allowed.contains(s)).map(str::to_owned);
    rows.iter()
        .take(8)
        .filter_map(|row| {
            let backend = text(row, "backend", &["app_owned", "composited", "print_window", "wgc"])?;
            let scope = text(row, "scope", &["target", "owner"])?;
            let status = text(row, "status", &["captured", "unavailable", "failed"])?;
            let elapsed = row.get("elapsed_ms").filter(|v| duration(Some(*v)))?;
            let mut out = Map::new();
            out.insert("backend".into(), json!(backend));
            out.insert("scope".into(), json!(scope));
            out.insert("status".into(), json!(status));
            out.insert("elapsed_ms".into(), elapsed.clone());
            if let Some(code) = category(row.get("code")) {
                out.insert("code".into(), json!(code));
            }
            if let Some(cleanup) = row.get("cleanup")
                && let Some(state) = text(cleanup, "status", &["confirmed", "failed", "unconfirmed", "unknown"])
            {
                let mut kept = Map::new();
                kept.insert("status".into(), json!(state));
                if let Some(cancellation) = text(cleanup, "cancellation", &["settled", "unconfirmed", "failed"]) {
                    kept.insert("cancellation".into(), json!(cancellation));
                }
                out.insert("cleanup".into(), Value::Object(kept));
            }
            Some(Value::Object(out))
        })
        .collect()
}

// ---------------------------------------------------------------- failure-diagnostics.ts

/// An allowlist boundary: no titles, text, clipboard, app paths or pixels.
fn recovery_evidence(recovery: &Map<String, Value>) -> Map<String, Value> {
    const KEYS: [&str; 10] = [
        "ok",
        "user_control",
        "recovery_skipped",
        "focus_preserved_for_followup",
        "recapture_available",
        "focus_restored",
        "focus_unchanged",
        "input_not_dispatched",
        "cursor_restored",
        "reasserted",
    ];
    KEYS.iter().filter(|key| recovery.get(**key).is_some_and(Value::is_boolean)).map(|key| ((*key).to_owned(), recovery[*key].clone())).collect()
}

fn native_result_evidence(native: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["code", "path", "effect", "delivery"] {
        if category(native.get(key)).is_some() {
            out.insert(key.into(), native[key].clone());
        }
    }
    for key in ["delivery_accepted", "input_may_have_executed", "verified", "goal_verified"] {
        if boolean_evidence(key, native.get(key)) {
            out.insert(key.into(), native[key].clone());
        }
    }
    out
}

fn observation_evidence(observed: &Map<String, Value>) -> Map<String, Value> {
    let pixels = object(observed.get("pixel_unavailable"));
    let mut out = Map::new();
    for key in ["pixel_status", "accessibility_status"] {
        if category(observed.get(key)).is_some() {
            out.insert(key.into(), observed[key].clone());
        }
    }
    if let Some(ok) = observed.get("ok").filter(|v| v.is_boolean()) {
        out.insert("ok".into(), ok.clone());
    }
    if let Some(reason) = first(observed.get("pixel_reason"), pixels.get("reason")).filter(|v| category(Some(*v)).is_some()) {
        out.insert("pixel_reason".into(), reason.clone());
    }
    // `computerErrorCode(...) || diagnosticCategory(...)`.
    let error = observed.get("accessibility_error");
    let coded = error.and_then(Value::as_str).map(lead_code).unwrap_or_default();
    let accessibility = if coded.is_empty() { category(error).unwrap_or_default().to_owned() } else { coded };
    if !accessibility.is_empty() {
        out.insert("accessibility_error".into(), json!(accessibility));
    }
    out
}

fn iso_timestamp(value: &Value) -> bool {
    let Some(text) = value.as_str() else { return false };
    let b = text.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            23 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

fn hwnd_id(value: &Value) -> bool {
    let Some(rest) = value.as_str().and_then(|text| text.strip_prefix("hwnd:0x")) else { return false };
    (1..=16).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `diagnosticRecord`: the bounded projection of a command reply or error that persisted diagnostics keep.
pub fn diagnostic_record(input: &Map<String, Value>) -> Map<String, Value> {
    let mut result = Map::new();
    if input.get("at").is_some_and(iso_timestamp) {
        result.insert("at".into(), input["at"].clone());
    }
    for key in ["action", "delivery", "effect", "code", "error", "path", "escalation", "stage"] {
        if category(input.get(key)).is_some() {
            result.insert(key.into(), input[key].clone());
        }
    }
    for key in ["ok", "verified", "goal_verified", "completed", "input_may_have_executed", "delivery_accepted"] {
        if boolean_evidence(key, input.get(key)) {
            result.insert(key.into(), input[key].clone());
        }
    }
    if input.get("window_id").is_some_and(hwnd_id) {
        result.insert("window_id".into(), input["window_id"].clone());
    }
    if let Some(ms) = input.get("ms").filter(|v| v.is_number()).and_then(Value::as_f64).filter(|m| m.is_finite()) {
        result.insert("ms".into(), if ms < 0.0 { json!(0) } else { input["ms"].clone() });
    }
    result.insert("recovery".into(), Value::Object(recovery_evidence(&object(first(input.get("input_recovery"), input.get("recovery"))))));
    let native = object(input.get("native_result"));
    result.insert("native_result".into(), Value::Object(native_result_evidence(&native)));
    result.insert("cursor_feedback".into(), cursor_feedback(first(input.get("cursor_feedback"), native.get("cursor_feedback"))).unwrap_or_else(|| json!({})));
    result.insert("timings_ms".into(), Value::Object(timings(input.get("timings_ms"))));
    // The observation rides on the reply itself for capture-style actions.
    let observation = object(first(input.get("capture_after"), input.get("observation")));
    let capture_reply = if matches!(input.get("action").and_then(Value::as_str), Some("capture" | "screenshot" | "zoom")) { input.clone() } else { Map::new() };
    let observed = if observation.is_empty() { capture_reply } else { observation.clone() };
    result.insert("observation".into(), Value::Object(observation_evidence(&observed)));
    let capture_timings = timings(first(input.get("capture_timings_ms"), observation.get("timings_ms")));
    let attempts = capture_attempts(first(input.get("capture_attempts"), observed.get("capture_attempts")));
    if !attempts.is_empty() {
        result.insert("capture_attempts".into(), Value::Array(attempts));
    }
    if !capture_timings.is_empty() {
        result.insert("capture_timings_ms".into(), Value::Object(capture_timings));
    }
    let steps = step_timings(first(first(input.get("step_timings"), input.get("steps")), input.get("actions")));
    if !steps.is_empty() {
        result.insert("step_timings".into(), Value::Array(steps));
    }
    result
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn failure(code: &str, error: impl std::fmt::Display) -> ComputerError {
    ComputerError::Failed { code: code.into(), message: format!("{code}: {error}") }
}

fn hex_id(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// `/^failure-[0-9a-f-]+\.json$/`.
fn bundle_file(name: &str) -> bool {
    name.strip_prefix("failure-").and_then(|rest| rest.strip_suffix(".json")).is_some_and(|id| !id.is_empty() && hex_id(id))
}

fn session_key(session: &str) -> String {
    Sha256::digest(session.as_bytes())[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// `process.platform`.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

#[derive(Default)]
struct BundleState {
    /// Each session's records, least recently recorded first.
    histories: Vec<(String, Vec<Map<String, Value>>)>,
    bundle_ids: HashMap<String, String>,
}

/// The failure bundles of one data directory: at most 20 files and 32 sessions in memory, 40 records and 128 KiB a bundle.
pub struct FailureBundles {
    directory: PathBuf,
    state: Mutex<BundleState>,
}

impl FailureBundles {
    pub fn new(data_dir: &Path) -> Self {
        Self { directory: data_dir.join(FAILURE_DIRECTORY), state: Mutex::new(BundleState::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, BundleState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The bundle files, newest first.
    fn files(&self) -> std::io::Result<Vec<String>> {
        let mut files: Vec<(String, SystemTime)> = fs::read_dir(&self.directory)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                bundle_file(&name).then_some(())?;
                Some((name, entry.metadata().ok()?.modified().ok()?))
            })
            .collect();
        files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
        Ok(files.into_iter().map(|(name, _)| name).collect())
    }

    /// Records one command outcome of `session`; a failed one (or the cleanup that follows a failed one) writes the session's
    /// bundle. A diagnostic failure never alters an action's outcome, so none is reported.
    pub fn record(&self, session: &str, input: &Map<String, Value>) {
        let key = session_key(session);
        let history = {
            let mut state = self.state();
            let mut history = match state.histories.iter().position(|(k, _)| *k == key) {
                Some(at) => state.histories.remove(at).1,
                None => Vec::new(),
            };
            let mut row = Map::new();
            row.insert("at".into(), json!(now_iso()));
            row.extend(diagnostic_record(input));
            history.push(row);
            if history.len() > MAX_RECORDS {
                history.remove(0);
            }
            state.histories.push((key.clone(), history.clone()));
            if state.histories.len() > MAX_SESSIONS {
                let (oldest, _) = state.histories.remove(0);
                state.bundle_ids.remove(&oldest);
            }
            history
        };
        let failed = input.get("ok") == Some(&Value::Bool(false));
        let cleanup_after_failure =
            input.get("stage").and_then(Value::as_str) == Some("cleanup") && history.iter().any(|row| row.get("ok") == Some(&Value::Bool(false)));
        if failed || cleanup_after_failure {
            let _ = self.write(session, json!({ "records": history }));
        }
    }

    /// Writes `session`'s bundle (`bundle.records`): a pending file first, renamed into place, then the oldest bundles beyond 20
    /// are removed. One session keeps one bundle id, so its later failures replace its file.
    pub fn write(&self, session: &str, bundle: Value) -> Result<(), ComputerError> {
        let key = session_key(session);
        fs::create_dir_all(&self.directory).map_err(|e| failure("computer_failure_bundle_failed", e))?;
        let id = self.state().bundle_ids.entry(key.clone()).or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone();
        let body = json!({
            "version": 1,
            "id": id,
            "session": key,
            "createdAt": now_iso(),
            "platform": platform(),
            "screenshots": "excluded",
            "records": bundle.get("records").cloned().unwrap_or_else(|| json!([])),
        });
        let text = body.to_string();
        if text.len() > MAX_BYTES {
            return Err(failure("computer_failure_bundle_too_large", text.len()));
        }
        let pending = self.directory.join(format!("pending-{id}.json"));
        let save = || -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            let _ = std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options.open(&pending)?.write_all(text.as_bytes())?;
            fs::rename(&pending, self.directory.join(format!("failure-{id}.json")))
        };
        save().map_err(|e| failure("computer_failure_bundle_failed", e))?;
        if let Ok(files) = self.files() {
            for name in files.into_iter().skip(MAX_BUNDLES) {
                let _ = fs::remove_file(self.directory.join(name));
            }
        }
        Ok(())
    }

    /// The newest bundles, the boundary reapplied to what the files hold.
    pub fn read(&self) -> Vec<Value> {
        let Ok(files) = self.files() else { return Vec::new() };
        files
            .into_iter()
            .take(MAX_BUNDLES)
            .filter_map(|name| {
                let path = self.directory.join(name);
                if usize::try_from(fs::metadata(&path).ok()?.len()).ok()? > MAX_BYTES {
                    return None;
                }
                let value: Value = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;
                let mut out = Map::new();
                out.insert("version".into(), json!(1));
                out.insert("screenshots".into(), json!("excluded"));
                if let Some(id) = value.get("id").and_then(Value::as_str).filter(|id| id.len() == 36 && hex_id(id)) {
                    out.insert("id".into(), json!(id));
                }
                if let Some(at) = value.get("createdAt").filter(|at| iso_timestamp(at)) {
                    out.insert("createdAt".into(), at.clone());
                }
                let records = value.get("records").and_then(Value::as_array).map(|rows| {
                    let skip = rows.len().saturating_sub(MAX_RECORDS);
                    rows[skip..].iter().map(|row| Value::Object(diagnostic_record(&object(Some(row))))).collect::<Vec<_>>()
                });
                out.insert("records".into(), Value::Array(records.unwrap_or_default()));
                Some(Value::Object(out))
            })
            .collect()
    }
}

// ---------------------------------------------------------------- run-log.ts

/// A command's reply as the run record sees it: its text, and the capture attempts it carried beside it.
pub struct RunReply<'a> {
    pub text: &'a str,
    pub capture_attempts: Option<&'a Value>,
}

/// The run history of one data directory.
pub struct RunLog {
    directory: PathBuf,
    pruned: Mutex<bool>,
}

fn run_log_file_name(session: &str) -> String {
    let mut name = String::new();
    let mut in_run = false;
    for c in session.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            name.push(c);
            in_run = false;
        } else if !in_run {
            name.push('_');
            in_run = true;
        }
    }
    name.truncate(80);
    if name.is_empty() {
        name = "session".to_owned();
    }
    format!("{name}.jsonl")
}

fn prune_run_logs(directory: &Path) {
    let Ok(read) = fs::read_dir(directory) else { return };
    let mut files: Vec<(PathBuf, SystemTime)> = read
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".jsonl"))
        .map(|entry| (entry.path(), entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)))
        .collect();
    files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    for (stale, _) in files.into_iter().skip(RUN_LOG_MAX_FILES) {
        let _ = fs::remove_file(stale);
    }
}

/// `list kind="history"`'s limit: a positive integer up to [`MAX_HISTORY_RECORDS`], else the most.
pub fn history_limit(requested: Option<&Value>) -> usize {
    let number = match requested {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => mixdog_js::js_trim(s).parse::<f64>().ok(),
        _ => None,
    };
    match number {
        Some(n) if n.fract() == 0.0 && n >= 1.0 => n.min(MAX_HISTORY_RECORDS as f64) as usize,
        _ => MAX_HISTORY_RECORDS,
    }
}

impl RunLog {
    pub fn new(data_dir: &Path) -> Self {
        Self { directory: data_dir.join(RUN_LOG_DIRECTORY), pruned: Mutex::new(false) }
    }

    /// One line `{at, session, ...record}`; a line that would take the session's file past 256 KiB is dropped, and a failure
    /// to write is not reported (a command never fails because of its history).
    pub fn append(&self, session: &str, record: Map<String, Value>) {
        let id = mixdog_js::js_trim(session);
        if id.is_empty() {
            return;
        }
        let _ = self.write_line(id, record);
    }

    fn write_line(&self, id: &str, record: Map<String, Value>) -> std::io::Result<()> {
        let path = self.directory.join(run_log_file_name(id));
        fs::create_dir_all(&self.directory)?;
        {
            let mut pruned = self.pruned.lock().unwrap_or_else(PoisonError::into_inner);
            if !*pruned {
                prune_run_logs(&self.directory);
                *pruned = true;
            }
        }
        let written = fs::metadata(&path).map(|m| m.len());
        let mut line = Map::new();
        line.insert("at".into(), json!(now_iso()));
        line.insert("session".into(), json!(id));
        line.extend(record);
        let mut line = Value::Object(line);
        redact_for_log(&mut line);
        let text = format!("{line}\n");
        if written.as_ref().map_or(0, |w| *w) + text.len() as u64 > RUN_LOG_MAX_BYTES {
            return Ok(());
        }
        fs::OpenOptions::new().create(true).append(true).open(&path)?.write_all(text.as_bytes())?;
        if written.is_err() {
            prune_run_logs(&self.directory);
        }
        Ok(())
    }

    /// The reply of `list kind="history"`: the most recent `limit` records of `session`, newest last; a truncated or foreign
    /// line is skipped, and a session that never ran has none.
    pub fn history(&self, session: &str, limit: usize) -> Value {
        let records = self.records(session, limit);
        json!({ "history": records, "returned": records.len() })
    }

    fn records(&self, session: &str, limit: usize) -> Vec<Value> {
        let id = mixdog_js::js_trim(session);
        if id.is_empty() {
            return Vec::new();
        }
        let Ok(bytes) = fs::read(self.directory.join(run_log_file_name(id))) else { return Vec::new() };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').filter(|line| !line.is_empty()).collect();
        let skip = lines.len().saturating_sub(limit.max(1));
        lines[skip..].iter().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect()
    }
}

/// Structured reply fields worth a log line: the diagnostic projection, the delivery booleans, scalar evidence and the verdict.
fn apply_reply_evidence(record: &mut Map<String, Value>, payload: &Map<String, Value>) {
    if let Some(ok) = payload.get("ok").filter(|v| v.is_boolean()) {
        record.insert("ok".into(), ok.clone());
    }
    let diagnostic = diagnostic_record(payload);
    for (key, from) in [("input_recovery", "recovery"), ("timings_ms", "timings_ms"), ("native_result", "native_result"), ("observation", "observation")] {
        record.insert(key.into(), diagnostic[from].clone());
    }
    for key in ["delivery_accepted", "input_may_have_executed", "completed"] {
        if let Some(value) = payload.get(key).filter(|v| v.is_boolean() || v.is_null()) {
            record.insert(key.into(), value.clone());
        }
    }
    for key in ["capture_timings_ms", "capture_attempts", "step_timings"] {
        if let Some(value) = diagnostic.get(key) {
            record.insert(key.into(), value.clone());
        }
    }
    for key in ["effect", "verified", "goal_verified", "code", "path", "escalation", "window_id", "pixel_status", "accessibility_status"] {
        if let Some(value) = payload.get(key).filter(|v| !v.is_object() && !v.is_array()) {
            record.insert(key.into(), value.clone());
        }
    }
    if let Some(verdict) = payload.get("verdict").and_then(Value::as_object) {
        let mut kept = Map::new();
        for key in ["decision", "recommended"] {
            if let Some(text) = verdict.get(key).filter(|v| v.is_string()) {
                kept.insert(key.into(), text.clone());
            }
        }
        record.insert("verdict".into(), Value::Object(kept));
    }
}

/// `String(value)` of a command field a record names.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A field as JavaScript's truthiness reads it.
fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    })
}

/// `computerRunRecord`: the line a command leaves, from the command, the milliseconds it took and its reply (none when it
/// failed before one).
pub fn run_record(command: &Map<String, Value>, elapsed_ms: f64, reply: Option<&RunReply<'_>>) -> Map<String, Value> {
    let mut record = Map::new();
    record.insert("action".into(), json!(truthy(command.get("action")).map(js_string).unwrap_or_default()));
    for key in ["window_id", "app", "ref", "delivery"] {
        if let Some(value) = truthy(command.get(key)) {
            let text = js_string(value);
            record.insert(key.into(), json!(if key == "app" { log_target(&text) } else { text }));
        }
    }
    record.insert("ms".into(), json!(elapsed_ms.round() as i64));
    let Some(reply) = reply else { return record };
    let attempts = capture_attempts(reply.capture_attempts);
    if !attempts.is_empty() {
        record.insert("capture_attempts".into(), Value::Array(attempts));
    }
    record.insert("ok".into(), json!(true));
    record.insert("bytes".into(), json!(reply.text.encode_utf16().count()));
    // Plain-text discovery results carry no structured verdict.
    match serde_json::from_str::<Value>(reply.text) {
        Ok(Value::Null) | Err(_) => {}
        Ok(Value::Object(payload)) => apply_reply_evidence(&mut record, &payload),
        Ok(_) => apply_reply_evidence(&mut record, &Map::new()),
    }
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("an object")
    }

    fn actions(reply: &Value) -> Vec<String> {
        reply["history"].as_array().unwrap().iter().map(|r| r["action"].as_str().unwrap().to_owned()).collect()
    }

    #[test]
    fn a_session_reads_back_its_history_newest_last_without_the_truncated_tail() {
        let dir = tempfile::tempdir().unwrap();
        let log = RunLog::new(dir.path());
        log.append("history-1", map(json!({"action": "click", "effect": "confirmed"})));
        log.append("history-1", map(json!({"action": "type", "effect": "confirmed"})));
        let all = log.history("history-1", 10);
        assert_eq!(actions(&all), ["click", "type"]);
        assert_eq!(all["returned"], 2);
        assert_eq!(all["history"][0]["session"], "history-1");
        assert_eq!(actions(&log.history("history-1", 1)), ["type"]);
        assert_eq!(log.history("", 10)["returned"], 0);
        assert_eq!(log.history("never-ran", 10)["history"], json!([]));
        fs::write(dir.path().join("computer-runs").join("history-1.jsonl"), "{\"action\":\"click\"}\n{\"action\":").unwrap();
        assert_eq!(actions(&log.history("history-1", 10)), ["click"]);
    }

    #[test]
    fn lines_written_by_the_node_host_are_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("computer-runs");
        fs::create_dir_all(&folder).unwrap();
        let written = concat!(
            "{\"at\":\"2026-01-02T03:04:05.678Z\",\"session\":\"s a/b\",\"action\":\"click\",\"app\":\"editor.exe\",\"ms\":12,\"ok\":true,\"bytes\":40,",
            "\"input_recovery\":{},\"timings_ms\":{\"total_ms\":9},\"native_result\":{},\"observation\":{},\"verdict\":{\"decision\":\"proceed\"}}\n",
            "{\"at\":\"2026-01-02T03:04:06.000Z\",\"session\":\"s a/b\",\"action\":\"capture\",\"ms\":3}\n"
        );
        // The Node host named the file after the session, every run of foreign characters replaced by one underscore.
        fs::write(folder.join("s_a_b.jsonl"), written).unwrap();
        let reply = RunLog::new(dir.path()).history("s a/b", 60);
        assert_eq!(reply["returned"], 2);
        assert_eq!(reply["history"][0]["timings_ms"]["total_ms"], 9);
        assert_eq!(reply["history"][1]["action"], "capture");
    }

    #[test]
    fn the_history_limit_is_a_positive_integer_up_to_sixty() {
        assert_eq!(history_limit(None), 60);
        assert_eq!(history_limit(Some(&json!(3))), 3);
        assert_eq!(history_limit(Some(&json!(500))), 60);
        assert_eq!(history_limit(Some(&json!(0))), 60);
        assert_eq!(history_limit(Some(&json!(2.5))), 60);
        assert_eq!(history_limit(Some(&json!("7"))), 7);
    }

    #[test]
    fn a_session_file_stops_at_its_size_bound_and_the_directory_at_twenty_files() {
        let dir = tempfile::tempdir().unwrap();
        let log = RunLog::new(dir.path());
        let big = "x".repeat(100 * 1024);
        for _ in 0..4 {
            log.append("big", map(json!({"action": "click", "note": big})));
        }
        assert_eq!(log.history("big", 60)["returned"], 2);
        for n in 0..25 {
            log.append(&format!("many-{n}"), map(json!({"action": "click"})));
        }
        let files = fs::read_dir(dir.path().join("computer-runs")).unwrap().count();
        assert!(files <= RUN_LOG_MAX_FILES, "{files}");
    }

    #[test]
    fn launch_diagnostics_omit_url_credentials_paths_queries_and_fragments() {
        let record = run_record(&map(json!({"action": "launch", "app": "https://user:secret@example.invalid/reset/secret?token=secret#secret"})), 1.0, None);
        assert_eq!(record["app"], "https://example.invalid/");
        assert!(!Value::Object(record).to_string().contains("secret"));
        assert_eq!(log_target("custom:secret"), "custom:[redacted]");
        assert_eq!(log_target("https://[invalid/secret"), "[redacted-url]");
        assert_eq!(log_target("C:\\Apps\\editor.exe"), "editor.exe");
        assert_eq!(log_target("http://localhost:3000/x"), "http://localhost:3000/");
        let mut persisted = json!({"app": "https://u:p@example.invalid/a?b"});
        redact_for_log(&mut persisted);
        assert_eq!(persisted["app"], "https://example.invalid/");
    }

    #[test]
    fn diagnostics_retain_only_the_error_category() {
        assert_eq!(log_error("Error: target_required: private clipboard text"), "target_required");
        assert_eq!(log_error("target_mismatch|private clipboard text"), "target_mismatch");
        assert_eq!(log_error("launch failed for https://example.invalid/?secret"), "computer_command_failed");
    }

    #[test]
    fn run_history_keeps_sequence_and_capture_phase_timings_behind_the_privacy_boundary() {
        let text = json!({
            "ok": true, "action": "sequence",
            "timings_ms": {"total_ms": 900, "steps_ms": 600, "post_capture_ms": 290},
            "steps": [
                {"status": "succeeded", "text": "private-value", "timings_ms": {"delivery_ms": 40, "settle_ms": 150, "after_windows_ms": 5}},
                {"status": "failed", "message": "private-value", "timings_ms": {"execution_ms": 300}},
                {"status": "skipped", "timings_ms": {"execution_ms": 999}}
            ],
            "capture_after": {"timings_ms": {"accessibility_ms": 200, "screenshot_ms": 180, "ocr_ms": 70, "title": "private-value"}}
        })
        .to_string();
        let record = run_record(&map(json!({"action": "sequence"})), 5.0, Some(&RunReply { text: &text, capture_attempts: None }));
        assert_eq!(record["timings_ms"], json!({"total_ms": 900, "steps_ms": 600, "post_capture_ms": 290}));
        assert_eq!(record["step_timings"].as_array().unwrap().len(), 2);
        assert_eq!(record["step_timings"][0]["timings_ms"]["settle_ms"], 150);
        assert_eq!(record["step_timings"][1]["timings_ms"]["execution_ms"], 300);
        assert_eq!(record["capture_timings_ms"], json!({"accessibility_ms": 200, "screenshot_ms": 180, "ocr_ms": 70}));
        assert!(!Value::Object(record).to_string().contains("private-value"));
    }

    #[test]
    fn uncertain_input_and_a_failed_observation_stay_independently_diagnosable() {
        let text = json!({
            "ok": false, "completed": false, "input_may_have_executed": true,
            "steps": [{"status": "uncertain", "code": "background_delivery_unknown", "delivery_accepted": null, "input_may_have_executed": true, "message": "private-value", "timings_ms": {"execution_ms": 20}}],
            "observation": {"ok": false, "accessibility_status": "error", "accessibility_error": "computer_command_timeout: private-value", "pixel_status": "unavailable",
                "pixel_unavailable": {"code": "pixel_unavailable", "reason": "capture_source_unavailable"}}
        })
        .to_string();
        let record = run_record(&map(json!({"action": "sequence"})), 5.0, Some(&RunReply { text: &text, capture_attempts: None }));
        assert_eq!(record["input_may_have_executed"], true);
        assert_eq!(record["step_timings"][0]["status"], "uncertain");
        assert_eq!(record["step_timings"][0]["delivery_accepted"], Value::Null);
        assert_eq!(record["step_timings"][0]["code"], "background_delivery_unknown");
        assert_eq!(record["observation"]["accessibility_error"], "computer_command_timeout");
        assert_eq!(record["observation"]["pixel_reason"], "capture_source_unavailable");
        assert!(!Value::Object(record).to_string().contains("private-value"));
    }

    #[test]
    fn plain_screenshots_and_failed_post_action_captures_keep_bounded_attempt_evidence() {
        let rows = Value::Array(
            (0..12)
                .map(|_| {
                    json!({"backend": "wgc", "scope": "target", "status": "failed", "elapsed_ms": 40, "code": "capture_timeout",
                        "cleanup": {"status": "unconfirmed", "cancellation": "unconfirmed", "secret": "private-value"},
                        "text": "private-value", "image": "private-value", "window_title": "private-value"})
                })
                .collect(),
        );
        let nested = json!({"action": "click", "ok": false, "capture_after": {"capture_attempts": rows}}).to_string();
        let plain = "Screenshot of private-value";
        for reply in [RunReply { text: plain, capture_attempts: Some(&rows) }, RunReply { text: &nested, capture_attempts: None }] {
            let record = run_record(&map(json!({"action": "screenshot"})), 1.0, Some(&reply));
            assert_eq!(record["capture_attempts"].as_array().unwrap().len(), 8);
            assert_eq!(
                record["capture_attempts"][0],
                json!({"backend": "wgc", "scope": "target", "status": "failed", "elapsed_ms": 40, "code": "capture_timeout",
                    "cleanup": {"status": "unconfirmed", "cancellation": "unconfirmed"}})
            );
            assert!(!Value::Object(record).to_string().contains("private-value"));
        }
    }

    #[test]
    fn diagnostics_never_invent_observation_evidence_and_keep_unknown_delivery() {
        let record = diagnostic_record(&map(json!({"action": "click", "ok": false, "delivery_accepted": null, "input_may_have_executed": true,
            "native_result": {"delivery_accepted": null, "input_may_have_executed": true}})));
        assert_eq!(record["observation"], json!({}));
        assert_eq!(record["delivery_accepted"], Value::Null);
        assert_eq!(record["native_result"]["delivery_accepted"], Value::Null);
        let capture = diagnostic_record(&map(json!({"action": "capture", "ok": false, "pixel_status": "unavailable"})));
        assert_eq!(capture["observation"], json!({"pixel_status": "unavailable", "ok": false}));
    }

    fn noisy(index: i64) -> Map<String, Value> {
        map(json!({
            "action": "click", "ok": index < 60, "ms": index, "window_id": "hwnd:0x123",
            "text": "private-text", "app": "private-app", "title": "private-title", "image": {"data": "private-pixels"},
            "clipboard": "private-clipboard", "path": "C:\\private-path", "error": "private-error with content",
            "native_result": {"code": "foreground_unavailable", "path": "foreground", "delivery_accepted": false, "text": "private-native-text", "cursor": [100, 200],
                "cursor_feedback": {"system_theme_applied": true, "system_theme_restored": true, "pointer_moved": false, "text": "private-cursor"}},
            "timings_ms": {"delivery_ms": 3, "settle_ms": 150, "after_windows_ms": 4, "extra": "private-timing"},
            "steps": (0..9).map(|_| json!({"status": "failed", "message": "private-step", "timings_ms": {"execution_ms": 200, "extra": "private-step-timing"}})).collect::<Vec<_>>(),
            "capture_after": {"timings_ms": {"ocr_ms": 20, "text": "private-ocr"}},
            "input_recovery": {"ok": false, "user_control": true, "focus_restored": false, "cursor_restored": true, "reasserted": true, "message": "private-recovery"}
        }))
    }

    #[test]
    fn failure_bundles_keep_bounded_steps_and_recovery_and_exclude_private_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = FailureBundles::new(dir.path());
        for index in 0..85 {
            bundles.record("private-session", &noisy(index));
        }
        let folder = dir.path().join("computer-failures");
        let names: Vec<_> = fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.len(), 1, "one noisy session must not evict every other session: {names:?}");
        let source = fs::read_to_string(folder.join(&names[0])).unwrap();
        assert!(!source.contains("private-"));
        let bundle: Value = serde_json::from_str(&source).unwrap();
        assert_eq!(bundle["records"].as_array().unwrap().len(), 40);
        assert_eq!(bundle["screenshots"], "excluded");
        let last = &bundle["records"][39];
        assert_eq!(last["recovery"]["user_control"], true);
        assert_eq!(last["native_result"], json!({"code": "foreground_unavailable", "path": "foreground", "delivery_accepted": false}));
        assert_eq!(last["timings_ms"]["delivery_ms"], 3);
        assert_eq!(last["step_timings"].as_array().unwrap().len(), 6);
        assert_eq!(last["capture_timings_ms"]["ocr_ms"], 20);
        assert!(source.len() <= MAX_BYTES);
        let restored = bundles.read();
        assert_eq!(restored.len(), 1);
        let again = &restored[0]["records"][39];
        assert_eq!(again["step_timings"][0]["timings_ms"]["execution_ms"], 200);
        assert_eq!(again["timings_ms"]["settle_ms"], 150);
        assert_eq!(again["recovery"]["focus_restored"], false);
        assert_eq!(again["recovery"]["cursor_restored"], true);
        assert_eq!(again["native_result"]["code"], "foreground_unavailable");
        assert_eq!(again["cursor_feedback"], json!({"system_theme_applied": true, "system_theme_restored": true, "pointer_moved": false}));
    }

    #[test]
    fn failure_retention_is_bounded_across_sessions_rather_than_repeated_failures() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = FailureBundles::new(dir.path());
        for session in 0..25 {
            bundles.record(&format!("session-{session}"), &map(json!({"action": "click", "ok": false})));
        }
        for _ in 0..30 {
            bundles.record("session-24", &map(json!({"action": "capture", "ok": false})));
        }
        assert_eq!(fs::read_dir(dir.path().join("computer-failures")).unwrap().count(), 20);
        assert_eq!(bundles.read().len(), 20);
    }

    #[test]
    fn capture_attempt_categories_survive_a_bundle_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = FailureBundles::new(dir.path());
        bundles.record(
            "fixture",
            &map(json!({"action": "capture", "ok": false, "capture_attempts": [
                {"backend": "print_window", "scope": "target", "status": "unavailable", "elapsed_ms": 1, "code": "blank_black_frame"},
                {"backend": "wgc", "scope": "target", "status": "failed", "elapsed_ms": 2, "code": "capture_timeout",
                    "cleanup": {"status": "unconfirmed", "cancellation": "unconfirmed"}, "text": "private"}
            ]})),
        );
        let attempts = &bundles.read()[0]["records"][0]["capture_attempts"];
        assert_eq!(attempts.as_array().unwrap().len(), 2);
        assert_eq!(attempts[0]["code"], "blank_black_frame");
        assert_eq!(attempts[1]["cleanup"], json!({"status": "unconfirmed", "cancellation": "unconfirmed"}));
        assert!(!attempts.to_string().contains("private"));
    }

    #[test]
    fn a_cleanup_after_a_failure_writes_the_bundle_and_a_success_alone_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let bundles = FailureBundles::new(dir.path());
        bundles.record("one", &map(json!({"action": "click", "ok": true})));
        assert!(!dir.path().join("computer-failures").exists());
        bundles.record("one", &map(json!({"action": "click", "ok": false})));
        bundles.record("one", &map(json!({"action": "release", "ok": true, "stage": "cleanup"})));
        assert_eq!(bundles.read()[0]["records"].as_array().unwrap().len(), 3);
        assert_eq!(fs::read_dir(dir.path().join("computer-failures")).unwrap().count(), 1);
    }
}
