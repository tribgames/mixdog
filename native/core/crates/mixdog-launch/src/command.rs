//! What the terminal program's command line and `mixdogd exec`'s share (`headless-command.mjs`, `app.mjs`): the exec verb, how a
//! refusal quotes a word, the tool modes, the usage and the removed flag's line; the words an exec the terminal program read is
//! handed to `mixdogd exec` with; and the helper subcommands a core starts its own program with.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use serde_json::Value;

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

/// `printHelp`'s text (`src/help.mjs`), as Node prints it.
pub const HELP_TEXT: &str = include_str!("help.txt");

/// What `--react` prints to stderr, with exit 1 (`run`, `app.mjs`).
pub const REACT_REMOVED: &str = "mixdog: --react was removed; run `mixdog` for the canonical TUI.\n";

/// The subcommands of the helper processes a core starts as its own program (`mixdog_cli::helpers::Helper`).
pub const HELPER_SUBCOMMANDS: [&str; 8] =
    ["embedding-host", "effort-judge-host", "ext-worker", "graph-worker", "search-worker", "office-com-host", "acp-mcp-bridge", "skill-run"];

/// `roleKey(value) === 'exec'`.
pub fn is_exec(value: &str) -> bool {
    js_to_lowercase(js_trim(value)) == "exec"
}

/// `JSON.stringify(word)`, as a refusal quotes it.
pub fn quoted(word: &str) -> String {
    json_stringify(&Value::from(word))
}

/// An exec the terminal program read and accepted: its message and the options an exec takes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecLine {
    /// The words of the message as the line gave them, which `mixdogd exec` joins as this program's reading does. A word that
    /// reads as a flag only once trimmed (` --help`) stays one `mixdogd` does not take for the flag.
    pub message: Vec<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub web_search: bool,
    pub json: bool,
}

impl ExecLine {
    /// The words after `mixdogd` that ask it for this exec: the subcommand, each option given, and the message's words after `--`,
    /// so none of them reads as an option's value.
    pub fn words(&self) -> Vec<String> {
        let mut words = vec!["exec".to_owned()];
        for (option, value) in [("--provider", &self.provider), ("--model", &self.model), ("--effort", &self.effort)] {
            if let Some(value) = value {
                words.extend([option.to_owned(), value.clone()]);
            }
        }
        for (flag, given) in [("--fast", self.fast), ("--web-search", self.web_search), ("--json", self.json)] {
            if given {
                words.push(flag.to_owned());
            }
        }
        words.push("--".to_owned());
        words.extend(self.message.iter().cloned());
        words
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exec_is_handed_on_as_its_options_then_its_message_after_the_end_of_the_options() {
        let line = ExecLine {
            message: vec!["-x".to_owned(), " is text ".to_owned()],
            provider: Some("anthropic".to_owned()),
            effort: Some("high".to_owned()),
            fast: true,
            json: true,
            ..ExecLine::default()
        };
        assert_eq!(line.words(), ["exec", "--provider", "anthropic", "--effort", "high", "--fast", "--json", "--", "-x", " is text "]);
        assert_eq!(ExecLine { message: vec!["hi".to_owned()], ..ExecLine::default() }.words(), ["exec", "--", "hi"]);
    }
}
