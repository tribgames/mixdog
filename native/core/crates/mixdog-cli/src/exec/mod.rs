//! `mixdogd exec`: the headless one-shot (`src/headless-exec.mjs`, `src/headless-command.mjs`).
//!
//! Ask once, re-ask with an empty prompt for background completions that already arrived, never
//! wait for running background work, shut down in order, and leave the answer on stdout, errors on
//! stderr, the usage document rewritten after every model response, and, with `--json`, the
//! lifecycle events. The core it runs on is its own, on a pristine root.

pub mod boundary;
pub mod feed;
pub mod launcher;
pub mod lifecycle;
pub mod route;
pub mod run;
pub mod seams;
pub mod usage;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;

use clap::Args;
use mixdog_core::run_host::tool_pool::session_create::worktree_name_error;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use serde_json::Value;

/// Where the exec writes: the answer (or the JSON events) and its errors.
pub trait Sink: Send + Sync {
    fn out(&self, text: &str);
    fn err(&self, text: &str);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolMode {
    Readonly,
    Full,
}

impl ToolMode {
    /// The value of `--tool-mode`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "full" => Some(Self::Full),
            "readonly" => Some(Self::Readonly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Readonly => "readonly",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Route {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub fast: bool,
}

#[derive(Debug, Clone)]
pub struct ExecOptions {
    pub message: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    /// `--provider-config`: the one custom provider the run may use (decision B-8; Node's exec has no such option).
    pub provider_config: Option<String>,
    pub web_search: bool,
    pub json: bool,
    pub cwd: PathBuf,
    pub usage_log: Option<PathBuf>,
    pub tool_mode: ToolMode,
}

/// `mixdogd exec [options] <message...>`.
// clap only collects the words, as the OS gave them (a path need not be Unicode); they are read as Node reads
// `mixdog exec`'s (`parseTokens` and `classifyCliInvocation`, `headless-command.mjs`), `--help` included.
#[derive(Args, Debug)]
#[command(disable_help_flag = true)]
pub struct ExecArgs {
    /// The options and the message, in any order; `--` ends the options. --provider <name>, --model <name>, --effort
    /// <level>, --fast, --web-search (web research stays off unless asked for), --json (the lifecycle events as JSON
    /// lines), --cwd <dir> (default: the current one), --usage-log <file> (default: $MIXDOG_USAGE_LOG), --tool-mode
    /// full|readonly, --provider-config <file-or-json> ({"custom-x": {...}}: the one custom provider the run may use).
    #[arg(allow_hyphen_values = true, value_name = "ARGS")]
    argv: Vec<OsString>,
    /// The message after a `--` that comes first, which clap takes for itself.
    #[arg(last = true, value_name = "MESSAGE")]
    escaped: Vec<OsString>,
}

/// What an exec's command line asks for: Node's `help`, `plain`, `react` and `exec` kinds (`classifyCliInvocation`).
#[derive(Debug)]
pub enum Invocation {
    /// `--help` or `-h` anywhere on the line: the usage (`printHelp`).
    Help,
    /// `--plain` (without help): Node starts its readline REPL, which `mixdogd` does not have.
    Plain,
    /// `--react` (without help or plain): Node's removed-flag refusal.
    React,
    Run(ExecOptions),
}

/// `printHelp`'s text (`src/help.mjs`), as Node prints it.
pub const HELP_TEXT: &str = include_str!("help.txt");

/// What `--react` prints to stderr, with exit 1 (`run`, `app.mjs`).
pub const REACT_REMOVED: &str = "mixdog: --react was removed; run `mixdog` for the canonical TUI.
";

/// The options that take the next word as their value (`VALUE_OPTIONS`), with the core's `--cwd`, `--usage-log` and `--provider-config` (B-8).
const VALUE_OPTIONS: [&str; 7] = ["--provider", "--model", "--effort", "--workflow", "--cwd", "--usage-log", "--provider-config"];
const FLAG_OPTIONS: [&str; 12] = [
    "--no-worktree",
    "--readonly",
    "--help",
    "-h",
    "--plain",
    "--react",
    "--remote",
    "--onboarding",
    "--fast",
    "--web-search",
    "--memory",
    "--json",
];
/// The interactive CLI's flags an exec refuses, in Node's order (`EXEC_UNSUPPORTED_FLAGS`).
const UNSUPPORTED_FLAGS: [&str; 5] = ["--readonly", "--remote", "--onboarding", "--memory", "--no-worktree"];
const WORKTREE_OPTION: &str = "--worktree";
const WORKFLOW_REFUSAL: &str = "option --workflow is not supported for mixdog exec";

/// An exec's words as `parseTokens` reads them: the message words, the first value of each value option (the index of
/// its word), the tool mode and whether `--worktree` was given.
#[derive(Default)]
struct Tokens<'a> {
    positional: Vec<&'a str>,
    values: BTreeMap<&'static str, usize>,
    tool_mode: Option<ToolMode>,
    worktree: bool,
}

/// `roleKey(value) === 'exec'`.
fn is_exec(value: &str) -> bool {
    js_to_lowercase(js_trim(value)) == "exec"
}

/// `JSON.stringify(word)`, as a refusal quotes it.
fn quoted(word: &str) -> String {
    json_stringify(&Value::from(word))
}

/// `parseTokens`: an option counts wherever it stands, only `--` ends the options. A `strict` line refuses a missing value,
/// an invalid worktree name and (unless it carries `--react`) the exec verb as a route value; a line that asks for help or
/// `--plain` (not strict) skips them.
fn parse_tokens(argv: &[String], strict: bool) -> Result<Tokens<'_>, String> {
    let headless_intent = strict && !argv.iter().any(|arg| arg == "--react");
    let mut tokens = Tokens::default();
    let mut index = 0;
    while let Some(arg) = argv.get(index).map(String::as_str) {
        let next = argv.get(index + 1).map(String::as_str);
        // `isWorktreeOption`: `--worktree`, or `--worktree=<name>`.
        if let Some(rest) = arg.strip_prefix(WORKTREE_OPTION).filter(|rest| rest.is_empty() || rest.starts_with('=')) {
            let name = match rest.strip_prefix('=') {
                Some(name) => Some(name),
                // `worktreeNameToken`: the next word is the name unless it is an option or the exec verb.
                None => {
                    let name = next.filter(|name| !name.is_empty() && !name.starts_with('-') && !is_exec(name));
                    index += usize::from(name.is_some());
                    name
                }
            };
            let invalid = name.filter(|_| strict).and_then(|name| worktree_name_error(&Value::from(name)).map(|error| (name, error)));
            if let Some((name, error)) = invalid {
                return Err(format!("option --worktree name {} is invalid: {error}", quoted(name)));
            }
            tokens.worktree = true;
        } else if let Some(option) = VALUE_OPTIONS.into_iter().find(|option| *option == arg) {
            match next.filter(|value| !value.is_empty() && !value.starts_with('-')) {
                None if strict => return Err(format!("option {option} requires a non-option value")),
                None => {}
                Some(value) => {
                    if headless_intent && is_exec(value) {
                        if option == "--workflow" {
                            return Err(WORKFLOW_REFUSAL.into());
                        }
                        if matches!(option, "--provider" | "--model" | "--effort") {
                            return Err(format!("option {option} requires a route value before {}", quoted(value)));
                        }
                    }
                    tokens.values.entry(option).or_insert(index + 1);
                    index += 1;
                }
            }
        } else if arg == "--tool-mode" {
            // The core's spelling of the read-only runtime Node's one caller builds (the pptx `review-deck.mjs` passes a
            // `runtimeFactory` with `toolMode: 'readonly'`). Node's exec has no such option: any other use is its refusal.
            let mode = next.and_then(ToolMode::parse).ok_or_else(|| "unknown option --tool-mode".to_owned())?;
            tokens.tool_mode.get_or_insert(mode);
            index += 1;
        } else if arg == "--" {
            tokens.positional.extend(argv[index + 1..].iter().map(String::as_str));
            break;
        } else if !arg.starts_with('-') {
            tokens.positional.push(arg);
        } else if !FLAG_OPTIONS.contains(&arg) {
            return Err(format!("unknown option {arg}"));
        }
        index += 1;
    }
    Ok(tokens)
}

impl ExecArgs {
    /// What the command line asks for (`classifyCliInvocation`, `execFromPositional`), else the refusal (printed as
    /// `mixdog: <text>`).
    pub fn into_invocation(self, usage_log_env: Option<String>) -> Result<Invocation, String> {
        let mut words = self.argv;
        if !self.escaped.is_empty() {
            words.push("--".into());
            words.extend(self.escaped);
        }
        // Every word is read as text; a path option's value stays the word the OS gave.
        let argv: Vec<String> = words.iter().map(|word| word.to_string_lossy().into_owned()).collect();
        // Node reads a flag with `argv.includes`: anywhere on the line, past a `--` too.
        let given = |flag: &str| argv.iter().any(|arg| arg == flag);
        let help = given("--help") || given("-h");
        let plain = given("--plain");
        let tokens = parse_tokens(&argv, !help && !plain)?;
        if help {
            return Ok(Invocation::Help);
        }
        if plain {
            return Ok(Invocation::Plain);
        }
        if tokens.worktree && given("--no-worktree") {
            return Err("options --worktree and --no-worktree are mutually exclusive".into());
        }
        if given("--react") {
            return Ok(Invocation::React);
        }
        let message = js_trim(&tokens.positional.join(" ")).to_owned();
        if message.is_empty() {
            return Err("usage: mixdog exec [options] <message...>".into());
        }
        if tokens.values.contains_key("--workflow") {
            return Err(WORKFLOW_REFUSAL.into());
        }
        let unsupported = UNSUPPORTED_FLAGS.into_iter().find(|&flag| given(flag)).or(tokens.worktree.then_some(WORKTREE_OPTION));
        if let Some(flag) = unsupported {
            return Err(format!("option {flag} is not supported for mixdog exec"));
        }
        let value = |option: &str| tokens.values.get(option).map(|&index| argv[index].clone());
        let path = |option: &str| tokens.values.get(option).map(|&index| PathBuf::from(&words[index]));
        let cwd = match path("--cwd") {
            Some(cwd) => cwd,
            None => std::env::current_dir().map_err(|err| format!("the working directory: {err}"))?,
        };
        Ok(Invocation::Run(ExecOptions {
            message,
            provider: value("--provider"),
            model: value("--model"),
            effort: value("--effort"),
            fast: given("--fast"),
            provider_config: value("--provider-config"),
            web_search: given("--web-search"),
            json: given("--json"),
            cwd,
            usage_log: path("--usage-log").or_else(|| usage_log_env.map(PathBuf::from)),
            tool_mode: tokens.tool_mode.unwrap_or(ToolMode::Full),
        }))
    }
}
