use std::ffi::OsString;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_launch::command::ExecLine;
use mixdog_launch::command::HELP_TEXT;
use mixdog_launch::command::REACT_REMOVED;
use mixdog_launch::lifecycle::LifecycleHandle;
use mixdog_launch::lifecycle::begin_process_lifecycle;
use mixdog_launch::lifecycle::finish_process_lifecycle;
use mixdog_launch::lifecycle::record_catchable_fatal;
use mixdog_launch::staged_update::register_live_session;

use crate::argv::Invocation;
use crate::argv::Kind;
use crate::argv::Options;
use crate::argv::classify;
use crate::handoff::hand_off;
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
        assert_eq!(answer(&Kind::Exec { words: vec!["hi".to_owned()] }).0, None);
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

    fn handed(words: &[&str]) -> Vec<String> {
        let invocation = classify(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>());
        let (Kind::Exec { words }, Some(options)) = (&invocation.kind, &invocation.options) else { panic!("{invocation:?}") };
        exec_line(words, options).words()
    }

    /// `mixdogd exec` reads the handed line as this program read its own: the route and flags given anywhere, the message's words
    /// as given after `--`. A flag is read from the whole line, past a `--` too, as Node's `argv.includes` reads it; a word that is
    /// a flag only once trimmed is message text on both sides.
    #[test]
    fn an_exec_reaches_mixdogd_with_the_route_and_flags_it_was_given_wherever_they_stood() {
        assert_eq!(
            handed(&["--provider", "p", "--fast", " Exec ", "--json", "say", "--model", "m", "hi "]),
            ["exec", "--provider", "p", "--model", "m", "--fast", "--json", "--", "say", "hi "]
        );
        assert_eq!(handed(&["exec", "--", "--web-search"]), ["exec", "--web-search", "--", "--web-search"]);
        assert_eq!(handed(&["exec", "--", " --help", "--effort"]), ["exec", "--", " --help", "--effort"]);
        assert_eq!(handed(&["--effort", "low", "exec", "a", "--", "--", "b"]), ["exec", "--effort", "low", "--", "a", "--", "b"]);
    }
}

/// Runs the command on `argv` (the words after the program's name) and returns the exit code.
pub fn run(argv: &[String]) -> i32 {
    let invocation = classify(argv);
    if invocation.skip_host_prelude {
        end_on_panic(None);
        return execute(&invocation);
    }
    let lifecycle = Arc::new(Mutex::new(Some(begin_process_lifecycle("tui"))));
    // Interactive and general sessions are live sessions: the launcher's staged-update swap (`bin/staged-swap.mjs`) never replaces
    // the package under one that runs.
    let _live = register_live_session(&format!("pid-{}", std::process::id()));
    end_on_panic(Some(lifecycle.clone()));
    let code = execute(&invocation);
    if let Some(run) = take(&lifecycle) {
        finish_process_lifecycle(run, "clean-shutdown", code);
    }
    code
}

fn take(lifecycle: &Arc<Mutex<Option<LifecycleHandle>>>) -> Option<LifecycleHandle> {
    lifecycle.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// A panic, on any thread, ends the run with 1 as Node's uncaught exception does: once the hooks installed after this one (the
/// terminal's restore) and the report on stderr have run, and an interactive run's ledger has recorded it as its catchable fatal.
/// Nothing catches it on the way, so a build that unwinds ends as one that aborts (`panic = "abort"`) does.
fn end_on_panic(lifecycle: Option<Arc<Mutex<Option<LifecycleHandle>>>>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        if let Some(run) = lifecycle.as_ref().and_then(take) {
            let payload = info.payload();
            let text = payload.downcast_ref::<String>().map(String::as_str).or_else(|| payload.downcast_ref::<&str>().copied()).unwrap_or("panic");
            record_catchable_fatal(&run, text);
            finish_process_lifecycle(run, "catchable-fatal-error", 1);
        }
        std::process::exit(1);
    }));
}

/// The exec `mixdogd` runs for an exec line: its message's words and the options an exec takes.
fn exec_line(words: &[String], options: &Options) -> ExecLine {
    ExecLine {
        message: words.to_vec(),
        provider: options.provider.clone(),
        model: options.model.clone(),
        effort: options.effort.clone(),
        fast: options.fast,
        web_search: options.web_search,
        json: options.json,
    }
}

/// `run` of `app.mjs`.
fn execute(invocation: &Invocation) -> i32 {
    if let Some(code) = immediate(&invocation.kind, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()) {
        return code;
    }
    let Some(options) = &invocation.options else { return 1 };
    match &invocation.kind {
        Kind::Exec { words } => hand_off(&exec_line(words, options).words().into_iter().map(OsString::from).collect::<Vec<_>>()),
        Kind::Plain => run_interactive(Mode::Plain, options),
        _ => run_interactive(Mode::Tui, options),
    }
}
