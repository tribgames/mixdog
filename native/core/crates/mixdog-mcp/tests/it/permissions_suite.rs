//! The connector permission lookups: the permission each agent has for each tool under its policy files, and whether a project's
//! paths have a tool's connector switched off.
#![allow(clippy::disallowed_methods, reason = "test fixtures write policy files directly")]

use std::sync::Arc;

use mixdog_mcp::permissions::ConnectorPolicy;
use mixdog_mcp::permissions::PolicyIo;
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_policy_is_kept_aside_and_its_good_copy_restored_but_without_one_it_stays() {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let good = r#"{"connectors":{"off":["gmail"]}}"#;
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agents").join("worker");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("agent.json"), r#"{"connectors":"#).unwrap();
    std::fs::write(agent.join("agent.json.bak"), good).unwrap();
    let policy = ConnectorPolicy::new(dir.path().to_path_buf(), io);
    policy.reload().await;
    assert_eq!(policy.permission("worker", "mcp__gmail__read").name(), "disabled");
    assert_eq!(std::fs::read_to_string(agent.join("agent.json")).unwrap(), good);
    let aside: Vec<_> = std::fs::read_dir(&agent).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read_to_string(aside[0].path()).unwrap(), r#"{"connectors":"#);

    let lone = tempfile::tempdir().unwrap();
    let agent = lone.path().join("agents").join("worker");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("agent.json"), "{").unwrap();
    let policy = ConnectorPolicy::new(lone.path().to_path_buf(), io);
    policy.reload().await;
    assert_eq!(policy.permission("worker", "mcp__gmail__read").name(), "disabled");
    assert_eq!(std::fs::read_to_string(agent.join("agent.json")).unwrap(), "{", "kept in place: moving it would read as no policy");
}

/// Node stat-checks the policy files on every read (`cachedRead`): a policy saved after the start load, by any
/// writer, is what the refresh before the next connector call (or at a turn start) answers; one switched back on is
/// on again. A call of a tool that is no connector tool reads nothing, as Node reads the files for an MCP name alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_policy_saved_after_the_start_load_is_read_at_the_next_refresh() {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agents").join("worker");
    std::fs::create_dir_all(&agent).unwrap();
    let policy = ConnectorPolicy::new(dir.path().to_path_buf(), io);
    policy.reload().await;
    let tool = "mcp__outbox__say";
    assert_eq!(policy.permission("worker", tool).name(), "auto");
    // Each save has a size of its own, so its stamp moves however coarse the file times are.
    for (connectors, expected) in
        [(r#"{"tools":{"outbox":{"say":"needs_approval"}}}"#, "needs_approval"), (r#"{"off":["outbox"]}"#, "disabled"), (r#"{"off":[]}"#, "auto")]
    {
        std::fs::write(agent.join("agent.json"), format!(r#"{{"connectors":{connectors}}}"#)).unwrap();
        policy.refresh("worker", Some(tool)).await;
        assert_eq!(policy.permission("worker", tool).name(), expected, "after saving {connectors}");
    }
    std::fs::write(agent.join("agent.json"), r#"{"connectors":{"off":["outbox","other"]}}"#).unwrap();
    policy.refresh("worker", Some("read")).await;
    assert_eq!(policy.permission("worker", tool).name(), "auto", "a call of a built-in tool reads no policy");
    let later = dir.path().join("agents").join("later");
    std::fs::create_dir_all(&later).unwrap();
    std::fs::write(later.join("agent.json"), r#"{"connectors":{"off":["outbox"]}}"#).unwrap();
    policy.refresh("later", None).await;
    assert_eq!(policy.permission("later", tool).name(), "disabled", "an agent made after the start load");

    let root = dir.path().join("ws");
    let paths = [root.clone()];
    assert!(!policy.project_disabled(&paths, tool));
    let mut projects = serde_json::Map::new();
    projects.insert(root.to_string_lossy().into_owned(), json!({ "off": ["outbox"] }));
    std::fs::write(dir.path().join("project-connectors.json"), json!({ "projects": projects }).to_string()).unwrap();
    policy.refresh("", Some(tool)).await;
    assert!(policy.project_disabled(&paths, tool), "the project switched the connector off");
}

/// Node reads `serverConnector` and the tool's server as the servers are when the call is judged: a catalog connector's
/// high-risk tool asks once its server is connected, and a name the resolver tells back is judged by its server and tool.
#[tokio::test(flavor = "multi_thread")]
async fn the_connector_of_a_server_and_a_cut_name_are_read_live() {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let policy = ConnectorPolicy::new(dir.path().to_path_buf(), io);
    let connected = Arc::new(std::sync::Mutex::new(None::<String>));
    let source = connected.clone();
    policy.set_server_connectors(Arc::new(move |server| source.lock().unwrap().clone().filter(|_| server == "gmail")));
    policy.set_resolver(Arc::new(|name| (name == "mcp__gmail__cut_1a2b3c").then(|| ("gmail".to_owned(), "send_email".to_owned()))));
    assert_eq!(policy.permission("worker", "mcp__gmail__send_email").name(), "auto");
    *connected.lock().unwrap() = Some("gmail".to_owned());
    assert_eq!(policy.permission("worker", "mcp__gmail__send_email").name(), "needs_approval");
    assert_eq!(policy.permission("worker", "mcp__gmail__cut_1a2b3c").name(), "needs_approval", "a cut name is told back to its tool");
    assert_eq!(policy.permission("worker", "mcp__gmail__read_email").name(), "auto");
}

/// A remembered approval's key is the connector and the server's own tool name: every account of the connector reads the
/// same, and a name cut with a hash suffix is told back to its tool.
#[tokio::test(flavor = "multi_thread")]
async fn a_tools_identity_is_its_connector_and_tool_whichever_account_serves_it() {
    let tokens = mixdog_rt::testing::tokens();
    let io = PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let policy = ConnectorPolicy::new(dir.path().to_path_buf(), io);
    policy.set_resolver(Arc::new(|name| (name == "mcp__gmail-2__cut_1a2b3c").then(|| ("gmail-2".to_owned(), "send_email".to_owned()))));
    assert_eq!(policy.identity("mcp__gmail__send_email"), "mcp__gmail__send_email");
    assert_eq!(policy.identity("mcp__gmail-2__send_email"), "mcp__gmail__send_email");
    assert_eq!(policy.identity("mcp__gmail-2__cut_1a2b3c"), "mcp__gmail__send_email");
    assert_eq!(policy.identity("mcp__slack__post"), "mcp__slack__post");
    assert_eq!(policy.identity("shell"), "shell");
}
