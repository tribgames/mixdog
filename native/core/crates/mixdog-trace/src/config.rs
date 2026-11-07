//! Where the trace goes and whether it is written at all: Node's `_resolveLocalTracePath`,
//! `_resolveToolFailurePath`, the rotation env knobs and `isDiagnosticIOEnabled`
//! (`src/lib/mixdog-debug.cjs`). The environment is read through a lookup so a test supplies its own.

use std::path::Path;
use std::path::PathBuf;

/// The local trace file and whether `MIXDOG_AGENT_TRACE_PATH` named it.
pub struct LocalTrace {
    pub path: PathBuf,
    pub explicit: bool,
}

pub struct TraceConfig {
    /// `MIXDOG_AGENT_TRACE_DISABLE=1`: `appendAgentTrace` returns at once.
    pub agent_trace_disable: bool,
    /// `None` when the local file is off (ship mode without an explicit path, or disabled).
    pub local: Option<LocalTrace>,
    /// `None` when `MIXDOG_TOOL_FAILURE_LOG_DISABLE=1`.
    pub failure_path: Option<PathBuf>,
    pub rotate_keep: usize,
    pub rotate_check_ms: i64,
    /// MIXDOG_AGENT_TRACE_VERBOSE=1 or MIXDOG_AGENT_TRACE_TIMING=1: the loop rows and the
    /// `browser_timing` rows are written (`traceAgentLoop`, `traceBrowserTiming`).
    pub loop_rows: bool,
    /// `MIXDOG_SLOW_TOOL_TRACE_MS` / `_NAMES`.
    pub slow_tool: crate::SlowTool,
}

fn truthy_env(value: Option<String>) -> bool {
    value.is_some_and(|v| {
        matches!(
            mixdog_js::js_to_lowercase(mixdog_js::js_trim(&v)).as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// `parseInt(v, 10)` kept only when it is a positive finite number (the shape of every knob here).
fn positive_int(value: Option<String>) -> Option<i64> {
    let text = value?;
    let text = mixdog_js::js_trim_start(&text);
    let digits: String = text
        .strip_prefix('+')
        .unwrap_or(text)
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<i64>().ok().filter(|n| *n > 0)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// `isDiagnosticIOEnabled()`: `MIXDOG_DIAGNOSTICS` forces on; otherwise on unless in ship mode.
/// `from_source_checkout` is the last tie-break of `resolveMixdogMode` (a `.git` next to the
/// sources); a packaged daemon passes false.
fn diagnostic_io(get: &dyn Fn(&str) -> Option<String>, from_source_checkout: bool) -> bool {
    if truthy_env(get("MIXDOG_DIAGNOSTICS")) {
        return true;
    }
    let mode = mixdog_js::js_to_lowercase(mixdog_js::js_trim(&get("MIXDOG_MODE").unwrap_or_default()));
    let ship = match mode.as_str() {
        "dev" | "development" | "debug" => false,
        "ship" | "shipping" | "prod" | "production" => true,
        _ if truthy_env(get("MIXDOG_SHIP")) => true,
        _ if truthy_env(get("MIXDOG_DEBUG")) => false,
        _ => !from_source_checkout,
    };
    !ship
}

impl TraceConfig {
    pub fn from_env(
        data_dir: &Path,
        get: &dyn Fn(&str) -> Option<String>,
        from_source_checkout: bool,
    ) -> Self {
        let explicit = non_empty(get("MIXDOG_AGENT_TRACE_PATH"));
        let history = data_dir.join("history");
        let local = if get("MIXDOG_AGENT_TRACE_LOCAL_DISABLE").as_deref() == Some("1") {
            None
        } else if explicit.is_none() && !diagnostic_io(get, from_source_checkout) {
            None
        } else {
            Some(match &explicit {
                Some(path) => LocalTrace {
                    path: PathBuf::from(path),
                    explicit: true,
                },
                None => LocalTrace {
                    path: history.join("agent-trace.jsonl"),
                    explicit: false,
                },
            })
        };
        let failure_path = if get("MIXDOG_TOOL_FAILURE_LOG_DISABLE").as_deref() == Some("1") {
            None
        } else {
            Some(match non_empty(get("MIXDOG_TOOL_FAILURE_LOG_PATH")) {
                Some(path) => PathBuf::from(path),
                None => history.join("tool-failures.jsonl"),
            })
        };
        Self {
            agent_trace_disable: get("MIXDOG_AGENT_TRACE_DISABLE").as_deref() == Some("1"),
            local,
            failure_path,
            rotate_keep: positive_int(get("MIXDOG_AGENT_TRACE_ROTATE_KEEP")).unwrap_or(3) as usize,
            rotate_check_ms: positive_int(get("MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS")).unwrap_or(60_000),
            slow_tool: crate::SlowTool::from_env(get),
            loop_rows: get("MIXDOG_AGENT_TRACE_VERBOSE").as_deref() == Some("1")
                || get("MIXDOG_AGENT_TRACE_TIMING").as_deref() == Some("1"),
        }
    }
}

