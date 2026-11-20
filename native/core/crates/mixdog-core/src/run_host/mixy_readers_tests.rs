//! The readers of "does Mixy exist" that run in the daemon: the routine rules (`DefinitionAgents`) and
//! the heartbeat-report delivery (`DefinitionsDirectory`) both ask the agent definitions' one rule.
//! The rule: `created: false` is no; a name, a message the user wrote in her thread, or a routine of
//! hers is yes. A routine that is already stored is itself her evidence, so for it only `created: false`
//! says no. When the rule cannot be read the report reader answers yes (a report is never dropped on
//! an unreadable definition) and the routine reader passes the fault on.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentDefinitions, AgentEvidence};
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};
use mixdog_services::bots::delivery::env::HomeDirectory;
use serde_json::Value;

use super::home_directory::DefinitionsDirectory;
use super::routine_host::{DefinitionAgents, RoutineAgents};

/// What the sessions and the routine store say of Mixy.
struct Facts {
    chatted: bool,
    owns: Result<bool, String>,
}

#[async_trait]
impl AgentEvidence for Facts {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        self.chatted
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        self.owns.clone()
    }
}

/// Definitions over a data folder whose `agents/lead/agent.json` holds `manifest`.
async fn definitions(manifest: Option<&str>, facts: Facts) -> (tempfile::TempDir, Arc<AgentDefinitions>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, "{}").unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let data = dir.path().join("data");
    if let Some(manifest) = manifest {
        std::fs::create_dir_all(data.join("agents/lead")).unwrap();
        std::fs::write(data.join("agents/lead/agent.json"), manifest).unwrap();
    }
    let agents = AgentDefinitions::new(
        dir.path().join("shipped"),
        &data,
        tokens.interactive_io,
        AgentRoutes::new(config, &data),
        Arc::new(facts),
        Arc::new(|| Value::Null),
        dir.path().join("task"),
    );
    (dir, Arc::new(agents))
}

fn quiet() -> Facts {
    Facts { chatted: false, owns: Ok(false) }
}

#[tokio::test]
async fn the_report_reader_drops_nothing_for_a_mixy_who_exists_and_drops_for_one_declined_or_never_made() {
    // (her manifest, the user wrote to her, a routine of hers exists, whether she exists)
    let cases = [
        (Some(r#"{"created":false,"name":"Mixy"}"#), true, true, false),
        (Some(r#"{"name":"Mixy"}"#), false, false, true),
        (Some("{}"), true, false, true),
        (Some("{}"), false, true, true),
        (None, false, false, false),
    ];
    for (manifest, chatted, owns, expected) in cases {
        let (_dir, definitions) = definitions(manifest, Facts { chatted, owns: Ok(owns) }).await;
        let directory = DefinitionsDirectory::new(definitions);
        assert_eq!(directory.mixy_exists().await, expected, "{manifest:?} chatted={chatted} owns={owns}");
    }
}

#[tokio::test]
async fn an_unreadable_rule_never_drops_a_heartbeat_report() {
    let (_dir, definitions) = definitions(None, Facts { chatted: false, owns: Err("routines unreadable".into()) }).await;
    assert!(DefinitionsDirectory::new(definitions).mixy_exists().await);
}

#[tokio::test]
async fn a_new_routine_needs_mixy_to_exist_by_the_one_rule() {
    let cases = [(Some(r#"{"created":false}"#), false), (Some(r#"{"name":"Mixy"}"#), true), (None, false)];
    for (manifest, expected) in cases {
        let (_dir, definitions) = definitions(manifest, quiet()).await;
        assert_eq!(DefinitionAgents::new(definitions).mixy_exists(false).await, Ok(expected), "{manifest:?}");
    }
}

#[tokio::test]
async fn a_stored_routine_is_her_evidence_so_only_a_declined_mixy_pauses_it() {
    for (manifest, expected) in [(Some(r#"{"created":false}"#), false), (Some(r#"{"created":true}"#), true), (None, true), (Some("{}"), true)] {
        let (_dir, definitions) = definitions(manifest, quiet()).await;
        assert_eq!(DefinitionAgents::new(definitions).mixy_exists(true).await, Ok(expected), "{manifest:?}");
    }
}

#[tokio::test]
async fn the_routine_reader_passes_an_unreadable_rule_on_and_pauses_nothing() {
    let (_dir, definitions) = definitions(None, Facts { chatted: false, owns: Err("routines unreadable".into()) }).await;
    let error = DefinitionAgents::new(definitions).mixy_exists(false).await.unwrap_err();
    assert!(error.contains("routines unreadable"), "{error}");
}
