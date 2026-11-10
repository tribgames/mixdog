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
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use super::directory::SessionDirectory;
use mixdog_core_ports::ports::domain_sessions::AgentRoutePublisher;
use mixdog_core_ports::ports::route::AgentChats;
use mixdog_core_ports::ports::route::AgentRouteFollow;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::room_member_of_session;

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

type Delivery = Shared<BoxFuture<'static, Result<(), PortError>>>;

/// `publishAgentRouteChange` / `publishStoredAgentRoute` over the follow.
pub struct SessionRoutePublisher {
    shared: Arc<PublisherState>,
}

/// The follow and the publications in flight: shared with the deliveries, which outlive a call.
struct PublisherState {
    follow: Arc<AgentRouteFollow>,
    routes: Mutex<Routes>,
}

#[derive(Default)]
struct Routes {
    /// Per bot, the route every chat took last (`publishedRoutes`), recorded only once all did.
    published: HashMap<String, String>,
    /// Per bot, the publication in flight, its route key and serial (`publishingRoutes`).
    in_flight: HashMap<String, (String, u64, Delivery)>,
    next: u64,
}

impl SessionRoutePublisher {
    pub fn new(follow: Arc<AgentRouteFollow>) -> Arc<Self> {
        Arc::new(Self { shared: Arc::new(PublisherState { follow, routes: Mutex::default() }) })
    }

    /// `publishStoredAgentRoute`: a bot route read from a changed config. A route every chat
    /// already took is not sent again; fails when a chat refused it, so the change step retries.
    pub async fn publish_stored(&self, agent_id: &str, route: &Value) -> Result<(), PortError> {
        self.shared.publish_stored(agent_id, route).await
    }
}

impl PublisherState {
    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        self.routes.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn publish_stored(self: &Arc<Self>, agent_id: &str, route: &Value) -> Result<(), PortError> {
        let done = {
            let routes = self.routes();
            if !routes.in_flight.contains_key(agent_id) && routes.published.get(agent_id) == Some(&route.to_string()) {
                return Ok(());
            }
            drop(routes);
            self.deliver(agent_id, route)
        };
        done.await
    }

    /// `deliverAgentRoute`: every chat takes the route; a publication of the same route already
    /// in flight is joined, not repeated.
    fn deliver(self: &Arc<Self>, agent_id: &str, route: &Value) -> Delivery {
        // `JSON.stringify(route ?? null)`.
        let key = route.to_string();
        let mut routes = self.routes();
        if let Some((held, _, done)) = routes.in_flight.get(agent_id)
            && *held == key
        {
            return done.clone();
        }
        routes.next += 1;
        let serial = routes.next;
        let (me, agent, pick) = (self.clone(), agent_id.to_owned(), route.as_object().cloned().unwrap_or_else(Route::new));
        let held = key.clone();
        let done = async move {
            let result = me.follow.follow(&agent, &pick).await;
            let mut routes = me.routes();
            if routes.in_flight.get(&agent).is_some_and(|(_, ours, _)| *ours == serial) {
                routes.in_flight.remove(&agent);
            }
            if result.is_ok() {
                routes.published.insert(agent, held);
            }
            result
        }
        .boxed()
        .shared();
        routes.in_flight.insert(agent_id.to_owned(), (key, serial, done.clone()));
        done
    }
}

#[async_trait]
impl AgentRoutePublisher for SessionRoutePublisher {
    /// `publishAgentRouteChange`: settles once every chat settled; a refusing chat never fails
    /// the save (the change step that follows publishes the route again).
    async fn publish(&self, agent_id: &str, route: &Value) {
        let _ = self.shared.deliver(agent_id, route).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering::SeqCst;

    use mixdog_store::schema::record::Header;
    use serde_json::json;

    use super::*;
    use mixdog_core_ports::ports::route::ChatRouteSetter;
    use mixdog_core_ports::ports::route::FollowOptions;
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

    #[tokio::test(start_paused = true)]
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

    /// The home chat refuses until `taking` is set.
    struct Flaky {
        taking: std::sync::atomic::AtomicBool,
        taken: AtomicUsize,
        attempts: AtomicUsize,
    }
    #[async_trait]
    impl ChatRouteSetter for Flaky {
        async fn set_route(&self, thread: &ThreadId, _pick: Route, _options: FollowOptions) -> Result<(), PortError> {
            self.attempts.fetch_add(1, SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            if thread.as_str() == "sess_home_writer" && !self.taking.load(SeqCst) {
                return Err(PortError::Failed { capability: "route".into(), message: "host busy".into() });
            }
            self.taken.fetch_add(1, SeqCst);
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stored_route_a_chat_refused_is_retried_and_once_taken_not_sent_again() {
        let setter = Arc::new(Flaky { taking: false.into(), taken: 0.into(), attempts: 0.into() });
        let publisher = SessionRoutePublisher::new(Arc::new(AgentRouteFollow::new(Arc::new(Two), setter.clone())));
        let route = json!({ "provider": "openai", "model": "next" });
        // Two runtimes apply the same change at once: one attempt per chat, both told it failed.
        let (first, second) =
            tokio::join!(publisher.publish_stored("writer", &route), publisher.publish_stored("writer", &route));
        assert!(first.is_err() && second.is_err());
        assert_eq!(setter.attempts.load(SeqCst), 2);
        setter.taking.store(true, SeqCst);
        publisher.publish_stored("writer", &route).await.expect("the retry delivers it");
        assert_eq!(setter.attempts.load(SeqCst), 4);
        publisher.publish_stored("writer", &route).await.expect("already taken");
        assert_eq!(setter.attempts.load(SeqCst), 4, "taken once, it is not delivered again");
    }
}
