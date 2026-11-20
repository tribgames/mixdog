//! The composition's side of the desktop notices (`DesktopNotices`, the `notice` section): the
//! session's turn ends and failed saves, and a connector's sign-in problems, reported by the layers
//! that see them, shown by the one `DesktopNotices`.

use std::sync::Arc;

use mixdog_core_domains::notify::desktop_notice::DesktopNotices;
use mixdog_core_session::session::notices::SessionNotices;
use mixdog_mcp::sign_in_notice::SignInNotices;

/// `SessionDeps.notices` over the process's notices.
pub struct SessionDesktopNotices(pub Arc<DesktopNotices>);

impl SessionNotices for SessionDesktopNotices {
    fn turn_completed(&self, provider: &str) {
        self.0.turn_completed(provider);
    }

    fn turn_failed(&self, provider: &str, kind: Option<&str>) {
        self.0.turn_failed(provider, kind);
    }

    fn save_failed(&self, session: &str) {
        self.0.conversation_save_failed(session);
    }

    fn save_resolved(&self, session: &str) {
        self.0.conversation_save_resolved(session);
    }

    fn offload_prune_blocked(&self, session: &str) {
        self.0.offload_prune_blocked(session);
    }
}

/// `McpHub::set_sign_in_notices` over the process's notices.
pub struct ConnectorDesktopNotices(pub Arc<DesktopNotices>);

impl SignInNotices for ConnectorDesktopNotices {
    fn expired(&self, server: &str) {
        self.0.connector_sign_in_expired(server);
    }

    fn restored(&self, server: &str) {
        self.0.connector_sign_in_restored(server);
    }
}

#[cfg(test)]
mod tests {}
