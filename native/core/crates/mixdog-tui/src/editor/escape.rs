//! Escape priority (`components/prompt-input/escape-policy.mjs`): after overlays have had a chance to consume the key, an
//! active turn is interrupted at once, a selected draft collapses its selection, then (while idle) queued editable messages
//! are restored for editing, an idle non-empty draft clears on a double press, an idle empty draft with history opens the
//! message selector on a double press, otherwise nothing.

/// A second press within this many milliseconds of the first is a double press.
pub const PROMPT_ESCAPE_CLEAR_WINDOW_MS: u64 = 800;
/// How long the hint armed by the first press stays up.
pub const PROMPT_ESCAPE_HINT_TIMEOUT_MS: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscapeAction {
    Interrupt,
    CollapseSelection,
    RestoreQueue,
    Idle,
    MessageSelector,
    ArmSelect,
    Clear,
    ArmClear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EscapeDecision {
    pub action: EscapeAction,
    /// The time to remember for the next press; 0 for none.
    pub next_clear_press_at: u64,
}

/// What the decision reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct EscapeInput<'a> {
    pub interrupt_active: bool,
    pub has_selection: bool,
    pub has_queued_messages: bool,
    pub has_messages: bool,
    pub value: &'a str,
    pub last_clear_press_at: u64,
    pub now: u64,
}

pub fn classify_prompt_escape(input: EscapeInput<'_>) -> EscapeDecision {
    let decide = |action, next_clear_press_at| EscapeDecision { action, next_clear_press_at };
    if input.interrupt_active {
        return decide(EscapeAction::Interrupt, 0);
    }
    if input.has_selection {
        return decide(EscapeAction::CollapseSelection, 0);
    }
    if input.has_queued_messages {
        return decide(EscapeAction::RestoreQueue, 0);
    }
    let repeated = input.last_clear_press_at > 0
        && input.now >= input.last_clear_press_at
        && input.now - input.last_clear_press_at <= PROMPT_ESCAPE_CLEAR_WINDOW_MS;
    let armed = if input.now > 0 { input.now } else { 1 };
    // With an empty draft a double press opens the message selector so a previous prompt can be pulled back into the box
    // (there is nothing to clear).
    if input.value.is_empty() {
        if !input.has_messages {
            return decide(EscapeAction::Idle, 0);
        }
        return if repeated { decide(EscapeAction::MessageSelector, 0) } else { decide(EscapeAction::ArmSelect, armed) };
    }
    if repeated { decide(EscapeAction::Clear, 0) } else { decide(EscapeAction::ArmClear, armed) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: &str) -> EscapeInput<'_> {
        EscapeInput { value, now: 10_000, ..EscapeInput::default() }
    }

    #[test]
    fn active_work_wins_then_selection_then_queue() {
        let busy = EscapeInput { interrupt_active: true, has_selection: true, has_queued_messages: true, ..input("x") };
        assert_eq!(classify_prompt_escape(busy).action, EscapeAction::Interrupt);
        let selected = EscapeInput { has_selection: true, has_queued_messages: true, ..input("x") };
        assert_eq!(classify_prompt_escape(selected).action, EscapeAction::CollapseSelection);
        let queued = EscapeInput { has_queued_messages: true, ..input("x") };
        let decision = classify_prompt_escape(queued);
        assert_eq!(decision, EscapeDecision { action: EscapeAction::RestoreQueue, next_clear_press_at: 0 });
    }

    #[test]
    fn a_non_empty_idle_draft_clears_on_a_double_press() {
        let first = classify_prompt_escape(input("hello"));
        assert_eq!(first, EscapeDecision { action: EscapeAction::ArmClear, next_clear_press_at: 10_000 });
        let second = classify_prompt_escape(EscapeInput { last_clear_press_at: 9_500, ..input("hello") });
        assert_eq!(second, EscapeDecision { action: EscapeAction::Clear, next_clear_press_at: 0 });
        let late = classify_prompt_escape(EscapeInput { last_clear_press_at: 9_199, ..input("hello") });
        assert_eq!(late.action, EscapeAction::ArmClear);
        let edge = classify_prompt_escape(EscapeInput { last_clear_press_at: 9_200, ..input("hello") });
        assert_eq!(edge.action, EscapeAction::Clear);
    }

    #[test]
    fn an_empty_draft_arms_then_opens_the_message_selector_when_there_is_history() {
        let with_history = EscapeInput { has_messages: true, ..input("") };
        assert_eq!(classify_prompt_escape(with_history).action, EscapeAction::ArmSelect);
        let repeated = EscapeInput { last_clear_press_at: 9_900, ..with_history };
        assert_eq!(classify_prompt_escape(repeated).action, EscapeAction::MessageSelector);
        let idle = classify_prompt_escape(input(""));
        assert_eq!(idle, EscapeDecision { action: EscapeAction::Idle, next_clear_press_at: 0 });
    }

    #[test]
    fn a_clock_at_zero_arms_with_one() {
        let decision = classify_prompt_escape(EscapeInput { now: 0, ..input("x") });
        assert_eq!(decision.next_clear_press_at, 1);
    }
}
