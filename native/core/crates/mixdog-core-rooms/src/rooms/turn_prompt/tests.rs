//! `room_turn_prompt` against `fixtures/room-turn/golden.json`, recorded from the real Node
//! `roomTurnPrompt` by `record-room-turn.mjs`.


use serde_json::Value;

use super::{PromptInput, PromptMember, RoomPrompt, room_turn_prompt};
use crate::rooms::exchange::Scene;

fn member(value: &Value) -> PromptMember {
    PromptMember { id: value["id"].as_str().unwrap().to_owned(), name: value["name"].as_str().unwrap_or("").to_owned() }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().map(|item| item.as_str().unwrap().to_owned()).collect()).unwrap_or_default()
}

#[test]
fn builds_what_the_node_function_built_for_each_recorded_case() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/room-turn/golden.json")).unwrap();
    let mut failures = Vec::new();
    for case in golden["prompts"].as_array().unwrap() {
        let input = &case["input"];
        let (myself, members) = (member(&input["self"]), input["members"].as_array().unwrap().iter().map(member).collect::<Vec<_>>());
        let addressed = strings(&input["addressed"]);
        let rows = input["rows"].as_array().unwrap();
        let text = |field: &str| input[field].as_str().unwrap_or("").to_owned();
        let (room_name, mentioned_by, instruction, asked_by, relay) = (text("roomName"), text("mentionedBy"), text("instruction"), text("askedBy"), text("relay"));
        let prompt = room_turn_prompt(&PromptInput {
            room_name: &room_name,
            myself: &myself,
            members: &members,
            rows,
            share_tools: input["shareTools"].as_bool().unwrap_or(false),
            addressed: &addressed,
            mentioned_by: &mentioned_by,
            instruction: &instruction,
            scene: if input["scene"].as_str() == Some("casual") { Scene::Casual } else { Scene::Work },
            waiting: input["waiting"].as_bool(),
            asked_by: &asked_by,
            relay: &relay,
        });
        let got = match prompt {
            RoomPrompt::Text(text) => Value::String(text),
            RoomPrompt::Parts(parts) => Value::Array(parts),
        };
        if got != case["answer"] {
            failures.push(format!("{}:\n got  {got}\n Node {}", case["name"], case["answer"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
