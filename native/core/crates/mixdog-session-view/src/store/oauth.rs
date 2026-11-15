//! The provider and MCP sign-in flows (`session/oauth-flows.mjs`, `integrations.mjs`, `extensions.mjs`, the pollers of
//! `app/extension-pickers/mcp-login.mjs` and `provider-setup/oauth-actions.mjs`). The core holds the flow (its live promises and
//! callbacks are in the core's process) and answers `begin`, `status`, `complete` and `cancel` with the serializable flow status; this
//! side begins them, polls them, and cancels the ones still pending when the store is disposed (`oauthFlows.cancelAll`).

use std::time::Duration;

use serde_json::Value;

use super::SessionStore;
use super::StoreError;
use super::held;

/// How often a pending flow is asked for its status (`POLL_MS` of the MCP sign-in).
pub const OAUTH_POLL: Duration = Duration::from_millis(1500);
/// How long a flow may stay pending (`DEFAULT_FLOW_TTL_MS`: the core expires it then; this ends the wait with it).
pub const OAUTH_FLOW_TTL: Duration = Duration::from_secs(10 * 60);

/// Which sign-in a flow is: a model provider's account, or an MCP server's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OAuthKind {
    Provider,
    Mcp,
}

impl OAuthKind {
    fn begin_action(self) -> &'static str {
        match self {
            Self::Provider => "beginOAuthProviderLogin",
            Self::Mcp => "beginMcpOAuthLogin",
        }
    }

    fn status_action(self) -> &'static str {
        match self {
            Self::Provider => "getOAuthProviderLoginStatus",
            Self::Mcp => "getMcpOAuthLoginStatus",
        }
    }

    fn complete_action(self) -> &'static str {
        match self {
            Self::Provider => "completeOAuthProviderLogin",
            Self::Mcp => "completeMcpOAuthLogin",
        }
    }

    fn cancel_action(self) -> &'static str {
        match self {
            Self::Provider => "cancelOAuthProviderLogin",
            Self::Mcp => "cancelMcpOAuthLogin",
        }
    }

    /// The protocol method of the cancel, for the release of a store.
    pub(super) fn cancel_method(self) -> &'static str {
        match self {
            Self::Provider => "account/cancelOAuthProviderLogin",
            Self::Mcp => "mcp/cancelMcpOAuthLogin",
        }
    }
}

fn is_pending(status: &Value) -> bool {
    status["state"] == "pending"
}

impl SessionStore {
    fn track_flow(&self, kind: OAuthKind, status: &Value) {
        let Some(flow_id) = status["flowId"].as_str() else { return };
        let mut flows = held(&self.inner.oauth_flows);
        flows.retain(|(held_kind, held_id)| !(*held_kind == kind && held_id == flow_id));
        if is_pending(status) {
            flows.push((kind, flow_id.to_owned()));
        }
    }

    fn forget_flow(&self, kind: OAuthKind, flow_id: &str) {
        held(&self.inner.oauth_flows).retain(|(held_kind, held_id)| !(*held_kind == kind && held_id == flow_id));
    }

    /// Begins a sign-in: a provider id (`options` as the picker gives them) or an MCP server name (`{ openBrowser: true }`). The answer
    /// is the flow's status (`flowId`, `url`, `manualUrl`, `userCode`, `state`, `manualCodeSupported`); a flow still pending is
    /// cancelled if the store is disposed first.
    pub async fn begin_oauth(&self, kind: OAuthKind, subject: &str, options: &Value) -> Result<Value, StoreError> {
        let status = self.call(kind.begin_action(), &[Value::String(subject.to_owned()), options.clone()]).await?;
        self.track_flow(kind, &status);
        Ok(status)
    }

    /// The status of a flow.
    pub async fn oauth_status(&self, kind: OAuthKind, flow_id: &str) -> Result<Value, StoreError> {
        let status = self.call(kind.status_action(), &[Value::String(flow_id.to_owned())]).await?;
        if !is_pending(&status) {
            self.forget_flow(kind, flow_id);
        }
        Ok(status)
    }

    /// Completes a flow with the code or the redirect address the user pasted.
    pub async fn complete_oauth(&self, kind: OAuthKind, flow_id: &str, text: &str) -> Result<Value, StoreError> {
        let status = self.call(kind.complete_action(), &[Value::String(flow_id.to_owned()), Value::String(text.to_owned())]).await?;
        if !is_pending(&status) {
            self.forget_flow(kind, flow_id);
        }
        Ok(status)
    }

    /// Cancels a flow.
    pub async fn cancel_oauth(&self, kind: OAuthKind, flow_id: &str) -> Result<Value, StoreError> {
        let status = self.call(kind.cancel_action(), &[Value::String(flow_id.to_owned())]).await;
        self.forget_flow(kind, flow_id);
        status
    }

    /// Polls a flow every `interval` ([`OAUTH_POLL`]) until it is no longer pending and answers its final status (`complete`,
    /// `failed`, `cancelled` or `expired`). A flow that outlives [`OAUTH_FLOW_TTL`] ends the wait with an error. A status that cannot be
    /// read ends it with that error.
    pub async fn wait_oauth(&self, kind: OAuthKind, flow_id: &str, interval: Duration) -> Result<Value, StoreError> {
        let polling = async {
            loop {
                let status = self.oauth_status(kind, flow_id).await?;
                if !is_pending(&status) {
                    return Ok::<Value, StoreError>(status);
                }
                mixdog_rt::time::sleep(interval).await;
            }
        };
        match mixdog_rt::time::timeout(OAUTH_FLOW_TTL, polling).await {
            Ok(done) => done,
            Err(_) => {
                self.forget_flow(kind, flow_id);
                Err(StoreError::Protocol("OAuth login expired.".to_owned()))
            }
        }
    }
}
