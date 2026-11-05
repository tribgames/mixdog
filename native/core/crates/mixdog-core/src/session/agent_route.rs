//! A bot's saved route reaching its hosted chats (`agent-profile-changes.mjs`
//! `publishAgentRouteChange`, `agent-route-follow.mjs`): the chats are the loaded threads that
//! are the bot's home or one of its room-member sessions, and a publication of the same route
//! already in flight is joined, not repeated.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::directory::SessionDirectory;
use crate::domains::ai_admin::agent_route_service::AgentRoutePublisher;
use crate::ports::route::AgentChats;
use crate::ports::route::AgentRouteFollow;
use crate::ports::route::Route;
use crate::rooms::ids::agent_home_session_id;
use crate::rooms::ids::room_member_of_session;

/// The chats `follow` filters `sessionsById` to: the home thread and the bot's room-member
/// sessions, among the threads this process hosts.
impl AgentChats for SessionDirectory {
    fn chats_of(&self, agent_id: &str) -> Option<Vec<ThreadId>> {
        let home = agent_home_session_id(agent_id)?;
        Some(
            self.loaded_ids()
                .into_iter()
                .filter(|id| {
                    id.as_str() == home
                        || room_member_of_session(id.as_str()).is_some_and(|member| member.agent_id == agent_id)
                })
                .collect(),
        )
    }
}

type Delivery = Shared<BoxFuture<'static, ()>>;

/// `publishAgentRouteChange` over the follow: settles once every chat settled; a refusing chat
/// never fails the save.
pub struct SessionRoutePublisher {
    follow: Arc<AgentRouteFollow>,
    /// Per bot, the publication in flight and its route key (`publishingRoutes`).
    in_flight: Mutex<HashMap<String, (String, u64, Delivery)>>,
    next: std::sync::atomic::AtomicU64,
}

impl SessionRoutePublisher {
    pub fn new(follow: Arc<AgentRouteFollow>) -> Arc<Self> {
        Arc::new(Self { follow, in_flight: Mutex::new(HashMap::new()), next: Default::default() })
    }

    fn deliver(self: &Arc<Self>, agent_id: &str, route: &Value) -> Delivery {
        // `JSON.stringify(route ?? null)`.
        let key = route.to_string();
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((held, _, done)) = in_flight.get(agent_id)
            && *held == key
        {
            return done.clone();
        }
        let serial = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (me, agent, pick) = (self.clone(), agent_id.to_owned(), route.as_object().cloned().unwrap_or_else(Route::new));
        let done = async move {
            let _ = me.follow.follow(&agent, &pick).await;
            let mut in_flight = me.in_flight.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if in_flight.get(&agent).is_some_and(|(_, held, _)| *held == serial) {
                in_flight.remove(&agent);
            }
        }
        .boxed()
        .shared();
        in_flight.insert(agent_id.to_owned(), (key, serial, done.clone()));
        done
    }
}

#[async_trait]
impl AgentRoutePublisher for Arc<SessionRoutePublisher> {
    async fn publish(&self, agent_id: &str, route: &Value) {
        self.deliver(agent_id, route).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering::SeqCst;

    use mixdog_store::schema::record::Header;
    use serde_json::json;

    use super::*;
    use mixdog_tools::orch::util::PortError;

    use crate::ports::route::ChatRouteSetter;
    use crate::ports::route::FollowOptions;
    use crate::session::testing::Rig;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bots_chats_are_its_hosted_home_and_room_member_sessions() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        for id in ["sess_home_writer", "sess_rmem_room01_writer", "sess_home_editor", "sess_rmem_room01_editor", "sess_task_1"] {
            directory.create_with_id(ThreadId::from(id), Header::new(), json!({})).await.expect("create");
        }
        let mut chats = directory.chats_of("writer").expect("a home id");
        chats.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        assert_eq!(chats, [ThreadId::from("sess_home_writer"), ThreadId::from("sess_rmem_room01_writer")]);
        assert_eq!(directory.chats_of("Not An Id"), None);
    }

    struct Two;
    impl AgentChats for Two {
        fn chats_of(&self, _agent_id: &str) -> Option<Vec<ThreadId>> {
            Some(vec![ThreadId::from("sess_home_writer"), ThreadId::from("sess_rmem_room01_writer")])
        }
    }

    /// Counts the picks; the home chat refuses them, after a pause that keeps the publication
    /// in flight.
    struct Refusing(AtomicUsize);
    #[async_trait]
    impl ChatRouteSetter for Refusing {
        async fn set_route(&self, thread: &ThreadId, _pick: Route, _options: FollowOptions) -> Result<(), PortError> {
            self.0.fetch_add(1, SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if thread.as_str() == "sess_home_writer" {
                return Err(PortError::Failed { capability: "route".into(), message: "signed out".into() });
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn the_same_route_in_flight_is_joined_and_a_refusal_never_fails_the_save() {
        let setter = Arc::new(Refusing(AtomicUsize::new(0)));
        let publisher = SessionRoutePublisher::new(Arc::new(AgentRouteFollow::new(Arc::new(Two), setter.clone())));
        let route = json!({ "provider": "anthropic-oauth", "model": "claude-new" });
        tokio::join!(publisher.publish("writer", &route), publisher.publish("writer", &route));
        assert_eq!(setter.0.load(SeqCst), 2, "one pick per chat");
        // Settled, the next publication of the same route reaches the chats again.
        publisher.publish("writer", &route).await;
        assert_eq!(setter.0.load(SeqCst), 4);
    }
}
