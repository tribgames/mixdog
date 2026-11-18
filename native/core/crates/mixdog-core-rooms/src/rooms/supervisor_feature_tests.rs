//! What the room supervisor reads each step: the window of rows (the user's latest message, at most six messages before it, the
//! newest thirty after it), the fields and bounds the rows keep, and the prompt's framing of that window.

use serde_json::{Value, json};

use super::exchange::{DecideInput, Remaining};
use super::supervisor::{SupervisorInput, SupervisorMember, supervisor_prompt, supervisor_rows};

fn speech(id: &str) -> Value {
    json!({ "id": id, "kind": "speech", "speaker": "bench", "text": "x", "files": ["a.txt"] })
}

fn user(id: &str) -> Value {
    json!({ "id": id, "kind": "user", "text": "go" })
}

fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect()
}

fn numbered(prefix: &str, range: std::ops::RangeInclusive<usize>) -> Vec<Value> {
    range.map(|n| speech(&format!("{prefix}{n}"))).collect()
}

fn idle(must_pick: bool) -> DecideInput {
    DecideInput { must_pick, turns: vec![], last: String::new(), mention: None, remaining: Remaining { messages: 4, steps: 6 } }
}

fn members() -> Vec<SupervisorMember> {
    vec![SupervisorMember { id: "bench".into(), name: "Bench".into(), description: String::new() }]
}

fn prompt_of(rows: &[Value]) -> String {
    supervisor_prompt(&SupervisorInput { room_name: "Plan", members: &members(), rows, decide: &idle(false) }).user
}

#[test]
fn the_window_is_the_users_latest_message_with_six_before_it_and_the_newest_thirty_after_it() {
    let mut rows = numbered("s", 1..=8);
    rows.push(json!({ "id": "t1", "kind": "tool", "text": "ran" }));
    rows.push(user("u1"));
    rows.extend(numbered("a", 1..=35));
    let got = ids(&supervisor_rows(&rows));
    let mut want: Vec<String> = (3..=8).map(|n| format!("s{n}")).collect();
    want.push("u1".into());
    want.extend((6..=35).map(|n| format!("a{n}")));
    assert_eq!(got, want);
}

#[test]
fn with_no_user_message_yet_the_window_is_the_newest_thirty_speeches() {
    let got = ids(&supervisor_rows(&numbered("n", 1..=40)));
    assert_eq!(got, (11..=40).map(|n| format!("n{n}")).collect::<Vec<_>>());
}

#[test]
fn a_row_keeps_only_who_said_what_each_value_bounded() {
    let long_text = "a".repeat(700);
    let long_id = "i".repeat(100);
    let row = json!({ "id": long_id, "kind": "speech", "speaker": "bench", "text": long_text, "files": ["a.txt"], "toolResult": "big" });
    let kept = supervisor_rows(&[row]);
    assert_eq!(kept.len(), 1);
    let kept = kept[0].as_object().unwrap();
    assert_eq!(kept.keys().map(String::as_str).collect::<Vec<_>>(), ["id", "kind", "speaker", "text"]);
    assert_eq!(kept["id"], json!(format!("{}…", "i".repeat(79))));
    assert_eq!(kept["text"], json!(format!("{}…", "a".repeat(599))));
}

#[test]
fn the_prompt_marks_settled_talk_the_newest_user_message_and_who_answered_it_first() {
    let rows = vec![speech("s1"), user("u1"), speech("a1")];
    let prompt = prompt_of(&rows);
    let at = |needle: &str| prompt.find(needle).unwrap_or_else(|| panic!("{needle} in {prompt}"));
    assert!(at("(background: earlier talk, already settled)") < at("(the user's newest message and what followed it)"));
    assert!(prompt.contains("The user's newest message: already answered (first by Bench (id bench))"));
}

#[test]
fn a_user_message_nobody_followed_is_not_answered_and_an_empty_room_has_none_in_view() {
    assert!(prompt_of(&[user("u1")]).contains("The user's newest message: not answered yet"));
    let empty = prompt_of(&[]);
    assert!(empty.contains("(none)"));
    assert!(empty.contains("The user's newest message: none in view"));
    assert!(!empty.contains("(background"));
}

#[test]
fn the_budget_and_the_forced_pick_are_told_to_the_supervisor() {
    let prompt = supervisor_prompt(&SupervisorInput { room_name: "Plan", members: &members(), rows: &[user("u1")], decide: &idle(true) }).user;
    assert!(prompt.contains("Budget left: 4 member messages, 6 turns."));
    assert!(prompt.contains("Must pick a member: yes, nobody has answered the user yet"));
}
