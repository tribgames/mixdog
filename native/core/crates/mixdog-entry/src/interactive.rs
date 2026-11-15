//! The interactive runs: the terminal interface (`runTui`) and the line-based REPL of `--plain` (`runRepl`). The ledger, the swap and
//! the live-session mark that Node's `cli.mjs` did before them are `dispatch`'s; this file maps the classified options onto the two
//! runs and builds what the REPL's statusline needs of the process.

use std::process::ExitCode;
use std::sync::Arc;

use mixdog_repl::ReplOptions;
use mixdog_tui::footer::process::process_renderer;
use mixdog_tui::run::TuiOptions;
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
        Mode::Plain => mixdog_repl::run(repl_options(options), Arc::new(process_renderer())),
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
        statusline: Some(process_renderer()),
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

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;

    use mixdog_tui::footer::process::config_dir_of;

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
