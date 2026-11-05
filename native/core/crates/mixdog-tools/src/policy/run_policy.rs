//! Schedule and webhook runs never ask. Saving a schedule or webhook is the
//! user's explicit grant for its runs (and the work they start): outbound
//! actions and ordinary approvals are allowed without a card, inside the
//! bot's own permissions (a `block` applies before any ask). Payments and
//! permanent deletes are never done in a run. Group-room members are not runs
//! of this kind and keep their held/approval behaviour.

use mixdog_core_api::domain::approval::ActionKind;
use serde_json::Value;

pub const RUN_FORBIDDEN_REASON: &str =
    "Payments and permanent deletes aren't allowed in schedule/webhook runs; do it from the chat.";

/// The ask reason of a schedule/webhook save: the grant, said plainly.
pub const AUTOMATION_GRANT_REASON: &str = "Approving lets this schedule's or webhook's runs act without asking, within the bot's permissions. Payments and permanent deletes are never done in runs.";

/// The unattended run that owns a session.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RunKind {
    Schedule,
    Webhook,
    Room,
}

impl RunKind {
    /// A schedule or webhook run: its asks are answered by this policy.
    pub const fn is_granted(self) -> bool {
        !matches!(self, Self::Room)
    }
}

/// Whether a run's outbound ask is one the run may never do.
pub const fn forbidden_in_run(kind: ActionKind) -> bool {
    !kind.rememberable()
}

/// Whether the call saves a schedule or webhook (the `setup` tool's
/// `save_automation`).
pub fn saves_automation(tool: &str, args: &Value) -> bool {
    tool == "setup" && args.get("action").and_then(Value::as_str) == Some("save_automation")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_schedule_and_webhook_runs_are_granted() {
        assert!(RunKind::Schedule.is_granted());
        assert!(RunKind::Webhook.is_granted());
        assert!(!RunKind::Room.is_granted());
    }

    #[test]
    fn payments_and_deletes_are_forbidden_in_runs() {
        assert!(forbidden_in_run(ActionKind::Payment));
        assert!(forbidden_in_run(ActionKind::Delete));
        assert!(!forbidden_in_run(ActionKind::Trash));
        assert!(!forbidden_in_run(ActionKind::Email));
    }

    #[test]
    fn saving_an_automation_is_recognised() {
        assert!(saves_automation("setup", &json!({"action": "save_automation"})));
        assert!(!saves_automation("setup", &json!({"action": "other"})));
        assert!(!saves_automation("shell", &json!({"action": "save_automation"})));
    }
}
