//! How a room member's finished turn is read from its session snapshot: the answer it owns, a turn that said nothing, the
//! tools it ran, and what of it is spoken in the room.

use serde_json::{Value, json};

use super::{SessionAnswer, empty_finished_turn, session_final_answer, spoken_text, tool_summaries};

fn snapshot(items: Value) -> Value {
    json!({ "items": items })
}

fn answered() -> Value {
    snapshot(json!([
        { "kind": "user", "id": "u1", "at": 1 },
        { "kind": "assistant", "id": "a1", "text": "the answer" },
        { "kind": "turndone", "id": "d1", "at": 10, "status": "done", "finalAssistantId": "a1" },
    ]))
}

#[test]
fn a_completed_turn_owns_the_answer_named_by_its_done_item() {
    let answer = session_final_answer(&answered(), &json!(5)).expect("an answer");
    assert_eq!(answer.to_value(), json!({ "id": "d1", "at": 10, "status": "done", "text": "the answer" }));
}

#[test]
fn a_busy_or_streaming_or_older_or_superseded_turn_has_no_answer_yet() {
    let mut busy = answered();
    busy["busy"] = json!(true);
    assert!(session_final_answer(&busy, &json!(5)).is_none(), "busy");
    let mut streaming = answered();
    streaming["streamingTail"] = json!("partial");
    assert!(session_final_answer(&streaming, &json!(5)).is_none(), "streaming");
    assert!(session_final_answer(&answered(), &json!(11)).is_none(), "the done item is older than the turn's start");
    let mut newer = answered();
    newer["items"].as_array_mut().unwrap().push(json!({ "kind": "user", "id": "u2", "at": 12 }));
    assert!(session_final_answer(&newer, &json!(5)).is_none(), "a newer prompt arrived");
    assert!(session_final_answer(&answered(), &json!("soon")).is_none(), "no start time");
}

#[test]
fn a_failed_or_cancelled_turn_answers_with_its_status_and_no_text() {
    for status in ["failed", "cancelled"] {
        let failed = snapshot(json!([{ "kind": "turndone", "id": "d1", "at": 10, "status": status }]));
        let answer = session_final_answer(&failed, &json!(5)).unwrap();
        assert_eq!((answer.status.as_str(), answer.text.as_str()), (status, ""));
    }
}

#[test]
fn a_reaction_alone_is_an_answer_and_a_still_streaming_reply_is_not() {
    let reacted = snapshot(json!([{ "kind": "turndone", "id": "d1", "at": 10, "status": "done", "reacted": true }]));
    let answer = session_final_answer(&reacted, &json!(5)).unwrap();
    assert!(answer.reacted && answer.text.is_empty());
    assert_eq!(answer.to_value()["reacted"], json!(true));

    let mut streaming = answered();
    streaming["items"][1]["streaming"] = json!(true);
    assert!(session_final_answer(&streaming, &json!(5)).is_none());
}

#[test]
fn a_finished_turn_without_text_is_an_empty_answer_only_when_nothing_follows_it() {
    let silent = snapshot(json!([
        { "kind": "user", "id": "u1", "at": 1 },
        { "kind": "turndone", "id": "d1", "at": 10, "status": "done" },
    ]));
    let answer = empty_finished_turn(&silent, &json!(5)).expect("a silent turn passes");
    assert_eq!((answer.status.as_str(), answer.text.as_str()), ("done", ""));

    assert!(empty_finished_turn(&answered(), &json!(5)).is_none(), "a turn with text is not empty");
    let mut followed = silent.clone();
    followed["items"].as_array_mut().unwrap().push(json!({ "kind": "user", "id": "u2", "at": 11 }));
    assert!(empty_finished_turn(&followed, &json!(5)).is_none());
    let failed = snapshot(json!([{ "kind": "turndone", "id": "d1", "at": 10, "status": "failed" }]));
    assert!(empty_finished_turn(&failed, &json!(5)).is_none());
}

#[test]
fn tool_summaries_are_the_bounded_lines_of_the_tools_since_the_last_user_message() {
    let long = "x".repeat(500);
    let turn = snapshot(json!([
        { "kind": "tool", "name": "old", "result": "before the prompt", "at": 1 },
        { "kind": "user", "id": "u1", "at": 2 },
        { "kind": "tool", "name": "read", "result": "short", "at": 3 },
        { "kind": "tool", "result": { "ok": true }, "at": 4 },
        { "kind": "tool", "name": "big", "result": long, "at": 5 },
    ]));
    let got = tool_summaries(&turn, 2.0);
    assert_eq!(got.len(), 3, "the tool before the user message is another turn's");
    assert_eq!(got[0], ("read".to_owned(), "short".to_owned()));
    assert_eq!(got[1], ("tool".to_owned(), "{\"ok\":true}".to_owned()), "a nameless tool is `tool`, a non-text result is its JSON");
    assert_eq!(got[2].1.chars().count(), 400, "a summary is cut at 400");
}

#[test]
fn a_pass_never_shows_its_marker() {
    let said = |text: &str, status: &str| SessionAnswer { id: json!("d"), at: json!(1), status: status.into(), text: text.into(), reacted: false };
    assert_eq!(spoken_text(&said("hello there", "done"), false), "hello there");
    assert_eq!(spoken_text(&said("(pass)", "done"), false), "");
    assert_eq!(spoken_text(&said("", "done"), false), "");
    assert_eq!(spoken_text(&said("I will wait (pass)", "done"), false), "", "a pass says nothing");
    assert_eq!(spoken_text(&said("I will wait (pass)", "done"), true), "I will wait", "while the user waits the words before the marker are the answer");
    assert_eq!(spoken_text(&said("text", "failed"), true), "");
}
