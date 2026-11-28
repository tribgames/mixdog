//! The footer of a process that hosts no session itself (the terminal UI and the line REPL): what its statusline renderer reads
//! and runs on.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_files::statusline_agents::RuntimeEntry;
use mixdog_fsio::Unlaned;
use mixdog_tui_style::color::Styler;
use mixdog_view_model::display::statusline_format::StatusStyle;
use mixdog_view_model::display::statusline_segments::BackgroundRun;
use serde_json::Map;
use serde_json::Value;

use super::DiskIo;
use super::RendererDeps;
use super::StatusHost;
use super::StatusPaths;
use super::StatuslineRenderer;

/// `MIXDOG_CONFIG_DIR`, else `~/.mixdog` (an empty variable counts as unset).
pub fn config_dir_of(env: &dyn Fn(&str) -> Option<OsString>, home: Option<PathBuf>) -> PathBuf {
    match env("MIXDOG_CONFIG_DIR").filter(|value| !value.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => home.unwrap_or_default().join(".mixdog"),
    }
}

/// What the footer asks of the process. The sessions run in the core, not here: this process holds no session runtimes, and the
/// model catalog and the plan-usage cache are the core's; what the footer shows comes from the files the core keeps.
struct ProcessHost;

impl StatusHost for ProcessHost {
    fn catalog_meta(&self, _model: &str, _provider: &str) -> Option<Map<String, Value>> {
        None
    }

    fn cached_models(&self, _provider: &str) -> Vec<Value> {
        Vec::new()
    }

    fn cached_oauth_usage(&self, _route: &Value, _allow_stale: bool) -> Option<Value> {
        None
    }

    fn agent_runtimes(&self) -> Vec<RuntimeEntry> {
        Vec::new()
    }

    fn hidden_agent_names(&self) -> Vec<String> {
        Vec::new()
    }

    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// Node's `setImmediate` for the footer's cache refreshes: each job runs on a thread of its own, off the render call.
struct ThreadBackground;

impl BackgroundRun for ThreadBackground {
    fn run(&self, job: Box<dyn FnOnce() + Send>) {
        let _ = std::thread::Builder::new().name("mixdog-footer".to_owned()).spawn(job);
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// The one statusline renderer of the process (`renderStatusline` and its caches).
pub fn process_renderer() -> StatuslineRenderer {
    let home = std::env::home_dir();
    let data_dir = mixdog_launch::crash_capture::data_dir().unwrap_or_else(|| home.clone().unwrap_or_default().join(".mixdog").join("data"));
    let config_dir = config_dir_of(&|name| std::env::var_os(name), home);
    StatuslineRenderer::new(RendererDeps {
        host: Arc::new(ProcessHost),
        io: Arc::new(DiskIo::new(Unlaned)),
        paths: StatusPaths { data_dir, config_dir },
        background: Arc::new(ThreadBackground),
        clock: Arc::new(now_ms),
        style: StatusStyle::new(Styler::process()),
        process_started_at_ms: now_ms(),
    })
}
