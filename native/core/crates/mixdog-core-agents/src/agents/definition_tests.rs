//! The definition loader's answers over files on disk: first-response deadlines, presence and the custom agents.

use serde_json::json;

use super::tests::writable;
use super::*;
use mixdog_core_rooms::rooms::home::Presence;

fn put(root: &std::path::Path, rel: &str, text: &str) {
    let file = root.join(rel);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn timeout_of(ms: &str) -> String {
    format!("---\nname: X\nfirstResponseTimeoutMs: {ms}\n---\nBody\n")
}

#[tokio::test]
async fn the_first_response_deadline_comes_from_the_first_definition_that_sets_one_user_copy_first() {
    let (dir, agents) = writable(json!({})).await;
    let (data, shipped) = (dir.path().join("data"), dir.path().join("shipped"));
    put(&data, "agents/own/AGENT.md", &timeout_of("1500.9"));
    put(&shipped, "agents/own/AGENT.md", &timeout_of("9000"));
    put(&shipped, "agents/inherit/AGENT.md", &timeout_of("7000"));
    put(&data, "agents/inherit/AGENT.md", "---\nname: X\n---\nBody\n");
    put(&data, "agents/off/AGENT.md", &timeout_of("0"));
    put(&data, "agents/negative/AGENT.md", &timeout_of("-5"));
    put(&data, "agents/words/AGENT.md", &timeout_of("soon"));
    put(&data, "agents/none/AGENT.md", "---\nname: X\n---\nBody\n");
    let ask = |id: &'static str| agents.first_response_timeout_ms(id);
    assert_eq!(ask("own").await.unwrap(), Some(1500), "floored, and the user copy wins over the shipped one");
    assert_eq!(ask("inherit").await.unwrap(), Some(7000), "a copy that sets none falls back to the shipped one");
    assert_eq!(ask("off").await.unwrap(), Some(0), "zero turns the deadline off");
    assert_eq!(ask("negative").await.unwrap(), None);
    assert_eq!(ask("words").await.unwrap(), None);
    assert_eq!(ask("none").await.unwrap(), None);
    assert_eq!(ask("ghost").await.unwrap(), None);
    assert_eq!(ask("").await.unwrap(), None);
}

#[tokio::test]
async fn a_deleted_agent_has_no_first_response_deadline() {
    let (dir, agents) = writable(json!({})).await;
    let data = dir.path().join("data");
    put(&data, "agents/gone/AGENT.md", &timeout_of("1000"));
    put(&data, &format!("agents/gone/{DELETED_MARKER}"), "");
    assert_eq!(agents.first_response_timeout_ms("gone").await.unwrap(), None);
}

#[tokio::test]
async fn presence_is_read_from_the_files_themselves() {
    let (dir, agents) = writable(json!({})).await;
    let (data, shipped) = (dir.path().join("data"), dir.path().join("shipped"));
    put(&data, "agents/here/AGENT.md", "---\nname: X\n---\nBody\n");
    put(&data, "agents/gone/AGENT.md", "---\nname: X\n---\nBody\n");
    std::fs::remove_file(data.join("agents/gone/AGENT.md")).unwrap();
    put(&data, &format!("agents/gone/{DELETED_MARKER}"), "");
    put(&shipped, "agents/role/AGENT.md", "---\nname: X\n---\nBody\n");
    let ids: Vec<String> = ["here", "gone", "role", "Bad Id"].map(String::from).to_vec();
    let found = agents.presence(&ids).await.unwrap();
    assert_eq!(found["here"], Presence::Present);
    assert_eq!(found["gone"], Presence::Deleted);
    assert_eq!(found["role"], Presence::Present);
    assert_eq!(found["Bad Id"], Presence::Unknown);
}

#[tokio::test]
async fn the_custom_agents_are_those_with_a_definition_on_disk() {
    let (dir, agents) = writable(json!({})).await;
    put(&dir.path().join("data"), "agents/ann/AGENT.md", "---\nname: Ann\n---\nBody\n");
    put(&dir.path().join("data"), "agents/bob/AGENT.md", "---\nname: Bob\n---\nBody\n");
    let ids = agents.custom_agent_ids().await.unwrap();
    assert!(ids.contains(&"ann".to_owned()) && ids.contains(&"bob".to_owned()), "{ids:?}");
    assert!(!ids.contains(&"ghost".to_owned()));
}
