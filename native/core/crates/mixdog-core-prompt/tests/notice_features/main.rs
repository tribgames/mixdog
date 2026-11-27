//! The prompt-settings notice: a conversation whose settings moved after its prompt was built is told
//! once, in a size-capped reminder carried by its next turn, and the prompt folds the change in later.

use mixdog_core_prompt::prompt::notice::{
    NOTICE_MAX_BYTES, OwnedSections, acknowledge_change, acknowledge_pending, carry_reminders, note_presented, snapshot_pending, stage_prompt_settings_notice,
};
use mixdog_store::schema::record::Header;
use serde_json::{Value, json};

const OPEN: &str = "<system-reminder>\nSettings changed during this conversation; each section replaces the matching part of your system prompt.";
const CLOSE: &str = "</system-reminder>";

fn notice_of(body: &str) -> String {
    format!("{OPEN}\n\n{body}\n\n{CLOSE}")
}

fn base() -> OwnedSections {
    OwnedSections { skills: "- tidy: x".into(), ..OwnedSections::default() }
}

fn session_presenting(sections: &OwnedSections) -> Header {
    let mut session = Header::new();
    session.insert("id".into(), json!("sess_x"));
    session.insert("promptSettings".into(), sections.record());
    session
}

fn stage(session: &mut Header, sections: &OwnedSections) -> Vec<String> {
    stage_prompt_settings_notice(session, sections, 1)
}

#[test]
fn a_conversation_with_no_recorded_settings_adopts_the_current_ones_silently() {
    let mut session = Header::new();
    assert!(stage(&mut session, &base()).is_empty());
    assert_eq!(session["promptSettings"], base().record());
    assert!(snapshot_pending(&session).is_none());
}

#[test]
fn unchanged_settings_stage_nothing() {
    let mut session = session_presenting(&base());
    assert!(stage(&mut session, &base()).is_empty());
    assert!(snapshot_pending(&session).is_none());
}

#[test]
fn a_changed_skill_list_is_told_once_and_acknowledged_once() {
    let mut session = session_presenting(&base());
    let now = OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() };

    assert_eq!(stage(&mut session, &now), ["skills"]);
    let (revision, content) = snapshot_pending(&session).expect("a notice is staged");
    assert_eq!(revision, 1);
    assert_eq!(content, notice_of("# Skills\nAdded: docx"));

    assert!(!acknowledge_pending(&mut session, revision + 1), "another revision acknowledges nothing");
    assert_eq!(snapshot_pending(&session).map(|(r, _)| r), Some(1), "a turn that failed leaves the notice pending");

    assert!(acknowledge_pending(&mut session, revision));
    assert!(snapshot_pending(&session).is_none());
    assert!(!acknowledge_pending(&mut session, revision), "acknowledged once");

    assert_eq!(stage(&mut session, &now), ["skills"], "the prompt still differs, but the model was told");
    assert!(snapshot_pending(&session).is_none());
}

#[test]
fn moving_a_setting_back_to_the_prompts_value_is_told_too() {
    let mut session = session_presenting(&base());
    let now = OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() };
    stage(&mut session, &now);
    let (revision, _) = snapshot_pending(&session).unwrap();
    acknowledge_pending(&mut session, revision);

    assert!(stage(&mut session, &base()).is_empty(), "the prompt and the settings agree again");
    let (_, content) = snapshot_pending(&session).expect("the model still believes docx is there");
    assert_eq!(content, notice_of("# Skills\nRemoved: docx"));
}

#[test]
fn a_restaged_change_replaces_the_unsent_notice_under_a_new_revision() {
    let mut session = session_presenting(&base());
    stage(&mut session, &OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() });
    stage(&mut session, &OwnedSections { skills: "- tidy: x\n- pdf: z".into(), ..base() });
    let (revision, content) = snapshot_pending(&session).unwrap();
    assert_eq!(revision, 2);
    assert_eq!(content, notice_of("# Skills\nAdded: pdf"));
}

#[test]
fn a_response_language_change_names_the_new_language_or_says_it_is_gone() {
    let was = OwnedSections { language: "Korean".into(), response_language: json!({ "id": "ko", "name": "Korean" }), ..base() };
    let mut session = session_presenting(&was);
    let now = OwnedSections { language: "French".into(), response_language: json!({ "id": "fr", "name": "French" }), ..base() };
    assert_eq!(stage(&mut session, &now), ["language"]);
    assert_eq!(snapshot_pending(&session).unwrap().1, notice_of("# Language\nRespond in French from now on."));

    let none = OwnedSections { response_language: Value::Null, ..base() };
    let mut session = session_presenting(&was);
    assert_eq!(stage(&mut session, &none), ["language"]);
    assert_eq!(
        snapshot_pending(&session).unwrap().1,
        notice_of("# Language\nNo response language is set any more: reply in the language of the conversation.")
    );
}

#[test]
fn workflow_core_memory_and_orchestration_changes_are_each_told_in_their_own_section() {
    let was = OwnedSections {
        workflow: "w1".into(),
        workflow_id: "pack".into(),
        workflow_name: Some("pack".into()),
        core_memory: "remember x".into(),
        orchestration: "plan first".into(),
        orchestration_mode: "focused".into(),
        ..base()
    };
    let told = |now: &OwnedSections| {
        let mut session = session_presenting(&was);
        let changed = stage(&mut session, now);
        (changed, snapshot_pending(&session).unwrap().1)
    };

    let (changed, content) = told(&OwnedSections { workflow: "w2".into(), ..was.clone() });
    assert_eq!(changed, ["workflow"]);
    assert_eq!(content, notice_of("# Workflow\nThe \"pack\" workflow pack changed; it applies from the next prompt rebuild."));

    let (changed, content) = told(&OwnedSections { core_memory: String::new(), ..was.clone() });
    assert_eq!(changed, ["coreMemory"]);
    assert_eq!(content, notice_of("# Core Memory\nNo core memory is currently supplied."));

    let (changed, content) = told(&OwnedSections { core_memory: "remember y".into(), ..was.clone() });
    assert_eq!(changed, ["coreMemory"]);
    assert!(content.starts_with(&format!("{OPEN}\n\n# Core Memory\nCore memory was updated:\n")), "{content}");

    let (changed, content) = told(&OwnedSections { orchestration: "plan twice".into(), ..was.clone() });
    assert_eq!(changed, ["orchestration"]);
    assert!(content.contains("# Orchestration Mode\nThe Focused orchestration mode instructions were edited:\n"), "{content}");
}

#[test]
fn a_new_output_style_is_named_and_a_removed_one_is_withdrawn() {
    let styled = OwnedSections { meta: "# Output Style: terse\nShort answers only.".into(), ..base() };
    let mut session = session_presenting(&base());
    stage(&mut session, &styled);
    assert_eq!(snapshot_pending(&session).unwrap().1, notice_of("# Output Style\nThe output style is now \"terse\".\n\nShort answers only."));

    let mut session = session_presenting(&styled);
    stage(&mut session, &base());
    assert_eq!(snapshot_pending(&session).unwrap().1, notice_of("# Output Style\nNo output style applies any more."));
}

#[test]
fn a_changed_instruction_file_is_diffed_line_by_line_and_a_dropped_one_is_withdrawn() {
    let files = |a: &str| format!("# Instruction Files\n\n## /w/a.md\n\n{a}\n\n## /w/b.md\n\nkeep");
    let was = OwnedSections { instruction_files: files("one\ntwo"), ..base() };
    let mut session = session_presenting(&was);
    let now = OwnedSections { instruction_files: "# Instruction Files\n\n## /w/a.md\n\none\nthree".into(), ..base() };
    assert_eq!(stage(&mut session, &now), ["instructionFiles"]);
    let content = snapshot_pending(&session).unwrap().1;
    assert!(content.contains("## /w/a.md\n- two\n+ three\nRead /w/a.md for the full file."), "{content}");
    assert!(content.contains("## /w/b.md\nNo longer applies."), "{content}");
}

#[test]
fn an_oversized_change_is_cut_to_the_budget_and_the_rest_follows_in_the_next_notice() {
    let listing = |count: usize| {
        let mut text = String::from("# Instruction Files");
        for index in 0..count {
            text.push_str(&format!("\n\n## /d/f{index:03}.md\n\nbody {index}"));
        }
        text
    };
    let mut session = session_presenting(&base());
    let now = OwnedSections { instruction_files: listing(150), ..base() };
    stage(&mut session, &now);
    let (revision, content) = snapshot_pending(&session).unwrap();
    assert!(content.len() <= NOTICE_MAX_BYTES, "{} bytes", content.len());
    assert!(content.contains("more changed files follow in the next notice"), "{content}");
    assert!(content.contains("/d/f000.md"));

    acknowledge_pending(&mut session, revision);
    assert_eq!(session.get("promptSettingsRecheck"), Some(&json!(true)), "what was left out is checked again");

    stage(&mut session, &now);
    let (_, next) = snapshot_pending(&session).expect("the rest is told by the next notice");
    assert!(next.len() <= NOTICE_MAX_BYTES);
    assert!(!next.contains("/d/f000.md"), "what was told is not told again");
}

#[test]
fn a_rebuilt_prompt_presents_the_settings_and_clears_the_notice() {
    let mut session = session_presenting(&base());
    stage(&mut session, &OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() });
    assert!(snapshot_pending(&session).is_some());
    let rebuilt = OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() };
    note_presented(&mut session, &rebuilt);
    assert!(snapshot_pending(&session).is_none());
    assert_eq!(session["promptSettings"], rebuilt.record());
    assert!(stage(&mut session, &rebuilt).is_empty());
}

#[test]
fn a_turn_carries_the_notice_after_its_text_and_an_accepted_turn_acknowledges_it() {
    let mut session = session_presenting(&base());
    stage(&mut session, &OwnedSections { skills: "- tidy: x\n- docx: y".into(), ..base() });
    let (revision, block) = snapshot_pending(&session).unwrap();

    let plain = json!({ "role": "user", "content": "hello" });
    let carried = carry_reminders(&plain, &block, None, Some(revision)).unwrap();
    assert_eq!(carried["content"], json!(format!("hello\n\n{block}")));
    assert_eq!(carried["meta"]["promptSettingsNoticeRevision"], json!(revision));
    assert_eq!(carried["meta"]["runtimeUserContext"], json!({ "prefix": "", "suffix": format!("\n\n{block}") }));

    let blocks = json!({ "role": "user", "content": [{ "type": "text", "text": "hi" }] });
    let carried = carry_reminders(&blocks, &block, None, None).unwrap();
    assert_eq!(carried["content"][1], json!({ "type": "text", "text": format!("\n\n{block}") }));

    assert_eq!(carry_reminders(&plain, "", None, None), Some(plain.clone()), "no reminder keeps the message");
    assert!(carry_reminders(&json!({ "content": 5 }), &block, None, None).is_none());

    let change = acknowledge_change(&session, revision).expect("the accepted turn acknowledges");
    assert!(change.unset.contains(&"promptSettingsNotice".to_owned()));
    assert!(change.set.contains_key("promptSettingsTold"));
    assert!(acknowledge_change(&session, revision + 1).is_none());
}
