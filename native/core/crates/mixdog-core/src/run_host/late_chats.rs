//! The chats of a bot (`AgentChats`) read through the late session directory.
//!
//! A bot's saved route reaches its chats through `AgentRouteFollow`, which the route setter holds
//! (`AgentRouteSetter.publisher`), and the route setter is what `AgentEffects` (so the agent
//! definitions the tool pool is built from) is made of: all of them exist before the directory,
//! whose own `AgentChats` is the answer. The directory is bound once after `TurnPath::new` and
//! the composition verifies it before the listener accepts; a save never comes before that.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::AgentChats;

use super::compose_parts::LateDirectory;
use super::late::Bound;

/// [`AgentChats`] of the directory once it is bound; before that a bot has no chats.
pub struct LateAgentChats(pub Arc<LateDirectory>);

impl AgentChats for LateAgentChats {
    fn chats_of(&self, agent_id: &str) -> Option<Vec<ThreadId>> {
        self.0.directory()?.chats_of(agent_id)
    }
}

impl Bound for LateAgentChats {
    fn cell(&self) -> &'static str {
        "agent chats"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::testing::Rig;
    use serde_json::json;

    use super::*;

    #[test]
    fn a_bot_has_no_chats_until_the_directory_is_bound() {
        let late = Arc::new(LateDirectory::default());
        let chats = LateAgentChats(late);
        assert_eq!(chats.chats_of("writer"), None);
        assert!(!chats.is_bound());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_bound_directory_answers_the_home_and_room_member_sessions_of_the_bot() {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        for id in ["sess_home_writer", "sess_rmem_room01_writer", "sess_home_editor"] {
            directory.create_with_id(ThreadId::from(id), serde_json::Map::new(), json!({})).await.expect("create");
        }
        let late = Arc::new(LateDirectory::default());
        late.bind(&directory);
        let chats = LateAgentChats(late);
        assert!(chats.is_bound());
        let mut got = chats.chats_of("writer").expect("a home id");
        got.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        assert_eq!(got, [ThreadId::from("sess_home_writer"), ThreadId::from("sess_rmem_room01_writer")]);
    }
}
