//! The prompt-hint band (`app/use-prompt-hint.mjs`): one transient line under the prompt (copy feedback, queue restore
//! notices, slash argument hints) with a single auto-dismiss timer. `active` and the timer are kept apart as in Node, so a key
//! handler can ask whether a hint currently owns the band before clearing it.

use crate::editor::helpers::HintTone;

/// How long a hint stays up when the caller names no time.
pub const PROMPT_HINT_DISMISS_MS: u64 = 2200;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PromptHint {
    text: String,
    tone: HintTone,
    active: bool,
    dismiss_at: Option<u64>,
}

impl PromptHint {
    pub fn new() -> Self {
        Self::default()
    }

    /// The hint shown, empty for none.
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn tone(&self) -> HintTone {
        self.tone
    }

    /// When the dismiss timer fires, if one is pending.
    pub fn dismiss_at(&self) -> Option<u64> {
        self.dismiss_at
    }

    /// Whether a hint is shown or still pending its timer (`promptHintActiveRef.current || promptHintTimerRef.current`).
    pub fn is_live(&self) -> bool {
        self.active || self.dismiss_at.is_some()
    }

    /// `showPromptHint(text, tone, dismissMs)`; a missing or non-positive `dismiss_ms` is the default.
    pub fn show(&mut self, text: &str, tone: HintTone, dismiss_ms: Option<u64>, now: u64) {
        self.active = true;
        self.text = text.to_owned();
        self.tone = tone;
        let timeout = dismiss_ms.filter(|ms| *ms > 0).unwrap_or(PROMPT_HINT_DISMISS_MS);
        self.dismiss_at = Some(now + timeout);
    }

    /// `clearPromptHint()`: nothing happens when no hint is live.
    pub fn clear(&mut self) {
        if !self.is_live() {
            return;
        }
        self.dismiss_at = None;
        self.active = false;
        self.text.clear();
        self.tone = HintTone::Info;
    }

    /// The dismiss timer: clears the hint once its time has come; true when it did.
    pub fn tick(&mut self, now: u64) -> bool {
        if self.dismiss_at.is_some_and(|at| now >= at) {
            self.clear();
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hint_dismisses_itself_after_its_time_and_a_new_one_restarts_the_timer() {
        let mut hint = PromptHint::new();
        hint.show("copied 3 chars", HintTone::Plain, None, 1000);
        assert_eq!((hint.text(), hint.tone(), hint.dismiss_at()), ("copied 3 chars", HintTone::Plain, Some(3200)));
        assert!(!hint.tick(3199));
        hint.show("again", HintTone::Info, Some(1000), 3000);
        assert_eq!(hint.dismiss_at(), Some(4000));
        assert!(hint.tick(4000));
        assert_eq!((hint.text(), hint.is_live()), ("", false));
        hint.show("x", HintTone::Info, Some(0), 0);
        assert_eq!(hint.dismiss_at(), Some(PROMPT_HINT_DISMISS_MS));
    }

    #[test]
    fn clearing_a_band_with_no_hint_changes_nothing() {
        let mut hint = PromptHint::new();
        hint.clear();
        assert!(!hint.is_live());
        hint.show("a", HintTone::Error, None, 5);
        hint.clear();
        assert_eq!((hint.text(), hint.tone(), hint.dismiss_at()), ("", HintTone::Info, None));
    }
}
