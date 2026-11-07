//! `ApprovalSurfaces` over the loaded threads: Node's "the run has a `toolApprovalHook`" test
//! (`resolvePreToolAskApproval`, `loop/tool-helpers.mjs`), which decides whether a run's ask is
//! held for the owner (`HeldHome.ui_attached`).
//!
//! Node's hook is set on the session by the client turn that can answer (`ask-turn-execute.mjs`)
//! and exists only while that turn runs; a thread that is not loaded runs nothing and has none. A
//! headless session (`approvalMode: "implicit"`) has none whatever is attached. Otherwise the
//! hook is the client that shows the card: a connection live on the thread's feed or on the feed
//! of the surface its requests are shown on (the parent chat of a sub-agent), or an
//! `approvalsInbox` connection ([`ApprovalPresence`]).

use std::sync::Arc;

use mixdog_core_api::ApprovalPresence;
use mixdog_core_api::ApprovalSurfaces;
use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;
use super::session_options::approval_implicit;

pub struct ThreadApprovalSurfaces {
    directory: Arc<SessionDirectory>,
    presence: Arc<dyn ApprovalPresence>,
}

impl ThreadApprovalSurfaces {
    pub fn new(directory: Arc<SessionDirectory>, presence: Arc<dyn ApprovalPresence>) -> Self {
        Self { directory, presence }
    }
}

/// [`ApprovalSurfaces::attached`] over a directory, for a holder that finds the directory late.
pub fn attached_in(directory: &SessionDirectory, presence: &dyn ApprovalPresence, thread: &ThreadId) -> bool {
    let Some(handle) = directory.handle(thread) else {
        return false;
    };
    !approval_implicit(&handle.live_header().header()) && presence.answerable(thread, &handle.lineage().surface)
}

impl ApprovalSurfaces for ThreadApprovalSurfaces {
    fn attached(&self, thread: &ThreadId) -> bool {
        attached_in(&self.directory, &*self.presence, thread)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Map;
    use serde_json::Value;
    use serde_json::json;

    use super::super::testing::Rig;
    use super::*;

    /// Records what it is asked and answers `yes` only for the (thread, surface) pairs it lists.
    #[derive(Default)]
    struct Presence {
        live: Mutex<Vec<(String, String)>>,
        asked: Mutex<Vec<(String, String)>>,
    }

    impl ApprovalPresence for Presence {
        fn answerable(&self, thread: &ThreadId, surface: &ThreadId) -> bool {
            let pair = (thread.as_str().to_owned(), surface.as_str().to_owned());
            self.asked.lock().unwrap().push(pair.clone());
            self.live.lock().unwrap().contains(&pair)
        }
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    async fn rig() -> (Arc<SessionDirectory>, Arc<Presence>, ThreadApprovalSurfaces, Rig) {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let presence = Arc::new(Presence::default());
        let surfaces = ThreadApprovalSurfaces::new(directory.clone(), presence.clone());
        (directory, presence, surfaces, rig)
    }

    async fn make(directory: &SessionDirectory, id: &str, header: Value) -> ThreadId {
        let id = ThreadId::from(id);
        directory.create_with_id(id.clone(), obj(header), json!({})).await.expect("create");
        id
    }

    /// The hook is present exactly when a client answers the thread's approvals; the consumer
    /// holds a run's ask exactly when it is not (`fixtures/approval-surface/golden.json`, tested at
    /// `held_requests`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_thread_has_a_surface_while_a_client_that_answers_is_attached_to_it() {
        let (directory, presence, surfaces, _rig) = rig().await;
        let top = make(&directory, "sess_top", json!({})).await;
        assert!(!surfaces.attached(&top), "nobody is attached");
        presence.live.lock().unwrap().push(("sess_top".into(), "sess_top".into()));
        assert!(surfaces.attached(&top), "a client live on its feed answers");
        assert!(!surfaces.attached(&ThreadId::from("sess_unloaded")), "a thread that is not loaded runs nothing");
        presence.live.lock().unwrap().clear();
        assert!(!surfaces.attached(&top), "the client left");
    }

    /// A sub-agent's card is shown on its parent's surface: a client on the parent chat answers it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sub_agents_surface_is_its_parents() {
        let (directory, presence, surfaces, _rig) = rig().await;
        let parent = make(&directory, "sess_parent", json!({})).await;
        let child = make(&directory, "sess_child", json!({ "parentSessionId": "sess_parent" })).await;
        presence.live.lock().unwrap().push(("sess_child".into(), "sess_parent".into()));
        assert!(surfaces.attached(&child));
        assert!(!surfaces.attached(&parent), "the parent's own surface is itself");
        assert_eq!(presence.asked.lock().unwrap().last(), Some(&("sess_parent".to_owned(), "sess_parent".to_owned())));
    }

    /// `approvalMode: "implicit"` is Node's headless runtime: no hook, so nothing counts as attached.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_headless_session_has_no_surface_whoever_is_attached() {
        let (directory, presence, surfaces, _rig) = rig().await;
        let id = make(&directory, "sess_headless", json!({ "approvalMode": "implicit" })).await;
        presence.live.lock().unwrap().push(("sess_headless".into(), "sess_headless".into()));
        assert!(!surfaces.attached(&id));
        assert!(presence.asked.lock().unwrap().is_empty(), "the header decides before any connection is asked");
    }
}