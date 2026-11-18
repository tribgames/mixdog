//! The prompt of a session after creation: the `# Session` block that follows the environment facts, the staged
//! working-folder change a route change applies, the reset of a cleared conversation, and the workspace the prompt
//! presents.

use mixdog_core::run_host::prompt_session::presented_workspace_of;
use mixdog_core::run_host::prompt_session::refresh_environment;
use mixdog_core::run_host::prompt_session::reset_environment;
use mixdog_core::run_host::prompt_session::route_prompt;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

const SEP: &str = "\n\n---\n\n";
const FACTS: &str = "- Cwd: /w — the active Project root; relative paths and shell commands resolve here.";

fn header(session: Value) -> Header {
    session.as_object().expect("a session object").clone()
}

fn split_blocks(env: &str) -> SystemBlocks {
    SystemBlocks { base: Some("BASE".into()), stable: Some("STABLE".into()), core: Some("CORE".into()), env: Some(env.into()), combined: false }
}

fn lead_header(tail: &str) -> Header {
    header(json!({ "owner": "lead", "cwd": "/w", "model": "claude-opus-4", "bp3EnvSplit": true, "bp3EnvironmentContext": tail, "sessionStartMetaInjected": false }))
}

#[test]
fn the_session_block_leads_the_environment_tail_with_the_cwd_and_the_model() {
    let patch = refresh_environment(&lead_header("- Shell: Bash."), &split_blocks("- Shell: Bash."));
    assert_eq!(patch.blocks.env.as_deref(), Some(format!("# Session\nCwd: /w\nModel: Claude-Opus-4{SEP}- Shell: Bash.").as_str()));
    assert_eq!((patch.blocks.base.as_deref(), patch.blocks.stable.as_deref(), patch.blocks.core.as_deref()), (Some("BASE"), Some("STABLE"), Some("CORE")));
    assert_eq!(patch.change.set["sessionStartMetaInjected"], true, "the next ask knows the block is in");
    assert_eq!(patch.change.set.len(), 2, "the env block and the flag are all that change: {:?}", patch.change.set);
}

#[test]
fn a_delegated_worker_gets_no_session_block() {
    let mut worker = lead_header("- Shell: Bash.");
    worker.insert("owner".into(), json!("agent"));
    let patch = refresh_environment(&worker, &split_blocks("- Shell: Bash."));
    assert_eq!(patch.blocks.env.as_deref(), Some("- Shell: Bash."));
}

#[test]
fn a_route_change_applies_the_staged_folder_change_and_without_one_the_prompt_stays_rooted_where_it_was() {
    let mut staged = lead_header(&format!("{FACTS}{SEP}- Shell: Bash."));
    staged.insert("cwd".into(), json!("/new"));
    staged.insert(
        "workspaceReroot".into(),
        json!({ "revision": 1, "rootCwd": "/old", "seen": { "cwd": "/old" }, "target": { "cwd": "/new", "environmentContext": "- Cwd: /new — the active Project root; relative paths and shell commands resolve here." } }),
    );
    let blocks = split_blocks(&format!("{FACTS}{SEP}- Shell: Bash."));

    let kept = route_prompt(&staged, &blocks, false);
    assert!(kept.blocks.env.as_deref().is_some_and(|env| env.starts_with("# Session\nCwd: /old\n")), "{:?}", kept.blocks.env);
    assert!(!kept.change.unset.iter().any(|key| key == "workspaceReroot"), "the staged change is still pending");

    let applied = route_prompt(&staged, &blocks, true);
    let env = applied.blocks.env.expect("an env block");
    assert!(env.starts_with("# Session\nCwd: /new\n"), "{env}");
    assert!(env.contains("- Cwd: /new — the active Project root") && !env.contains("- Cwd: /w"), "the facts are the new folder's: {env}");
    assert!(applied.change.unset.iter().any(|key| key == "workspaceReroot"), "the applied change is no longer pending");
}

#[test]
fn clearing_the_conversation_leaves_only_the_environment_tail_and_asks_for_a_fresh_session_block() {
    let mut session = lead_header("- Shell: Bash.");
    session.insert("sessionStartMetaInjected".into(), json!(true));
    let patch = reset_environment(&session, &split_blocks(&format!("# Session\nCwd: /w{SEP}- Shell: Bash.")));
    assert_eq!(patch.blocks.env.as_deref(), Some("- Shell: Bash."));
    assert_eq!(patch.change.set["sessionStartMetaInjected"], false);
}

#[test]
fn a_session_in_the_combined_layout_keeps_one_core_message_through_a_reset() {
    let mut session = lead_header("- Shell: Bash.");
    session.shift_remove("bp3EnvSplit");
    session.insert("bp3CoreContext".into(), json!("CORE"));
    session.insert("sessionStartMetaInjected".into(), json!(true));
    let blocks = SystemBlocks { base: Some("BASE".into()), stable: Some("STABLE".into()), core: Some(format!("CORE{SEP}# Session\nCwd: /w{SEP}- Shell: Bash.")), env: None, combined: true };
    let patch = reset_environment(&session, &blocks);
    assert!(patch.blocks.combined && patch.blocks.env.is_none());
    assert_eq!(patch.blocks.core.as_deref(), Some(format!("CORE{SEP}- Shell: Bash.").as_str()));
}

#[test]
fn the_presented_workspace_is_read_back_from_the_blocks_and_the_environment_tail() {
    let mut session = lead_header(&format!("{FACTS}{SEP}- Shell: Bash."));
    let mut blocks = split_blocks(&format!("# Session\nCwd: /s{SEP}{FACTS}"));
    blocks.core = Some(format!("CORE{SEP}# Instruction Files\nrules{SEP}# Core Memory\nremember"));
    blocks.write(&mut session);
    assert_eq!(
        presented_workspace_of(&session),
        json!({ "cwd": "/s", "environmentContext": FACTS, "coreMemoryContext": "remember", "instructionFilesContext": "# Instruction Files\nrules" })
    );

    // With no `# Session` block (a delegated worker), the facts' own Cwd line is the folder.
    let mut worker = session.clone();
    split_blocks(FACTS).write(&mut worker);
    worker.insert("owner".into(), json!("agent"));
    let presented = presented_workspace_of(&worker);
    assert_eq!(presented["cwd"], "/w");
    assert_eq!(presented["coreMemoryContext"], "");
    assert_eq!(presented["instructionFilesContext"], "");
}
