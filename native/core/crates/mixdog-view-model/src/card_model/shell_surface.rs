//! The shell/run tool family: its status merge and header (`shared/tool-card-model/shell-surface.mjs`).

use mixdog_js::js_to_lowercase;
use mixdog_js::number_to_string;

use super::terminal_status::shell_result_status;
use crate::tool_primitives::pluralize;

/// `isShellTool`.
pub fn is_shell_tool(normalized_name: &str, label: &str) -> bool {
    let n = js_to_lowercase(normalized_name);
    matches!(n.as_str(), "shell" | "bash" | "bash_session" | "shell_command" | "job_wait") || js_to_lowercase(label) == "run"
}

/// The inputs of [`shell_display_status`].
#[derive(Clone, Copy, Debug, Default)]
pub struct ShellStatusInput<'a> {
    pub pending: bool,
    pub failed_count: f64,
    pub exit_failed_count: f64,
    pub is_error: bool,
    pub result: &'a str,
}

/// `shellDisplayStatus`: `running`, `cancelled`, `failed`, `exit` (the command ran but exited non-zero) or `completed`.
pub fn shell_display_status(input: &ShellStatusInput) -> &'static str {
    let status = shell_result_status(input.result);
    if input.pending || matches!(status.as_str(), "running" | "pending" | "queued") {
        return "running";
    }
    if status.starts_with("cancel") {
        return "cancelled";
    }
    if matches!(status.as_str(), "failed" | "error" | "killed" | "timeout") {
        return "failed";
    }
    // A command that RAN but exited non-zero is a command failure, not a failed tool invocation: it renders the warning
    // state unless a real tool failure also exists in the group.
    let real_failed = (input.failed_count - input.exit_failed_count).max(0.0);
    if real_failed > 0.0 {
        return "failed";
    }
    if input.exit_failed_count > 0.0 {
        return "exit";
    }
    if input.is_error || input.failed_count > 0.0 {
        return "failed";
    }
    "completed"
}

/// `shellHeader`: "Ran 2 commands"; a shell that follows an edit in the same batch is the verification and is labelled so
/// while healthy.
pub fn shell_header(status: &str, count: f64, verifying: bool) -> String {
    let n = if count.is_nan() || count == 0.0 { 1.0 } else { count }.max(1.0);
    let object = format!("{} {}", number_to_string(n), pluralize(n, "command", "commands"));
    if verifying && status == "running" {
        return format!("Verifying {object}");
    }
    if verifying && status == "completed" {
        return format!("Verified {object}");
    }
    if status == "running" {
        return format!("Running {object}");
    }
    format!("Ran {object}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_surfaces_and_headers() {
        assert!(is_shell_tool("bash", ""));
        assert!(is_shell_tool("read", "Run"));
        assert!(!is_shell_tool("read", "Read"));
        assert_eq!(shell_header("completed", 2.0, true), "Verified 2 commands");
        assert_eq!(shell_header("running", 1.0, false), "Running 1 command");
        assert_eq!(shell_header("exit", 0.0, true), "Ran 1 command");
    }

    #[test]
    fn shell_status_separates_exits_from_failures() {
        let status = |input: ShellStatusInput| shell_display_status(&input);
        assert_eq!(status(ShellStatusInput { pending: true, ..Default::default() }), "running");
        assert_eq!(status(ShellStatusInput { result: "status: cancelled", ..Default::default() }), "cancelled");
        assert_eq!(status(ShellStatusInput { result: "status: failed", ..Default::default() }), "failed");
        assert_eq!(status(ShellStatusInput { failed_count: 1.0, exit_failed_count: 1.0, ..Default::default() }), "exit");
        assert_eq!(status(ShellStatusInput { failed_count: 2.0, exit_failed_count: 1.0, ..Default::default() }), "failed");
        assert_eq!(status(ShellStatusInput { is_error: true, ..Default::default() }), "failed");
        assert_eq!(status(ShellStatusInput::default()), "completed");
    }
}
