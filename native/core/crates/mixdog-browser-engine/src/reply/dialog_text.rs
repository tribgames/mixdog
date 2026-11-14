//! Owner: s4-engine-reply
//! What the agent reads about JavaScript dialogs and about the state of a page (the text part of `dialog-report.ts`): the reply
//! of a dialog that blocks the page, the notice of a dialog the host dismissed unseen, and the `status` report. Answering a dialog
//! is a host call (`host/browser/page/dialog/answer`), made by the action that owns it.

use mixdog_app_protocol::v2::browser_engine::BrowserDismissedDialog;
use mixdog_app_protocol::v2::browser_engine::BrowserPendingDialog;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_browser_policy::redaction::redact_url;

use crate::ledger::ingest::PageLedgers;

use super::reply::ReplyOutcome;
use super::reply::ToolReply;
use super::reply::json_string;

/// The dialog type Chromium gives no text for and answers by itself.
const BEFORE_UNLOAD: &str = "beforeunload";

/// Why a dialog was dismissed unseen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DismissedReason {
    /// Its bridge request never reached the host (a page security policy can refuse it).
    Unreachable,
    /// It fired where the bridge was not yet installed and Chromium dismissed it.
    Early,
}

impl DismissedReason {
    /// The reason the host names (`reason` of a dismissed dialog); a host that names none (or another) is read as `Unreachable`.
    pub fn from_wire(reason: Option<&str>) -> Self {
        if reason == Some("early") { Self::Early } else { Self::Unreachable }
    }

    fn because(self) -> &'static str {
        match self {
            Self::Unreachable => "its request never reached the browser (a page security policy can refuse it)",
            Self::Early => "it opened before the browser was intercepting dialogs on this page",
        }
    }
}

/// A dialog the page opened that nobody was shown. The pane shows it as a notice; one reply reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DismissedNotice {
    pub kind: String,
    pub message: String,
    pub reason: DismissedReason,
    /// When the host dismissed it (epoch milliseconds): the identity of the notice across facts.
    pub at: i64,
    /// A reply already said so.
    pub reported: bool,
}

impl DismissedNotice {
    pub fn from_facts(dialog: &BrowserDismissedDialog) -> Self {
        Self {
            kind: dialog.kind.clone(),
            message: dialog.message.clone(),
            reason: DismissedReason::from_wire(dialog.reason.as_deref()),
            at: dialog.at,
            reported: false,
        }
    }
}

/// The page-report line for a dialog that was dismissed unseen (`describeDismissedDialog`).
pub fn describe_dismissed_dialog(dialog: &DismissedNotice) -> String {
    format!(
        "Dismissed {} dialog {}: {}, so nobody saw it and the page received a dismissal \
         (confirm returns false, prompt returns null). handle_dialog has nothing to answer.",
        dialog.kind,
        json_string(&redact_browser_text(&dialog.message)),
        dialog.reason.because()
    )
}

/// The reply that pre-empts a command while a dialog blocks the page (`dialogResult`). `dispatched` says whether this command's own
/// gesture already reached the page: the same dialog means opposite things to a caller that never replays, the action ran (and
/// likely opened it), or it was never sent. `redact` is the page's redaction.
pub fn blocking_dialog_reply(dialog: &BrowserPendingDialog, dispatched: bool, redact: &dyn Fn(&str) -> String) -> ToolReply {
    // Chromium supplies no text for a leave-confirmation and the choice is not symmetric: accepting discards whatever the page has
    // not saved.
    if dialog.kind == BEFORE_UNLOAD {
        return ToolReply {
            text: "The page refused to be left: it guards unsaved work with a leave confirmation, which Chromium answers by \
                   itself, so the navigation was abandoned and the page stayed. handle_dialog has nothing left to answer.\n\
                   Finish or discard what the page is holding — submit, reset, or clear the form — and navigate again; \
                   repeating the same navigation is refused the same way."
                .to_owned(),
            outcome: Some(ReplyOutcome::Blocked),
            ..ToolReply::default()
        };
    }
    let ran = if dispatched {
        "The action ran; do not repeat it. "
    } else {
        "This action was not sent; after handle_dialog, repeat it only if it is still needed. "
    };
    ToolReply {
        text: format!(
            "A {} dialog is blocking the page: {}\n{ran}Call handle_dialog with accept:true or accept:false before continuing.",
            dialog.kind,
            json_string(&redact(&dialog.message))
        ),
        outcome: Some(ReplyOutcome::Blocked),
        ..ToolReply::default()
    }
}

/// The `status` report: the page, its state, the requests in flight, a blocking dialog, and the recent faults (`diagnosticsResult`).
pub fn status_text(facts: &PageFacts, ledgers: &PageLedgers) -> String {
    let address = if facts.url.is_empty() { "about:blank" } else { facts.url.as_str() };
    let state = match facts.fault.as_deref().filter(|fault| !fault.is_empty()) {
        Some(fault) => fault,
        None if facts.loading => "loading",
        None => "ready",
    };
    let mut lines = vec![
        format!("Page: {} — {}", facts.page_id, redact_url(address)),
        format!("State: {state}"),
        format!("Pending requests: {}", ledgers.network.pending_count()),
    ];
    if let Some(dialog) = &facts.pending_dialog {
        lines.push(format!("Dialog: {} {}", dialog.kind, json_string(&redact_browser_text(&dialog.message))));
    }
    let console_errors = ledgers.console.recent_errors(10);
    if !console_errors.is_empty() {
        lines.push("Console errors:".to_owned());
        lines.extend(console_errors.iter().map(|entry| format!("- {entry}")));
    }
    if !ledgers.failures.is_empty() {
        lines.push("Network failures:".to_owned());
        let first = ledgers.failures.len().saturating_sub(10);
        lines.extend(ledgers.failures[first..].iter().map(|entry| format!("- {entry}")));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::fake::page_facts;

    fn dialog(kind: &str, message: &str) -> BrowserPendingDialog {
        serde_json::from_value(json!({"type": kind, "message": message, "openedAt": 1, "bridge": false})).expect("dialog")
    }

    fn facts(patch: serde_json::Value) -> PageFacts {
        let mut value = page_facts("p1", 1);
        if let (Some(target), Some(extra)) = (value.as_object_mut(), patch.as_object()) {
            target.extend(extra.clone());
        }
        serde_json::from_value(value).expect("facts")
    }

    fn keep(text: &str) -> String {
        text.to_owned()
    }

    #[test]
    fn a_blocking_dialog_says_whether_the_action_ran() {
        let confirm = dialog("confirm", "Delete \"x\"?");
        let ran = blocking_dialog_reply(&confirm, true, &keep);
        assert_eq!(ran.outcome, Some(ReplyOutcome::Blocked));
        assert_eq!(
            ran.text,
            "A confirm dialog is blocking the page: \"Delete \\\"x\\\"?\"\nThe action ran; do not repeat it. Call handle_dialog with accept:true or accept:false before continuing."
        );
        let unsent = blocking_dialog_reply(&confirm, false, &keep);
        assert!(unsent.text.contains("\nThis action was not sent; after handle_dialog, repeat it only if it is still needed. Call handle_dialog"));
    }

    #[test]
    fn a_blocking_dialog_message_is_redacted() {
        let reply = blocking_dialog_reply(&dialog("alert", "token abc"), true, &|text: &str| text.replace("abc", "[REDACTED]"));
        assert!(reply.text.contains("\"token [REDACTED]\""), "{}", reply.text);
    }

    #[test]
    fn a_leave_confirmation_is_reported_as_the_page_refusing_to_be_left() {
        let reply = blocking_dialog_reply(&dialog("beforeunload", ""), true, &keep);
        assert_eq!(reply.outcome, Some(ReplyOutcome::Blocked));
        assert!(reply.text.starts_with("The page refused to be left: it guards unsaved work with a leave confirmation"));
        assert!(reply.text.ends_with("repeating the same navigation is refused the same way."));
        assert!(reply.text.contains("handle_dialog has nothing left to answer.\nFinish or discard what the page is holding — submit, reset, or clear the form — and navigate again; "));
        assert_eq!(reply.text, blocking_dialog_reply(&dialog("beforeunload", ""), false, &keep).text);
    }

    #[test]
    fn a_dismissed_dialog_names_why_nobody_saw_it() {
        let notice = |reason| DismissedNotice { kind: "confirm".into(), message: "Sure?".into(), reason, at: 5, reported: false };
        assert_eq!(
            describe_dismissed_dialog(&notice(DismissedReason::Early)),
            "Dismissed confirm dialog \"Sure?\": it opened before the browser was intercepting dialogs on this page, so nobody saw it and the page received a dismissal (confirm returns false, prompt returns null). handle_dialog has nothing to answer."
        );
        assert!(describe_dismissed_dialog(&notice(DismissedReason::Unreachable)).contains("its request never reached the browser (a page security policy can refuse it), so nobody saw it"));
        assert_eq!(DismissedReason::from_wire(Some("early")), DismissedReason::Early);
        assert_eq!(DismissedReason::from_wire(None), DismissedReason::Unreachable);
    }

    #[test]
    fn status_lists_the_page_its_state_and_the_recent_faults() {
        let mut ledgers = PageLedgers::new(Arc::new(|text: &str| text.to_owned()));
        let ready = status_text(&facts(json!({"url": ""})), &ledgers);
        assert_eq!(ready, "Page: p1 — about:blank\nState: ready\nPending requests: 0");
        ledgers.console.record_error("Error: boom");
        for index in 0..12 {
            ledgers.push_failure(&format!("GET https://a.test/{index} — failed"));
        }
        let loading = facts(json!({"loading": true, "pendingDialog": {"type": "alert", "message": "hi", "openedAt": 1, "bridge": false}}));
        let text = status_text(&loading, &ledgers);
        assert!(text.starts_with("Page: p1 — https://a.test/\nState: loading\nPending requests: 0\nDialog: alert \"hi\"\nConsole errors:\n- Error: boom\nNetwork failures:\n- GET https://a.test/2 — failed\n"), "{text}");
        assert!(text.ends_with("- GET https://a.test/11 — failed"));
        assert_eq!(text.matches("\n- GET").count(), 10);
        let faulted = status_text(&facts(json!({"fault": "crashed", "loading": true})), &ledgers);
        assert!(faulted.contains("State: crashed\n"));
    }
}
