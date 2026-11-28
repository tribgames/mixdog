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
pub mod profile;
pub mod route;
pub mod run;
pub mod seams;
pub mod usage;

#[cfg(test)]
mod tests;

use mixdog_rt::Backend;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Args;
use mixdog_acp::preset::AgentPreset;
use mixdog_core::run_host::tool_pool::session_create::worktree_name_error;
use mixdog_js::js_trim;
use mixdog_rt::TaskClass;
use serde_json::Value;

pub use mixdog_launch::command::HELP_TEXT;
pub use mixdog_launch::command::REACT_REMOVED;
pub use mixdog_launch::command::ToolMode;
pub use mixdog_launch::command::is_exec;
pub use mixdog_launch::command::quoted;

/// Where the exec writes: the answer (or the JSON events) and its errors.
pub trait Sink: Send + Sync {
    fn out(&self, text: &str);
    fn err(&self, text: &str);
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
    /// `--route-profile`: the agent roles' routes and the Lead's fallback (`profile.rs`).
    pub route_profile: Option<String>,
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
    /// full|readonly, --provider-config <file-or-json> ({"custom-x": {...}}: the one custom provider the run may use),
    /// --route-profile <file-or-json> ({"routes": {"worker": {...}, ...}, "leadFallback": {...}}: the agent roles' routes
    /// and the Lead's fallback).
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

/// The options that take the next word as their value (`VALUE_OPTIONS`), with the core's `--cwd`, `--usage-log`, `--provider-config` (B-8)
/// and `--route-profile`.
const VALUE_OPTIONS: [&str; 8] = ["--provider", "--model", "--effort", "--workflow", "--cwd", "--usage-log", "--provider-config", "--route-profile"];
const FLAG_OPTIONS: [&str; 12] =
    ["--no-worktree", "--readonly", "--help", "-h", "--plain", "--react", "--remote", "--onboarding", "--fast", "--web-search", "--memory", "--json"];
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

/// Writes the exec's answer and errors to this process's stdout and stderr.
pub struct StdSink;

impl Sink for StdSink {
    fn out(&self, text: &str) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    fn err(&self, text: &str) {
        use std::io::Write;
        let _ = std::io::stderr().lock().write_all(text.as_bytes());
    }
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
            route_profile: value("--route-profile"),
            web_search: given("--web-search"),
            json: given("--json"),
            cwd,
            usage_log: path("--usage-log").or_else(|| usage_log_env.map(PathBuf::from)),
            tool_mode: tokens.tool_mode.unwrap_or(ToolMode::Full),
        }))
    }
}
/// The providers whose host credentials the run looks up: the Lead's and every one the route profile names, once each. An ACP
/// agent's is none: its CLI signs in on its own.
fn credential_providers(options: &ExecOptions, agent_presets: &[AgentPreset]) -> Vec<String> {
    let mut providers: Vec<String> = Vec::new();
    let named = std::iter::once(route::clean(options.provider.as_deref()).to_owned())
        .chain(options.route_profile.as_deref().map(profile::providers_named).unwrap_or_default());
    for provider in named {
        if !providers.contains(&provider) && !agent_presets.iter().any(|preset| preset.provider == provider) {
            providers.push(provider);
        }
    }
    providers
}

/// Refuses an unusable explicit route as Node does before anything starts (`validateExplicitPristineRoute`, printed as
/// `mixdog: <text>`, exit 1), then runs the exec on its own core on this thread (`runHeadlessExec`) and returns its exit code.
pub fn run_command(options: ExecOptions) -> i32 {
    if let Err(refusal) = route::validate_explicit_route(options.provider.as_deref(), options.model.as_deref(), options.effort.as_deref()) {
        eprintln!("mixdog: {refusal}");
        return 1;
    }
    let js = match mixdog_app_server_daemon::js_runtime::resolve_current() {
        Ok(js) => js,
        Err(err) => {
            eprintln!("mixdog: resolving the JS runtime: {err}");
            return 1;
        }
    };
    // The host's own data folder (`resolvePluginData()`), where its credentials live; the run never writes to it.
    let Some(host_data_dir) = mixdog_store::paths::Paths::from_process(&js.package_root).map(|paths| paths.data_dir) else {
        eprintln!("mixdog: no data directory (set MIXDOG_DATA_DIR or HOME)");
        return 1;
    };
    let (executors, tokens) = match mixdog_app_server_daemon::boot_executors() {
        Ok(booted) => booted,
        Err(err) => {
            eprintln!("mixdog: starting the executors: {err}");
            return 1;
        }
    };
    let agent_presets = mixdog_app_server_daemon::acp_tools::builtin_presets();
    let providers = credential_providers(&options, &agent_presets);
    let credentials = executors.handle(TaskClass::Work).block_on(launcher::ResolvedCredentials::read(&tokens, &providers, &host_data_dir));
    let agents_dir = js.package_root.join("src").join("agents");
    // The exec's own thread: one, so the boundary's environment is applied while no other thread reads it.
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("mixdog: starting the async runtime: {err}");
            return 1;
        }
    };
    let ort_library = match mixdog_app_server_daemon::js_runtime::resolve_ort_library_current() {
        Ok(Some(library)) => mixdog_services::effort_judge::model::OrtRuntime::Library(library),
        Ok(None) => mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
        Err(err) => {
            eprintln!("mixdog: resolving the ONNX Runtime: {err}");
            return 1;
        }
    };
    let launcher = launcher::InProcessLauncher::new(executors, tokens, js, ort_library, agent_presets, &host_data_dir);
    let host = run::Host {
        launcher: &launcher,
        credentials: &credentials,
        host_env: std::env::vars().collect(),
        host_data_dir,
        agents_dir,
        temp_dir: std::env::temp_dir(),
        sink: Arc::new(StdSink),
        now: lifecycle::system_clock(),
    };
    // `installProcessSignalCleanup`: an interrupt ends the run with 130 after the shutdown.
    let signal: run::Signal = Box::pin(async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => 130,
            Err(_) => std::future::pending().await,
        }
    });
    let code = runtime.block_on(run::run_exec(options, host, signal));
    i32::from(u8::try_from(code).unwrap_or(1))
}
