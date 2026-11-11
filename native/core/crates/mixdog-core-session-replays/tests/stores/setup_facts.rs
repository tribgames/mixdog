//! [`SessionSetupFacts`] against `fixtures/session-facts/golden.json`
//! (`record-session-facts.mjs`): Node's `resolveSessionMode` verdict for each recorded caller
//! (stored here as a thread under that id) and for no caller, and Node's `mixyDisplayName()`
//! over each recorded data dir.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_config::workflow::thread_settings::SessionSwitches;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde_json::Value;
use serde_json::json;

use mixdog_core_session::session::setup_facts::SessionSetupFacts;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/session-facts/golden.json")).expect("golden.json")
}

/// The thread-switch layer, recording the threads it is asked about.
#[derive(Default)]
struct Switches {
    asked: Mutex<Vec<String>>,
    reach: bool,
}

#[async_trait]
impl SessionSwitches for Switches {
    async fn settings_reach(&self, thread: &str) -> bool {
        self.asked.lock().unwrap().push(thread.to_owned());
        self.reach
    }
    async fn switch_workflow(&self, _: &str, _: &str) -> Result<Option<Value>, String> {
        unreachable!("the facts switch nothing")
    }
    async fn switch_orchestration_mode(&self, _: &str, _: &str) -> Result<Option<Value>, String> {
        unreachable!("the facts switch nothing")
    }
}

fn facts(directory: &Arc<SessionDirectory>, switches: Arc<Switches>, data_dir: PathBuf) -> SessionSetupFacts {
    SessionSetupFacts::new(directory.clone(), switches, data_dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_caller_is_in_agent_mode_exactly_when_node_resolves_it_so() {
    let golden = golden();
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let facts = facts(&directory, Arc::default(), PathBuf::new());
    for case in golden["agentMode"].as_array().expect("agentMode") {
        let mut header = case["session"].as_object().expect("session").clone();
        let id = header.shift_remove("id").expect("id");
        let id = ThreadId::from(id.as_str().expect("id"));
        header.insert("createdAt".into(), json!(1));
        directory.create_with_id(id.clone(), header, json!({})).await.expect("created");
        assert_eq!(Value::Bool(facts.agent_mode(&id).await), case["agentMode"], "{id}");
    }
    assert_eq!(Value::Bool(facts.agent_mode(&ThreadId::from("sess_unknown")).await), golden["noCaller"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mixy_name_is_read_from_the_data_dir_as_node_reads_it() {
    let golden = golden();
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let root = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    for case in golden["mixyName"].as_array().expect("mixyName") {
        let data = root.path().join(case["name"].as_str().expect("name"));
        let files: Vec<(PathBuf, String)> = case["files"]
            .as_object()
            .expect("files")
            .iter()
            .map(|(rel, text)| (data.join(rel), text.as_str().expect("text").to_owned()))
            .collect();
        tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |lane| {
                for (path, text) in &files {
                    mixdog_statefile::append_file(lane, path, text.as_bytes()).expect("a recorded file");
                }
            })
            .expect("lane")
            .await
            .expect("job ran");
        let facts = facts(&directory, Arc::default(), data);
        assert_eq!(facts.mixy_name().await, case["mixyName"].as_str().expect("mixyName"), "{}", case["name"]);
    }
}

/// `settingsReachCurrentSession()` is the thread-switch layer's answer for the caller's thread.
#[tokio::test]
async fn the_settings_reach_is_the_switch_layers_answer_for_the_caller() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    for reach in [true, false] {
        let switches = Arc::new(Switches { reach, ..Switches::default() });
        let facts = facts(&directory, switches.clone(), PathBuf::new());
        assert_eq!(facts.settings_reach_session(&ThreadId::from("sess_caller")).await, reach);
        assert_eq!(*switches.asked.lock().unwrap(), ["sess_caller"]);
    }
}
