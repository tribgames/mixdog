//! The supersession counter of the bottom surface (`app/panel-epoch.mjs`).
//!
//! Anything that hands surface ownership back to the user (closing a picker, cancelling a text-entry prompt, a newer
//! submit of the same prompt) supersedes every deferred paint issued before it. Async work takes
//! [`PanelEpoch::current`] when the user action starts and re-checks [`PanelEpoch::is_current`] immediately before it opens,
//! refreshes or closes a surface: a daemon write settling after Esc cannot re-open the dismissed panel, and an older ack
//! cannot close a panel that meanwhile holds newer user input.

/// A panel as far as ownership is concerned: the identity of the surface it stands for.
pub trait PanelValue {
    /// The panel's kind (`_kind`), empty when it has none.
    fn kind(&self) -> &str;
    /// The panel's title, empty when it has none.
    fn title(&self) -> &str;
}

/// The counter. One per application: every picker and prompt factory is rebuilt on each render, so the marker cannot live
/// in a factory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PanelEpoch {
    value: u64,
}

impl PanelEpoch {
    pub fn new() -> Self {
        Self::default()
    }

    /// `currentPanelEpoch()`.
    pub fn current(&self) -> u64 {
        self.value
    }

    /// `supersedePanelEpoch()`: marks every in-flight deferred paint as superseded and returns the token of the action
    /// that performs the supersession.
    pub fn supersede(&mut self) -> u64 {
        self.value += 1;
        self.value
    }

    /// `isPanelEpochCurrent(token)`.
    pub fn is_current(&self, token: u64) -> bool {
        token == self.value
    }
}

/// `panelIdentity(panel)`: what the surface of a panel is called. A rebuild of the same surface (a light Settings refresh,
/// a toggle-driven MCP re-render) keeps it stable; a different panel reports a different one.
pub fn panel_identity<P: PanelValue>(panel: Option<&P>) -> Option<&str> {
    let panel = panel?;
    [panel.kind(), panel.title()].into_iter().find(|name| !name.is_empty())
}

/// `shouldSupersedePanelEpoch(previous, next)`: true when `next` takes the surface away from a different panel that was
/// open (a close, or a replacement by another panel). Not a handover: null to anything (nothing owned the surface, and the
/// in-flight write of a text-entry prompt on screen must stay valid) and a rebuild of the same panel (its own deferred
/// refresh must still land).
pub fn should_supersede_panel_epoch<P: PanelValue>(previous: Option<&P>, next: Option<&P>) -> bool {
    let Some(previous) = previous else { return false };
    let Some(next) = next else { return true };
    panel_identity(Some(previous)) != panel_identity(Some(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, Default)]
    struct Panel {
        kind: &'static str,
        title: &'static str,
    }

    impl PanelValue for Panel {
        fn kind(&self) -> &str {
            self.kind
        }
        fn title(&self) -> &str {
            self.title
        }
    }

    const fn titled(title: &'static str) -> Panel {
        Panel { kind: "", title }
    }

    #[test]
    fn identity_is_the_kind_then_the_title() {
        assert_eq!(panel_identity(Some(&titled("Settings"))), Some("Settings"));
        assert_eq!(panel_identity(Some(&Panel { kind: "mcp-servers", title: "MCP servers · 2 connected" })), Some("mcp-servers"));
        assert_eq!(panel_identity(Some(&Panel::default())), None);
        assert_eq!(panel_identity::<Panel>(None), None);
    }

    #[test]
    fn close_and_replacement_supersede_rebuild_and_first_open_do_not() {
        let settings = titled("Settings");
        assert!(should_supersede_panel_epoch(Some(&settings), None));
        assert!(should_supersede_panel_epoch(Some(&settings), Some(&titled("Core memories"))));
        assert!(should_supersede_panel_epoch(
            Some(&Panel { kind: "mcp-servers", title: "Extensions" }),
            Some(&Panel { kind: "skills", title: "Extensions" })
        ));
        assert!(!should_supersede_panel_epoch(Some(&settings), Some(&titled("Settings"))));
        assert!(!should_supersede_panel_epoch(Some(&settings), Some(&settings)));
        assert!(!should_supersede_panel_epoch(
            Some(&Panel { kind: "mcp-servers", title: "MCP · 1" }),
            Some(&Panel { kind: "mcp-servers", title: "MCP · 2" })
        ));
        assert!(!should_supersede_panel_epoch::<Panel>(None, None));
        assert!(!should_supersede_panel_epoch(None, Some(&settings)));
    }

    #[test]
    fn a_supersession_invalidates_the_earlier_token() {
        let mut epoch = PanelEpoch::new();
        let token = epoch.current();
        assert!(epoch.is_current(token));
        assert_eq!(epoch.supersede(), token + 1);
        assert!(!epoch.is_current(token));
    }
}
