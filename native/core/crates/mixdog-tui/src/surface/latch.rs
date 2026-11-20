//! The picker Enter latch and the index-mode carry-over (`app/picker-enter-latch.mjs`, `app/picker-index-mode.mjs`).
//!
//! A picker opened from Enter shows its row indexes whatever its own mode says. The latch marks "the next picker opened is
//! from Enter"; it is cleared when a picker consumes it, or by its expiry when the action opens none. Time is an input: the
//! caller passes the current millisecond and calls [`EnterLatch::tick`] when its timer fires, nothing here reads a clock.

use mixdog_tui_widgets::picker::IndexMode;

use super::epoch::PanelValue;

/// How long an armed latch waits for a picker before it clears itself.
pub const PICKER_OPENED_FROM_ENTER_TTL_MS: u64 = 3000;

/// `pickerOpenedFromEnterRef` and its expiry timer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnterLatch {
    armed: bool,
    expires_at_ms: Option<u64>,
}

impl EnterLatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the next picker opened counts as opened from Enter.
    pub fn is_armed(&self) -> bool {
        self.armed
    }

    /// When the expiry timer fires, if one is pending.
    pub fn expires_at_ms(&self) -> Option<u64> {
        self.expires_at_ms
    }

    /// The start of `withPickerEnterLatch`: arms the latch and cancels a pending expiry.
    pub fn arm(&mut self) {
        self.armed = true;
        self.expires_at_ms = None;
    }

    /// The end of `withPickerEnterLatch` (it runs even when the action fails): re-arms the expiry timer.
    pub fn finish(&mut self, now_ms: u64) {
        self.expires_at_ms = Some(now_ms + PICKER_OPENED_FROM_ENTER_TTL_MS);
    }

    /// A picker consumes the mark: true when it was armed.
    pub fn consume(&mut self) -> bool {
        if !self.armed {
            return false;
        }
        self.armed = false;
        self.expires_at_ms = None;
        true
    }

    /// The expiry timer: clears the mark when its time has come.
    pub fn tick(&mut self, now_ms: u64) {
        if self.expires_at_ms.is_some_and(|at| now_ms >= at) {
            self.armed = false;
            self.expires_at_ms = None;
        }
    }
}

/// A panel that carries the row-index display mode.
pub trait IndexModePanel: PanelValue + Sized {
    /// The panel's own mode (`indexMode`), unset when it has none.
    fn index_mode(&self) -> Option<IndexMode>;
    /// The panel with its mode set.
    fn with_index_mode(self, mode: IndexMode) -> Self;
}

/// `resolvePickerState(prev, resolved, refs)`: the index-mode carry-over applied to every picker state update. `resolved` is
/// the state about to be committed, `prev` the one on screen. Consumes the Enter latch when a picker opens.
pub fn resolve_picker_state<P: IndexModePanel>(prev: Option<&P>, resolved: Option<P>, latch: &mut EnterLatch) -> Option<P> {
    let resolved = resolved?;
    if latch.consume() {
        return Some(if resolved.index_mode().is_some() { resolved } else { resolved.with_index_mode(IndexMode::Always) });
    }
    // A same-kind reopen (a toggle-driven rebuild like the MCP flip) keeps the mode injected at Enter-open time instead of
    // falling back to `auto` and hiding the row indexes.
    if resolved.index_mode().is_none() {
        if let Some(prev) = prev {
            if let Some(mode) = prev.index_mode() {
                if !prev.kind().is_empty() && prev.kind() == resolved.kind() {
                    return Some(resolved.with_index_mode(mode));
                }
            }
        }
    }
    Some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Panel {
        kind: &'static str,
        mode: Option<IndexMode>,
    }

    impl PanelValue for Panel {
        fn kind(&self) -> &str {
            self.kind
        }
        fn title(&self) -> &str {
            ""
        }
    }

    impl IndexModePanel for Panel {
        fn index_mode(&self) -> Option<IndexMode> {
            self.mode
        }
        fn with_index_mode(self, mode: IndexMode) -> Self {
            Self { mode: Some(mode), ..self }
        }
    }

    const fn panel(kind: &'static str, mode: Option<IndexMode>) -> Panel {
        Panel { kind, mode }
    }

    #[test]
    fn a_picker_opened_from_enter_shows_its_indexes_and_consumes_the_latch() {
        let mut latch = EnterLatch::new();
        latch.arm();
        latch.finish(100);
        assert_eq!(latch.expires_at_ms(), Some(3100));
        let resolved = resolve_picker_state(None, Some(panel("model", None)), &mut latch);
        assert_eq!(resolved, Some(panel("model", Some(IndexMode::Always))));
        assert!(!latch.is_armed());
        assert_eq!(latch.expires_at_ms(), None);
    }

    #[test]
    fn a_mode_the_picker_set_itself_wins_over_the_latch() {
        let mut latch = EnterLatch::new();
        latch.arm();
        let resolved = resolve_picker_state(None, Some(panel("model", Some(IndexMode::Never))), &mut latch);
        assert_eq!(resolved, Some(panel("model", Some(IndexMode::Never))));
        assert!(!latch.is_armed());
    }

    #[test]
    fn a_same_kind_rebuild_carries_the_previous_mode() {
        let mut latch = EnterLatch::new();
        let prev = panel("mcp-servers", Some(IndexMode::Always));
        assert_eq!(resolve_picker_state(Some(&prev), Some(panel("mcp-servers", None)), &mut latch), Some(panel("mcp-servers", Some(IndexMode::Always))));
        assert_eq!(resolve_picker_state(Some(&prev), Some(panel("skills", None)), &mut latch), Some(panel("skills", None)));
        let kindless = panel("", Some(IndexMode::Always));
        assert_eq!(resolve_picker_state(Some(&kindless), Some(panel("", None)), &mut latch), Some(panel("", None)));
    }

    #[test]
    fn a_close_resolves_to_nothing_and_keeps_the_latch() {
        let mut latch = EnterLatch::new();
        latch.arm();
        assert_eq!(resolve_picker_state::<Panel>(Some(&panel("model", None)), None, &mut latch), None);
        assert!(latch.is_armed());
    }

    #[test]
    fn the_latch_expires_when_no_picker_opens() {
        let mut latch = EnterLatch::new();
        latch.arm();
        latch.finish(0);
        latch.tick(2999);
        assert!(latch.is_armed());
        latch.tick(3000);
        assert!(!latch.is_armed());
        assert_eq!(latch.expires_at_ms(), None);
    }

    #[test]
    fn arming_again_cancels_the_pending_expiry() {
        let mut latch = EnterLatch::new();
        latch.arm();
        latch.finish(0);
        latch.arm();
        assert_eq!(latch.expires_at_ms(), None);
        latch.tick(10_000);
        assert!(latch.is_armed());
    }
}
