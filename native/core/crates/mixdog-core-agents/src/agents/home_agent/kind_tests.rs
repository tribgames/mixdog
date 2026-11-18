//! Whether an agent can have a home chat, decided from the definition files and the greeting evidence.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{Config, ConfigLanes};
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken as _};
use serde_json::{Value, json};

use super::HomeAgentKind;
use crate::agents::{AgentDefinitions, AgentEvidence, AgentRoutes};

// The test backend runs a lane job inline at submit; `unconstrained` keeps the handle from answering Pending.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

fn write(path: &Path, body: &str) {
    let (path, body) = (path.to_owned(), body.as_bytes().to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
}

struct Greeted(HashMap<String, bool>);

#[async_trait]
impl AgentEvidence for Greeted {
    async fn home_greeted(&self, agent_id: &str) -> bool {
        self.0.get(agent_id).copied().unwrap_or(false)
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// `shipped` and `data` are (agent id, AGENT.md text) pairs; `greeted` ids have a greeted home thread.
async fn world(shipped: &[(&str, &str)], data: &[(&str, &str)], greeted: &[&str]) -> (tempfile::TempDir, AgentDefinitions) {
    let dir = tempfile::tempdir().unwrap();
    let (shipped_dir, data_dir) = (dir.path().join("shipped"), dir.path().join("data"));
    for (root, files) in [(&shipped_dir, shipped), (&data_dir, data)] {
        for (id, text) in files {
            write(&root.join("agents").join(id).join("AGENT.md"), text);
        }
    }
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("mixdog-config.json");
    write(&config_path, &serde_json::to_string(&mixdog_core_config::config::agent_routes::stored_file_of(&json!({}))).unwrap());
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let evidence = Greeted(greeted.iter().map(|id| ((*id).to_owned(), true)).collect());
    let agents = AgentDefinitions::new(
        &shipped_dir,
        &data_dir,
        tokens.interactive_io,
        AgentRoutes::new(config, &data_dir),
        Arc::new(evidence),
        Arc::new(|| Value::Null),
        dir.path().join("task"),
    );
    (dir, agents)
}

fn definition(kind: &str) -> String {
    format!("---\nkind: {kind}\n---\nBody\n")
}

#[tokio::test]
async fn a_user_agent_marked_bot_has_a_home_chat_and_one_marked_agent_never_does() {
    let (_dir, agents) = world(&[], &[("friend", &definition("bot")), ("worker", &definition("agent"))], &[]).await;
    assert_eq!(agents.home_agent("friend").await.unwrap(), HomeAgentKind::Bot);
    assert_eq!(agents.home_agent("worker").await.unwrap(), HomeAgentKind::None);
}

#[tokio::test]
async fn an_unrecognised_kind_is_never_proof_that_the_agent_is_no_bot() {
    let (_dir, agents) = world(&[], &[("odd", &definition("gizmo"))], &[]).await;
    assert_eq!(agents.home_agent("odd").await.unwrap(), HomeAgentKind::Unknown);
}

#[tokio::test]
async fn an_agent_without_a_definition_or_an_id_is_unknown() {
    let (_dir, agents) = world(&[], &[], &[]).await;
    assert_eq!(agents.home_agent("ghost").await.unwrap(), HomeAgentKind::Unknown);
    assert_eq!(agents.home_agent("").await.unwrap(), HomeAgentKind::Unknown);
}

#[tokio::test]
async fn an_unmarked_shipped_role_is_a_workflow_agent() {
    let (_dir, agents) = world(&[("role", "No front matter\n")], &[], &[]).await;
    assert_eq!(agents.home_agent("role").await.unwrap(), HomeAgentKind::None);
}

#[tokio::test]
async fn an_unmarked_user_copy_is_a_bot_only_once_its_home_thread_was_greeted() {
    let (_dir, agents) = world(&[], &[("quiet", "No front matter\n"), ("hello", "No front matter\n")], &["hello"]).await;
    assert_eq!(agents.home_agent("quiet").await.unwrap(), HomeAgentKind::Unknown);
    assert_eq!(agents.home_agent("hello").await.unwrap(), HomeAgentKind::Bot);
}
