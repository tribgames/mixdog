//! `mixdogd exec`: the headless one-shot (`src/headless-exec.mjs`, `src/headless-command.mjs`).
//!
//! Ask once, re-ask with an empty prompt for background completions that already arrived, never
//! wait for running background work, shut down in order, and leave the answer on stdout, errors on
//! stderr, the usage document rewritten after every model response, and, with `--json`, the
//! lifecycle events. The core it runs on is its own, on a pristine root.
#![allow(dead_code, reason = "the composition root's launcher and credential lookups attach to this flow when they land")]

pub mod boundary;
pub mod feed;
pub mod lifecycle;
pub mod route;
pub mod run;
pub mod seams;
pub mod usage;

#[cfg(test)]
mod tests;

use std::path::PathBuf;

use clap::Args;
use mixdog_js::js_trim;

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
    pub web_search: bool,
    pub json: bool,
    pub cwd: PathBuf,
    pub usage_log: Option<PathBuf>,
    pub tool_mode: ToolMode,
}

/// `mixdogd exec [options] <message...>`.
#[derive(Args, Debug)]
pub struct ExecArgs {
    #[arg(long)]
    provider: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    effort: Option<String>,
    #[arg(long)]
    fast: bool,
    /// Web research stays off unless asked for.
    #[arg(long)]
    web_search: bool,
    /// Stream the lifecycle events as JSON lines.
    #[arg(long)]
    json: bool,
    /// The working directory of the run (default: the current one).
    #[arg(long)]
    cwd: Option<PathBuf>,
    /// Where the usage document is rewritten (default: `$MIXDOG_USAGE_LOG`).
    #[arg(long)]
    usage_log: Option<PathBuf>,
    /// `full` (default) or `readonly`: the read-only tool surface. Node's exec has no such option: its runtime is always
    /// created `full`, and the one caller that wants a read-only run (the pptx `review-deck.mjs`) passes a `runtimeFactory`
    /// that re-creates the runtime with `toolMode: 'readonly'`; `mixdog exec --readonly` is refused (below). This is the
    /// daemon-side spelling of that factory.
    #[arg(long)]
    tool_mode: Option<String>,
    // The interactive CLI's options an exec refuses, kept so the refusal reads as Node's.
    #[arg(long, hide = true)]
    workflow: Option<String>,
    #[arg(long, hide = true)]
    readonly: bool,
    #[arg(long, hide = true)]
    remote: bool,
    #[arg(long, hide = true)]
    onboarding: bool,
    #[arg(long, hide = true)]
    memory: bool,
    #[arg(long, hide = true)]
    no_worktree: bool,
    #[arg(long, hide = true, num_args = 0..=1, default_missing_value = "")]
    worktree: Option<String>,
    #[arg(trailing_var_arg = true)]
    message: Vec<String>,
}

impl ExecArgs {
    /// The options of a valid invocation, else the refusal (printed as `mixdog: <text>`).
    pub fn into_options(self, usage_log_env: Option<String>) -> Result<ExecOptions, String> {
        let message = js_trim(&self.message.join(" ")).to_owned();
        if message.is_empty() {
            return Err("usage: mixdog exec [options] <message...>".into());
        }
        if self.workflow.is_some() {
            return Err("option --workflow is not supported for mixdog exec".into());
        }
        let unsupported = [
            (self.readonly, "--readonly"),
            (self.remote, "--remote"),
            (self.onboarding, "--onboarding"),
            (self.memory, "--memory"),
            (self.no_worktree, "--no-worktree"),
            (self.worktree.is_some(), "--worktree"),
        ];
        if let Some((_, flag)) = unsupported.iter().find(|(set, _)| *set) {
            return Err(format!("option {flag} is not supported for mixdog exec"));
        }
        let tool_mode = match self.tool_mode.as_deref() {
            None => ToolMode::Full,
            // Any other value is an option Node's exec does not know (`unknown option --tool-mode`, `headless-command.mjs`).
            Some(value) => ToolMode::parse(value).ok_or_else(|| "unknown option --tool-mode".to_owned())?,
        };
        let cwd = match self.cwd {
            Some(cwd) => cwd,
            None => std::env::current_dir().map_err(|err| format!("the working directory: {err}"))?,
        };
        let usage_log = self.usage_log.or_else(|| usage_log_env.map(PathBuf::from));
        Ok(ExecOptions {
            message,
            provider: self.provider,
            model: self.model,
            effort: self.effort,
            fast: self.fast,
            web_search: self.web_search,
            json: self.json,
            cwd,
            usage_log,
            tool_mode,
        })
    }
}
