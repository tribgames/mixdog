//! The limits every engine module shares (`apps/desktop/src/main/browser/command.ts`, the contract and limits part) and
//! the action sets that file derives from the command contract.

use std::time::Duration;

/// A whole command, from the queue to its reply.
pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(42_000);
/// One CDP request through `host/browser/cdp/send` and the typed calls.
pub const CDP_REQUEST_TIMEOUT: Duration = Duration::from_millis(12_000);
/// How long the page stays quiet before a gesture counts as settled.
pub const ACTION_SETTLE_QUIET: Duration = Duration::from_millis(350);
pub const ACTION_SETTLE_LOAD_TIMEOUT: Duration = Duration::from_millis(8_000);
pub const ACTION_SETTLE_DOM_TIMEOUT: Duration = Duration::from_millis(1_500);
pub const NAVIGATE_SETTLE_TIMEOUT: Duration = Duration::from_millis(20_000);
pub const OPEN_SURFACE_TIMEOUT: Duration = Duration::from_millis(8_000);
pub const BACKGROUND_RECLAIM_INTERVAL: Duration = Duration::from_millis(60_000);
pub const SCREENSHOT_TIMEOUT: Duration = Duration::from_millis(8_000);
pub const SCREENSHOT_FALLBACK_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Custom dropdowns paint their popup from page scripts: polled instead of a fixed delay.
pub const CUSTOM_DROPDOWN_TIMEOUT: Duration = Duration::from_millis(400);
pub const CUSTOM_DROPDOWN_POLL: Duration = Duration::from_millis(25);
pub const POSTCONDITION_POLL: Duration = Duration::from_millis(100);

/// Elements a snapshot lists by default.
pub const SNAPSHOT_MAX_ELEMENTS: usize = 160;
/// The most elements a snapshot call may ask for.
pub const SNAPSHOT_TOOL_MAX_ELEMENTS: usize = 500;
pub const SNAPSHOT_TEXT_CHARS: usize = 2_400;
pub const READ_DEFAULT_CHARS: usize = 8_000;
pub const READ_MAX_CHARS: usize = 30_000;
pub const EVALUATE_DEFAULT_CHARS: usize = 12_000;
pub const MAX_EVALUATE_SCRIPT_CHARS: usize = 100_000;
pub const DOWNLOAD_ATTACH_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_CHILD_CDP_SESSIONS: usize = 64;
pub const MAX_PRINTED_PDF_BYTES: u64 = 100 * 1024 * 1024;
pub const EXTRACT_DEFAULT_LIMIT: usize = 50;
pub const EXTRACT_MAX_LIMIT: usize = 200;
pub const EXTRACT_DEFAULT_CHARS: usize = 12_000;
/// Commands the engine runs at once across all pages (`MAX_CONCURRENT_BROWSER_COMMANDS` of `host/browser-command.ts`).
pub const MAX_CONCURRENT: usize = 32;

/// Offscreen (background) page viewport: fixed and generous so fixed-width desktop layouts render without a scrollbar the agent cannot see.
pub const OFFSCREEN_VIEWPORT: (u32, u32) = (1280, 900);

/// Actions whose reply carries a verified postcondition (`BROWSER_POSTCONDITION_ACTIONS` of the command contract).
pub const POSTCONDITION_ACTIONS: &[&str] = &[
    "navigate", "evaluate", "emulate", "click", "fill", "type", "select", "hover", "drag", "upload", "handle_dialog", "press", "scroll", "back",
    "sequence",
];
/// Observations (`BROWSER_OBSERVATION_ACTIONS` of the command contract); the pure ones may overlap, the snapshot-producing ones need the page's exclusive lane.
pub const OBSERVATION_ACTIONS: &[&str] = &["snapshot", "read", "extract", "locate", "status", "console", "network", "list_tabs", "downloads", "wait"];
/// Observations that write the ref/visual generation and so are not read-only.
pub const SNAPSHOT_WRITING_ACTIONS: &[&str] = &["snapshot", "locate", "wait"];
/// Gestures a sequence may chain (`BROWSER_SEQUENCE_STEP_ACTIONS`).
pub const SEQUENCE_STEP_ACTIONS: &[&str] = &["click", "fill", "type", "select", "hover", "press", "scroll", "wait"];
/// Bookkeeping actions that address a session, never a page.
pub const TABLESS_ACTIONS: &[&str] = &["list_tabs", "downloads", "close_tab", "hide"];
/// Actions that may run while a JavaScript dialog blocks the page; anything else is refused up front instead of dispatching a ghost gesture.
pub const DIALOG_TOLERANT_ACTIONS: &[&str] = &["handle_dialog", "status", "console", "network"];
/// Gestures whose reply says when the page did not react to them.
pub const EFFECT_REPORT_ACTIONS: &[&str] = &["click", "fill", "type", "select", "drag", "upload", "handle_dialog", "press", "scroll", "sequence"];

/// Observations that can overlap on one page.
pub fn is_read_only_action(action: &str) -> bool {
    OBSERVATION_ACTIONS.contains(&action) && !SNAPSHOT_WRITING_ACTIONS.contains(&action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_actions_leave_out_the_snapshot_writers() {
        assert!(is_read_only_action("read"));
        assert!(is_read_only_action("console"));
        assert!(!is_read_only_action("snapshot"));
        assert!(!is_read_only_action("wait"));
        assert!(!is_read_only_action("click"));
    }

    #[test]
    fn the_values_are_the_typescript_ones() {
        assert_eq!(COMMAND_TIMEOUT.as_millis(), 42_000);
        assert_eq!(CDP_REQUEST_TIMEOUT.as_millis(), 12_000);
        assert_eq!(ACTION_SETTLE_QUIET.as_millis(), 350);
        assert_eq!(SNAPSHOT_MAX_ELEMENTS, 160);
        assert_eq!(MAX_CHILD_CDP_SESSIONS, 64);
        assert!(SEQUENCE_STEP_ACTIONS.iter().all(|step| POSTCONDITION_ACTIONS.contains(step) || OBSERVATION_ACTIONS.contains(step)));
    }
}
