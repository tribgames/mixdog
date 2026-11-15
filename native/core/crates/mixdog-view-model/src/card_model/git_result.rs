//! The git tool's result headers (`shared/tool-card-model/git-result.mjs`). The exit and error readers live with the other
//! result shapes in `results::git_media`; this module adds the call's terminal status.

pub use crate::results::git_media::git_result_error;
pub use crate::results::git_media::git_result_exit_code;
use crate::tool_status::has_benign_exit_outcome;

/// `gitTerminalStatus`: a tool error fails the call; a git process that ran and exited non-zero is a command exit, like the
/// shell's, unless the tool marked the exit a signal.
pub fn git_terminal_status(text: &str) -> &'static str {
    if !git_result_error(text).is_empty() {
        return "failed";
    }
    if git_result_exit_code(text).is_some() && !has_benign_exit_outcome(text) {
        return "exit";
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_statuses() {
        assert_eq!(git_terminal_status("error: command failed: git x"), "failed");
        assert_eq!(git_terminal_status("## main\nexit 1\nout"), "exit");
        assert_eq!(git_terminal_status("exit 1\n[outcome: no-change]"), "");
        assert_eq!(git_terminal_status("fine"), "");
    }
}
