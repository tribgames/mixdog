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
mod tests {
    #[cfg(node_twin)]
    use async_trait::async_trait;
    #[cfg(node_twin)]
    use mixdog_core_api::mock::MockStatePublisher;
    #[cfg(node_twin)]
    use mixdog_core_api::state::SectionChange;
    #[cfg(node_twin)]
    use mixdog_mcp::sign_in_notice::NoticingAuthorizer;
    #[cfg(node_twin)]
    use mixdog_mcp::transport::Authorizer;
    #[cfg(node_twin)]
    use mixdog_mcp::transport::TransportError;
    #[cfg(node_twin)]
    use serde_json::Value;
    #[cfg(node_twin)]
    use serde_json::json;

    #[cfg(node_twin)]
    use super::*;

    /// A sign-in whose renewal ends as the scripted login does.
    #[cfg(node_twin)]
    struct Renewal {
        needs_user: bool,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl Authorizer for Renewal {
        async fn token(&self) -> Result<Option<String>, TransportError> {
            Ok(None)
        }

        async fn renew(&self, _: Option<String>, _: Option<String>) -> Result<(), TransportError> {
            if self.needs_user { Err(TransportError::AuthRequired) } else { Ok(()) }
        }
    }

    /// One request as the transports make it (`http.rs` `post_message`): send with the stored
    /// token, on a refusal renew and send once more, a second refusal needs the user, a success
    /// is reported with the token it carried.
    #[cfg(node_twin)]
    async fn request(auth: &dyn Authorizer, stored: bool, statuses: &[u64], login_needs_user: bool) {
        let attempted = stored.then(|| "old".to_owned());
        let mut sent = attempted.clone();
        let mut status = statuses[0];
        if status == 401 {
            if auth.renew(attempted.clone(), None).await.is_err() {
                return;
            }
            let fresh = (!login_needs_user).then(|| "new".to_owned());
            status = statuses[1];
            if status == 401 {
                auth.refused_after_renewal(attempted.as_deref(), None);
                return;
            }
            sent = fresh;
        }
        if (200..300).contains(&status) {
            auth.answered(sent.as_deref());
        }
    }

    #[cfg(node_twin)]
    fn standing(publisher: &MockStatePublisher) -> Vec<String> {
        let mut keys = std::collections::BTreeSet::new();
        for (_, key, change) in publisher.published() {
            let key = key.expect("keyed");
            match change {
                SectionChange::Set(_) => keys.insert(key),
                _ => keys.remove(&key),
            };
        }
        keys.into_iter().collect()
    }

    #[cfg(node_twin)]
    fn sets(publisher: &MockStatePublisher, seen: usize) -> Vec<Value> {
        publisher
            .published()
            .into_iter()
            .skip(seen)
            .filter_map(|(_, _, change)| match change {
                SectionChange::Set(bytes) => Some(serde_json::from_slice(&bytes).expect("json")),
                _ => None,
            })
            .collect()
    }

    /// `createAuthorizedFetch` of the real Node module over a scripted server
    /// (`fixtures/desktop-notice-raisers/golden.json`): which notices a request raises, and which
    /// it withdraws, from the events the transports report.
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_connectors_sign_in_notice_is_raised_and_withdrawn_as_node_does() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/desktop-notice-raisers/golden.json")).expect("fixture");
        for step in golden["connectorSteps"].as_array().expect("steps") {
            let publisher = Arc::new(MockStatePublisher::default());
            let notices = DesktopNotices::new(publisher.clone());
            if step["preRaised"] == true {
                notices.connector_sign_in_expired("acme");
            }
            let seen = publisher.published().len();
            let needs_user = step["login"] == "reauth";
            let auth = NoticingAuthorizer::new(Arc::new(Renewal { needs_user }), "acme", Arc::new(ConnectorDesktopNotices(notices)));
            let statuses: Vec<u64> = step["statuses"].as_array().expect("statuses").iter().filter_map(Value::as_u64).collect();
            request(&auth, step["stored"] == true, &statuses, needs_user).await;
            assert_eq!(Value::Array(sets(&publisher, seen)), step["delivered"], "{step}");
            assert_eq!(json!(standing(&publisher)), step["raised"], "{step}");
        }
    }
}

