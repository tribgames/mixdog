//! The answer readers against `fixtures/room-answer/golden.json`, recorded from the real desktop
//! `agent-room-turn.ts` / `session-final-answer.ts` by `record-room-answer.mjs`.

use std::path::Path;

use serde_json::{Value, json};

use super::{SessionAnswer, empty_finished_turn, session_final_answer, spoken_text, tool_summaries};

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-answer/golden.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn shown(answer: Option<SessionAnswer>) -> Value {
    answer.map_or(Value::Null, |answer| answer.to_value())
}

#[test]
fn reads_the_final_answer_as_the_node_function_did() {
    for case in golden()["finalAnswers"].as_array().unwrap() {
        let got = shown(session_final_answer(&case["snapshot"], &case["startedAt"]));
        assert_eq!(got, case["answer"], "{}", case["name"]);
    }
}

#[test]
fn a_finished_turn_without_text_is_an_empty_answer_only_when_nothing_else_is_pending() {
    for case in golden()["emptyTurns"].as_array().unwrap() {
        let got = shown(empty_finished_turn(&case["snapshot"], &case["startedAt"]));
        assert_eq!(got, case["answer"], "{}", case["name"]);
    }
}

#[test]
fn tool_summaries_are_the_bounded_lines_of_the_tools_after_the_last_user_message() {
    for case in golden()["toolSummaries"].as_array().unwrap() {
        let got: Vec<Value> = tool_summaries(&case["snapshot"], case["startedAt"].as_f64().unwrap()).into_iter().map(|(name, summary)| json!({ "name": name, "summary": summary })).collect();
        assert_eq!(Value::Array(got), case["answer"], "{}", case["name"]);
    }
}

#[test]
fn a_pass_never_shows_its_marker() {
    for case in golden()["spokenText"].as_array().unwrap() {
        let answer = SessionAnswer {
            id: case["answer"]["id"].clone(),
            at: case["answer"]["at"].clone(),
            status: case["answer"]["status"].as_str().unwrap().to_owned(),
            text: case["answer"]["text"].as_str().unwrap().to_owned(),
            reacted: false,
        };
        assert_eq!(json!(spoken_text(&answer, case["waiting"].as_bool().unwrap())), case["spoken"], "{case}");
    }
}
