//! The text-entry submit policy (`src/tui/app/text-entry-policy.mjs`): several settings prompts document "empty = reset or
//! clear", so the kinds that accept a blank submit live here and the panel (submit gate) and the view (prop) cannot drift.

use mixdog_js::js_trim;

/// The prompt kinds a blank submit resets or clears: System shell falls back to automatic selection, an auto-clear provider
/// default to the built-in window, the Profile title clears.
const CLEAR_BY_EMPTY_KINDS: [&str; 3] = ["system-shell", "autoclear-provider", "profile-title"];

/// `textEntryClearsByEmpty(kind)`.
pub fn text_entry_clears_by_empty(kind: &str) -> bool {
    CLEAR_BY_EMPTY_KINDS.contains(&kind)
}

/// `canSubmitTextEntry(value, allowEmpty)`.
pub fn can_submit_text_entry(value: &str, allow_empty: bool) -> bool {
    allow_empty || !js_trim(value).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_by_empty_prompt_kinds_bypass_the_blank_submit_gate() {
        assert!(text_entry_clears_by_empty("system-shell"));
        assert!(text_entry_clears_by_empty("autoclear-provider"));
        assert!(text_entry_clears_by_empty("profile-title"));
        assert!(!text_entry_clears_by_empty("core-add"));
        assert!(!text_entry_clears_by_empty(""));
        assert!(can_submit_text_entry("", true));
        assert!(can_submit_text_entry("   ", true));
        assert!(!can_submit_text_entry("", false));
        assert!(!can_submit_text_entry("   ", false));
        assert!(can_submit_text_entry(" value ", false));
    }
}
