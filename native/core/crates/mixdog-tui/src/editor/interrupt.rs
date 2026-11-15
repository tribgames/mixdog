//! `components/prompt-input/interrupt-policy.mjs`.

use mixdog_js::js_trim;

/// What an interrupt settled to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InterruptResult {
    /// `Some(false)` when nothing was cancelled.
    pub aborted: Option<bool>,
    pub restore_text: String,
}

/// The submitted prompt to restore, only when Esc cancelled before a meaningful response and the user has not typed a
/// replacement meanwhile. The engine owns the response-progress guard; the prompt owns the draft guard.
pub fn prompt_interrupt_restore_text(result: Option<&InterruptResult>, current_text: &str) -> String {
    let Some(result) = result else { return String::new() };
    if result.aborted == Some(false) || !current_text.is_empty() {
        return String::new();
    }
    js_trim(&result.restore_text).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_is_restored_only_for_an_aborted_turn_and_an_empty_box() {
        let result = InterruptResult { aborted: Some(true), restore_text: "  fix it \n".into() };
        assert_eq!(prompt_interrupt_restore_text(Some(&result), ""), "fix it");
        assert_eq!(prompt_interrupt_restore_text(Some(&result), "typed"), "");
        assert_eq!(prompt_interrupt_restore_text(None, ""), "");
        let not_aborted = InterruptResult { aborted: Some(false), restore_text: "x".into() };
        assert_eq!(prompt_interrupt_restore_text(Some(&not_aborted), ""), "");
        let unknown = InterruptResult { aborted: None, restore_text: "x".into() };
        assert_eq!(prompt_interrupt_restore_text(Some(&unknown), ""), "x");
    }
}
