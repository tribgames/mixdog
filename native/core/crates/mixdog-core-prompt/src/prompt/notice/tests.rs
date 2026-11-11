//! The notice against Node's recording (`fixtures/prompt-settings-notice/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-prompt-settings-notice.mjs`): every step of every case is replayed on a
//! session header and must return what Node returned and leave the notice fields as Node left them.

use serde_json::Value;
use serde_json::json;

use super::*;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/prompt-settings-notice/twin.json")).expect("twin.json")
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

fn turn_twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/prompt-notice-turn/twin.json")).expect("twin.json")
}

/// The turn that carries the staged notice and the settle that acknowledges it, against Node's `buildUserTurn`
/// (`ask-turn-prepare.mjs:204`) and `acknowledgePendingPromptSettingsNotice` (`ask-turn-settle.mjs:155-156`).
#[test]
fn a_turn_carries_the_notice_as_node_builds_it_and_an_accepted_one_acknowledges_it() {
    let twin = turn_twin();
    let cases = twin["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 4);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut header = Header::new();
        header.insert("promptSettings".into(), case["startRecord"].clone());
        header.insert("promptSettingsNotice".into(), case["pending"].clone());
        header.insert("promptSettingsNoticeRevision".into(), case["pending"]["revision"].clone());

        // What the turn carries: the notice's revision and text, put into the message Node builds without one.
        let (revision, text) = snapshot_pending(&header).expect(name);
        assert_eq!(json!(revision), case["carriedRevision"], "{name}: revision");
        let plain = &case["next"]["message"];
        let carried = carry_reminders(plain, &text, None, Some(revision)).expect(name);
        assert_eq!(carried, case["message"], "{name}: the message the model is sent");

        // A failed turn settles nothing: the notice is still pending and the next turn carries it again.
        assert_eq!(header.get("promptSettingsNotice"), Some(&case["failed"]["notice"]), "{name}: failed");
        let (again, again_text) = snapshot_pending(&header).expect(name);
        assert_eq!(carry_reminders(plain, &again_text, None, Some(again)).expect(name), case["again"]["message"], "{name}: again");

        // An accepted turn acknowledges the revision it carried, once.
        let change = acknowledge_change(&header, revision).expect(name);
        assert_eq!(json!(true), case["acknowledged"], "{name}");
        for key in &change.unset {
            header.shift_remove(key);
        }
        for (key, value) in change.set {
            header.insert(key, value);
        }
        let after = &case["after"];
        assert_eq!(header.get("promptSettingsNotice").cloned().unwrap_or(Value::Null), after["notice"], "{name}: notice");
        assert_eq!(header.get("promptSettingsTold").cloned().unwrap_or(Value::Null), after["told"], "{name}: told");
        assert_eq!(header.get("promptSettingsRecheck").cloned().unwrap_or(Value::Null), after["recheck"], "{name}: recheck");
        assert_eq!(header.get("promptSettingsNoticeRevision").cloned().unwrap_or(Value::Null), after["revision"], "{name}: revision");
        assert!(snapshot_pending(&header).is_none(), "{name}: the next turn carries nothing");
        assert!(acknowledge_change(&header, revision).is_none(), "{name}: acknowledged once");
    }
}
