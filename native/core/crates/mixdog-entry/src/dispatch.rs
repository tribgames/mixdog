//! What the command does with a classified line (`src/cli.mjs` `main`, `src/app.mjs` `run`). An exec and a refusal made before the
//! host matters never touch the data folder: no lifecycle ledger, no live-session mark (`skipHostPrelude`). The staged-update swap is
//! not this program's: the npm launcher (`bin/mixdog.mjs`) does it before this program starts.
//! Dev-only Node items (the V8 compile cache, `NODE_ENV`, the uv thread pool, `MIXDOG_TUI_DEV`'s rebuild, the stale-bundle
//! warning) have no counterpart here. An inherited `MIXDOG_BOOT_PROFILE` stays away from the exec path as it did in Node: the
//! exec's boundary removes every `MIXDOG_*` variable from the process before its core starts.
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use mixdog_cli::exec::ExecOptions;
use mixdog_cli::exec::HELP_TEXT;
use mixdog_cli::exec::REACT_REMOVED;
use mixdog_cli::exec::run_command;
use mixdog_launch::lifecycle::begin_process_lifecycle;
use mixdog_launch::lifecycle::finish_process_lifecycle;
use mixdog_launch::lifecycle::record_catchable_fatal;
use mixdog_launch::staged_update::register_live_session;

use crate::argv::Invocation;
use crate::argv::Kind;
use crate::argv::classify;
use crate::interactive::Mode;
use crate::interactive::run_interactive;

/// The refusal, the help and the removed flag's line: what needs no more than the two streams. `None` for a run.
fn immediate(kind: &Kind, out: &mut dyn Write, err: &mut dyn Write) -> Option<i32> {
    match kind {
        Kind::Error(text) => {
            let _ = writeln!(err, "mixdog: {text}");
            Some(1)
        }
        Kind::Help => {
            let _ = out.write_all(HELP_TEXT.as_bytes());
            let _ = out.flush();
            Some(0)
        }
        Kind::React => {
            let _ = err.write_all(REACT_REMOVED.as_bytes());
            Some(1)
        }
        Kind::Plain | Kind::Exec { .. } | Kind::General => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(kind: &Kind) -> (Option<i32>, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = immediate(kind, &mut out, &mut err);
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    #[test]
    fn a_refusal_is_one_line_on_stderr_with_exit_1() {
        assert_eq!(answer(&Kind::Error("unknown option --x".to_owned())), (Some(1), String::new(), "mixdog: unknown option --x\n".to_owned()));
    }

    #[test]
    fn help_is_the_usage_on_stdout_with_exit_0() {
        let (code, out, err) = answer(&Kind::Help);
        assert_eq!((code, out.as_str(), err.as_str()), (Some(0), HELP_TEXT, ""));
        assert!(out.starts_with("mixdog — standalone mixdog CLI/TUI coding agent."));
    }

    #[test]
    fn a_run_is_not_answered_by_the_streams() {
        assert_eq!(answer(&Kind::General).0, None);
        assert_eq!(answer(&Kind::Plain).0, None);
        assert_eq!(answer(&Kind::Exec { message: "hi".to_owned() }).0, None);
    }

    #[test]
    fn an_exec_and_a_refusal_before_the_host_skip_the_prelude_and_help_does_not() {
        let line = |words: &[&str]| classify(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>()).skip_host_prelude;
        assert!(line(&["exec", "hi"]) && line(&["--json"]) && line(&["exec"]));
        assert!(!line(&[]) && !line(&["--help"]) && !line(&["--bogus"]) && !line(&["--plain"]));
    }

    #[test]
    fn the_removed_react_flag_says_so_with_exit_1() {
        let (code, out, err) = answer(&Kind::React);
        assert_eq!((code, out.as_str(), err.as_str()), (Some(1), "", "mixdog: --react was removed; run `mixdog` for the canonical TUI.\n"));
    }
}

/// Runs the command on `argv` (the words after the program's name) and returns the exit code.
pub fn run(argv: &[String]) -> i32 {
    let invocation = classify(argv);
    if invocation.skip_host_prelude {
        return match std::panic::catch_unwind(AssertUnwindSafe(|| execute(&invocation))) {
            Ok(code) => code,
            Err(_) => 1,
        };
    }
    let lifecycle = begin_process_lifecycle("tui");
    // Interactive and general sessions are live sessions: the launcher's staged-update swap (`bin/staged-swap.mjs`) never replaces
    // the package under one that runs.
    let _live = register_live_session(&format!("pid-{}", std::process::id()));
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| (execute(&invocation), "clean-shutdown")));
    let (code, reason) = match outcome {
        Ok(ended) => ended,
        Err(payload) => {
            let text = payload.downcast_ref::<String>().map(String::as_str).or_else(|| payload.downcast_ref::<&str>().copied()).unwrap_or("panic");
            record_catchable_fatal(&lifecycle, text);
            (1, "catchable-fatal-error")
        }
    };
    finish_process_lifecycle(lifecycle, reason, code);
    code
}
/// `run` of `app.mjs`.
fn execute(invocation: &Invocation) -> i32 {
    if let Some(code) = immediate(&invocation.kind, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()) {
        return code;
    }
    let Some(options) = &invocation.options else { return 1 };
    match &invocation.kind {
        Kind::Exec { message } => {
            let cwd = match std::env::current_dir() {
                Ok(cwd) => cwd,
                Err(err) => {
                    eprintln!("mixdog: the working directory: {err}");
                    return 1;
                }
            };
            run_command(ExecOptions {
                message: message.clone(),
                provider: options.provider.clone(),
                model: options.model.clone(),
                effort: options.effort.clone(),
                fast: options.fast,
                provider_config: None,
                web_search: options.web_search,
                json: options.json,
                cwd,
                usage_log: std::env::var("MIXDOG_USAGE_LOG").ok().map(PathBuf::from),
                tool_mode: options.tool_mode,
            })
        }
        Kind::Plain => run_interactive(Mode::Plain, options),
        _ => run_interactive(Mode::Tui, options),
    }
}
