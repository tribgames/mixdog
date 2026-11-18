use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use mixdog_services::channels::call::{CallDispatch, CallRequest, ChannelCallHandler, ChannelClient};
use mixdog_services::channels::intent::{INTENT_FILE, IntentFile, IntentRead, intent_of_read, normalize_intent};
use mixdog_services::channels::running::RunningWork;
use mixdog_services::channels::setup::{AccessScope, AgentDirectory, AutomationAdmin, AutomationSetup};
use mixdog_services::channels::tools::ACTIVATE_TOOL;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

const NOW: f64 = 1_800_000_000_000.0;

// ---- the remote intent file ----

#[test]
fn an_intent_names_a_session_only_when_its_transcript_is_named_after_it() {
    let intent = normalize_intent(&json!({"sessionId": " sess_1 ", "transcriptPath": "/work/sess_1.jsonl", "cwd": "/work", "updatedAt": 42}), NOW).unwrap();
    assert_eq!((intent.session_id.as_str(), intent.cwd.as_deref(), intent.updated_at), ("sess_1", Some("/work"), 42.0));
    assert_eq!(
        intent.to_json(),
        json!({"version": 1, "sessionId": "sess_1", "transcriptPath": "/work/sess_1.jsonl", "cwd": "/work", "updatedAt": 42})
    );
    for refused in [
        json!({"sessionId": "sess_1", "transcriptPath": "/work/other.jsonl"}),
        json!({"sessionId": "sess_1"}),
        json!({"sessionId": "bad id", "transcriptPath": "/work/bad id.jsonl"}),
        json!({"sessionId": "", "transcriptPath": "/work/.jsonl"}),
        json!(["sess_1"]),
        Value::Null,
    ] {
        assert!(normalize_intent(&refused, NOW).is_none(), "{refused}");
    }
}

#[test]
fn an_intent_without_a_usable_time_is_stamped_with_the_reading_clock() {
    for updated in [json!(null), json!(0), json!("soon")] {
        let intent = normalize_intent(&json!({"sessionId": "s", "transcriptPath": "s.jsonl", "updatedAt": updated}), NOW).unwrap();
        assert_eq!(intent.updated_at, NOW, "{updated}");
        assert_eq!(intent.cwd, None);
    }
}

#[test]
fn a_read_that_fails_for_another_reason_than_a_missing_file_is_not_a_malformed_intent() {
    assert!(matches!(intent_of_read(Err(std::io::Error::from(std::io::ErrorKind::NotFound)), NOW), IntentRead::Absent));
    assert!(matches!(intent_of_read(Err(std::io::Error::other("EBUSY")), NOW), IntentRead::Unreadable(_)));
    assert!(matches!(intent_of_read(Ok(b"{not json".to_vec()), NOW), IntentRead::Invalid));
    let valid = br#"{"sessionId":"s","transcriptPath":"/t/s.jsonl"}"#.to_vec();
    assert!(matches!(intent_of_read(Ok(valid), NOW), IntentRead::Pinned(_)));
}

type Logs = Arc<Mutex<Vec<String>>>;

fn intent_file(root: &std::path::Path) -> (IntentFile, Logs) {
    let logs: Logs = Arc::default();
    let sink = logs.clone();
    let file = IntentFile::with_clock(root, mixdog_rt::testing::tokens().maintenance_io, Arc::new(move |line: &str| sink.lock().unwrap().push(line.into())), Arc::new(|| NOW));
    (file, logs)
}

#[tokio::test]
async fn boot_reads_a_valid_file_and_removes_a_malformed_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(INTENT_FILE);
    std::fs::write(&path, r#"{"sessionId":"s1","transcriptPath":"/t/s1.jsonl"}"#).unwrap();
    let (file, logs) = intent_file(dir.path());
    let intent = file.load().await.expect("a valid file pins its session");
    assert_eq!((intent.session_id.as_str(), intent.updated_at), ("s1", NOW));
    assert!(path.exists() && logs.lock().unwrap().is_empty());

    std::fs::write(&path, r#"{"sessionId":"s1","transcriptPath":"/t/other.jsonl"}"#).unwrap();
    assert!(file.load().await.is_none());
    assert!(!path.exists(), "a mismatched binding is deleted");

    // No file: unpinned and nothing to log.
    assert!(file.load().await.is_none());
    assert!(logs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_intent_path_that_cannot_be_read_is_kept_and_logged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(INTENT_FILE);
    std::fs::create_dir(&path).unwrap();
    let (file, logs) = intent_file(dir.path());
    assert!(file.load().await.is_none());
    assert!(path.exists(), "an unreadable file is not proof of a malformed binding");
    assert!(logs.lock().unwrap()[0].starts_with("channel remote intent unreadable, starting unpinned: "));
}

// ---- remote ON / OFF through the dispatcher ----

struct Bridge {
    calls: Mutex<Vec<(String, Value)>>,
    answer: Mutex<Result<Value, String>>,
}

#[async_trait]
impl ChannelCallHandler for Bridge {
    async fn call(&self, name: &str, args: &Value, _: &ChannelClient) -> Result<Value, String> {
        self.calls.lock().unwrap().push((name.into(), args.clone()));
        self.answer.lock().unwrap().clone()
    }
}

fn bridge(answer: Result<Value, String>) -> Arc<Bridge> {
    Arc::new(Bridge { calls: Mutex::default(), answer: Mutex::new(answer) })
}

fn on(session: &str, transcript: Option<&str>) -> CallRequest {
    let mut args = json!({"active": true, "sessionId": session});
    if let Some(path) = transcript {
        args["transcriptPath"] = json!(path);
    }
    CallRequest { name: ACTIVATE_TOOL.into(), args, call_id: None }
}

fn lead() -> ChannelClient {
    ChannelClient { token: "connection:1".into(), lead_pid: None }
}

#[tokio::test]
async fn a_restart_restores_the_pinned_session_once_and_logs_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(INTENT_FILE), r#"{"sessionId":"s1","transcriptPath":"/t/s1.jsonl","cwd":"/t"}"#).unwrap();
    let handler = bridge(Ok(json!({"content": [{"type": "text", "text": "channel bridge activated"}]})));
    let calls = CallDispatch::new(handler.clone(), RunningWork::new());
    let (file, logs) = intent_file(dir.path());
    calls.load_intent(file).await;
    assert_eq!((calls.pinned_session().as_deref(), calls.remote_session()), (Some("s1"), None), "pinned, not yet live");

    assert!(calls.restore_intent().await);
    assert_eq!(calls.remote_session().as_deref(), Some("s1"));
    assert_eq!(*handler.calls.lock().unwrap(), vec![(ACTIVATE_TOOL.to_string(), json!({"active": true, "sessionId": "s1", "transcriptPath": "/t/s1.jsonl", "restore": true}))]);
    assert_eq!(*logs.lock().unwrap(), vec!["remote intent restored session=s1".to_string()]);

    assert!(calls.restore_intent().await, "a second restore finds it bound");
    assert_eq!(handler.calls.lock().unwrap().len(), 1, "and does not activate again");
}

#[tokio::test]
async fn a_restore_the_bridge_refuses_leaves_the_session_pinned_but_not_live() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(INTENT_FILE), r#"{"sessionId":"s1","transcriptPath":"/t/s1.jsonl"}"#).unwrap();
    for (answer, reason) in [
        (Ok(json!({"isError": true, "content": [{"type": "text", "text": "bridge unavailable"}]})), "bridge unavailable"),
        (Err("boom".to_string()), "boom"),
    ] {
        let calls = CallDispatch::new(bridge(answer), RunningWork::new());
        let (file, logs) = intent_file(dir.path());
        calls.load_intent(file).await;
        assert!(!calls.restore_intent().await);
        assert_eq!((calls.pinned_session().as_deref(), calls.remote_session()), (Some("s1"), None));
        assert_eq!(*logs.lock().unwrap(), vec![format!("remote intent restore failed session=s1: {reason}")]);
    }
}

#[tokio::test]
async fn a_manual_on_pins_the_session_and_saves_the_intent_and_off_clears_both() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(INTENT_FILE);
    let calls = CallDispatch::new(bridge(Ok(json!({"content": []}))), RunningWork::new());
    let (file, _) = intent_file(dir.path());
    calls.load_intent(file).await;

    calls.dispatch(lead(), on("sess_on", Some("/work/sess_on.jsonl"))).await.unwrap();
    assert_eq!((calls.pinned_session().as_deref(), calls.remote_session().as_deref()), (Some("sess_on"), Some("sess_on")));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!((&saved["sessionId"], &saved["transcriptPath"], &saved["updatedAt"]), (&json!("sess_on"), &json!("/work/sess_on.jsonl"), &json!(1_800_000_000_000_u64)));

    let off = CallRequest { name: ACTIVATE_TOOL.into(), args: json!({"active": false, "sessionId": "sess_on"}), call_id: None };
    calls.dispatch(lead(), off).await.unwrap();
    assert_eq!((calls.pinned_session(), calls.remote_session()), (None, None));
    assert!(!path.exists());
}

#[tokio::test]
async fn a_manual_on_is_pinned_but_not_persisted_when_the_transcript_names_another_session() {
    let dir = tempfile::tempdir().unwrap();
    for transcript in [Some("/work/other.jsonl"), None] {
        let calls = CallDispatch::new(bridge(Ok(json!({"content": []}))), RunningWork::new());
        let (file, logs) = intent_file(dir.path());
        calls.load_intent(file).await;
        calls.dispatch(lead(), on("sess_on", transcript)).await.unwrap();
        assert_eq!(calls.remote_session().as_deref(), Some("sess_on"));
        assert!(!dir.path().join(INTENT_FILE).exists(), "{transcript:?}");
        assert_eq!(*logs.lock().unwrap(), vec!["remote intent not persisted: session/transcript mismatch session=sess_on".to_string()]);
    }
}

#[tokio::test]
async fn a_manual_on_the_bridge_refuses_leaves_the_binding_and_the_file_as_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let calls = CallDispatch::new(bridge(Ok(json!({"isError": true, "content": [{"type": "text", "text": "no"}]}))), RunningWork::new());
    let (file, _) = intent_file(dir.path());
    calls.load_intent(file).await;
    calls.dispatch(lead(), on("sess_on", Some("/work/sess_on.jsonl"))).await.unwrap();
    assert_eq!((calls.pinned_session(), calls.remote_session()), (None, None));
    assert!(!dir.path().join(INTENT_FILE).exists());
}

// ---- who may change an automation (the setup tool) ----

struct Rows(Value);

#[async_trait]
impl AutomationAdmin for Rows {
    async fn get_channel_setup(&self) -> Result<Value, String> {
        Ok(self.0.clone())
    }
    async fn save_schedule(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn save_webhook(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn delete_schedule(&self, name: &str) -> Result<Value, String> {
        Ok(json!({"name": name, "deleted": true}))
    }
    async fn delete_webhook(&self, name: &str) -> Result<Value, String> {
        Ok(json!({"name": name, "deleted": true}))
    }
    async fn set_schedule_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        Ok(json!({"name": name, "enabled": enabled != Some(&json!(false))}))
    }
    async fn set_webhook_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        Ok(json!({"name": name, "enabled": enabled != Some(&json!(false))}))
    }
    async fn run_schedule_now(&self, _: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }
    async fn run_webhook_now(&self, _: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }
    async fn set_webhook_config(&self, _: Option<&Value>) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

struct Agents;

#[async_trait]
impl AgentDirectory for Agents {
    async fn agent_ids(&self) -> Result<Vec<String>, String> {
        Ok(vec!["reviewer".into(), "critic".into()])
    }
}

fn setup() -> AutomationSetup {
    let state = json!({
        "schedules": [{"name": "mine", "owner": "reviewer"}, {"name": "theirs", "owner": "critic"}],
        "webhooks": [{"name": "hook", "owner": "critic"}],
    });
    AutomationSetup::new(Arc::new(Rows(state)), Arc::new(Agents))
}

async fn refusal(action: &str, args: Value, scope: AccessScope) -> String {
    match setup().run(action, &args, &ThreadId::from("sess_x"), &scope).await {
        Err(PortError::Denied(message) | PortError::Failed { message, .. }) => message,
        other => panic!("{action} {args}: {other:?}"),
    }
}

#[tokio::test]
async fn an_agent_thread_manages_only_its_own_automations() {
    let reviewer = AccessScope::Agent { agent_id: "reviewer".into() };
    let deleted = setup().run("delete_automation", &json!({"automationKind": "schedule", "name": "mine"}), &ThreadId::from("t"), &reviewer).await.unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(
        refusal("delete_automation", json!({"automationKind": "schedule", "name": "theirs"}), reviewer.clone()).await,
        "Schedule \"theirs\" belongs to another agent; this thread manages only its own schedules"
    );
    assert_eq!(
        refusal("set_automation_enabled", json!({"automationKind": "webhook", "name": "hook", "enabled": false}), reviewer).await,
        "Webhook \"hook\" belongs to another agent; this thread manages only its own webhooks"
    );
}

#[tokio::test]
async fn a_background_run_or_a_room_member_may_not_change_automations() {
    let args = json!({"automationKind": "schedule", "name": "mine"});
    assert_eq!(refusal("delete_automation", args.clone(), AccessScope::RoomMember).await, "A group-room member cannot delete schedules");
    assert_eq!(refusal("run_automation", args.clone(), AccessScope::Headless).await, "A background run cannot run schedules");
    let paused = json!({"automationKind": "schedule", "name": "mine", "enabled": false});
    assert_eq!(refusal("set_automation_enabled", paused, AccessScope::Headless).await, "A background run cannot pause schedules");
    let resumed = json!({"automationKind": "schedule", "name": "mine"});
    assert_eq!(refusal("set_automation_enabled", resumed, AccessScope::Headless).await, "A background run cannot resume schedules");
}

#[tokio::test]
async fn a_human_may_hand_an_automation_to_an_existing_agent_only() {
    let save = |owner: &str| json!({"automationKind": "schedule", "entry": {"name": "mine", "instructions": "x", "time": "0 9 * * *", "overwrite": true, "owner": owner}});
    let saved = setup().run("save_automation", &save("critic"), &ThreadId::from("t"), &AccessScope::Human).await.unwrap();
    assert_eq!(saved["owner"], "critic");
    assert_eq!(refusal("save_automation", save("ghost"), AccessScope::Human).await, "Agent \"ghost\" does not exist");
    // An agent thread cannot give one away.
    let reviewer = AccessScope::Agent { agent_id: "reviewer".into() };
    assert_eq!(refusal("save_automation", save("critic"), reviewer).await, "This thread cannot give a schedule to another agent");
}

#[tokio::test]
async fn an_automation_that_is_not_listed_is_not_found() {
    let message = refusal("delete_automation", json!({"automationKind": "schedule", "name": "nope"}), AccessScope::Human).await;
    assert_eq!(message, "Automation entry not found");
}
