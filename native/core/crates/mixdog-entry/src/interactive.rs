//! The interactive runs: the terminal interface (`runTui`) and the line-based REPL of `--plain` (`runRepl`). The ledger, the swap and
//! the live-session mark that Node's `cli.mjs` did before them are `dispatch`'s; this file maps the classified options onto the two
//! runs and builds what the REPL's statusline needs of the process.
#![allow(
    clippy::disallowed_methods,
    reason = "the footer's refresh jobs run on a thread of their own (Node's setImmediate): the entry has no lane to submit them to"
)]

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_session::session::statusline_agents::RuntimeEntry;
use mixdog_fsio::Unlaned;
use mixdog_repl::ReplOptions;
use mixdog_tui::footer::DiskIo;
use mixdog_tui::footer::RendererDeps;
use mixdog_tui::footer::StatusHost;
use mixdog_tui::footer::StatusPaths;
use mixdog_tui::footer::StatuslineRenderer;
use mixdog_tui::run::TuiOptions;
use mixdog_tui_style::color::Styler;
use mixdog_view_model::display::statusline_format::StatusStyle;
use mixdog_view_model::display::statusline_segments::BackgroundRun;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::argv::Options;
use crate::argv::Worktree;

/// Which interactive run the line asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The terminal interface (`mixdog`).
    Tui,
    /// The line-based REPL (`mixdog --plain`).
    Plain,
}

/// Runs the interactive session with `options` and returns the process's exit code.
pub fn run_interactive(mode: Mode, options: &Options) -> i32 {
    let code = match mode {
        Mode::Tui => mixdog_tui::run::run_tui(tui_options(options)),
        Mode::Plain => mixdog_repl::run(repl_options(options), Arc::new(statusline_renderer())),
    };
    exit_code_of(code)
}

/// `worktree` of the session options: `--worktree [name]` is `{ mode: 'worktree', name }`, `--no-worktree` is `{ mode: 'branch' }`;
/// neither leaves the worktree settings' default to the run.
fn worktree_option(worktree: Option<&Worktree>) -> Option<Value> {
    match worktree? {
        Worktree::New(name) => Some(json!({ "mode": "worktree", "name": name })),
        Worktree::Branch => Some(json!({ "mode": "branch" })),
    }
}

/// The options `runTui` is given (`opts` of `app.mjs`). The working folder is the process's.
fn tui_options(options: &Options) -> TuiOptions {
    TuiOptions {
        cwd: None,
        provider: options.provider.clone(),
        model: options.model.clone(),
        effort: options.effort.clone(),
        fast: options.fast,
        web_search: options.web_search,
        tool_mode: Some(options.tool_mode.as_str().to_owned()),
        remote: options.remote,
        force_onboarding: options.force_onboarding,
        worktree: worktree_option(options.worktree.as_ref()),
        resume: None,
    }
}

/// The options `runRepl` is given: the route and the tool mode (the REPL starts no worktree and takes no effort).
fn repl_options(options: &Options) -> ReplOptions {
    ReplOptions { provider: options.provider.clone(), model: options.model.clone(), tool_mode: options.tool_mode.as_str().to_owned(), cwd: None }
}

/// The number an `ExitCode` carries. The type has no accessor; its `Debug` text ends with the number on every platform.
fn exit_code_of(code: ExitCode) -> i32 {
    let text = format!("{code:?}");
    let reversed: String = text.chars().rev().filter(|c| *c != ')').take_while(char::is_ascii_digit).collect();
    reversed.chars().rev().collect::<String>().parse().unwrap_or(1)
}

/// `MIXDOG_CONFIG_DIR`, else `~/.mixdog` (an empty variable counts as unset).
fn config_dir_of(env: &dyn Fn(&str) -> Option<OsString>, home: Option<PathBuf>) -> PathBuf {
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
fn statusline_renderer() -> StatuslineRenderer {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::argv::classify;

    fn options(words: &[&str]) -> Options {
        classify(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>()).options.expect("options")
    }

    #[test]
    fn the_route_flags_and_modes_reach_the_terminal_interface() {
        let tui = tui_options(&options(&["--provider", "p", "--model", "m", "--effort", "high", "--fast", "--web-search", "--readonly", "--remote", "--onboarding"]));
        assert_eq!((tui.provider.as_deref(), tui.model.as_deref(), tui.effort.as_deref()), (Some("p"), Some("m"), Some("high")));
        assert!(tui.fast && tui.web_search && tui.remote && tui.force_onboarding);
        assert_eq!((tui.tool_mode.as_deref(), tui.worktree, tui.cwd, tui.resume), (Some("readonly"), None, None, None));
    }

    #[test]
    fn a_line_without_flags_is_a_full_tool_mode_that_follows_the_worktree_default() {
        let tui = tui_options(&options(&[]));
        assert_eq!((tui.tool_mode.as_deref(), tui.worktree, tui.fast, tui.remote), (Some("full"), None, false, false));
    }

    #[test]
    fn worktree_intent_is_named_as_node_names_it() {
        assert_eq!(tui_options(&options(&["--worktree", "feat"])).worktree, Some(json!({ "mode": "worktree", "name": "feat" })));
        assert_eq!(tui_options(&options(&["--worktree"])).worktree, Some(json!({ "mode": "worktree", "name": null })));
        assert_eq!(tui_options(&options(&["--no-worktree"])).worktree, Some(json!({ "mode": "branch" })));
    }

    #[test]
    fn the_repl_takes_the_route_and_the_tool_mode_only() {
        let repl = repl_options(&options(&["--plain", "--provider", "p", "--model", "m", "--readonly"]));
        assert_eq!((repl.provider.as_deref(), repl.model.as_deref(), repl.tool_mode.as_str(), repl.cwd), (Some("p"), Some("m"), "readonly", None));
        assert_eq!(repl_options(&options(&["--plain"])).tool_mode, "full");
    }

    #[test]
    fn an_exit_code_is_read_back_from_its_number() {
        for code in [0, 1, 2, 130, 255] {
            assert_eq!(exit_code_of(ExitCode::from(code)), i32::from(code));
        }
    }

    #[test]
    fn the_config_directory_is_the_variable_else_the_mixdog_folder_of_home() {
        let set = |name: &str| (name == "MIXDOG_CONFIG_DIR").then(|| OsString::from("/cfg"));
        assert_eq!(config_dir_of(&set, Some(PathBuf::from("/home/u"))), PathBuf::from("/cfg"));
        let empty = |name: &str| (name == "MIXDOG_CONFIG_DIR").then(OsString::new);
        assert_eq!(config_dir_of(&empty, Some(PathBuf::from("/home/u"))), PathBuf::from("/home/u").join(".mixdog"));
        assert_eq!(config_dir_of(&|_| None, Some(PathBuf::from("/home/u"))), PathBuf::from("/home/u").join(".mixdog"));
    }
}
