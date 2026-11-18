//! `agent/getLeadStatus` as the desktop window asks it: the status plus whether Mixy exists, and the
//! once-per-profile `created` decision. Rule: `created: false` is no; a name, a message the user wrote
//! in her thread or a routine of hers is yes. A profile with no `created` flag yet has it decided by
//! her existing or her home thread being there, and persisted; one that cannot be read is an error and
//! decides nothing.

use mixdog_core_api::CoreRequest;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;

use super::super::lead::LeadAppearance;
use super::super::lead_service::DesktopLeadStatus;
use super::super::lead_service::LeadService;
use super::*;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

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

struct NoEffects;

#[async_trait]
impl AgentEffects for NoEffects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
    async fn delete_owned_routines(&self, _: &str) -> Result<OwnedRoutines, String> {
        Ok(OwnedRoutines::default())
    }
}

struct Window {
    _dir: tempfile::TempDir,
    status: DesktopLeadStatus,
    agents: Arc<AgentDefinitions>,
}

/// A window over a profile whose `agents/lead/agent.json` is `manifest`, her home thread present or not.
async fn window(manifest: Option<&str>, facts: Facts, home_thread: bool) -> Window {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("mixdog-config.json");
    std::fs::write(&config_path, "{}").unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let (data, state) = (dir.path().join("data"), dir.path().join("state"));
    std::fs::create_dir_all(&state).unwrap();
    if let Some(manifest) = manifest {
        std::fs::create_dir_all(data.join("agents/lead")).unwrap();
        std::fs::write(data.join("agents/lead/agent.json"), manifest).unwrap();
    }
    let agents = Arc::new(
        AgentDefinitions::new(dir.path().join("shipped"), &data, tokens.interactive_io, AgentRoutes::new(config.clone(), &data), Arc::new(facts), Arc::new(|| Value::Null), state.join("task"))
            .with_writes(tokens.durability_io, Arc::new(NoEffects), Arc::new(String::new)),
    );
    let (_, homes) = world_of(|world| {
        if home_thread {
            world.sessions.insert("sess_home_lead".into(), (json!({}), false));
        }
    });
    let lead = LeadService::new(agents.clone(), LeadAppearance::new(config), scopes(&state, "agent").await);
    Window { _dir: dir, status: DesktopLeadStatus::new(lead, agents.clone(), homes), agents }
}

async fn ask(window: &Window) -> Result<Value, CoreError> {
    let req: CoreRequest = request("agent/getLeadStatus", json!({}), None);
    value(&window.status, req).await
}

#[tokio::test]
async fn the_status_says_whether_mixy_exists_and_shows_it_as_created() {
    // (manifest, the user wrote to her, a routine of hers, her home thread, exists)
    let cases = [
        (Some(r#"{"created":false,"name":"Mixy"}"#), true, Ok(true), false),
        // A `created` flag alone proves nothing.
        (Some(r#"{"created":true}"#), false, Ok(false), false),
        (Some(r#"{"name":"Mixy"}"#), false, Ok(false), true),
        (Some("{}"), true, Ok(false), true),
        (Some("{}"), false, Ok(true), true),
        (Some("{}"), false, Ok(false), false),
    ];
    for (manifest, chatted, owns, exists) in cases {
        let window = window(manifest, Facts { chatted, owns: owns.clone() }, false).await;
        let status = ask(&window).await.unwrap();
        assert_eq!((status["exists"].clone(), status["created"].clone()), (json!(exists), json!(exists)), "{manifest:?} chatted={chatted} owns={owns:?}");
    }
}

#[tokio::test]
async fn a_profile_with_no_decision_has_created_persisted_once_her_name_or_home_thread_proves_her() {
    let window = window(Some(r#"{"name":"Mixy"}"#), Facts { chatted: false, owns: Ok(false) }, false).await;
    assert_eq!(window.agents.lead_status().await.unwrap().created, None);
    ask(&window).await.unwrap();
    assert_eq!(window.agents.lead_status().await.unwrap().created, Some(true), "her existing settled it");

    // Her home thread is there but nothing else proves her: the answer is no, the decision is yes.
    let window = self::window(Some("{}"), Facts { chatted: false, owns: Ok(false) }, true).await;
    let status = ask(&window).await.unwrap();
    assert_eq!((status["exists"].clone(), status["created"].clone()), (json!(false), json!(false)));
    assert_eq!(window.agents.lead_status().await.unwrap().created, Some(true), "her thread marks her created");
}

#[tokio::test]
async fn a_decided_profile_is_never_decided_again() {
    let window = window(Some(r#"{"created":false,"name":"Mixy"}"#), Facts { chatted: true, owns: Ok(true) }, true).await;
    let status = ask(&window).await.unwrap();
    assert_eq!(status["exists"], false);
    assert_eq!(window.agents.lead_status().await.unwrap().created, Some(false), "the stored decision stands");
}

#[tokio::test]
async fn when_her_routines_cannot_be_read_nothing_is_answered_or_decided() {
    let window = window(Some("{}"), Facts { chatted: false, owns: Err("routines unreadable".into()) }, true).await;
    let error = ask(&window).await.unwrap_err();
    assert_eq!(message(&error), "Mixy's status could not be read.");
    assert_eq!(window.agents.lead_status().await.unwrap().created, None);
}
