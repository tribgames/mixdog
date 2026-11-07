//! The notice against Node's recording (`fixtures/prompt-settings-notice/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-prompt-settings-notice.mjs`): every step of every case is replayed on a
//! session header and must return what Node returned and leave the notice fields as Node left them.

use serde_json::Value;
use serde_json::json;

use super::*;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/prompt-settings-notice/twin.json")).expect("twin.json")
}

fn sections_of(value: &Value) -> OwnedSections {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    OwnedSections {
        meta: text("meta"),
        workflow: text("workflow"),
        workflow_name: value.get("workflowName").and_then(Value::as_str).map(str::to_owned),
        orchestration: text("orchestration"),
        orchestration_mode: text("orchestrationMode"),
        skills: text("skills"),
        instruction_files: text("instructionFiles"),
        core_memory: text("coreMemory"),
        language: text("language"),
        instruction_files_mode: text("instructionFilesMode"),
        response_language: value.get("responseLanguage").cloned().unwrap_or(Value::Null),
    }
}

/// The session fields the notice machinery owns.
const OWNED: [&str; 6] = ["promptSettings", "promptSettingsNotice", "promptSettingsNoticeRevision", "promptSettingsTold", "promptSettingsRecheck", "responseLanguage"];

fn owned(session: &Header) -> Value {
    Value::Object(OWNED.iter().filter_map(|key| session.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect())
}

#[test]
fn every_step_returns_and_leaves_what_node_did() {
    let twin = twin();
    let base = sections_of(&twin["base"]);
    let cases = twin["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 23);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut session = Header::new();
        session.insert("id".into(), json!("sess_x"));
        for (key, value) in case["session"].as_object().expect("session") {
            session.insert(key.clone(), value.clone());
        }
        if case["noRecord"] != json!(true) {
            let mut record = base.record();
            if let Some(dropped) = case["dropHash"].as_str() {
                record["hashes"].as_object_mut().expect("hashes").shift_remove(dropped);
            }
            session.insert("promptSettings".into(), record);
        }
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let at = format!("{name} step {index} {}", step["op"]);
            let returned = match step["op"].as_str().expect("op") {
                "stage" => json!(stage_prompt_settings_notice(&mut session, &sections_of(&step["sections"]), 1)),
                "snapshot" => snapshot_pending(&session).map_or(Value::Null, |(revision, content)| json!({ "revision": revision, "content": content })),
                "ack" => json!(acknowledge_pending(&mut session, step["revision"].as_i64().unwrap_or(-1))),
                "presented" => {
                    note_presented(&mut session, &sections_of(&step["sections"]));
                    Value::Null
                }
                other => panic!("{other}"),
            };
            assert_eq!(returned, step["returned"], "{at}: returned");
            assert_eq!(owned(&session), step["session"], "{at}: session");
        }
    }
}

/// A notice never exceeds its cap, whatever the changes (the degraded forms of the recorded cases included).
#[test]
fn a_notice_stays_inside_its_budget() {
    let twin = twin();
    for case in twin["cases"].as_array().expect("cases") {
        for step in case["steps"].as_array().expect("steps") {
            if let Some(content) = step["session"]["promptSettingsNotice"]["content"].as_str() {
                assert!(content.len() <= NOTICE_MAX_BYTES, "{}: {} bytes", case["name"], content.len());
            }
        }
    }
}
