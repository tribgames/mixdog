//! How the command line is read (`src/headless-command.mjs`: `parseTokens`, `classifyCliInvocation`): which kind of run it asks
//! for, with which options, or the refusal. Nothing here starts anything or touches a file: a refusal that is made before the
//! host exists says so (`skip_host_prelude`), and the caller then never touches the data folder.

use std::collections::BTreeMap;

use mixdog_app_protocol::boundary::validate::worktree_name::worktree_name_error;
use mixdog_js::js_trim;
use mixdog_launch::command::ToolMode;
use mixdog_launch::command::is_exec;
use mixdog_launch::command::quoted;
use serde_json::Value;

/// The options that take the next word as their value (`VALUE_OPTIONS`).
const VALUE_OPTIONS: [&str; 4] = ["--provider", "--model", "--effort", "--workflow"];
/// `--worktree [name]` takes an optional value; `--worktree=<name>` is the unambiguous spelling.
const WORKTREE_OPTION: &str = "--worktree";
const NO_WORKTREE_OPTION: &str = "--no-worktree";
const FLAG_OPTIONS: [&str; 12] =
    [NO_WORKTREE_OPTION, "--readonly", "--help", "-h", "--plain", "--react", "--remote", "--onboarding", "--fast", "--web-search", "--memory", "--json"];
/// The interactive CLI's flags an exec refuses, in Node's order (`EXEC_UNSUPPORTED_FLAGS`).
const EXEC_UNSUPPORTED_FLAGS: [&str; 5] = ["--readonly", "--remote", "--onboarding", "--memory", NO_WORKTREE_OPTION];
const HEADLESS_WORKFLOW_ERROR: &str = "option --workflow is not supported for mixdog exec";

/// What a session is created in (`worktree` of the options): a new worktree, optionally named, or the checked-out branch.
#[allow(dead_code, reason = "the interactive runs the switch task adds read these options; until then only the tests do")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Worktree {
    /// `--worktree [name]`: a name that was invalid on a line that asks for help or `--plain` is dropped.
    New(Option<String>),
    /// `--no-worktree`.
    Branch,
}

/// The options every kind of run is given (`options` of the classification).
#[allow(dead_code, reason = "the interactive runs the switch task adds read these options; until then only the tests do")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// Without either option the worktree settings' default decides.
    pub worktree: Option<Worktree>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub web_search: bool,
    pub json: bool,
    pub tool_mode: ToolMode,
    pub remote: bool,
    pub force_onboarding: bool,
}

/// What the line asks for (`kind`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// The refusal, printed as `mixdog: <text>` with exit 1.
    Error(String),
    /// `--help` or `-h` anywhere on the line.
    Help,
    /// `--plain`: the line-based REPL.
    Plain,
    /// `--react`: the removed flag's refusal.
    React,
    /// `exec <message...>`: the headless one-shot, with the words of its message as the line gave them (joined, they are the
    /// message: `mixdogd exec` joins them).
    Exec { words: Vec<String> },
    /// Everything else: the terminal interface.
    General,
}

/// `classifyCliInvocation`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub kind: Kind,
    /// Absent for a refusal that is made while the line is read.
    pub options: Option<Options>,
    /// The run never touches the host's data folder: no lifecycle ledger, no live-session mark (an exec
    /// and every refusal made before the host matters, `skipHostPrelude`).
    pub skip_host_prelude: bool,
}

/// What `parseTokens` reads.
#[derive(Default)]
struct Parsed<'a> {
    positional: Vec<&'a str>,
    /// The first value of each value option.
    values: BTreeMap<&'static str, String>,
    /// `--worktree` was given: with its name, if it has a valid one.
    worktree: Option<Option<String>>,
}

/// A refusal made while the line is read.
struct Refusal {
    error: String,
    skip_host_prelude: bool,
}

impl Refusal {
    fn new(error: impl Into<String>, skip_host_prelude: bool) -> Self {
        Self { error: error.into(), skip_host_prelude }
    }
}

fn is_worktree_option(arg: &str) -> bool {
    arg.strip_prefix(WORKTREE_OPTION).is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
}

/// `worktreeNameToken`: the word after a bare `--worktree` is its name unless it is empty, an option or the exec verb.
fn worktree_name_token(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty() && !text.starts_with('-') && !is_exec(text))
}

/// `argvIndicatesExec`: the first word that is not an option (nor the value of one) is the exec verb.
fn argv_indicates_exec(argv: &[String]) -> bool {
    let mut index = 0;
    while let Some(arg) = argv.get(index).map(String::as_str) {
        if VALUE_OPTIONS.contains(&arg) {
            index += 2;
            continue;
        }
        if arg == WORKTREE_OPTION {
            index += 1 + usize::from(worktree_name_token(argv.get(index + 1).map(String::as_str)).is_some());
            continue;
        }
        if is_worktree_option(arg) || arg == "--" || FLAG_OPTIONS.contains(&arg) || arg.starts_with('-') {
            index += 1;
            continue;
        }
        return is_exec(arg);
    }
    false
}

/// `parseTokens`: an option counts wherever it stands, only `--` ends the options. A `strict` line refuses a missing value, an
/// invalid worktree name and (unless it carries `--react`) the exec verb as a route value; a line that asks for help or
/// `--plain` (not strict) skips them.
fn parse_tokens(argv: &[String], strict: bool) -> Result<Parsed<'_>, Refusal> {
    let allow_headless_intent = strict && !argv.iter().any(|arg| arg == "--react");
    let mut parsed = Parsed::default();
    let mut index = 0;
    while let Some(arg) = argv.get(index).map(String::as_str) {
        let next = argv.get(index + 1).map(String::as_str);
        if is_worktree_option(arg) {
            let name = match arg.strip_prefix("--worktree=") {
                Some(name) => Some(name),
                None => {
                    let name = worktree_name_token(next);
                    index += usize::from(name.is_some());
                    name
                }
            };
            let error = name.and_then(|name| worktree_name_error(&Value::from(name)).map(|error| (name, error)));
            if let (true, Some((name, error))) = (strict, &error) {
                return Err(Refusal::new(format!("option --worktree name {} is invalid: {error}", quoted(name)), false));
            }
            parsed.worktree = Some(if error.is_some() { None } else { name.map(str::to_owned) });
        } else if let Some(option) = VALUE_OPTIONS.into_iter().find(|option| *option == arg) {
            match next.filter(|value| !value.is_empty() && !value.starts_with('-')) {
                None if strict => return Err(Refusal::new(format!("option {option} requires a non-option value"), matches!(option, "--provider" | "--model"))),
                None => {}
                Some(value) => {
                    if allow_headless_intent && is_exec(value) {
                        let error = if option == "--workflow" {
                            HEADLESS_WORKFLOW_ERROR.to_owned()
                        } else {
                            format!("option {option} requires a route value before {}", quoted(value))
                        };
                        return Err(Refusal::new(error, true));
                    }
                    parsed.values.entry(option).or_insert_with(|| value.to_owned());
                    index += 1;
                }
            }
        } else if FLAG_OPTIONS.contains(&arg) {
            // A flag is read from the whole line (`argv.includes`), not here.
        } else if arg == "--" {
            parsed.positional.extend(argv[index + 1..].iter().map(String::as_str));
            break;
        } else if arg.starts_with('-') {
            return Err(Refusal::new(format!("unknown option {arg}"), allow_headless_intent && argv_indicates_exec(argv)));
        } else {
            parsed.positional.push(arg);
        }
        index += 1;
    }
    Ok(parsed)
}

fn refusal(error: impl Into<String>, skip_host_prelude: bool) -> Invocation {
    Invocation { kind: Kind::Error(error.into()), options: None, skip_host_prelude }
}

/// `classifyCliInvocation`: what the words of the command line (after the program's name) ask for.
pub fn classify(argv: &[String]) -> Invocation {
    let given = |flag: &str| argv.iter().any(|arg| arg == flag);
    let help = given("--help") || given("-h");
    let plain = given("--plain");
    let parsed = match parse_tokens(argv, !help && !plain) {
        Ok(parsed) => parsed,
        Err(Refusal { error, skip_host_prelude }) => return refusal(error, skip_host_prelude),
    };
    // `worktreeIntent`: `--worktree` and `--no-worktree` exclude each other, unless the line only asks for help or `--plain`.
    let disabled = given(NO_WORKTREE_OPTION);
    let worktree = match (disabled, &parsed.worktree) {
        (true, Some(_)) if !help && !plain => return refusal("options --worktree and --no-worktree are mutually exclusive", false),
        (true, Some(_)) => None,
        (true, None) => Some(Worktree::Branch),
        (false, Some(name)) => Some(Worktree::New(name.clone())),
        (false, None) => None,
    };
    let options = Options {
        worktree,
        provider: parsed.values.get("--provider").cloned(),
        model: parsed.values.get("--model").cloned(),
        effort: parsed.values.get("--effort").cloned(),
        fast: given("--fast"),
        web_search: given("--web-search"),
        json: given("--json"),
        tool_mode: if given("--readonly") { ToolMode::Readonly } else { ToolMode::Full },
        remote: given("--remote"),
        force_onboarding: given("--onboarding"),
    };
    let with = |kind: Kind, skip_host_prelude: bool, options: Options| Invocation { kind, options: Some(options), skip_host_prelude };
    if help {
        return with(Kind::Help, false, options);
    }
    if plain {
        return with(Kind::Plain, false, options);
    }
    if given("--react") {
        return with(Kind::React, false, options);
    }
    // `execFromPositional`.
    if parsed.positional.first().is_some_and(|word| is_exec(word)) {
        let words = &parsed.positional[1..];
        if js_trim(&words.join(" ")).is_empty() {
            return refusal("usage: mixdog exec [options] <message...>", true);
        }
        if parsed.values.contains_key("--workflow") {
            return refusal(HEADLESS_WORKFLOW_ERROR, true);
        }
        let unsupported = EXEC_UNSUPPORTED_FLAGS.into_iter().find(|&flag| given(flag)).or(parsed.worktree.is_some().then_some(WORKTREE_OPTION));
        if let Some(flag) = unsupported {
            return refusal(format!("option {flag} is not supported for mixdog exec"), true);
        }
        return with(Kind::Exec { words: words.iter().map(|word| (*word).to_owned()).collect() }, true, options);
    }
    if given("--json") {
        return refusal("option --json is only supported for mixdog exec", true);
    }
    with(Kind::General, false, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(words: &[&str]) -> Invocation {
        classify(&words.iter().map(|word| (*word).to_owned()).collect::<Vec<_>>())
    }

    fn exec(words: &[&str]) -> Kind {
        Kind::Exec { words: words.iter().map(|word| (*word).to_owned()).collect() }
    }

    fn error(words: &[&str]) -> (String, bool) {
        match line(words) {
            Invocation { kind: Kind::Error(text), skip_host_prelude, .. } => (text, skip_host_prelude),
            other => panic!("{words:?} is not refused: {other:?}"),
        }
    }

    #[test]
    fn a_bare_line_is_the_terminal_interface_with_the_defaults() {
        let invocation = line(&[]);
        assert_eq!(invocation.kind, Kind::General);
        assert!(!invocation.skip_host_prelude);
        let options = invocation.options.unwrap();
        assert_eq!((options.worktree, options.provider, options.tool_mode), (None, None, ToolMode::Full));
        assert!(!(options.fast || options.web_search || options.json || options.remote || options.force_onboarding));
    }

    #[test]
    fn the_exec_verb_is_found_after_options_in_any_case_and_its_words_are_joined() {
        let invocation = line(&["--provider", "p", "--fast", " Exec ", "say", "hi "]);
        assert_eq!(invocation.kind, exec(&["say", "hi "]));
        assert!(invocation.skip_host_prelude);
        let options = invocation.options.unwrap();
        assert_eq!((options.provider.as_deref(), options.fast), (Some("p"), true));
        assert_eq!(line(&["--", "exec", "a b"]).kind, exec(&["a b"]));
        assert_eq!(line(&["hi", "exec"]).kind, Kind::General);
    }

    #[test]
    fn an_exec_without_a_message_or_with_an_option_it_does_not_have_is_refused_before_the_host() {
        assert_eq!(error(&["exec"]), ("usage: mixdog exec [options] <message...>".to_owned(), true));
        assert_eq!(error(&["exec", "--workflow", "w", "hi"]), (HEADLESS_WORKFLOW_ERROR.to_owned(), true));
        for flag in ["--readonly", "--remote", "--onboarding", "--memory", "--no-worktree"] {
            assert_eq!(error(&["exec", flag, "hi"]), (format!("option {flag} is not supported for mixdog exec"), true));
        }
        assert_eq!(error(&["exec", "--worktree=x", "hi"]).0, "option --worktree is not supported for mixdog exec");
        assert_eq!(error(&["--json"]), ("option --json is only supported for mixdog exec".to_owned(), true));
    }

    #[test]
    fn a_value_option_takes_a_non_option_value_and_the_first_one_wins() {
        assert_eq!(error(&["--provider"]), ("option --provider requires a non-option value".to_owned(), true));
        assert_eq!(error(&["--effort", "-x"]), ("option --effort requires a non-option value".to_owned(), false));
        assert!(error(&["--model", ""]).1);
        let options = line(&["--model", "a", "--model", "b"]).options.unwrap();
        assert_eq!(options.model.as_deref(), Some("a"));
        assert_eq!(error(&["--model", "exec", "hi"]), ("option --model requires a route value before \"exec\"".to_owned(), true));
        assert_eq!(error(&["--workflow", "Exec"]), (HEADLESS_WORKFLOW_ERROR.to_owned(), true));
        // `--react` keeps the exec verb as an ordinary value.
        assert_eq!(line(&["--react", "--model", "exec"]).kind, Kind::React);
    }

    #[test]
    fn a_worktree_name_is_the_next_word_unless_it_is_an_option_or_the_exec_verb() {
        let name = |words: &[&str]| line(words).options.unwrap().worktree;
        assert_eq!(name(&["--worktree"]), Some(Worktree::New(None)));
        assert_eq!(name(&["--worktree", "feature"]), Some(Worktree::New(Some("feature".to_owned()))));
        assert_eq!(name(&["--worktree=feature"]), Some(Worktree::New(Some("feature".to_owned()))));
        assert_eq!(name(&["--worktree", "--fast"]), Some(Worktree::New(None)));
        // The exec verb is not taken as the name: the line is an exec with a worktree, which an exec refuses.
        assert_eq!(error(&["--worktree", "exec", "hi"]).0, "option --worktree is not supported for mixdog exec");
        assert_eq!(name(&["--no-worktree"]), Some(Worktree::Branch));
        let (text, skip) = error(&["--worktree=a b"]);
        assert!(text.starts_with("option --worktree name \"a b\" is invalid: "), "{text}");
        assert!(!skip);
        // A line that only asks for help keeps what it can: the invalid name is dropped.
        assert_eq!(name(&["--worktree=a b", "--help"]), Some(Worktree::New(None)));
    }

    #[test]
    fn the_two_worktree_options_exclude_each_other_unless_the_line_asks_for_help_or_plain() {
        assert_eq!(error(&["--worktree", "--no-worktree"]), ("options --worktree and --no-worktree are mutually exclusive".to_owned(), false));
        let invocation = line(&["--worktree", "--no-worktree", "--plain"]);
        assert_eq!((invocation.kind, invocation.options.unwrap().worktree), (Kind::Plain, None));
    }

    #[test]
    fn an_unknown_option_is_refused_and_skips_the_host_only_on_an_exec_line() {
        assert_eq!(error(&["--bogus"]), ("unknown option --bogus".to_owned(), false));
        assert_eq!(error(&["-"]).0, "unknown option -");
        assert_eq!(error(&["exec", "--bogus", "hi"]), ("unknown option --bogus".to_owned(), true));
        assert!(error(&["--provider", "p", "exec", "--bogus"]).1);
        assert!(!error(&["--bogus", "--react"]).1);
        // After `--` everything is a word.
        assert_eq!(line(&["exec", "--", "--bogus"]).kind, exec(&["--bogus"]));
    }

    #[test]
    fn help_plain_and_react_win_in_that_order_and_help_forgives_the_rest() {
        assert_eq!(line(&["--react", "--plain", "--help"]).kind, Kind::Help);
        assert_eq!(line(&["-h", "--provider"]).kind, Kind::Help);
        assert_eq!(line(&["--react", "--plain"]).kind, Kind::Plain);
        assert_eq!(line(&["--react", "exec", "hi"]).kind, Kind::React);
        assert!(!line(&["--help"]).skip_host_prelude);
        // Flags are read from the whole line, past a `--` too.
        assert_eq!(line(&["--", "--help"]).kind, Kind::Help);
    }

    /// The table `bin/invocation.mjs` (the npm launcher's own reading of `skipHostPrelude`) is tested against too.
    #[test]
    fn the_launchers_prelude_table_is_what_classify_answers() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../tests/prelude-cases.json")).unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let words: Vec<&str> = case["argv"].as_array().unwrap().iter().map(|word| word.as_str().unwrap()).collect();
            assert_eq!(line(&words).skip_host_prelude, case["skip"].as_bool().unwrap(), "{words:?}");
        }
    }

    #[test]
    fn each_flag_and_route_option_sets_its_own_option_wherever_it_stands_and_repeating_a_flag_changes_nothing() {
        let options = line(&["--fast", "--effort", "high", "--web-search", "--provider", "anthropic", "--remote", "--onboarding", "--model", "m", "--fast"])
            .options
            .unwrap();
        assert_eq!(
            (options.fast, options.web_search, options.remote, options.force_onboarding, options.json, options.tool_mode),
            (true, true, true, true, false, ToolMode::Full)
        );
        assert_eq!((options.effort.as_deref(), options.provider.as_deref(), options.model.as_deref()), (Some("high"), Some("anthropic"), Some("m")));
        // An exec keeps the options that it supports, `--json` among them.
        let invocation = line(&["exec", "--json", "--fast", "go"]);
        assert_eq!(invocation.kind, exec(&["go"]));
        let options = invocation.options.unwrap();
        assert!(options.json && options.fast);
    }

    #[test]
    fn an_exec_message_is_the_words_after_the_verb_as_given_whatever_they_hold() {
        assert_eq!(line(&["exec", "안녕", "  세계 ", "😀"]).kind, exec(&["안녕", "  세계 ", "😀"]));
        assert_eq!(line(&["exec", "--", "--json", "-x"]).kind, exec(&["--json", "-x"]), "after `--` every word is text");
        assert_eq!(error(&["exec", "  ", ""]), ("usage: mixdog exec [options] <message...>".to_owned(), true), "words that join to blank are no message");
        assert_eq!(line(&["--", "-x"]).kind, Kind::General, "a word after `--` that looks like an option is text, not an unknown option");
    }

    #[test]
    fn an_option_the_exec_does_not_have_is_refused_before_the_host_with_its_name() {
        assert_eq!(error(&["exec", "--tool-mode", "readonly", "hi"]), ("unknown option --tool-mode".to_owned(), true));
        assert_eq!(error(&["--bogus", "exec", "hi"]), ("unknown option --bogus".to_owned(), true));
    }

    #[test]
    fn the_read_only_flag_sets_the_tool_mode() {
        assert_eq!(line(&["--readonly"]).options.unwrap().tool_mode, ToolMode::Readonly);
    }
}
